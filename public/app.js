let activeSymbol = 'BTCUSDT';
let chartInstance = null;
let equityChartInstance = null;
let currentSettings = null;
let runtimeInfo = null;
let controlToken = localStorage.getItem('autotread_control_token') || '';

function apiHeaders(json = false) {
  const headers = {};
  if (json) headers['Content-Type'] = 'application/json';
  if (controlToken) headers['X-Control-Token'] = controlToken;
  return headers;
}

// Initialize Chart
function initChart() {
  const ctx = document.getElementById('marketChart').getContext('2d');
  chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: '1m Price (USDT)',
          data: [],
          borderColor: '#00f2fe',
          backgroundColor: 'rgba(0, 242, 254, 0.08)',
          borderWidth: 2,
          fill: true,
          tension: 0.2,
          pointRadius: 2,
          pointHoverRadius: 5
        },
        {
          label: 'EMA (9)',
          data: [],
          borderColor: '#ffeb3b',
          borderWidth: 1.5,
          borderDash: [4, 4],
          pointRadius: 0,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: { color: '#8a99ad', font: { family: "'Plus Jakarta Sans', sans-serif", size: 11 } }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#8a99ad', font: { size: 10 } }
        },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#8a99ad', font: { family: "'JetBrains Mono', monospace", size: 11 } }
        }
      }
    }
  });
}

function initEquityChart() {
  const el = document.getElementById('equityChart');
  if (!el || equityChartInstance) return;
  equityChartInstance = new Chart(el.getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Equity (USDT)',
        data: [],
        borderColor: '#00e676',
        backgroundColor: 'rgba(0, 230, 118, 0.08)',
        borderWidth: 2,
        fill: true,
        tension: 0.15,
        pointRadius: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#8a99ad', font: { size: 10 }, maxTicksLimit: 8 } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#8a99ad', font: { family: "'JetBrains Mono', monospace", size: 11 } } }
      }
    }
  });
}

// Format numbers
const formatUSD = (val) => '$' + Number(val || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatPrice = (val) => Number(val || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: (val < 1 ? 4 : 2) });
function formatDateTimeParts(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const date = d.toLocaleDateString([], { year: 'numeric', month: 'short', day: '2-digit' });
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return { date, time };
}

function formatDateTime(iso) {
  const parts = formatDateTimeParts(iso);
  if (!parts) return '--';
  return `${parts.date}<br>${parts.time}`;
}

function formatDateTimeLine(iso) {
  const parts = formatDateTimeParts(iso);
  if (!parts) return '--';
  return `${parts.date} ${parts.time}`;
}

// Poll data and update UI
async function fetchStateAndUpdate() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) return;
    const data = await res.json();

    currentSettings = data.settings;
    runtimeInfo = data.runtime || null;

    // Skip heavy dashboard DOM re-rendering while modal is open to keep scrolling butter-smooth
    if (document.body.classList.contains('modal-open')) {
      const modalBal = document.getElementById('modalFreeBalance');
      if (modalBal && data.portfolio) {
        modalBal.textContent = `${formatUSD(data.portfolio.freeBalance)} USDT`;
      }
      return;
    }

    renderRuntimeBanner(runtimeInfo, data);
    renderTopbarAndKPIs(data);
    renderPerformance(data);
    renderCoinList(data.marketData, data.opportunities);
    const scannerTitle = document.getElementById('scannerTitle');
    if (scannerTitle) {
      const n = (data.watchedCoins && data.watchedCoins.length) || (data.opportunities && data.opportunities.length) || 0;
      scannerTitle.textContent = `Opportunity Scanner (${n} coins)`;
    }
    renderActiveChart(data.marketData[activeSymbol]);
    renderAIBrain(data.aiMetrics, data.marketData[activeSymbol], data.fiveMinForecast);
    renderFiveMinForecast(data.fiveMinForecast, data.marketData[activeSymbol]);
    renderMarketContext(data.marketContext, data.marketData[activeSymbol]);
    renderPositions(data.positions, data.marketData);
    renderHistory(data.tradeHistory, data.tradeHistorySaved || (data.tradeHistory || []).length);
  } catch (err) {
    console.error('Fetch state error:', err);
  }
}

function renderRuntimeBanner(runtime, data) {
  const banner = document.getElementById('runtimeBanner');
  if (!banner || !runtime) return;

  if (runtime.mode === 'live') {
    banner.style.display = 'flex';
    const net = runtime.testnet ? 'FUTURES TESTNET' : 'FUTURES LIVE — REAL MONEY';
    const circuit = runtime.circuitBroken ? ` CIRCUIT BREAKER: ${runtime.circuitReason}` : '';
    const nn = runtime.nnReady ? 'NN ready' : 'NN gated (untrained — not in score)';
    banner.className = 'runtime-banner ' + (runtime.testnet ? 'runtime-testnet' : 'runtime-live');
    banner.textContent = `${net} · ${runtime.leverage}x max · daily halt ${runtime.maxDailyLossPercent}% · ${nn}.${circuit} Control token required for actions. Bot starts paused.`;
  } else {
    const nn = runtime.nnReady ? 'NN ready (persisted)' : 'NN gated until 20 trained trades';
    const q = (data.settings && data.settings.qualityMode !== false) ? 'Quality filters ON' : 'Quality filters OFF';
    const pause = runtime.entriesPausedReason ? ` · ${runtime.entriesPausedReason}` : '';
    banner.style.display = 'flex';
    banner.className = 'runtime-banner runtime-paper';
    banner.textContent = `PAPER MODE · ${q} · ${nn} · 26h 1m history + websocket. Losses still happen.${pause}`;
  }
}

function renderTopbarAndKPIs(data) {
  const p = data.portfolio;
  const botBtn = document.getElementById('toggleBotBtn');
  const botBadge = document.getElementById('botStatusBadge');

  if (data.isBotActive) {
    botBadge.textContent = 'AUTONOMOUS ACTIVE';
    botBadge.className = 'value text-success';
    botBtn.textContent = 'Pause AI Bot';
    botBtn.className = 'btn btn-outline';
  } else {
    botBadge.textContent = 'PAUSED';
    botBadge.className = 'value text-danger';
    botBtn.textContent = 'Resume AI Bot';
    botBtn.className = 'btn btn-primary';
  }

  document.getElementById('headerEquity').textContent = formatUSD(p.totalEquity);
  document.getElementById('kpiFreeBalance').textContent = formatUSD(p.freeBalance);
  
  const netProfitEl = document.getElementById('kpiNetProfit');
  const realized = p.realizedPnL != null ? p.realizedPnL : 0;
  const unreal = p.totalUnrealizedPnL || 0;
  const closedCount = p.closedTradesCount || 0;
  const show = closedCount > 0 ? realized : unreal;
  const showPct = p.initialBalance ? (show / p.initialBalance) * 100 : 0;
  const sign = show >= 0 ? '+' : '';
  netProfitEl.textContent = `${sign}${formatUSD(show)} (${sign}${showPct.toFixed(2)}%)`;
  netProfitEl.className = `kpi-val ${show >= 0 ? 'text-success' : 'text-danger'}`;
  const titleEl = document.getElementById('kpiPnlTitle');
  const subEl = document.getElementById('kpiPnlSub');
  if (titleEl) titleEl.textContent = closedCount > 0 ? 'Closed PnL' : 'Open PnL';
  if (subEl) {
    subEl.textContent = closedCount > 0
      ? `Unrealized ${unreal >= 0 ? '+' : ''}${formatUSD(unreal)} still in open positions`
      : `Mark-to-market on ${p.openPositionsCount || 0} open position(s) · nothing closed yet`;
  }

  const perf = data.performance || {};
  const wr = perf.winRate != null ? perf.winRate : (data.aiMetrics.winRate || 0);
  document.getElementById('kpiWinRate').textContent = wr + '%';
  document.getElementById('kpiTradeCount').textContent =
    `${perf.wins || 0}W / ${perf.losses || 0}L · fees ${formatUSD(p.totalFeesPaid)}`;

  const ddEl = document.getElementById('kpiDrawdown');
  if (ddEl) {
    const dd = p.maxDrawdownPercent != null ? p.maxDrawdownPercent : (perf.maxDrawdownPercent || 0);
    ddEl.textContent = Number(dd).toFixed(2) + '%';
  }
  const pfEl = document.getElementById('kpiProfitFactor');
  if (pfEl) {
    const pf = perf.profitFactor;
    pfEl.textContent = (pf == null || pf === 0 && !(perf.trades)) ? 'Profit factor: —' : `Profit factor: ${Number(pf).toFixed(2)}`;
  }

  const modalBal = document.getElementById('modalFreeBalance');
  if (modalBal) modalBal.textContent = `${formatUSD(p.freeBalance)} USDT`;
}

function renderPerformance(data) {
  const status = document.getElementById('backtestStatus');
  const bt = data.lastBacktest;
  if (status) {
    if (data.backtestRunning || (bt && bt.running)) {
      status.textContent = 'Replaying stored 1m history (already downloaded at boot)…';
    } else if (bt && bt.ok === false) {
      status.textContent = 'Replay failed: ' + (bt.error || 'unknown error');
    } else if (bt && bt.trades != null) {
      const pf = bt.profitFactor == null ? 'n/a' : bt.profitFactor;
      const src = bt.source === 'stored-1m' ? 'from memory' : 'from exchange';
      const extra = bt.note ? ` · ${bt.note}` : '';
      status.textContent = `History replay ${src}: ${bt.trades} trades · ${bt.winRate}% WR · ${bt.netProfitPercent}% net · PF ${pf} · DD ${bt.maxDrawdownPercent}%${extra}`;
    }
  }

  if (!equityChartInstance) return;
  let curve = (bt && bt.ok && bt.equityCurve && bt.equityCurve.length > 1)
    ? bt.equityCurve
    : (data.performance && data.performance.equityCurve) || [];
  if (curve.length < 2 && data.portfolio) {
    curve = [
      { t: 'Start', equity: data.portfolio.initialBalance || 10000 },
      { t: 'Now', equity: data.portfolio.totalEquity || 10000 }
    ];
  }
  const labels = curve.map((p, i) => p.t ? (String(p.t).length > 12 ? new Date(p.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : p.t) : String(i));
  const values = curve.map(p => p.equity);
  equityChartInstance.data.labels = labels;
  equityChartInstance.data.datasets[0].data = values;
  equityChartInstance.data.datasets[0].label = (bt && bt.ok && bt.equityCurve && bt.equityCurve.length > 1) ? 'History replay equity' : 'Live session equity';
  equityChartInstance.options.scales.y.beginAtZero = false;
  equityChartInstance.update('none');
}

async function runBacktest() {
  const status = document.getElementById('backtestStatus');
  if (status) status.textContent = 'Replaying stored candles…';
  const res = await fetch('/api/backtest', { method: 'POST', headers: apiHeaders(true), body: JSON.stringify({ fiveMinBars: 400 }) });
  if (res.status === 401) return alert('Control token rejected.');
  if (res.status === 409) {
    if (status) status.textContent = 'A backtest is already running.';
    return;
  }
  if (!res.ok) {
    if (status) status.textContent = 'Could not start backtest.';
    return;
  }
  const poll = setInterval(async () => {
    const s = await fetch('/api/state');
    if (!s.ok) return;
    const data = await s.json();
    renderPerformance(data);
    if (!data.backtestRunning && data.lastBacktest && !data.lastBacktest.running) {
      clearInterval(poll);
    }
  }, 2000);
}

function renderCoinList(marketData, opportunities) {
  const container = document.getElementById('coinListContainer');
  container.innerHTML = '';

  const listToRender = (opportunities && opportunities.length > 0) ? opportunities : Object.values(marketData);

  for (const item of listToRender) {
    const sym = item.symbol;
    const mkt = marketData[sym] || item;
    const card = document.createElement('div');
    card.className = `coin-card ${sym === activeSymbol ? 'active' : ''}`;
    card.onclick = () => selectCoin(sym);

    const sig = mkt.analysis ? mkt.analysis.signal : (item.signal || 'HOLD');
    const conf = (mkt.analysis?.confidence ?? item.confidence ?? 50);
    const opp = (mkt.analysis?.opportunityScore ?? item.opportunityScore ?? 50);

    let tagClass = 'tag-hold';
    let label = `${sig} (${conf}%)`;

    if (mkt.isCooldown || item.isCooldown) {
      tagClass = 'tag-cooldown';
      label = `⏳ Cooldown (${mkt.cooldownRemainingSeconds || item.cooldownRemainingSeconds || 0}s)`;
    } else if (sig === 'BUY') {
      tagClass = 'tag-buy';
      label = `▲ LONG (${conf}%)`;
    } else if (sig === 'SHORT') {
      tagClass = 'tag-sell';
      label = `▼ SHORT (${conf}%)`;
    } else if (sig === 'CHOP_SKIP') {
      tagClass = 'tag-chop';
      label = `〰 Chop / Flat`;
    }

    card.innerHTML = `
      <div>
        <div class="coin-sym">${sym.replace('USDT', '')} <span style="font-size:10px; color:#8a99ad">/USDT</span></div>
        <div class="coin-price">$${formatPrice(mkt.price || item.price)}</div>
      </div>
      <div style="text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 4px;">
        <span class="signal-tag ${tagClass}">${label}</span>
        <span class="opp-badge">Score: ${opp}/100</span>
        <span class="opp-badge">${(mkt.analysis && mkt.analysis.fiveMin && mkt.analysis.fiveMin.side) ? ('5m→ ' + mkt.analysis.fiveMin.side) : (item.fiveMin && item.fiveMin.side ? ('5m→ ' + item.fiveMin.side) : '5m→ --')}</span>
      </div>
    `;
    container.appendChild(card);
  }
}

function selectCoin(symbol) {
  activeSymbol = symbol;
  fetchStateAndUpdate();
}

function renderActiveChart(coinData) {
  if (!coinData || !coinData.candles) return;

  document.getElementById('activeSymbolTitle').textContent = `${activeSymbol.replace('USDT', '')}/USDT`;
  document.getElementById('activeSymbolPrice').textContent = `$${formatPrice(coinData.price)}`;
  const priceTimeEl = document.getElementById('activeSymbolPriceTime');
  if (priceTimeEl) {
    const checkedAt = coinData.priceUpdatedAt || coinData.updatedAt;
    priceTimeEl.textContent = checkedAt
      ? `Last checked: ${formatDateTimeLine(checkedAt)}`
      : 'Last checked: --';
  }

  const sigEl = document.getElementById('activeSymbolSignal');
  const sig = coinData.analysis?.signal || 'HOLD';
  const conf = coinData.analysis?.confidence ?? 50;

  if (coinData.isCooldown) {
    sigEl.textContent = `⏳ IN COOLDOWN (${coinData.cooldownRemainingSeconds}s REMAINING)`;
    sigEl.className = 'signal-tag tag-cooldown';
    } else if (sig === 'BUY') {
    const strong = conf >= 60;
    sigEl.textContent = strong ? `▲ STRONG LONG (${conf}% CONFIDENCE)` : `▲ LONG (${conf}% CONFIDENCE)`;
    sigEl.className = 'signal-tag tag-buy';
  } else if (sig === 'SHORT') {
    const strong = conf >= 60;
    sigEl.textContent = strong ? `▼ STRONG SHORT (${conf}% CONFIDENCE)` : `▼ SHORT (${conf}% CONFIDENCE)`;
    sigEl.className = 'signal-tag tag-sell';
  } else if (sig === 'CHOP_SKIP') {
    sigEl.textContent = `〰 CHOPPY MARKET - SKIPPING`;
    sigEl.className = 'signal-tag tag-chop';
  } else {
    sigEl.textContent = `HOLD (${conf}% CONFIDENCE)`;
    sigEl.className = 'signal-tag tag-hold';
  }


  // Render Multi-Timeframe Trend Radar Badges
  if (coinData.analysis && coinData.analysis.mtf) {
    const m = coinData.analysis.mtf;
    const setTag = (id, label, val) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = `${label}: ${val}`;
      if (val === 'BULLISH' || val === 'BUY') el.className = 'badge tag-buy';
      else if (val === 'BEARISH' || val === 'SHORT') el.className = 'badge tag-sell';
      else el.className = 'badge tag-hold';
    };
    const opEl = document.getElementById('secondOpinionTag');
    if (opEl) {
      const op = coinData.analysis.secondOpinion;
      if (op && op.pBull != null) {
        opEl.textContent = `2nd: ${op.side} ${(op.pBull * 100).toFixed(0)}%`;
        if (op.side === 'LONG') opEl.className = 'badge tag-buy';
        else if (op.side === 'SHORT') opEl.className = 'badge tag-sell';
        else opEl.className = 'badge tag-hold';
      } else {
        opEl.textContent = '2nd: --';
        opEl.className = 'badge tag-hold';
      }
    }
    const rlEl = document.getElementById('rlPolicyTag');
    if (rlEl) {
      const r = coinData.analysis.rl;
      if (r && r.action) {
        rlEl.textContent = `RL: ${r.action} ${r.action === 'LONG' ? r.long : r.action === 'SHORT' ? r.short : r.hold}%`;
        if (r.action === 'LONG') rlEl.className = 'badge tag-buy';
        else if (r.action === 'SHORT') rlEl.className = 'badge tag-sell';
        else rlEl.className = 'badge tag-hold';
      } else {
        rlEl.textContent = 'RL: --';
        rlEl.className = 'badge tag-hold';
      }
    }
    const f5El = document.getElementById('fiveMinTag');
    const f5HitEl = document.getElementById('fiveMinHitTag');
    const f5 = coinData.analysis.fiveMin;
    if (f5El) {
      f5El.textContent = f5 && f5.side ? `5m next: ${f5.side}` : '5m next: --';
      if (f5 && f5.side === 'LONG') f5El.className = 'badge tag-buy';
      else if (f5 && f5.side === 'SHORT') f5El.className = 'badge tag-sell';
      else f5El.className = 'badge tag-hold';
    }
    if (f5HitEl) {
      if (f5 && f5.lastHit) {
        f5HitEl.textContent = `5m check: ${f5.lastHit} hit`;
        f5HitEl.className = f5.lastHit === 'LONG' ? 'badge tag-buy' : 'badge tag-sell';
      } else {
        f5HitEl.textContent = '5m check: waiting';
        f5HitEl.className = 'badge tag-hold';
      }
    }

    setTag('mtfTag1m', '1m', m['1m'] || sig);
    setTag('mtfTag5m', '5m', m['5m'] || '--');
    setTag('mtfTag1h', '1h', m['1h'] || '--');
    setTag('mtfTag4h', '4h', m['4h'] || '--');
  }

  const labels = coinData.candles.map(c => new Date(c.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  const closes = coinData.candles.map(c => c.close);
  
  // Calculate simple EMA line for chart
  const emaValues = [];
  let k = 2 / 10;
  let ema = closes[0];
  for (let i = 0; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    emaValues.push(ema);
  }

  // Update SMC Info Bar
  const a = coinData.analysis;
  const smc = a.smcStructure;
  if (smc) {
    const structEl = document.getElementById('smcStructureVal');
    const structPill = document.getElementById('smcStructurePill');
    if (structEl) {
      structEl.textContent = smc.structureState || '--';
      structPill.className = 'smc-pill ' +
        (['UPTREND','BULLISH_BOS','BULLISH_CHOCH'].includes(smc.structureState) ? 'smc-bullish' :
         ['DOWNTREND','BEARISH_BOS','BEARISH_CHOCH'].includes(smc.structureState) ? 'smc-bearish' : '');
    }

    // CHoCH pill
    const chochPill = document.getElementById('smcChochPill');
    const chochVal = document.getElementById('smcChochVal');
    if (smc.lastCHoCH && chochPill && chochVal) {
      chochPill.style.display = 'flex';
      chochVal.textContent = smc.lastCHoCH.type.replace('_CHOCH','');
      chochPill.className = 'smc-pill ' + (smc.lastCHoCH.type.includes('BULLISH') ? 'smc-bullish' : 'smc-bearish');
    } else if (chochPill) { chochPill.style.display = 'none'; }

    // BOS pill
    const bosPill = document.getElementById('smcBosPill');
    const bosVal = document.getElementById('smcBosVal');
    if (smc.lastBOS && bosPill && bosVal) {
      bosPill.style.display = 'flex';
      bosVal.textContent = smc.lastBOS.type.replace('_BOS','');
      bosPill.className = 'smc-pill ' + (smc.lastBOS.type.includes('BULLISH') ? 'smc-bullish' : 'smc-bearish');
    } else if (bosPill) { bosPill.style.display = 'none'; }
  }

  // PDH / PDL
  const pdhEl = document.getElementById('smcPDH');
  const pdlEl = document.getElementById('smcPDL');
  if (a.pdLevels && a.pdLevels.pdh && pdhEl) {
    pdhEl.textContent = '$' + formatPrice(a.pdLevels.pdh);
    pdhEl.style.color = a.pdLevels.isAbovePDH ? '#00e676' : '#ff9800';
  }
  if (a.pdLevels && a.pdLevels.pdl && pdlEl) {
    pdlEl.textContent = '$' + formatPrice(a.pdLevels.pdl);
    pdlEl.style.color = a.pdLevels.isBelowPDL ? '#ff5252' : '#ff9800';
  }

  // Session
  const sessionEl = document.getElementById('smcSession');
  if (sessionEl && a.sessionLevels) {
    const sColors = { TOKYO: '#00b0ff', LONDON: '#e040fb', NEW_YORK: '#ff9800', OFFHOURS: '#546e7a' };
    sessionEl.textContent = a.sessionLevels.currentSession || 'OFF';
    sessionEl.style.color = sColors[a.sessionLevels.currentSession] || '#8a99ad';
  }

  // CVD
  const cvdEl = document.getElementById('smcCVD');
  if (cvdEl && a.cvd) {
    const trend = a.cvd.deltaTrend;
    cvdEl.textContent = `${a.cvd.deltaTrend} (${a.cvd.buyPressure}%)`;
    cvdEl.style.color = trend === 'BUYING' ? '#00e676' : trend === 'SELLING' ? '#ff5252' : '#8a99ad';
  }

  // SAR Flip indicator
  const sarPill = document.getElementById('smcSarPill');
  if (sarPill) {
    if (coinData.sarFlip && (Date.now() - coinData.sarFlip.time) < 60000) {
      sarPill.style.display = 'flex';
    } else { sarPill.style.display = 'none'; }
  }

  chartInstance.data.labels = labels;
  chartInstance.data.datasets[0].data = closes;
  chartInstance.data.datasets[1].data = emaValues;
  chartInstance.update('none');
}

function renderAIBrain(aiMetrics, coinData, fiveMinForecast) {
  const w = aiMetrics.weights;
  const wins = aiMetrics.successfulTrades || 0;
  const total = aiMetrics.totalTradesLearned || 0;
  const losses = Math.max(0, total - wins);
  const nnLabel = aiMetrics.nnLiveLearning || !aiMetrics.nnFrozen
    ? 'Model A live-learning 1m closes'
    : (aiMetrics.nnReady
      ? 'NN in score (persisted)'
      : `NN off (${total}/${aiMetrics.minTradesForNn || 20} samples)`);
  const cw = aiMetrics.confirmWeights || {};
  const confirmBits = ['ADX', 'SMC', 'B', 'RL', '5mF', 'FUND', 'LSR', 'FNG', 'BTC']
    .map(k => `${k} ${(Number(cw[k]) || 1).toFixed(2)}`)
    .join(' · ');
  document.getElementById('modelExperienceBadge').textContent = `${wins}W / ${losses}L · ${nnLabel} · confirms ${confirmBits}`;
  const nnName = document.getElementById('w-nn-name');
  if (nnName) {
    nnName.textContent = aiMetrics.nnReady || aiMetrics.nnLiveLearning
      ? 'Neural net A (1m live-learn, year file kept)'
      : `Neural net (off until ${aiMetrics.minTradesForNn || 20} samples)`;
  }


  const setW = (id, val) => {
    const valEl = document.getElementById(`w-${id}-val`);
    const barEl = document.getElementById(`w-${id}`);
    if (valEl && barEl) {
      valEl.textContent = (val || 0).toFixed(2);
      barEl.style.width = `${Math.min(100, ((val || 0) / 3.0) * 100)}%`;
    }
  };

  setW('nn',   w.neuralNetPredictor  || 1.45);
  setW('smc',  w.smcStructure        || 1.60);
  setW('macd', w.macdMomentum        || 1.25);
  setW('kl',   w.keyLevels           || 1.30);
  setW('ema',  w.emaTrend            || 1.20);
  setW('adx',  w.adxTrendStrength    || 1.10);
  setW('rsi',  w.rsiMomentum         || 1.05);
  setW('cvd',  w.cvdPressure         || 0.95);
  setW('bb',   w.bollingerBreakout   || 0.90);

  if (coinData && coinData.analysis) {
    const a = coinData.analysis;
    const adxText = a.adx ? ` | ADX: ${a.adx.adx.toFixed(1)} (${a.adx.isTrending ? 'Trending' : 'Chop'})` : '';
    const rsiText = a.rsi ? ` | RSI: ${a.rsi.toFixed(1)}` : '';
    const smcText = (a.smcStructure && a.smcStructure.smcSignal !== 'NEUTRAL') ? ` | SMC: ${a.smcStructure.smcSignal}` : '';
    const mtfText = (a.mtf && !a.mtf.isConfirmed && a.mtf.mtfRejectionReason) ? ` | ⚠️ [${a.mtf.mtfRejectionReason}]` : '';
    const saw = a.entrySight && a.entrySight.summary ? ` | saw ${a.entrySight.summary}` : '';
    const f5 = a.fiveMin
      ? ` | 5m forecast ${a.fiveMin.side || 'HOLD'}${a.fiveMin.lastHit ? ` (last 5m ${a.fiveMin.lastHit} hit)` : ''} (${Math.round((a.fiveMin.accuracy || 0) * 100)}% 5m skill)`
      : '';
    document.getElementById('signalReasonText').textContent = `${a.reasons}${adxText}${rsiText}${smcText}${mtfText}${saw}${f5}`;
  }
}

function renderFiveMinForecast(book, coinData) {
  const skill = document.getElementById('fiveMinSkillBadge');
  const nowLine = document.getElementById('fiveMinNowLine');
  const tbody = document.getElementById('fiveMinTableBody');
  if (!skill || !tbody) return;
  const hits = (book && book.hits) || 0;
  const misses = (book && book.misses) || 0;
  const acc = book && book.accuracy != null ? Math.round(book.accuracy * 100) : 0;
  skill.textContent = `5m skill: ${hits} hit / ${misses} miss · ${acc}%`;
  const f = coinData && coinData.analysis && coinData.analysis.fiveMin;
  if (nowLine) {
    if (!f) {
      nowLine.textContent = 'Restart once if this stays empty. Then wait ~5 minutes for the first check.';
    } else {
      const next = f.side || 'HOLD';
      const last = f.lastHit ? `Last 5m check was right: ${f.lastHit}.` : 'Last 5m check not in yet (needs ~5 minutes).';
      nowLine.textContent = `${(coinData.symbol || activeSymbol)} next 5m call: ${next}. ${last} After 5m it compares to the real 1m close.`;
    }
  }
  const rows = (book && book.recent) || [];
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Waiting for the first 5-minute check…</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r) => {
    const when = r.t ? new Date(r.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--';
    const result = r.hit ? 'HIT' : 'MISS';
    const color = r.hit ? 'text-success' : 'text-danger';
    const move = (r.pct >= 0 ? '+' : '') + Number(r.pct || 0).toFixed(3) + '%';
    return `<tr>
      <td>${when}</td>
      <td><strong>${r.s || '--'}</strong></td>
      <td>${r.side || '--'}</td>
      <td class="${color}"><strong>${result}</strong></td>
      <td>${move}</td>
    </tr>`;
  }).join('');
}

function renderMarketContext(ctx, coinData) {
  const el = document.getElementById('marketContextLine');
  if (!el) return;
  if (!ctx) {
    el.textContent = 'Context APIs: waiting…';
    return;
  }
  const btc = ctx.btcRegime;
  const fng = ctx.fearGreed;
  const sym = (coinData && coinData.symbol) || activeSymbol;
  const fund = (ctx.funding && (ctx.funding[sym] || ctx.funding.BTCUSDT)) || null;
  const ls = (ctx.longShort && (ctx.longShort[sym] || ctx.longShort.BTCUSDT)) || null;
  const votes = (coinData && coinData.analysis && coinData.analysis.marketContext && coinData.analysis.marketContext.votes) || null;
  const bits = [
    btc ? `BTC ${btc.side || 'HOLD'} (15m ${btc.ret15m ?? '--'}% / 1h ${btc.ret1h ?? '--'}%)` : 'BTC --',
    fng ? `F&G ${fng.value} ${fng.classification || ''}` : 'F&G --',
    fund ? `fund ${fund.ratePct}%` : 'fund --',
    ls ? `L/S ${(ls.longRatio * 100).toFixed(0)}/${((ls.shortRatio || 0) * 100).toFixed(0)}` : 'L/S --'
  ];
  if (votes) {
    bits.push(`votes FUND=${votes.FUND} LSR=${votes.LSR} FNG=${votes.FNG} BTC=${votes.BTC}`);
  }
  el.textContent = `Context: ${bits.join(' · ')}`;
}

function renderPositions(positions, marketData) {
  const tbody = document.getElementById('positionsTableBody');
  if (!positions || positions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="12" class="empty-state">No open positions. AI is scanning for high-confidence entries...</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  positions.forEach(pos => {
    const market = marketData[pos.symbol];
    const currentPrice = market ? market.price : pos.entryPrice;
    const pnl = pos.unrealizedPnL || 0;
    const pnlPct = pos.unrealizedPnLPercent || 0;
    const isProfit = pnl >= 0;
    const isShort = pos.side === 'SHORT';
    const openTime = formatDateTime(pos.entryTime);

    const row = document.createElement('tr');
    row.innerHTML = `
      <td><span style="color:#00f2fe">${pos.id}</span></td>
      <td><span style="font-size:12px; color:#8a99ad; font-family:var(--font-mono)">${openTime}</span></td>
      <td><strong>${pos.symbol}</strong></td>
      <td>
        <span class="badge ${isShort ? 'badge-short' : 'badge-long'}">
          ${isShort ? '▼ SHORT' : '▲ LONG'}
        </span>
      </td>
      <td><span style="font-size:11px; color:#69f0ae">${pos.whoAgreed || (pos.entrySight && (pos.entrySight.confirms && pos.entrySight.confirms.join('+'))) || (pos.entrySight && pos.entrySight.summary) || '--'}</span></td>
      <td>$${formatPrice(pos.entryPrice)}</td>
      <td>
        <strong>$${formatPrice(currentPrice)}</strong>
        <div style="font-size:11px; color:#8a99ad; font-family:var(--font-mono)">${formatDateTime(market && (market.priceUpdatedAt || market.updatedAt))}</div>
      </td>
      <td style="color:${pos.trailingActivated ? '#00e676' : '#ffb300'}">
        ${(pos.slPnlPercent ?? -0.8).toFixed(2)}% of position${pos.trailingActivated ? ' 🟢 trail' : ''}
      </td>
      <td style="color:#00f2fe">${(pos.tpPnlPercent ?? 1.6) >= 0 ? '+' : ''}${(pos.tpPnlPercent ?? 1.6).toFixed(2)}% of position</td>
      <td>$${formatPrice(pos.investedUSDT)}</td>
      <td class="${isProfit ? 'text-success' : 'text-danger'}">
        ${isProfit ? '+' : ''}$${pnl.toFixed(2)} (${isProfit ? '+' : ''}${pnlPct.toFixed(2)}%)
      </td>
      <td>
        <button class="btn btn-sm btn-danger-outline" onclick="manualClose('${pos.id}')">Close</button>
      </td>
    `;
    tbody.appendChild(row);
  });
}

function renderHistory(history, savedCount) {
  const tbody = document.getElementById('historyTableBody');
  const title = document.getElementById('historyTitle');
  const n = (history && history.length) || 0;
  if (title) title.textContent = `📜 Closed Trades — all saved (${savedCount || n}) · 0.1% fee deducted`;
  if (!history || history.length === 0) {
    tbody.innerHTML = '<tr><td colspan="13" class="empty-state">No closed trades yet.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  history.forEach(trade => {
    const isWin = trade.netProfit > 0;
    const isShort = trade.side === 'SHORT';
    const openTime = formatDateTime(trade.entryTime);
    const closeTime = formatDateTime(trade.exitTime);
    const invested = trade.investedUSDT != null ? formatPrice(trade.investedUSDT) : '--';
    const fees = Number(trade.totalFees || 0);

    const row = document.createElement('tr');
    row.innerHTML = `
      <td><span style="font-size:12px; color:#8a99ad; font-family:var(--font-mono)">${openTime}</span></td>
      <td><span style="font-size:12px; color:#00f2fe; font-family:var(--font-mono)">${closeTime}</span></td>
      <td><strong>${trade.symbol}</strong></td>
      <td>
        <span class="badge ${isShort ? 'badge-short' : 'badge-long'}">
          ${isShort ? 'SHORT' : 'LONG'}
        </span>
      </td>
      <td>$${formatPrice(trade.entryPrice)}</td>
      <td>$${formatPrice(trade.exitPrice)}</td>
      <td>$${invested}</td>
      <td class="text-warning">$${fees.toFixed(3)}</td>
      <td class="${isWin ? 'text-success' : 'text-danger'}">
        <strong>${isWin ? '+' : ''}$${Number(trade.netProfit || 0).toFixed(2)} (${isWin ? '+' : ''}${Number(trade.profitPercent || 0).toFixed(2)}%)</strong>
      </td>
      <td><span style="font-size:11px; color:#8a99ad">${trade.exitReason || '--'}</span></td>
      <td><span style="font-size:11px; color:#ffb300">${trade.breakDown || trade.exitReason || '--'}</span></td>
      <td><span style="font-size:11px; color:#69f0ae">${trade.whoAgreed || (trade.entrySight && (trade.entrySight.confirms && trade.entrySight.confirms.join('+'))) || (trade.entrySight && trade.entrySight.summary) || '--'}</span></td>
      <td>
        <span class="badge ${isWin ? 'tag-buy' : 'tag-sell'}">
          ${isWin ? 'Rules +weight' : 'Rules −weight'}
        </span>
      </td>
    `;
    tbody.appendChild(row);
  });
}


// Settings Modal Controls
function setFieldValue(id, value) {
  const el = document.getElementById(id);
  if (!el || value == null) return;
  if (el.type === 'checkbox') el.checked = !!value;
  else el.value = value;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function toggleSizingModeUI() {
  const sel = document.getElementById('settingSizingMode');
  if (!sel) return;
  const mode = sel.value;
  const rowPct = document.getElementById('rowSizingPercent');
  const rowFix = document.getElementById('rowSizingFixedUSD');
  if (mode === 'FIXED_USD') {
    if (rowPct) rowPct.style.display = 'none';
    if (rowFix) rowFix.style.display = 'block';
  } else {
    if (rowPct) rowPct.style.display = 'block';
    if (rowFix) rowFix.style.display = 'none';
  }
}

function toggleRiskModeUI() {
  const sel = document.getElementById('settingRiskMode');
  if (!sel) return;
  const mode = sel.value;
  const rowPct = document.getElementById('rowRiskPercent');
  const rowFix = document.getElementById('rowRiskFixedUSD');
  if (mode === 'FIXED_USD') {
    if (rowPct) rowPct.style.display = 'none';
    if (rowFix) rowFix.style.display = 'block';
  } else {
    if (rowPct) rowPct.style.display = 'block';
    if (rowFix) rowFix.style.display = 'none';
  }
}

function fillSettingsModalForm(settingsObj) {
  const s = settingsObj || currentSettings;
  if (!s) return;
  try {
    const sizingMode = s.sizingMode || 'PERCENT';
    setFieldValue('settingSizingMode', sizingMode);
    const allocVal = Math.round((s.allocationPercent || 0.15) * 100);
    setFieldValue('settingAllocPercent', allocVal);
    setText('allocVal', allocVal + '%');
    setFieldValue('settingFixedTradeAmountUSD', s.fixedTradeAmountUSD || 10);
    toggleSizingModeUI();

    const riskMode = s.riskMode || 'PERCENT';
    setFieldValue('settingRiskMode', riskMode);
    const maxRiskVal = ((s.maxRiskPerTradePercent || 0.02) * 100).toFixed(1);
    setFieldValue('settingMaxRiskPercent', maxRiskVal);
    setText('maxRiskVal', maxRiskVal + '%');
    setFieldValue('settingFixedRiskUSD', s.fixedRiskUSD || 1.0);
    toggleRiskModeUI();

    setFieldValue('settingMaxPositions', s.maxPositions || 25);
    setText('maxPosVal', String(s.maxPositions || 25));
    setFieldValue('settingMinConfidence', s.minConfidence || 50);
    setText('confVal', (s.minConfidence || 50) + '%');
    setFieldValue('settingMinOpportunity', s.minOpportunityScore || 55);
    setText('oppVal', String(s.minOpportunityScore || 55));
    const stopPct = s.positionStopPercent || 0.8;
    const tpPct = s.positionTpPercent || 1.6;
    setFieldValue('settingPositionStopPercent', stopPct);
    setText('slVal', '-' + stopPct + '%');
    setFieldValue('settingPositionTpPercent', tpPct);
    setText('tpVal', '+' + tpPct + '%');
    setFieldValue('settingMtfStrictness', s.mtfStrictness || '5m_15m_1h');
    setFieldValue('settingChopCooldown', s.chopCooldownMins || 5);
    setText('chopCdVal', (s.chopCooldownMins || 5) + ' mins');
    setFieldValue('settingSlCooldown', s.slCooldownMins || 10);
    setText('slCdVal', (s.slCooldownMins || 10) + ' mins');

    const sarEl = document.getElementById('settingStopAndReverse');
    if (sarEl) sarEl.checked = !!s.stopAndReverse;
    const smcEl = document.getElementById('settingSmcEnabled');
    if (smcEl) smcEl.checked = s.smcEnabled !== false;
    const pdhEl = document.getElementById('settingUsePDHPDL');
    if (pdhEl) pdhEl.checked = s.usePDHPDL !== false;
    const sessEl = document.getElementById('settingUseSessionLevels');
    if (sessEl) sessEl.checked = s.useSessionLevels !== false;
    const qEl = document.getElementById('settingQualityMode');
    if (qEl) qEl.checked = s.qualityMode !== false;
    const liqEl = document.getElementById('settingTradeLiquidHours');
    if (liqEl) liqEl.checked = !!s.tradeLiquidHoursOnly;

    setFieldValue('settingControlToken', controlToken || '');
    const liveBox = document.getElementById('liveBalanceHint');
    if (liveBox && runtimeInfo) {
      liveBox.style.display = runtimeInfo.mode === 'live' ? 'block' : 'none';
    }
  } catch (err) {
    console.error('[UI] settings fill failed:', err);
  }
}

function openSettingsModal(e) {
  if (e && typeof e.preventDefault === 'function') {
    e.preventDefault();
  }
  const modal = document.getElementById('settingsModal');
  if (!modal) {
    console.error('[UI] settingsModal missing from page');
    return;
  }
  if (modal.classList.contains('open')) {
    return;
  }

  // Display modal immediately
  modal.style.display = 'flex';
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');

  // Reset scroll position to top
  const bodyEl = modal.querySelector('.modal-body');
  if (bodyEl) {
    bodyEl.scrollTop = 0;
  }

  // Populate settings form
  if (currentSettings) {
    fillSettingsModalForm(currentSettings);
  } else {
    // Fetch directly from server so form is never blank
    fetch('/api/settings')
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (data) {
          currentSettings = data;
          fillSettingsModalForm(data);
        }
      })
      .catch(err => console.warn('[UI] settings fallback fetch failed:', err));
  }
}

function closeSettingsModal(e) {
  if (e && typeof e.preventDefault === 'function') {
    e.preventDefault();
  }
  const modal = document.getElementById('settingsModal');
  if (modal) {
    modal.classList.remove('open');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
  }
  document.body.classList.remove('modal-open');
  // Immediately refresh dashboard now that modal is closed
  fetchStateAndUpdate();
}

async function saveSettingsFromModal() {
  const getBool = (id, def = true) => {
    const el = document.getElementById(id);
    return el ? el.checked : def;
  };

  const sizingMode = document.getElementById('settingSizingMode')?.value || 'PERCENT';
  const riskMode = document.getElementById('settingRiskMode')?.value || 'PERCENT';
  const fixTradeUSD = parseFloat(document.getElementById('settingFixedTradeAmountUSD')?.value || 10);
  const fixRiskUSD = parseFloat(document.getElementById('settingFixedRiskUSD')?.value || 1.0);
  const riskEl = document.getElementById('settingMaxRiskPercent');
  const maxRiskPercent = riskEl ? parseFloat(riskEl.value) / 100 : 0.02;

  const payload = {
    sizingMode:             sizingMode,
    allocationPercent:      parseFloat(document.getElementById('settingAllocPercent')?.value || 15) / 100,
    fixedTradeAmountUSD:    fixTradeUSD,
    riskMode:               riskMode,
    maxRiskPerTradePercent: maxRiskPercent,
    fixedRiskUSD:           fixRiskUSD,
    maxPositions:           parseInt(document.getElementById('settingMaxPositions')?.value || 5, 10),
    minConfidence:          parseInt(document.getElementById('settingMinConfidence')?.value || 55, 10),
    minOpportunityScore:    parseInt(document.getElementById('settingMinOpportunity')?.value || 58, 10),
    slMode:                 'POSITION',
    positionStopPercent:    parseFloat(document.getElementById('settingPositionStopPercent')?.value || 0.8),
    positionTpPercent:      parseFloat(document.getElementById('settingPositionTpPercent')?.value || 1.6),
    mtfStrictness:          document.getElementById('settingMtfStrictness')?.value || '5m_15m_1h',
    chopCooldownMins:       parseInt(document.getElementById('settingChopCooldown')?.value || 3, 10),
    slCooldownMins:         parseInt(document.getElementById('settingSlCooldown')?.value || 12, 10),
    stopAndReverse:         getBool('settingStopAndReverse', false),
    smcEnabled:             getBool('settingSmcEnabled'),
    usePDHPDL:              getBool('settingUsePDHPDL'),
    useSessionLevels:       getBool('settingUseSessionLevels'),
    qualityMode:            getBool('settingQualityMode'),
    tradeLiquidHoursOnly:   getBool('settingTradeLiquidHours', false)
  };



  const tokenEl = document.getElementById('settingControlToken');
  if (tokenEl) {
    controlToken = tokenEl.value.trim();
    localStorage.setItem('autotread_control_token', controlToken);
  }

  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: apiHeaders(true),
    body: JSON.stringify(payload)
  });

  if (res.status === 401) {
    alert('Control token rejected. Set it in Settings to match CONTROL_TOKEN in .env');
    return;
  }

  if (res.ok) {
    const data = await res.json();
    currentSettings = data.settings;
    closeSettingsModal();
    fetchStateAndUpdate();
  }
}

async function setCustomBalance() {
  if (runtimeInfo && runtimeInfo.mode === 'live') {
    return alert('Balance reset is disabled in live mode. Equity comes from Binance.');
  }
  const balance = parseFloat(document.getElementById('customBalanceInput').value);
  if (!balance || balance <= 0) return alert('Please enter a valid balance amount');

  const res = await fetch('/api/bot/reset', {
    method: 'POST',
    headers: apiHeaders(true),
    body: JSON.stringify({ balance })
  });
  if (res.status === 401) return alert('Control token rejected.');
  fetchStateAndUpdate();
}

async function toggleBot() {
  const res = await fetch('/api/bot/toggle', { method: 'POST', headers: apiHeaders() });
  if (res.status === 401) return alert('Control token rejected. Open Settings and paste CONTROL_TOKEN.');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return alert(data.error || 'Toggle failed');
  fetchStateAndUpdate();
}

async function resetDemo() {
  if (runtimeInfo && runtimeInfo.mode === 'live') {
    return alert('Reset is disabled in live mode.');
  }
  if (confirm('Reset simulated demo balance back to $10,000 USDT?')) {
    const res = await fetch('/api/bot/reset', { method: 'POST', headers: apiHeaders(true), body: JSON.stringify({}) });
    if (res.status === 401) return alert('Control token rejected.');
    fetchStateAndUpdate();
  }
}

async function triggerManualOrder(side = 'LONG') {
  const res = await fetch('/api/trade/manual-buy', {
    method: 'POST',
    headers: apiHeaders(true),
    body: JSON.stringify({ symbol: activeSymbol, side })
  });
  if (res.status === 401) return alert('Control token rejected.');
  const data = await res.json().catch(() => ({}));
  if (!data.success) alert(data.error || data.reason || 'Order failed');
  fetchStateAndUpdate();
}

async function manualClose(positionId) {
  const res = await fetch('/api/trade/close', {
    method: 'POST',
    headers: apiHeaders(true),
    body: JSON.stringify({ positionId })
  });
  if (res.status === 401) return alert('Control token rejected.');
  fetchStateAndUpdate();
}

window.openSettingsModal = openSettingsModal;
window.closeSettingsModal = closeSettingsModal;
window.saveSettingsFromModal = saveSettingsFromModal;
window.toggleSizingModeUI = toggleSizingModeUI;
window.toggleRiskModeUI = toggleRiskModeUI;
window.setCustomBalance = setCustomBalance;
window.toggleBot = toggleBot;
window.resetDemo = resetDemo;
window.triggerManualOrder = triggerManualOrder;
window.manualClose = manualClose;

// Boot UI
function initDashboardUI() {
  try {
    if (typeof Chart !== 'undefined') {
      initChart();
      initEquityChart();
    } else {
      console.warn('[UI] Chart.js not loaded — charts disabled, settings still work');
    }
  } catch (err) {
    console.error('[UI] chart init failed:', err);
  }

  const modal = document.getElementById('settingsModal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      // Close only if user clicked on the backdrop overlay itself
      if (e.target === modal) {
        closeSettingsModal(e);
      }
    });

    // Forward wheel scrolling anywhere on the modal or over inputs to .modal-body
    const bodyEl = modal.querySelector('.modal-body');
    if (bodyEl) {
      modal.addEventListener('wheel', (e) => {
        if (!e.target.closest('.modal-body')) {
          bodyEl.scrollTop += e.deltaY;
          e.preventDefault();
        }
      }, { passive: false });

      modal.querySelectorAll('input[type="range"]').forEach((slider) => {
        slider.addEventListener('wheel', (e) => {
          bodyEl.scrollTop += e.deltaY;
          e.preventDefault();
        }, { passive: false });
      });
    }
  }

  // Allow closing modal with Escape key
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const m = document.getElementById('settingsModal');
      if (m && (m.classList.contains('open') || m.style.display === 'flex')) {
        closeSettingsModal();
      }
    }
  });

  fetchStateAndUpdate();
  setInterval(fetchStateAndUpdate, 3000);
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initDashboardUI);
} else {
  initDashboardUI();
}

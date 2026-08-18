let activeSymbol = 'BTCUSDT';
let chartInstance = null;

// Initialize Chart
function initChart() {
  const ctx = document.getElementById('marketChart').getContext('2d');
  chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: '5m Price (USDT)',
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

// Format numbers
const formatUSD = (val) => '$' + Number(val || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatPrice = (val) => Number(val || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: (val < 1 ? 4 : 2) });

// Poll data and update UI
async function fetchStateAndUpdate() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) return;
    const data = await res.json();

    renderTopbarAndKPIs(data);
    renderCoinList(data.marketData);
    renderActiveChart(data.marketData[activeSymbol]);
    renderAIBrain(data.aiMetrics, data.marketData[activeSymbol]);
    renderPositions(data.positions, data.marketData);
    renderHistory(data.tradeHistory);
  } catch (err) {
    console.error('Fetch state error:', err);
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
  const sign = p.totalNetProfit >= 0 ? '+' : '';
  netProfitEl.textContent = `${sign}${formatUSD(p.totalNetProfit)} (${sign}${p.totalNetProfitPercent.toFixed(2)}%)`;
  netProfitEl.className = `kpi-val ${p.totalNetProfit >= 0 ? 'text-success' : 'text-danger'}`;

  const lossText = data.aiMetrics.nnLoss ? data.aiMetrics.nnLoss.toFixed(4) : '0.25';
  document.getElementById('kpiWinRate').innerHTML = `${data.aiMetrics.winRate}% <span style="font-size:12px; color:#8a99ad">(NN Loss: ${lossText})</span>`;
  document.getElementById('kpiTradeCount').textContent = `${data.aiMetrics.totalTradesLearned} completed trades`;
  document.getElementById('kpiFees').textContent = formatUSD(p.totalFeesPaid);
}

function renderCoinList(marketData) {
  const container = document.getElementById('coinListContainer');
  container.innerHTML = '';

  for (const [sym, item] of Object.entries(marketData)) {
    const card = document.createElement('div');
    card.className = `coin-card ${sym === activeSymbol ? 'active' : ''}`;
    card.onclick = () => selectCoin(sym);

    const sig = item.analysis.signal;
    let tagClass = 'tag-hold';
    if (sig === 'BUY') tagClass = 'tag-buy';
    if (sig === 'SELL_SIGNAL') tagClass = 'tag-sell';

    card.innerHTML = `
      <div>
        <div class="coin-sym">${sym.replace('USDT', '')} <span style="font-size:10px; color:#8a99ad">/USDT</span></div>
        <div class="coin-price">$${formatPrice(item.price)}</div>
      </div>
      <div style="text-align: right">
        <span class="signal-tag ${tagClass}">${sig} (${item.analysis.confidence}%)</span>
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

  const sigEl = document.getElementById('activeSymbolSignal');
  const sig = coinData.analysis.signal;
  sigEl.textContent = `${sig} (${coinData.analysis.confidence}% CONFIDENCE)`;
  sigEl.className = `signal-tag ${sig === 'BUY' ? 'tag-buy' : sig === 'SELL_SIGNAL' ? 'tag-sell' : 'tag-hold'}`;

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

  chartInstance.data.labels = labels;
  chartInstance.data.datasets[0].data = closes;
  chartInstance.data.datasets[1].data = emaValues;
  chartInstance.update('none');
}

function renderAIBrain(aiMetrics, coinData) {
  const w = aiMetrics.weights;
  document.getElementById('modelExperienceBadge').textContent = `Learned Trades: ${aiMetrics.totalTradesLearned}`;

  const setW = (id, val) => {
    const valEl = document.getElementById(`w-${id}-val`);
    const barEl = document.getElementById(`w-${id}`);
    if (valEl && barEl) {
      valEl.textContent = (val || 0).toFixed(2);
      barEl.style.width = `${Math.min(100, ((val || 0) / 3.0) * 100)}%`;
    }
  };

  setW('nn', w.neuralNetPredictor || 1.40);
  setW('ema', w.emaTrend);
  setW('rsi', w.rsiMomentum);
  setW('bb', w.bollingerBreakout);

  if (coinData && coinData.analysis) {
    document.getElementById('signalReasonText').textContent = coinData.analysis.reasons;
  }
}

function renderPositions(positions, marketData) {
  const tbody = document.getElementById('positionsTableBody');
  if (!positions || positions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">No active positions. AI scanning for optimal setup...</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  positions.forEach(pos => {
    const market = marketData[pos.symbol];
    const currentPrice = market ? market.price : pos.entryPrice;
    const pnl = pos.unrealizedPnL || 0;
    const pnlPct = pos.unrealizedPnLPercent || 0;
    const isProfit = pnl >= 0;

    const row = document.createElement('tr');
    row.innerHTML = `
      <td><span style="color:#00f2fe">${pos.id}</span></td>
      <td><strong>${pos.symbol}</strong></td>
      <td>$${formatPrice(pos.entryPrice)}</td>
      <td><strong>$${formatPrice(currentPrice)}</strong></td>
      <td style="color:${pos.trailingActivated ? '#00e676' : '#ffb300'}">
        $${formatPrice(pos.stopLoss)} ${pos.trailingActivated ? '🟢 (Trailing)' : ''}
      </td>
      <td style="color:#00f2fe">$${formatPrice(pos.takeProfit)}</td>
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

function renderHistory(history) {
  const tbody = document.getElementById('historyTableBody');
  if (!history || history.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No closed trades yet.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  history.forEach(trade => {
    const isWin = trade.netProfit > 0;
    const time = new Date(trade.exitTime).toLocaleTimeString();

    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${time}</td>
      <td><strong>${trade.symbol}</strong></td>
      <td>$${formatPrice(trade.entryPrice)}</td>
      <td>$${formatPrice(trade.exitPrice)}</td>
      <td class="text-warning">$${trade.totalFees.toFixed(3)}</td>
      <td class="${isWin ? 'text-success' : 'text-danger'}">
        <strong>${isWin ? '+' : ''}$${trade.netProfit.toFixed(2)} (${isWin ? '+' : ''}${trade.profitPercent.toFixed(2)}%)</strong>
      </td>
      <td><span style="font-size:11px; color:#8a99ad">${trade.exitReason}</span></td>
      <td>
        <span class="badge ${isWin ? 'tag-buy' : 'tag-sell'}">
          ${isWin ? 'Reinforced (+Weight)' : 'Penalized (-Weight)'}
        </span>
      </td>
    `;
    tbody.appendChild(row);
  });
}

// User Actions
async function toggleBot() {
  await fetch('/api/bot/toggle', { method: 'POST' });
  fetchStateAndUpdate();
}

async function resetDemo() {
  if (confirm('Reset simulated demo balance back to $10,000 USDT?')) {
    await fetch('/api/bot/reset', { method: 'POST' });
    fetchStateAndUpdate();
  }
}

async function triggerManualBuy() {
  await fetch('/api/trade/manual-buy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: activeSymbol })
  });
  fetchStateAndUpdate();
}

async function manualClose(positionId) {
  await fetch('/api/trade/close', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ positionId })
  });
  fetchStateAndUpdate();
}

// Boot UI
window.addEventListener('DOMContentLoaded', () => {
  initChart();
  fetchStateAndUpdate();
  setInterval(fetchStateAndUpdate, 3000); // 3-second live refresh
});

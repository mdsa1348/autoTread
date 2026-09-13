const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { AIBrain } = require('./ai_engine');
const { PaperBroker } = require('./paper_broker');
const { LiveBroker } = require('./live_broker');
const exchange = require('./exchange');
const { runBacktest, summarize, aggregate } = require('./backtest');

const app = express();
const server = http.createServer(app);
const { DATA_FILE, DATA_BACKUP_FILE, MINUTE_LOG_FILE } = require('./paths');
const { FiveMinBook } = require('./five_min_forecast');
const marketContext = require('./market_context');
const {
  MinuteBook,
  slimClosedForDisk,
  slimOpenForDisk,
  buildEntrySight,
  MIN_ATR_PCT
} = require('./analysis_log');
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    mode: exchange.TRADING_MODE,
    uptimeSec: Math.round(process.uptime())
  });
});

const WATCHED_COINS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'SUIUSDT', 'LINKUSDT',
  'NEARUSDT', 'PEPEUSDT', 'SHIBUSDT', 'DOTUSDT', 'LTCUSDT',
  'APTUSDT', 'ARBUSDT', 'OPUSDT', 'INJUSDT', 'TIAUSDT',
  'RENDERUSDT', 'FETUSDT', 'AAVEUSDT', 'POLUSDT', 'TONUSDT',
  'TRXUSDT', 'WLDUSDT', 'UNIUSDT', 'ATOMUSDT', 'FILUSDT',
  'BCHUSDT', 'ETCUSDT', 'XLMUSDT', 'ALGOUSDT', 'VETUSDT',
  'HBARUSDT', 'SEIUSDT', 'CRVUSDT', 'LDOUSDT', 'ENAUSDT',
  'ONDOUSDT', 'TAOUSDT', 'GALAUSDT', 'SANDUSDT', 'MANAUSDT',
  'IMXUSDT', 'STXUSDT', 'ENSUSDT', 'RUNEUSDT', 'ORDIUSDT',
  'WIFUSDT', 'BONKUSDT', 'FLOKIUSDT', 'JUPUSDT', 'STRKUSDT',
  'ZKUSDT', 'PYTHUSDT'
];

const DEFAULT_SETTINGS = {
  sizingMode: 'PERCENT',
  allocationPercent: 0.08,
  fixedTradeAmountUSD: 10.0,
  riskMode: 'PERCENT',
  maxRiskPerTradePercent: 0.01,
  fixedRiskUSD: 1.0,
  maxPositions: 25,
  minConfidence: 55,
  minOpportunityScore: 58,
  slMultiplier: 1.8,
  tpMultiplier: 3.0,
  slMode: 'POSITION',
  positionStopPercent: 0.8,
  positionTpPercent: 1.6,
  mtfStrictness: '5m_1h',
  chopCooldownMins: 3,
  slCooldownMins: 8,
  stopAndReverse: false,
  usePDHPDL: true,
  useSessionLevels: true,
  smcEnabled: true,
  qualityMode: true,
  tradeLiquidHoursOnly: false,
  maxSameDirection: 15,
  maxDailyLossPercent: 3
};

const cooldownMap = {};
const mtfKlinesCache = {};
const pendingFlips = {};
const klineStore1m = {};

function tryParseJsonFile(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Error loading ${path.basename(file)}:`, e.message);
    return null;
  }
}

function quarantineCorrupt(file) {
  if (!file || !fs.existsSync(file)) return;
  const dest = String(file).replace(/\.json$/i, `.corrupt-${Date.now()}.json`);
  try {
    fs.copyFileSync(file, dest);
    console.error(`[BOOT] Quarantined unreadable ${path.basename(file)} → ${path.basename(dest)}`);
  } catch (e) {
    console.error('[BOOT] Could not quarantine corrupt store:', e.message);
  }
}

function restoreHistoryIfEmpty(saved, backup) {
  const liveHist = saved?.broker?.tradeHistory || [];
  const bakHist = backup?.broker?.tradeHistory || [];
  if (liveHist.length || !bakHist.length) return saved;
  if (saved?.ai?.totalTradesLearned) return saved;

  const next = {
    ...saved,
    broker: { ...(saved.broker || {}) },
    ai: backup.ai ? { ...backup.ai } : (saved.ai || null)
  };
  next.broker.tradeHistory = bakHist;
  next.broker.tradeCounter = Math.max(next.broker.tradeCounter || 0, backup.broker?.tradeCounter || 0);
  next.broker.totalFeesPaid = (next.broker.totalFeesPaid || 0) + (backup.broker?.totalFeesPaid || 0);
  console.log(`[BOOT] Restored ${bakHist.length} closed trades from ${path.basename(DATA_BACKUP_FILE)}`);
  return next;
}

let savedState = { ai: null, broker: null, settings: null };
if (fs.existsSync(DATA_FILE)) {
  const parsed = tryParseJsonFile(DATA_FILE);
  if (parsed) {
    savedState = parsed;
  } else {
    quarantineCorrupt(DATA_FILE);
    savedState = tryParseJsonFile(DATA_FILE + '.tmp')
      || tryParseJsonFile(DATA_BACKUP_FILE)
      || savedState;
    if (savedState && savedState.broker) {
      console.log(`[BOOT] Loaded store from fallback (${(savedState.broker.tradeHistory || []).length} closed trades)`);
    }
  }
}
savedState = restoreHistoryIfEmpty(savedState, tryParseJsonFile(DATA_BACKUP_FILE));

function applyQualityCaps(s) {
  const next = { ...s };
  if (next.qualityMode === false) {
    next.maxPositions = Math.min(25, Math.max(1, Number(next.maxPositions) || 25));
    return next;
  }
  next.maxPositions = Math.min(25, Math.max(1, Number(next.maxPositions) || 25));
  next.maxSameDirection = Math.min(20, Math.max(1, Number(next.maxSameDirection) || 15));
  next.stopAndReverse = false;
  next.minConfidence = Math.min(Math.max(Number(next.minConfidence) || 55, 50), 70);
  next.minOpportunityScore = Math.min(Math.max(Number(next.minOpportunityScore) || 58, 50), 75);
  next.chopCooldownMins = Math.min(Math.max(Number(next.chopCooldownMins) || 3, 2), 8);
  next.slCooldownMins = Math.min(Math.max(Number(next.slCooldownMins) || 8, 4), 15);
  next.slMode = 'POSITION';
  next.positionStopPercent = Math.min(Math.max(Number(next.positionStopPercent) || 0.8, 0.5), 2);
  next.positionTpPercent = Math.min(Math.max(Number(next.positionTpPercent) || 1.6, 0.8), 4);
  return next;
}

let settings = applyQualityCaps({ ...DEFAULT_SETTINGS, ...(savedState.settings || {}) });
if (settings.qualityMode === undefined) settings.qualityMode = true;
if (settings.tradeLiquidHoursOnly === undefined) settings.tradeLiquidHoursOnly = false;
if (settings.maxSameDirection === undefined) settings.maxSameDirection = 15;
if (settings.maxDailyLossPercent === undefined) settings.maxDailyLossPercent = 3;
if (settings.positionStopPercent === undefined) settings.positionStopPercent = 0.8;
if (settings.positionTpPercent === undefined) settings.positionTpPercent = 1.6;
settings.slMode = 'POSITION';
settings = applyQualityCaps(settings);
settings.maxPositions = 5;
settings.maxSameDirection = 2;
settings.tradeLiquidHoursOnly = false;
settings.mtfStrictness = '5m_15m_1h';
settings.slCooldownMins = Math.max(settings.slCooldownMins || 8, 12);
const ai = new AIBrain(savedState.ai);

if (exchange.TRADING_MODE === 'live') {
  exchange.assertLiveConfig();
}

const broker = exchange.TRADING_MODE === 'live'
  ? new LiveBroker(savedState.broker)
  : new PaperBroker(10000, 0.001, savedState.broker);
if (!broker.live) broker.maxDailyLossPercent = settings.maxDailyLossPercent;

const marketCache = {};
const minuteBook = new MinuteBook();
minuteBook.load(MINUTE_LOG_FILE);
const fiveMinBook = new FiveMinBook(savedState.fiveMin || null);
let isBotActive = exchange.TRADING_MODE !== 'live';
let tickInFlight = false;
let posTickInFlight = false;
let lastScanSkipLog = 0;
let klineSocket = null;
let lastBacktest = null;
let backtestRunning = false;
let netOnline = true;

function persistState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const disk = tryParseJsonFile(DATA_FILE);
      if (!disk) {
        quarantineCorrupt(DATA_FILE);
      } else {
        const memHist = (broker.tradeHistory || []).length;
        const diskHist = (disk.broker?.tradeHistory || []).length;
        if (memHist === 0 && diskHist > 0) {
          console.error(`[SAVE] Refusing to overwrite ${diskHist} saved trades with an empty book`);
          return;
        }
      }
    }
    const brokerState = broker.exportState();
    brokerState.positions = (brokerState.positions || []).map(slimOpenForDisk);
    brokerState.tradeHistory = (brokerState.tradeHistory || []).map(slimClosedForDisk);
    const payload = JSON.stringify({
      ai: ai.exportState(),
      broker: brokerState,
      settings,
      fiveMin: fiveMinBook.exportState(),
      updatedAt: new Date().toISOString()
    });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.copyFileSync(tmp, DATA_FILE);
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    try { minuteBook.persist(MINUTE_LOG_FILE); } catch (e) { console.error('Minute-log save error:', e.message); }
  } catch (err) {
    console.error('Auto-save error:', err.message);
  }
}

setInterval(persistState, 30000);

function requireControl(req, res, next) {
  if (exchange.TRADING_MODE !== 'live') return next();
  const got = req.headers['x-control-token'] || req.body?.controlToken || req.query.controlToken;
  if (!got || got !== exchange.CONTROL_TOKEN) {
    return res.status(401).json({ success: false, error: 'Invalid or missing control token' });
  }
  next();
}

function upsert1m(symbol, bar) {
  if (!klineStore1m[symbol]) klineStore1m[symbol] = [];
  const arr = klineStore1m[symbol];
  const last = arr[arr.length - 1];
  if (last && last.time === bar.time) {
    arr[arr.length - 1] = { time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume };
  } else if (!last || bar.time > last.time) {
    arr.push({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
    const cutoff = Date.now() - 30 * 60 * 60 * 1000;
    while (arr.length > 1800 || (arr[0] && arr[0].time < cutoff)) arr.shift();
  }
}

async function fetchBinanceKlines(symbol, interval = '1m', limit = 60) {
  const cacheKey = `${symbol}_${interval}`;
  const cached = mtfKlinesCache[cacheKey];
  const now = Date.now();
  const cacheTTL = interval === '1m' ? 0
    : interval === '5m'  ? 20000
    : interval === '1h'  ? 60000
    : interval === '4h'  ? 180000
    : interval === '1d'  ? 300000 : 0;

  if (cached && (now - cached.timestamp) < cacheTTL) return cached.data;

  try {
    const parsed = await exchange.fetchKlines(symbol, interval, limit);
    if (cacheTTL > 0) mtfKlinesCache[cacheKey] = { timestamp: now, data: parsed };
    return parsed;
  } catch (e) {
    return cached ? cached.data : null;
  }
}

async function backfill1mHistory() {
  const start = Date.now() - 26 * 60 * 60 * 1000;
  console.log('[BOOT] Backfilling 26h of 1m candles for session/VWAP/ORB/IB...');
  console.log(`[BOOT] Watchlist: ${WATCHED_COINS.length} USDT pairs`);
  for (let i = 0; i < WATCHED_COINS.length; i += 6) {
    const batch = WATCHED_COINS.slice(i, i + 6);
    await Promise.all(batch.map(async (symbol) => {
      try {
        const bars = await exchange.fetchKlinesSince(symbol, '1m', start);
        klineStore1m[symbol] = bars;
        console.log(`[BOOT] ${symbol} 1m bars: ${bars.length}`);
      } catch (err) {
        console.error(`[BOOT] ${symbol} 1m backfill failed:`, err.message);
        klineStore1m[symbol] = [];
      }
    }));
  }
}

function startKlineSocket() {
  klineSocket = new exchange.KlineSocket(WATCHED_COINS, (symbol, bar) => {
    upsert1m(symbol, bar);
    if (marketCache[symbol]) {
      marketCache[symbol].price = bar.close;
      marketCache[symbol].priceUpdatedAt = new Date().toISOString();
      if (bar.closed && marketCache[symbol].analysis) {
        minuteBook.record(symbol, bar.close, marketCache[symbol].analysis, {
          t: new Date(bar.time || Date.now()).toISOString()
        });
      }
    }
  });
  klineSocket.start();
}

function tradeOptionsFromSettings() {
  return {
    sizingMode: settings.sizingMode || 'PERCENT',
    allocationPercent: settings.allocationPercent,
    fixedTradeAmountUSD: settings.fixedTradeAmountUSD || 10.0,
    riskMode: settings.riskMode || 'PERCENT',
    maxRiskPerTradePercent: settings.maxRiskPerTradePercent || 0.02,
    fixedRiskUSD: settings.fixedRiskUSD || 1.0,
    slMultiplier: settings.slMultiplier,
    tpMultiplier: settings.tpMultiplier,
    slMode: settings.slMode || 'POSITION',
    positionStopPercent: settings.positionStopPercent || 0.8,
    positionTpPercent: settings.positionTpPercent || 1.6
  };
}

function featureFlagsFromSettings() {
  return {
    smcEnabled: settings.smcEnabled !== false,
    useSessionLevels: settings.useSessionLevels !== false,
    usePDHPDL: settings.usePDHPDL !== false,
    useNeuralNet: true
  };
}

function isLiquidSession() {
  if (settings.tradeLiquidHoursOnly === false) return true;
  const hour = new Date().getUTCHours();
  return hour >= 7 && hour < 22;
}

function entriesPausedReason() {
  if (!isBotActive) return 'Bot is paused — no new entries';
  if (broker.circuitBroken) return broker.circuitReason || 'Circuit breaker';
  if (settings.qualityMode !== false && settings.tradeLiquidHoursOnly !== false && !isLiquidSession()) {
    const utc = new Date().getUTCHours();
    return `No new trades until 07:00 UTC (London/NY hours). Now ${String(utc).padStart(2, '0')}:xx UTC. Open positions still managed.`;
  }
  return null;
}

function slimClosedTrade(t) {
  return {
    id: t.id,
    symbol: t.symbol,
    side: t.side,
    entryTime: t.entryTime,
    exitTime: t.exitTime,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    investedUSDT: t.investedUSDT,
    quantity: t.quantity,
    entryFee: t.entryFee,
    exitFee: t.exitFee,
    totalFees: t.totalFees,
    netProfit: t.netProfit,
    profitPercent: t.profitPercent,
    exitReason: t.exitReason,
    breakDown: t.breakDown || t.exitReason || null,
    slPnlPercent: t.slPnlPercent,
    tpPnlPercent: t.tpPnlPercent,
    entrySight: t.entrySight || null,
    whoAgreed: t.whoAgreed || (t.entrySight && t.entrySight.confirms && t.entrySight.confirms.join('+')) || (t.entrySight && t.entrySight.summary) || null
  };
}

function allClosedTrades() {
  return (broker.tradeHistory || []).map(slimClosedTrade);
}

function qualityBlock(analysis, side) {
  if (settings.qualityMode === false) return null;
  if (!isLiquidSession()) return 'Outside London/NY hours';
  const dir = side === 'SHORT' ? 'SHORT' : 'LONG';
  const maxSame = settings.maxSameDirection || 2;
  if (broker.positions.filter(p => p.side === dir).length >= maxSame) {
    return `Max ${maxSame} ${dir} book`;
  }
  const px = analysis.currentPrice || 0;
  const atr = analysis.atr || 0;
  if (px > 0 && atr / px < MIN_ATR_PCT) {
    return `ATR too small vs fees (need ~${(MIN_ATR_PCT * 100).toFixed(2)}%)`;
  }
  const m5 = analysis.mtf && analysis.mtf['5m'];
  const m15 = analysis.mtf && analysis.mtf['15m'];
  const h1 = analysis.mtf && analysis.mtf['1h'];
  if (dir === 'LONG' && (m5 === 'BEARISH' || m15 === 'BEARISH' || h1 === 'BEARISH')) {
    return '5m/15m/1h against the long';
  }
  if (dir === 'SHORT' && (m5 === 'BULLISH' || m15 === 'BULLISH' || h1 === 'BULLISH')) {
    return '5m/15m/1h against the short';
  }
  const f5 = analysis.fiveMin;
  if (f5 && f5.side && f5.side !== 'HOLD' && f5.side !== dir) {
    return `5m forecast is ${f5.side}, not ${dir}`;
  }
  // Alts usually follow BTC — do not long alts into a BTC dump (or short into melt-up)
  const btc = analysis.marketContext?.btcRegime || marketContext.cache.btcRegime;
  const sym = analysis.symbol || null;
  if (sym && sym !== 'BTCUSDT' && btc) {
    if (dir === 'LONG' && btc.side === 'SHORT') return 'BTC dumping — skip alt long';
    if (dir === 'SHORT' && btc.side === 'LONG') return 'BTC ripping — skip alt short';
  }
  analysis.entrySight = buildEntrySight(analysis, dir);
  if ((analysis.entrySight.confirmHits || 0) < 2) {
    const who = analysis.entrySight.confirms && analysis.entrySight.confirms.length
      ? analysis.entrySight.confirms.join('+')
      : 'none';
    return `Not confident (${who} — need 2 confirms)`;
  }
  // Live: ADX+B alone was 21% WR — require SMC/RL/5mF/FUND/BTC
  if (!analysis.entrySight.hasStructure) {
    const who = (analysis.entrySight.confirms || []).join('+') || 'none';
    return `Weak structure (${who} — need SMC/RL/5mF/FUND/BTC)`;
  }
  return null;
}

function effectiveMaxPositions() {
  return Math.min(25, Math.max(1, Number(settings.maxPositions) || 25));
}

function effectiveThresholds() {
  if (settings.qualityMode === false) {
    return { minConfidence: settings.minConfidence, minOpportunity: settings.minOpportunityScore };
  }
  return {
    minConfidence: Math.max(settings.minConfidence, 50),
    minOpportunity: Math.max(settings.minOpportunityScore, 52)
  };
}

async function executeStopAndReverse(closedTrade, symbol, currentPrice, analysis, options) {
  if (!settings.stopAndReverse) return;
  if (!isBotActive) return;
  if (broker.circuitBroken) return;
  if (broker.positions.length >= effectiveMaxPositions()) return;

  const wasLong = closedTrade.side === 'LONG';
  const wasShort = closedTrade.side === 'SHORT';
  const wasHardStop = closedTrade.exitReason === 'Stop-Loss Hit';
  if (!wasHardStop) return;

  const smc = settings.smcEnabled !== false ? analysis.smcStructure : null;
  const shouldFlipToShort = wasLong && smc?.lastCHoCH?.type === 'BEARISH_CHOCH';
  const shouldFlipToLong = wasShort && smc?.lastCHoCH?.type === 'BULLISH_CHOCH';

  if (shouldFlipToShort) {
    const blocked = qualityBlock(analysis, 'SHORT');
    if (blocked) {
      console.log(`[SAR] ${symbol} flip to SHORT skipped: ${blocked}`);
      return;
    }
    console.log(`[SAR] ${symbol} LONG stopped → SHORT @ ${currentPrice}`);
    const result = await broker.openPosition(symbol, currentPrice, { ...analysis, reasons: `SAR Flip: LONG→SHORT | ${analysis.reasons}` }, 'SHORT', options);
    if (result.success) pendingFlips[symbol] = { from: 'LONG', to: 'SHORT', price: currentPrice, time: Date.now() };
  } else if (shouldFlipToLong) {
    const blocked = qualityBlock(analysis, 'LONG');
    if (blocked) {
      console.log(`[SAR] ${symbol} flip to LONG skipped: ${blocked}`);
      return;
    }
    console.log(`[SAR] ${symbol} SHORT stopped → LONG @ ${currentPrice}`);
    const result = await broker.openPosition(symbol, currentPrice, { ...analysis, reasons: `SAR Flip: SHORT→LONG | ${analysis.reasons}` }, 'LONG', options);
    if (result.success) pendingFlips[symbol] = { from: 'SHORT', to: 'LONG', price: currentPrice, time: Date.now() };
  }
}

async function handleClosedTrades(closedTrades, symbol, currentPrice, analysis, options) {
  for (const closed of closedTrades) {
    if (closed.netProfit < 0) {
      cooldownMap[symbol] = Date.now() + (settings.slCooldownMins * 60 * 1000);
      console.log(`[COOLDOWN] ${symbol} losing exit. ${settings.slCooldownMins}m cooldown.`);
    }
    if (analysis && closed.exitReason === 'Stop-Loss Hit') {
      await executeStopAndReverse(closed, symbol, currentPrice, analysis, options);
    }
  }
}

async function manageOpenPositions() {
  if (posTickInFlight) return;
  posTickInFlight = true;
  try {
    const options = tradeOptionsFromSettings();
    const snapshot = [...broker.positions];
    for (const pos of snapshot) {
      const bars = klineStore1m[pos.symbol];
      if (!bars || bars.length === 0) continue;
      const currentPrice = bars[bars.length - 1].close;
      const analysis = marketCache[pos.symbol]?.analysis || pos.analysis || null;
      const snap = analysis
        ? minuteBook.record(pos.symbol, currentPrice, analysis, { t: new Date().toISOString() })
        : null;
      const closedTrades = await broker.updatePositionsWithPrice(pos.symbol, currentPrice, ai, {
        snapshot: snap,
        exitAnalysis: analysis
      });
      await handleClosedTrades(closedTrades, pos.symbol, currentPrice, analysis, options);
    }
  } catch (err) {
    console.error('[POS] error:', err.message);
  } finally {
    posTickInFlight = false;
  }
}

async function marketTradingTick() {
  const now = Date.now();
  const currentPrices = {};
  const flags = featureFlagsFromSettings();
  const options = tradeOptionsFromSettings();
  const skip = { hold: 0, chop: 0, cooldown: 0, mtf: 0, score: 0, quality: {} };
  const batchSize = 8;
  const candidates = [];

  // Free context APIs — BTC regime + funding / L-S / Fear&Greed (trainable votes)
  try {
    const btcBars = klineStore1m.BTCUSDT || [];
    const btcCloses = btcBars.map(b => b.close);
    const focus = [
      ...broker.positions.map(p => p.symbol),
      ...WATCHED_COINS.slice(0, 8)
    ];
    await marketContext.refreshContext({ symbols: focus, btcCloses });
  } catch (e) {
    /* non-fatal */
  }

  for (let i = 0; i < WATCHED_COINS.length; i += batchSize) {
    const batch = WATCHED_COINS.slice(i, i + batchSize);

    await Promise.all(batch.map(async (symbol) => {
      if (broker.circuitBroken) return;

      const cooldownExpiry = cooldownMap[symbol] || 0;
      const isCooldown = cooldownExpiry > now;
      const cooldownRemainingSeconds = isCooldown ? Math.ceil((cooldownExpiry - now) / 1000) : 0;

      let candles1m = klineStore1m[symbol] || [];
      if (candles1m.length < 80) {
        const rest1m = await fetchBinanceKlines(symbol, '1m', 1000);
        if (rest1m && rest1m.length) {
          klineStore1m[symbol] = rest1m;
          candles1m = rest1m;
        }
      }
      if (!candles1m || candles1m.length === 0) return;

      const currentPrice = candles1m[candles1m.length - 1].close;
      currentPrices[symbol] = currentPrice;

      const candles1mExec = candles1m.slice(-300);
      const candles5m = aggregate(candles1m, 5 * 60 * 1000).slice(-80);
      const candles15m = aggregate(candles1m, 15 * 60 * 1000).slice(-80);
      const [candles1h, candles4h, candlesDaily] = await Promise.all([
        fetchBinanceKlines(symbol, '1h', 50),
        fetchBinanceKlines(symbol, '4h', 50),
        flags.usePDHPDL ? fetchBinanceKlines(symbol, '1d', 5) : Promise.resolve(null)
      ]);

      const analysis = ai.analyzeMultiTimeframe(
        candles1mExec, candles5m, candles1h, candles4h,
        settings.mtfStrictness,
        candlesDaily,
        { ...flags, symbol, candles15m }
      );
      analysis.symbol = symbol;
      marketContext.attachContext(analysis, symbol);
      const fiveMin = fiveMinBook.observe(symbol, currentPrice, analysis);
      if (analysis.signal === 'BUY' || analysis.signal === 'SHORT') {
        analysis.entrySight = buildEntrySight(analysis, analysis.signal === 'SHORT' ? 'SHORT' : 'LONG');
      }
      if (fiveMin.resolved && !fiveMin.resolved.skipped) {
        const skill = fiveMinBook.accuracy();
        // Do not train 5mF weight up while skill is below coin-flip
        if (skill >= 0.52 || !fiveMin.resolved.hit) {
          const bump = fiveMin.resolved.hit ? 0.04 : -0.05;
          const cur = Number(ai.confirmWeights['5mF'] ?? 1);
          ai.confirmWeights['5mF'] = Math.max(0.3, Math.min(2.5, cur + bump));
        }
        if (skill < 0.5) {
          const cur = Number(ai.confirmWeights['5mF'] ?? 1);
          if (cur > 0.5) ai.confirmWeights['5mF'] = Math.max(0.3, cur - 0.02);
        }
      }

      if (analysis.signal === 'CHOP_SKIP' && !isCooldown) {
        cooldownMap[symbol] = Date.now() + (settings.chopCooldownMins * 60 * 1000);
      }

      marketCache[symbol] = {
        symbol,
        price: currentPrice,
        priceUpdatedAt: new Date().toISOString(),
        candles: candles1m.slice(-30),
        analysis,
        isCooldown: cooldownExpiry > now,
        cooldownRemainingSeconds,
        sarFlip: pendingFlips[symbol] || null,
        updatedAt: new Date().toISOString()
      };

      minuteBook.record(symbol, currentPrice, analysis, { t: marketCache[symbol].updatedAt });

      if (analysis.signal === 'CHOP_SKIP') skip.chop++;
      else if (analysis.signal !== 'BUY' && analysis.signal !== 'SHORT') skip.hold++;

      if (pendingFlips[symbol] && (now - pendingFlips[symbol].time) > 300000) {
        delete pendingFlips[symbol];
      }

      if (broker.circuitBroken || !isBotActive || isCooldown) {
        if (isCooldown) skip.cooldown++;
        return;
      }
      if (broker.positions.some(p => p.symbol === symbol)) return;

      const { minConfidence, minOpportunity } = effectiveThresholds();
      const meetsConfidence = analysis.confidence >= minConfidence;
      const meetsOpportunity = analysis.opportunityScore >= minOpportunity;
      const isMTFConfirmed = !analysis.mtf || analysis.mtf.isConfirmed;
      if (analysis.signal !== 'BUY' && analysis.signal !== 'SHORT') return;
      if (!isMTFConfirmed) { skip.mtf++; return; }
      if (!meetsConfidence || !meetsOpportunity) { skip.score++; return; }

      if (analysis.signal === 'BUY') {
        candidates.push({ symbol, currentPrice, analysis, side: 'LONG' });
      } else if (analysis.signal === 'SHORT') {
        candidates.push({ symbol, currentPrice, analysis, side: 'SHORT' });
      }
    }));

    if (broker.circuitBroken) {
      isBotActive = false;
      if (typeof broker.flattenAll === 'function') {
        await broker.flattenAll(ai, currentPrices);
      }
      return;
    }
  }

  if (!isBotActive || broker.circuitBroken) return;
  if (!netOnline) {
    console.log('[NET] Offline — holding book, no new entries until internet returns');
    return;
  }

  candidates.sort((a, b) => (b.analysis.opportunityScore || 0) - (a.analysis.opportunityScore || 0));
  const maxNew = 2;
  let opened = 0;
  for (const c of candidates) {
    if (opened >= maxNew) break;
    if (broker.positions.length >= effectiveMaxPositions()) break;
    if (broker.positions.some(p => p.symbol === c.symbol)) continue;
    const blocked = qualityBlock(c.analysis, c.side);
    if (blocked) {
      if (marketCache[c.symbol]) marketCache[c.symbol].entryBlock = blocked;
      skip.quality[blocked] = (skip.quality[blocked] || 0) + 1;
      continue;
    }
    if (c.analysis && !c.analysis.entrySight) {
      c.analysis.entrySight = buildEntrySight(c.analysis, c.side);
    }
    const result = await broker.openPosition(c.symbol, c.currentPrice, c.analysis, c.side, options);
    if (result && result.success) opened++;
  }
  if (opened === 0 && Date.now() - lastScanSkipLog > 45000) {
    lastScanSkipLog = Date.now();
    const q = Object.entries(skip.quality).map(([k, v]) => `${k}:${v}`).join(', ') || 'none';
    console.log(`[SCAN] no new entries | candidates ${candidates.length} | HOLD ${skip.hold} chop ${skip.chop} cooldown ${skip.cooldown} mtf ${skip.mtf} score ${skip.score} | quality ${q} | 5mF ${fiveMinBook.hits}H/${fiveMinBook.misses}M`);
  }
}

async function guardedTick() {
  if (tickInFlight) {
    if (Date.now() - lastScanSkipLog > 20000) {
      lastScanSkipLog = Date.now();
      console.log('[SCAN] Previous universe scan still running — entries wait, stops still update');
    }
    return;
  }
  tickInFlight = true;
  const started = Date.now();
  try {
    await marketTradingTick();
    console.log(`[SCAN] universe done in ${Date.now() - started}ms | open ${broker.positions.length}/${effectiveMaxPositions()}`);
  } catch (err) {
    console.error('[SCAN] error:', err.message);
  } finally {
    tickInFlight = false;
  }
}

(async () => {
  while (true) {
    try {
      await exchange.waitForInternet('boot');
      await ai.ready();
      if (exchange.TRADING_MODE === 'live') {
        console.log('======================================================');
        console.log('LIVE MODE', exchange.USE_TESTNET ? '(FUTURES TESTNET)' : '(FUTURES REAL MONEY)');
        console.log(`Leverage cap: ${exchange.FUTURES_LEVERAGE}x | Daily loss halt: ${exchange.MAX_DAILY_LOSS_PERCENT}%`);
        console.log('Bot starts PAUSED. Toggle it on from the dashboard after checking the token.');
        console.log('======================================================');
        await broker.syncFromExchange();
      }
      await backfill1mHistory();
      startKlineSocket();
      startStoredReplay();
      await manageOpenPositions();
      await guardedTick();
      netOnline = true;
      setInterval(() => { manageOpenPositions(); }, 1500);
      setInterval(guardedTick, 8000);
      setInterval(async () => {
        const ok = await exchange.checkInternet();
        if (!ok) {
          if (netOnline) console.warn('[NET] Internet lost — waiting and rechecking. Stops still update from last ticks.');
          netOnline = false;
          await exchange.waitForInternet('live');
          netOnline = true;
          return;
        }
        if (!netOnline) console.log('[NET] Internet restored');
        netOnline = true;
      }, 10000);
      return;
    } catch (err) {
      console.error('Boot failed:', err.message, '— waiting, then retrying (will not quit)');
      await new Promise(r => setTimeout(r, 5000));
    }
  }
})();

app.get('/api/state', async (req, res) => {
  const prices = {};
  const opportunities = [];

  for (const [sym, data] of Object.entries(marketCache)) {
    prices[sym] = data.price;
    const smc = data.analysis.smcStructure;
    opportunities.push({
      symbol: sym,
      price: data.price,
      signal: data.analysis.signal,
      confidence: data.analysis.confidence,
      opportunityScore: data.analysis.opportunityScore,
      adx: data.analysis.adx ? data.analysis.adx.adx : 20,
      isCooldown: data.isCooldown,
      cooldownRemainingSeconds: data.cooldownRemainingSeconds,
      mtf: data.analysis.mtf,
      reasons: data.analysis.reasons,
      smcSignal: smc?.smcSignal || 'NEUTRAL',
      structureState: smc?.structureState || 'UNDEFINED',
      lastCHoCH: smc?.lastCHoCH || null,
      lastBOS: smc?.lastBOS || null,
      pdh: data.analysis.pdLevels?.pdh || null,
      pdl: data.analysis.pdLevels?.pdl || null,
      isAbovePDH: data.analysis.pdLevels?.isAbovePDH || false,
      isBelowPDL: data.analysis.pdLevels?.isBelowPDL || false,
      currentSession: data.analysis.sessionLevels?.currentSession || 'OFFHOURS',
      cvd: data.analysis.cvd || null,
      sarFlip: data.sarFlip || null,
      fiveMin: data.analysis.fiveMin || null
    });
  }

  opportunities.sort((a, b) => b.opportunityScore - a.opportunityScore);

  const portfolio = await Promise.resolve(broker.getPortfolioMetrics(prices));

  res.json({
    isBotActive,
    settings,
    watchedCoins: WATCHED_COINS,
    marketData: marketCache,
    opportunities,
    portfolio,
    positions: broker.positions,
    tradeHistory: allClosedTrades(),
    tradeHistoryDays: null,
    tradeHistorySaved: (broker.tradeHistory || []).length,
    aiMetrics: ai.exportState(),
    fiveMinForecast: {
      hits: fiveMinBook.hits,
      misses: fiveMinBook.misses,
      accuracy: fiveMinBook.accuracy(),
      recent: (fiveMinBook.recent || []).slice(0, 20)
    },
    marketContext: marketContext.snapshot(),
    performance: summarize(broker),
    lastBacktest,
    backtestRunning,
    runtime: {
      mode: exchange.TRADING_MODE,
      testnet: exchange.USE_TESTNET,
      liveRequiresToken: exchange.TRADING_MODE === 'live',
      leverage: exchange.FUTURES_LEVERAGE,
      maxDailyLossPercent: exchange.MAX_DAILY_LOSS_PERCENT,
      circuitBroken: !!broker.circuitBroken,
      circuitReason: broker.circuitReason || null,
      nnReady: !!ai.nnReady,
      entriesPausedReason: entriesPausedReason(),
      oneMinuteBars: Object.fromEntries(
        WATCHED_COINS.map(s => [s, (klineStore1m[s] || []).length])
      )
    }
  });
});

app.get('/api/settings', (req, res) => {
  res.json(settings);
});

app.post('/api/settings', requireControl, (req, res) => {
  const n = req.body;
  settings = {
    ...settings, ...n,
    sizingMode:             n.sizingMode === 'FIXED_USD' ? 'FIXED_USD' : 'PERCENT',
    allocationPercent:      Math.max(0.01,  Math.min(0.50, parseFloat(n.allocationPercent      || settings.allocationPercent))),
    fixedTradeAmountUSD:    Math.max(2,     Math.min(10000, parseFloat(n.fixedTradeAmountUSD   || settings.fixedTradeAmountUSD || 10))),
    riskMode:               n.riskMode === 'FIXED_USD' ? 'FIXED_USD' : 'PERCENT',
    maxRiskPerTradePercent: Math.max(0.005, Math.min(0.10, parseFloat(n.maxRiskPerTradePercent || settings.maxRiskPerTradePercent || 0.02))),
    fixedRiskUSD:           Math.max(0.1,   Math.min(1000, parseFloat(n.fixedRiskUSD           || settings.fixedRiskUSD || 1.0))),
    maxPositions:           Math.max(1,     Math.min(25,   parseInt(n.maxPositions           || settings.maxPositions))),
    minConfidence:          Math.max(30,    Math.min(90,   parseInt(n.minConfidence          || settings.minConfidence))),
    minOpportunityScore:    Math.max(30,    Math.min(90,   parseInt(n.minOpportunityScore    || settings.minOpportunityScore))),
    slMultiplier:           Math.max(0.5,   Math.min(5.0,  parseFloat(n.slMultiplier         || settings.slMultiplier))),
    tpMultiplier:           Math.max(1.0,   Math.min(10.0, parseFloat(n.tpMultiplier         || settings.tpMultiplier))),
    slMode:                 'POSITION',
    positionStopPercent:    Math.max(0.5,   Math.min(2.0,  parseFloat(n.positionStopPercent  || settings.positionStopPercent || 0.8))),
    positionTpPercent:      Math.max(0.8,   Math.min(4.0,  parseFloat(n.positionTpPercent    || settings.positionTpPercent || 1.6))),
    chopCooldownMins:       Math.max(1,     Math.min(60,   parseInt(n.chopCooldownMins       || settings.chopCooldownMins))),
    slCooldownMins:         Math.max(1,     Math.min(120,  parseInt(n.slCooldownMins         || settings.slCooldownMins))),
    stopAndReverse:         n.stopAndReverse !== undefined ? Boolean(n.stopAndReverse) : settings.stopAndReverse,
    usePDHPDL:              n.usePDHPDL     !== undefined ? Boolean(n.usePDHPDL)      : settings.usePDHPDL,
    useSessionLevels:       n.useSessionLevels !== undefined ? Boolean(n.useSessionLevels) : settings.useSessionLevels,
    smcEnabled:             n.smcEnabled    !== undefined ? Boolean(n.smcEnabled)     : settings.smcEnabled,
    qualityMode:            n.qualityMode !== undefined ? Boolean(n.qualityMode) : settings.qualityMode,
    tradeLiquidHoursOnly:   n.tradeLiquidHoursOnly !== undefined ? Boolean(n.tradeLiquidHoursOnly) : settings.tradeLiquidHoursOnly,
    maxSameDirection:       Math.max(1, Math.min(20, parseInt(n.maxSameDirection || settings.maxSameDirection || 15))),
    maxDailyLossPercent:    Math.max(1, Math.min(15, parseFloat(n.maxDailyLossPercent || settings.maxDailyLossPercent || 3)))
  };
  if (broker && !broker.live) broker.maxDailyLossPercent = settings.maxDailyLossPercent;
  settings = applyQualityCaps(settings);

  persistState();
  res.json({ success: true, settings });
});

app.post('/api/bot/toggle', requireControl, (req, res) => {
  if (broker.circuitBroken && !isBotActive) {
    if (exchange.TRADING_MODE === 'live') {
      return res.status(400).json({ success: false, error: broker.circuitReason || 'Circuit breaker is tripped' });
    }
    broker.circuitBroken = false;
    broker.circuitReason = null;
  }
  isBotActive = !isBotActive;
  res.json({ success: true, isBotActive });
});

app.post('/api/bot/reset', requireControl, async (req, res) => {
  if (exchange.TRADING_MODE === 'live') {
    return res.status(400).json({ success: false, error: 'Account reset is disabled in live mode' });
  }
  const balance = parseFloat(req.body.balance) || 10000;
  await Promise.resolve(broker.resetAccount(balance));
  res.json({ success: true, message: `Account reset to $${balance.toLocaleString()} USDT` });
});

app.post('/api/trade/manual-buy', requireControl, async (req, res) => {
  const { symbol, side = 'LONG' } = req.body;
  const market = marketCache[symbol];
  if (!market) return res.status(400).json({ success: false, error: 'Symbol data unavailable' });
  const result = await broker.openPosition(symbol, market.price, market.analysis, side, tradeOptionsFromSettings());
  res.json(result);
});

app.post('/api/trade/close', requireControl, async (req, res) => {
  const { positionId } = req.body;
  const pos = broker.positions.find(p => p.id === positionId);
  if (!pos) return res.status(404).json({ success: false, error: 'Position not found' });
  const market = marketCache[pos.symbol];
  const exitPrice = market ? market.price : pos.entryPrice;
  const closed = await broker.closePosition(pos.id, exitPrice, 'Manual User Close', ai);
  res.json({ success: true, closed });
});

function snapshotOneMinuteBooks(symbols) {
  const out = {};
  for (const s of symbols) {
    out[s] = (klineStore1m[s] || []).map((c) => ({ ...c }));
  }
  return out;
}

function replaySymbols() {
  const ready = WATCHED_COINS.filter((s) => (klineStore1m[s] || []).length >= 80);
  return ready.length ? ready : WATCHED_COINS.slice();
}

function startStoredReplay() {
  if (backtestRunning) return;
  const symbols = replaySymbols();
  const oneMinuteBooks = snapshotOneMinuteBooks(symbols);
  const haveData = symbols.some((s) => (oneMinuteBooks[s] || []).length >= 80);
  if (!haveData) {
    console.log('[REPLAY] No stored 1m history yet — skip');
    return;
  }
  backtestRunning = true;
  lastBacktest = { ok: true, running: true, startedAt: new Date().toISOString(), source: 'stored-1m' };
  console.log('[REPLAY] Scoring rules on stored 1m history (not waiting on new candles)');
  runBacktest({ symbols, oneMinuteBooks })
    .then((result) => {
      lastBacktest = { ...result, finishedAt: new Date().toISOString() };
      console.log(`[REPLAY] ${result.trades} trades | WR ${result.winRate}% | PnL ${result.netProfit} | PF ${result.profitFactor} | DD ${result.maxDrawdownPercent}%`);
    })
    .catch((err) => {
      lastBacktest = { ok: false, error: err.message, finishedAt: new Date().toISOString() };
      console.error('[REPLAY] failed:', err.message);
    })
    .finally(() => { backtestRunning = false; });
}

app.post('/api/backtest', requireControl, (req, res) => {
  if (backtestRunning) {
    return res.status(409).json({ success: false, error: 'A backtest is already running' });
  }
  backtestRunning = true;
  lastBacktest = { ok: true, running: true, startedAt: new Date().toISOString() };
  res.json({ success: true, started: true });
  const bars = Math.max(200, Math.min(800, parseInt(req.body?.fiveMinBars || 400, 10)));
  const symbols = replaySymbols();
  runBacktest({ fiveMinBars: bars, symbols, oneMinuteBooks: snapshotOneMinuteBooks(symbols) })
    .then((result) => {
      lastBacktest = { ...result, finishedAt: new Date().toISOString() };
      console.log(`[BACKTEST] ${result.trades} trades | WR ${result.winRate}% | PnL ${result.netProfit} | PF ${result.profitFactor} | DD ${result.maxDrawdownPercent}%`);
    })
    .catch((err) => {
      lastBacktest = { ok: false, error: err.message, finishedAt: new Date().toISOString() };
      console.error('[BACKTEST] failed:', err.message);
    })
    .finally(() => { backtestRunning = false; });
});

function shutdownPersist(signal) {
  console.log(`[EXIT] ${signal} — saving learning + book`);
  try { persistState(); } catch (e) { console.error('Save on exit failed:', e.message); }
  process.exit(0);
}
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err && err.stack ? err.stack : err);
  try { persistState(); } catch (e) { /* ignore */ }
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason);
});

server.on('error', (err) => {
  console.error('[HTTP]', err.message);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`AutoTread: http://0.0.0.0:${PORT}`);
  console.log(`Mode: ${exchange.TRADING_MODE}${exchange.USE_TESTNET ? ' / testnet' : ''}`);
  console.log(`NN persisted | Wilder ADX | SMC history | 26h 1m + WS | tick lock`);
  console.log(`Quality: ${settings.qualityMode !== false ? 'ON' : 'OFF'} | maxPos ${effectiveMaxPositions()} | sameDir ${settings.maxSameDirection} | SAR ${settings.stopAndReverse ? 'ON' : 'OFF'}`);
  console.log(`======================================================\n`);
});

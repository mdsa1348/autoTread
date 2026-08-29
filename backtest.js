/**
 * Walk-forward paper backtest on Binance 5m history.
 * This measures the rules engine, not a trained neural net.
 */
const { AIBrain } = require('./ai_engine');
const { PaperBroker } = require('./paper_broker');
const { fetchKlines } = require('./exchange');

const DEFAULT_SYMBOLS = [
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

const BACKTEST_SETTINGS = {
  sizingMode: 'PERCENT',
  allocationPercent: 0.08,
  riskMode: 'PERCENT',
  maxRiskPerTradePercent: 0.01,
  slMultiplier: 1.8,
  tpMultiplier: 3.0,
  slMode: 'POSITION',
  positionStopPercent: 0.8,
  positionTpPercent: 1.6,
  maxPositions: 10,
  minConfidence: 62,
  minOpportunityScore: 65,
  mtfStrictness: '5m_15m_1h',
  smcEnabled: true,
  useSessionLevels: true,
  usePDHPDL: true
};

function candlesUpTo(candles, time) {
  if (!candles || !candles.length) return [];
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time <= time) lo = mid + 1;
    else hi = mid;
  }
  return candles.slice(0, lo);
}

function isLondonNy(ts) {
  const h = new Date(ts).getUTCHours();
  return h >= 7 && h < 22;
}

function summarize(broker) {
  const closed = broker.tradeHistory || [];
  const wins = closed.filter(t => t.netProfit > 0);
  const losses = closed.filter(t => t.netProfit <= 0);
  const grossWin = wins.reduce((s, t) => s + t.netProfit, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netProfit, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? null : 0);
  const winRate = closed.length ? Math.round((wins.length / closed.length) * 100) : 0;

  let equity = broker.initialBalance;
  let peak = equity;
  let maxDd = 0;
  const curve = [{ t: null, equity }];
  for (const t of [...closed].reverse()) {
    equity += t.netProfit;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;
    curve.push({ t: t.exitTime, equity: Number(equity.toFixed(2)), symbol: t.symbol, pnl: Number(t.netProfit.toFixed(2)) });
  }

  return {
    trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    netProfit: Number((equity - broker.initialBalance).toFixed(2)),
    netProfitPercent: Number((((equity - broker.initialBalance) / broker.initialBalance) * 100).toFixed(2)),
    profitFactor: profitFactor == null ? null : Number(profitFactor.toFixed(2)),
    maxDrawdownPercent: Number(maxDd.toFixed(2)),
    fees: Number(broker.totalFeesPaid.toFixed(2)),
    finalEquity: Number(equity.toFixed(2)),
    equityCurve: curve.slice(-120)
  };
}

function aggregate(candles, periodMs) {
  if (!candles || candles.length === 0) return [];
  const out = [];
  let cur = null;
  for (const c of candles) {
    const t = Math.floor(c.time / periodMs) * periodMs;
    if (!cur || cur.time !== t) {
      if (cur) out.push(cur);
      cur = { time: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume || 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function loadBooks(symbols, fiveMinBars, oneMinuteBooks) {
  const books = {};
  for (const symbol of symbols) {
    const local1m = oneMinuteBooks && oneMinuteBooks[symbol];
    if (local1m && local1m.length >= 80) {
      books[symbol] = {
        c5: aggregate(local1m, 5 * 60 * 1000),
        c1h: aggregate(local1m, 60 * 60 * 1000),
        c4h: aggregate(local1m, 4 * 60 * 60 * 1000),
        c1d: aggregate(local1m, 24 * 60 * 60 * 1000),
        exec: [],
        source: 'stored-1m'
      };
      continue;
    }
    const [c5, c1h, c4h, c1d] = await Promise.all([
      fetchKlines(symbol, '5m', fiveMinBars),
      fetchKlines(symbol, '1h', 200),
      fetchKlines(symbol, '4h', 80),
      fetchKlines(symbol, '1d', 8)
    ]);
    books[symbol] = { c5: c5 || [], c1h: c1h || [], c4h: c4h || [], c1d: c1d || [], exec: [], source: 'rest' };
  }
  return books;
}

async function runBacktest(options = {}) {
  const symbols = options.symbols || DEFAULT_SYMBOLS;
  const fiveMinBars = options.fiveMinBars || 500;
  const startedAt = Date.now();

  const ai = new AIBrain(null);
  await ai.ready();
  ai.nnReady = false;

  const broker = new PaperBroker(options.initialBalance || 10000, 0.001, null);
  broker.maxDailyLossPercent = 100;

  const books = await loadBooks(symbols, fiveMinBars, options.oneMinuteBooks);

  const events = [];
  for (const symbol of symbols) {
    for (const bar of books[symbol].c5) {
      events.push({ time: bar.time, symbol, bar });
    }
  }
  events.sort((a, b) => a.time - b.time || a.symbol.localeCompare(b.symbol));

  const flags = {
    smcEnabled: BACKTEST_SETTINGS.smcEnabled,
    useSessionLevels: BACKTEST_SETTINGS.useSessionLevels,
    usePDHPDL: BACKTEST_SETTINGS.usePDHPDL
  };
  const tradeOpts = {
    sizingMode: BACKTEST_SETTINGS.sizingMode,
    allocationPercent: BACKTEST_SETTINGS.allocationPercent,
    riskMode: BACKTEST_SETTINGS.riskMode,
    maxRiskPerTradePercent: BACKTEST_SETTINGS.maxRiskPerTradePercent,
    slMultiplier: BACKTEST_SETTINGS.slMultiplier,
    tpMultiplier: BACKTEST_SETTINGS.tpMultiplier,
    slMode: BACKTEST_SETTINGS.slMode,
    positionStopPercent: BACKTEST_SETTINGS.positionStopPercent,
    positionTpPercent: BACKTEST_SETTINGS.positionTpPercent
  };

  let scanned = 0;
  for (const ev of events) {
    const book = books[ev.symbol];
    book.exec.push(ev.bar);
    if (book.exec.length > 120) book.exec.shift();
    scanned++;
    if (book.exec.length < 80) continue;

    const price = ev.bar.close;
    await broker.updatePositionsWithPrice(ev.symbol, price, null);

    if (broker.positions.length >= BACKTEST_SETTINGS.maxPositions) continue;
    if (broker.positions.some(p => p.symbol === ev.symbol)) continue;
    if (!isLondonNy(ev.time)) continue;

    const c1h = candlesUpTo(book.c1h, ev.time);
    const c4h = candlesUpTo(book.c4h, ev.time);
    const c1d = candlesUpTo(book.c1d, ev.time);
    const analysis = ai.analyzeMultiTimeframe(
      book.exec, book.exec, c1h, c4h,
      BACKTEST_SETTINGS.mtfStrictness,
      c1d,
      flags
    );

    if (!analysis.mtf || !analysis.mtf.isConfirmed) continue;
    if (analysis.confidence < BACKTEST_SETTINGS.minConfidence) continue;
    if (analysis.opportunityScore < BACKTEST_SETTINGS.minOpportunityScore) continue;
    if (analysis.signal === 'BUY' && analysis.vwap?.vwapBias === 'BELOW') continue;
    if (analysis.signal === 'SHORT' && analysis.vwap?.vwapBias === 'ABOVE') continue;

    const longs = broker.positions.filter(p => p.side === 'LONG').length;
    const shorts = broker.positions.filter(p => p.side === 'SHORT').length;
    if (analysis.signal === 'BUY' && longs >= 2) continue;
    if (analysis.signal === 'SHORT' && shorts >= 2) continue;

    if (analysis.signal === 'BUY') {
      await broker.openPosition(ev.symbol, price, analysis, 'LONG', tradeOpts);
    } else if (analysis.signal === 'SHORT') {
      await broker.openPosition(ev.symbol, price, analysis, 'SHORT', tradeOpts);
    }
  }

  for (const symbol of symbols) {
    const last = books[symbol].exec[books[symbol].exec.length - 1];
    if (last) await broker.updatePositionsWithPrice(symbol, last.close, null);
  }

  const fourHBars = Math.min(...symbols.map(s => (books[s].c4h || []).length));
  const stats = summarize(broker);
  return {
    ok: true,
    engine: 'rules + MTF + SMC (NN off)',
    symbols,
    source: symbols.every(s => books[s].source === 'stored-1m') ? 'stored-1m' : 'mixed',
    barsPerSymbol: Math.max(...symbols.map(s => (books[s].c5 || []).length)),
    fourHourBars: fourHBars,
    note: fourHBars < 20
      ? `Stored history only has ${fourHBars} 4h bars. Strict MTF often prints 0 trades here; that is not a wait to start live 1m trading.`
      : null,
    interval: '5m (built from 1m history already in memory when available)',
    scannedEvents: scanned,
    elapsedMs: Date.now() - startedAt,
    ...stats,
    recentTrades: broker.tradeHistory.slice(0, 15).map(t => ({
      symbol: t.symbol,
      side: t.side,
      netProfit: Number((t.netProfit || 0).toFixed(2)),
      profitPercent: Number((t.profitPercent || 0).toFixed(2)),
      exitReason: t.exitReason,
      exitTime: t.exitTime
    }))
  };
}

if (require.main === module) {
  runBacktest().then((r) => {
    console.log(JSON.stringify({
      trades: r.trades,
      winRate: r.winRate,
      netProfit: r.netProfit,
      netProfitPercent: r.netProfitPercent,
      profitFactor: r.profitFactor,
      maxDrawdownPercent: r.maxDrawdownPercent,
      fees: r.fees,
      elapsedMs: r.elapsedMs
    }, null, 2));
  }).catch((err) => {
    console.error('Backtest failed:', err);
    process.exit(1);
  });
}

module.exports = { runBacktest, summarize, aggregate };

/**
 * Train on multi-year candles + merge with current 1m / closed-trade samples.
 * Years of 1-minute bars are too large; 1h (2022+) and 4h (2019+) cover years,
 * then we mix in recent 1m so the net does not forget the live timeframe.
 */
const fs = require('fs');
const path = require('path');
const tf = require('@tensorflow/tfjs');
const { AIBrain } = require('./ai_engine');
const exchange = require('./exchange');
const { NN_MODEL_FILE } = require('./paths');

const HOURLY = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT'
];
const FOUR_HOUR = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT'];
const RECENT_1M = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'LINKUSDT', 'AVAXUSDT'];

const LOOKBACK = 120;
const FEE = 0.001;
const SL = 0.008;
const TP = 0.016;
const FLAGS = { smcEnabled: true, useSessionLevels: true, usePDHPDL: true, useNeuralNet: false };

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function dedupBars(bars) {
  const seen = new Set();
  const out = [];
  for (const b of bars || []) {
    if (!b || !b.time || seen.has(b.time)) continue;
    seen.add(b.time);
    out.push(b);
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

function parseAnyKlines(raw) {
  let rows = raw;
  if (!Array.isArray(rows)) rows = raw?.klines || raw?.data || raw?.candles || [];
  if (!Array.isArray(rows)) return [];
  return rows.map((c) => {
    if (Array.isArray(c)) {
      return {
        time: Number(c[0]), open: Number(c[1]), high: Number(c[2]),
        low: Number(c[3]), close: Number(c[4]), volume: Number(c[5] || 0)
      };
    }
    return {
      time: Number(c.time ?? c.t ?? c.openTime),
      open: Number(c.open ?? c.o),
      high: Number(c.high ?? c.h),
      low: Number(c.low ?? c.l),
      close: Number(c.close ?? c.c),
      volume: Number(c.volume ?? c.v ?? 0)
    };
  }).filter(b => Number.isFinite(b.time) && Number.isFinite(b.close) && b.close > 0);
}

async function fetchJson(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function monthStarts(fromYear, fromMonth = 1) {
  const out = [];
  const now = new Date();
  let y = fromYear;
  let m = fromMonth;
  while (y < now.getUTCFullYear() || (y === now.getUTCFullYear() && m <= now.getUTCMonth() + 1)) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

async function fetchStatic1h(symbol) {
  const bars = [];
  for (const date of monthStarts(2022, 1)) {
    const url = `https://finom.github.io/static-klines/api/klines/1h/${symbol}/${date}.json`;
    try {
      bars.push(...parseAnyKlines(await fetchJson(url)));
    } catch { /* missing month */ }
    await sleep(60);
  }
  return dedupBars(bars);
}

async function fetchBinanceRange(symbol, interval, startMs) {
  const end = Date.now();
  const out = [];
  let cursor = startMs;
  for (let i = 0; i < 12 && cursor < end; i++) {
    const chunk = await exchange.fetchKlinesSince(symbol, interval, cursor, end);
    if (!chunk.length) break;
    out.push(...chunk);
    const last = chunk[chunk.length - 1].time;
    if (last <= cursor) break;
    cursor = last + 1;
    if (chunk.length < 900) break;
    await sleep(160);
  }
  return dedupBars(out);
}

function simulateLabel(bars, idx, side, horizon) {
  const entry = bars[idx].close;
  const last = Math.min(bars.length - 1, idx + horizon);
  for (let j = idx + 1; j <= last; j++) {
    const px = bars[j].close;
    const pnl = side === 'SHORT'
      ? (entry - px) / entry - 2 * FEE
      : (px - entry) / entry - 2 * FEE;
    if (pnl <= -SL) return 0;
    if (pnl >= TP) return 1;
  }
  return null;
}

function collectSamples(ai, symbol, bars, daily, step, horizon, source) {
  const samples = [];
  if (!bars || bars.length < LOOKBACK + horizon + 5) return samples;
  for (let i = LOOKBACK; i < bars.length - horizon; i += step) {
    const window = bars.slice(Math.max(0, i - LOOKBACK + 1), i + 1);
    if (window.length < 80) continue;
    let analysis;
    try {
      analysis = ai.analyzeMarket(window, daily, FLAGS);
    } catch {
      continue;
    }
    if (!analysis || !Array.isArray(analysis.features) || analysis.features.length !== 15) continue;
    if (analysis.signal !== 'BUY' && analysis.signal !== 'SHORT') continue;
    const side = analysis.signal === 'SHORT' ? 'SHORT' : 'LONG';
    const label = simulateLabel(bars, i, side, horizon);
    if (label == null) continue;
    samples.push({
      t: bars[i].time,
      symbol,
      side,
      features: analysis.features,
      target: label,
      source
    });
  }
  return samples;
}

function loadBackupTrades() {
  const file = path.join(__dirname, 'data_store.pre-restart.json');
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (raw.broker?.tradeHistory || [])
      .filter(t => Array.isArray(t.analysis?.features) && t.analysis.features.length === 15)
      .map(t => ({
        t: new Date(t.exitTime || t.entryTime || 0).getTime(),
        symbol: t.symbol,
        side: t.side || 'LONG',
        features: t.analysis.features,
        target: t.netProfit > 0 ? 1 : 0,
        source: 'closed-backup'
      }));
  } catch {
    return [];
  }
}

function accuracy(model, rows) {
  if (!rows.length) return { n: 0, acc: 0, hits: 0 };
  const xs = tf.tensor2d(rows.map(r => r.features));
  const pred = model.predict(xs);
  const probs = Array.from(pred.dataSync());
  xs.dispose();
  pred.dispose();
  let hits = 0;
  for (let i = 0; i < rows.length; i++) {
    if ((probs[i] >= 0.5 ? 1 : 0) === rows[i].target) hits++;
  }
  return { n: rows.length, hits, acc: hits / rows.length };
}

async function main() {
  console.log('[YEARS] Multi-year 1h/4h + recent 1m + closed trades → one merged net');
  const ai = new AIBrain({});
  await ai.ready();
  ai.nnModel = ai.buildFreshNetwork();
  ai.nnReady = false;

  const samples = loadBackupTrades();
  console.log(`[YEARS] backup trades: ${samples.length}`);

  const y3 = Date.now() - Math.round(3.1 * 365 * 24 * 60 * 60 * 1000);
  const y6 = Date.now() - Math.round(6 * 365 * 24 * 60 * 60 * 1000);

  for (const symbol of HOURLY) {
    process.stdout.write(`[YEARS] 1h ${symbol} ... `);
    let bars = [];
    try { bars = await fetchStatic1h(symbol); } catch { bars = []; }
    if (bars.length < 2000) {
      const extra = await fetchBinanceRange(symbol, '1h', y3);
      bars = dedupBars(bars.concat(extra));
    }
    const daily = await exchange.fetchKlines(symbol, '1d', 10);
    const found = collectSamples(ai, symbol, bars, daily, 16, 24, '1h-years');
    samples.push(...found);
    const from = bars[0] ? new Date(bars[0].time).toISOString().slice(0, 10) : 'n/a';
    console.log(`${bars.length} bars ${from}→now → ${found.length} labeled`);
    await sleep(120);
  }

  for (const symbol of FOUR_HOUR) {
    process.stdout.write(`[YEARS] 4h ${symbol} ... `);
    try {
      const bars = await fetchBinanceRange(symbol, '4h', y6);
      const daily = await exchange.fetchKlines(symbol, '1d', 10);
      const found = collectSamples(ai, symbol, bars, daily, 4, 18, '4h-years');
      samples.push(...found);
      const from = bars[0] ? new Date(bars[0].time).toISOString().slice(0, 10) : 'n/a';
      console.log(`${bars.length} bars ${from}→now → ${found.length} labeled`);
    } catch (err) {
      console.log(`fail ${err.message}`);
    }
    await sleep(160);
  }

  for (const symbol of RECENT_1M) {
    process.stdout.write(`[YEARS] recent 1m ${symbol} ... `);
    try {
      const bars = await fetchBinanceRange(symbol, '1m', Date.now() - 5 * 24 * 60 * 60 * 1000);
      const daily = await exchange.fetchKlines(symbol, '1d', 8);
      const found = collectSamples(ai, symbol, bars, daily, 12, 90, '1m-recent');
      samples.push(...found);
      console.log(`${bars.length} bars → ${found.length} labeled`);
    } catch (err) {
      console.log(`fail ${err.message}`);
    }
    await sleep(160);
  }

  const usable = samples.filter(s => Array.isArray(s.features) && s.features.length === 15);
  const bySrc = {};
  for (const s of usable) bySrc[s.source] = (bySrc[s.source] || 0) + 1;
  console.log(`[YEARS] merged rows ${usable.length}`, bySrc);

  if (usable.length < 80) {
    console.error('[YEARS] Not enough samples. Model not overwritten.');
    process.exit(1);
  }

  const sorted = [...usable].sort((a, b) => a.t - b.t);
  const cut = Math.max(1, Math.floor(sorted.length * 0.85));
  const train = sorted.slice(0, cut);
  const test = sorted.slice(cut);

  const xs = tf.tensor2d(train.map(s => s.features));
  const ys = tf.tensor2d(train.map(s => [s.target]));
  const info = await ai.nnModel.fit(xs, ys, {
    epochs: 14,
    batchSize: Math.min(48, Math.max(16, Math.floor(train.length / 30))),
    shuffle: true,
    verbose: 0,
    validationSplit: 0.1
  });
  xs.dispose();
  ys.dispose();

  const trainM = accuracy(ai.nnModel, train);
  const testM = accuracy(ai.nnModel, test);
  const loss = info.history.loss[info.history.loss.length - 1];
  console.log(`[YEARS] train acc ${(trainM.acc * 100).toFixed(1)}% (${trainM.n})`);
  console.log(`[YEARS] test  acc ${(testM.acc * 100).toFixed(1)}% (${testM.n})  ← newest slice`);
  console.log(`[YEARS] loss ${Number(loss).toFixed(4)}`);

  if (fs.existsSync(NN_MODEL_FILE)) {
    fs.copyFileSync(NN_MODEL_FILE, path.join(__dirname, 'nn_model.pre-years.json'));
  }
  ai.nnReady = true;
  await ai.saveNeuralNet();

  fs.writeFileSync(path.join(__dirname, 'train_years_report.json'), JSON.stringify({
    savedAt: new Date().toISOString(),
    bySrc,
    rows: usable.length,
    train: trainM,
    test: testM,
    loss,
    note: 'Merged multi-year 1h/4h with recent 1m and closed trades. Test is the latest 15% by time.'
  }, null, 2));
  console.log('[YEARS] Saved nn_model.json and train_years_report.json');
  if (testM.acc < 0.53) {
    console.log('[YEARS] Test is near coin-flip. Years of data did not create a clear edge.');
  }
}

main().catch((err) => {
  console.error('[YEARS] Failed:', err);
  process.exit(1);
});

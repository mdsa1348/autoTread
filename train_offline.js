/**
 * Offline train the 15-input net on historical OHLCV.
 * Candles come from Binance (same feed as HF klines-binance) plus
 * static-klines 15m JSON. Features are computed with our SMC/RSI/ADX/VWAP engine.
 */
const fs = require('fs');
const path = require('path');
const { AIBrain } = require('./ai_engine');
const exchange = require('./exchange');
const { NN_MODEL_FILE } = require('./paths');

const BINANCE_1M = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'LTCUSDT',
  'DOTUSDT', 'SUIUSDT'
];

const STATIC_15M = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
  'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT'
];

const LOOKBACK = 120;
const HORIZON = 90;
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

function mondayDates(weeks) {
  const d = new Date();
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  d.setUTCHours(0, 0, 0, 0);
  const dates = [];
  for (let i = 0; i < weeks; i++) {
    const x = new Date(d.getTime() - i * 7 * 24 * 60 * 60 * 1000);
    dates.push(x.toISOString().slice(0, 10));
  }
  return dates;
}

function parseAnyKlines(raw) {
  let rows = raw;
  if (!Array.isArray(rows)) rows = raw?.klines || raw?.data || raw?.candles || [];
  if (!Array.isArray(rows)) return [];
  return rows.map((c) => {
    if (Array.isArray(c)) {
      return {
        time: Number(c[0]),
        open: Number(c[1]),
        high: Number(c[2]),
        low: Number(c[3]),
        close: Number(c[4]),
        volume: Number(c[5] || 0)
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

async function fetchBinanceHistory(symbol, interval, days) {
  const end = Date.now();
  const start = end - days * 24 * 60 * 60 * 1000;
  const out = [];
  let cursor = start;
  for (let guard = 0; guard < 8 && cursor < end; guard++) {
    const chunk = await exchange.fetchKlinesSince(symbol, interval, cursor, end);
    if (!chunk.length) break;
    out.push(...chunk);
    cursor = chunk[chunk.length - 1].time + 1;
    if (chunk.length < 800) break;
    await sleep(180);
  }
  return dedupBars(out);
}

async function fetchStatic15m(symbol) {
  const bars = [];
  for (const date of mondayDates(8)) {
    const url = `https://finom.github.io/static-klines/api/klines/15m/${symbol}/${date}.json`;
    try {
      const raw = await fetchJson(url);
      bars.push(...parseAnyKlines(raw));
    } catch {
      /* week file may not exist */
    }
    await sleep(80);
  }
  return dedupBars(bars);
}

function simulateLabel(bars, idx, side) {
  const entry = bars[idx].close;
  const last = Math.min(bars.length - 1, idx + HORIZON);
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

function collectSamples(ai, symbol, bars, daily, step) {
  const samples = [];
  if (!bars || bars.length < LOOKBACK + HORIZON + 5) return samples;
  const start = LOOKBACK;
  const end = bars.length - HORIZON;
  for (let i = start; i < end; i += step) {
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
    const label = simulateLabel(bars, i, side);
    if (label == null) continue;
    samples.push({
      t: bars[i].time,
      symbol,
      side,
      features: analysis.features,
      target: label,
      source: 'ohlcv'
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

function splitByTime(samples) {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const cut = Math.max(1, Math.floor(sorted.length * 0.8));
  return { train: sorted.slice(0, cut), test: sorted.slice(cut) };
}

function accuracy(model, rows, threshold = 0.5) {
  if (!rows.length) return { n: 0, acc: 0, hits: 0 };
  const xs = require('@tensorflow/tfjs').tensor2d(rows.map(r => r.features));
  const pred = model.predict(xs);
  const probs = Array.from(pred.dataSync());
  xs.dispose();
  pred.dispose();
  let hits = 0;
  for (let i = 0; i < rows.length; i++) {
    const guess = probs[i] >= threshold ? 1 : 0;
    if (guess === rows[i].target) hits++;
  }
  return { n: rows.length, hits, acc: hits / rows.length };
}

async function main() {
  console.log('[TRAIN] Building samples from Binance 1m + static-klines 15m + closed-trade backup');
  const ai = new AIBrain({});
  await ai.ready();
  ai.nnModel = ai.buildFreshNetwork();
  ai.nnReady = false;

  const samples = loadBackupTrades();
  console.log(`[TRAIN] Backup closed trades with features: ${samples.length}`);

  for (const symbol of BINANCE_1M) {
    process.stdout.write(`[TRAIN] Binance 1m ${symbol} ... `);
    try {
      const bars = await fetchBinanceHistory(symbol, '1m', 5);
      const daily = await exchange.fetchKlines(symbol, '1d', 8);
      const found = collectSamples(ai, symbol, bars, daily, 10);
      samples.push(...found);
      console.log(`${bars.length} bars → ${found.length} labeled`);
    } catch (err) {
      console.log(`fail ${err.message}`);
    }
    await sleep(200);
  }

  let staticOk = 0;
  for (const symbol of STATIC_15M) {
    process.stdout.write(`[TRAIN] static-klines 15m ${symbol} ... `);
    try {
      const bars = await fetchStatic15m(symbol);
      if (bars.length < LOOKBACK + HORIZON) {
        console.log(`${bars.length} bars (skip)`);
        continue;
      }
      const daily = await exchange.fetchKlines(symbol, '1d', 8);
      const found = collectSamples(ai, symbol, bars, daily, 2);
      samples.push(...found);
      staticOk += found.length;
      console.log(`${bars.length} bars → ${found.length} labeled`);
    } catch (err) {
      console.log(`fail ${err.message}`);
    }
  }
  console.log(`[TRAIN] static-klines labeled rows: ${staticOk}`);

  const usable = samples.filter(s => Array.isArray(s.features) && s.features.length === 15);
  console.log(`[TRAIN] Total labeled rows: ${usable.length}`);
  if (usable.length < 40) {
    console.error('[TRAIN] Not enough samples. Aborting without overwriting nn_model.json');
    process.exit(1);
  }

  const { train, test } = splitByTime(usable);
  const tf = require('@tensorflow/tfjs');
  const xs = tf.tensor2d(train.map(s => s.features));
  const ys = tf.tensor2d(train.map(s => [s.target]));
  const info = await ai.nnModel.fit(xs, ys, {
    epochs: 12,
    batchSize: Math.min(32, Math.max(8, Math.floor(train.length / 20))),
    shuffle: true,
    verbose: 0,
    validationSplit: 0.1
  });
  xs.dispose();
  ys.dispose();

  const trainM = accuracy(ai.nnModel, train);
  const testM = accuracy(ai.nnModel, test);
  const loss = info.history.loss[info.history.loss.length - 1];
  console.log(`[TRAIN] train acc ${(trainM.acc * 100).toFixed(1)}% (${trainM.n})`);
  console.log(`[TRAIN] test  acc ${(testM.acc * 100).toFixed(1)}% (${testM.n})  ← later days, not trained`);
  console.log(`[TRAIN] loss ${Number(loss).toFixed(4)}`);

  if (fs.existsSync(NN_MODEL_FILE)) {
    fs.copyFileSync(NN_MODEL_FILE, path.join(__dirname, 'nn_model.pre-offline.json'));
  }
  ai.nnReady = true;
  await ai.saveNeuralNet();

  const report = {
    savedAt: new Date().toISOString(),
    sources: {
      binance1m: BINANCE_1M,
      staticKlines15m: STATIC_15M,
      backupTrades: samples.filter(s => s.source === 'closed-backup').length
    },
    rows: usable.length,
    train: trainM,
    test: testM,
    loss,
    note: 'Test accuracy near 50% means no usable edge after fees. Do not treat this as RL.'
  };
  fs.writeFileSync(path.join(__dirname, 'train_report.json'), JSON.stringify(report, null, 2));
  console.log('[TRAIN] Saved nn_model.json and train_report.json');
  if (testM.acc < 0.53) {
    console.log('[TRAIN] Test is coin-flip range. Model saved, but it is not a proven edge.');
  }
}

main().catch((err) => {
  console.error('[TRAIN] Failed:', err);
  process.exit(1);
});

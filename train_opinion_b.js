/**
 * Train the second-opinion net on a different question than model A:
 * will price be higher (LONG) or lower (SHORT) ~20 bars later after fees?
 */
const { AIBrain } = require('./ai_engine');
const exchange = require('./exchange');
const secondOpinion = require('./second_opinion');
const { WATCHED_COINS } = require('./coins');

const SYMBOLS = WATCHED_COINS;
const LOOKBACK = 120;
const AHEAD = 20;
const FEE = 0.001;
const FLAGS = { smcEnabled: true, useSessionLevels: true, usePDHPDL: true, useNeuralNet: false };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const ai = new AIBrain({});
  await ai.ready();
  const model = secondOpinion.buildNet();
  const rows = [];

  for (const symbol of SYMBOLS) {
    process.stdout.write(`[OPINION-B] ${symbol} ... `);
    const end = Date.now();
    const start = end - 4 * 24 * 60 * 60 * 1000;
    const bars = await exchange.fetchKlinesSince(symbol, '1m', start, end);
    const daily = await exchange.fetchKlines(symbol, '1d', 8);
    let n = 0;
    if (bars.length >= LOOKBACK + AHEAD + 5) {
      for (let i = LOOKBACK; i < bars.length - AHEAD; i += 12) {
        const window = bars.slice(i - LOOKBACK + 1, i + 1);
        let analysis;
        try { analysis = ai.analyzeMarket(window, daily, FLAGS); } catch { continue; }
        if (!analysis?.features || analysis.features.length !== 15) continue;
        const now = bars[i].close;
        const later = bars[i + AHEAD].close;
        const up = (later - now) / now - 2 * FEE;
        rows.push({ features: analysis.features, target: up > 0 ? 1 : 0 });
        n++;
      }
    }
    console.log(`${bars.length} bars → ${n} rows`);
    await sleep(160);
  }

  console.log(`[OPINION-B] ${rows.length} direction samples`);
  if (rows.length < 40) {
    console.error('[OPINION-B] Not enough samples');
    process.exit(1);
  }

  const tf = require('@tensorflow/tfjs');
  const cut = Math.floor(rows.length * 0.8);
  const train = rows.slice(0, cut);
  const test = rows.slice(cut);
  const xs = tf.tensor2d(train.map(r => r.features));
  const ys = tf.tensor2d(train.map(r => [r.target]));
  await model.fit(xs, ys, { epochs: 10, batchSize: 32, shuffle: true, verbose: 0 });
  xs.dispose();
  ys.dispose();

  const tx = tf.tensor2d(test.map(r => r.features));
  const pred = model.predict(tx);
  const probs = Array.from(pred.dataSync());
  tx.dispose();
  pred.dispose();
  let hits = 0;
  for (let i = 0; i < test.length; i++) {
    if ((probs[i] >= 0.5 ? 1 : 0) === test[i].target) hits++;
  }
  const acc = hits / test.length;
  await secondOpinion.saveModelB(model);
  console.log(`[OPINION-B] test acc ${(acc * 100).toFixed(1)}% (${test.length}) — saved nn_model_b.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Bootstrap REINFORCE from closed trades + a slice of 1h history.
 * LONG/SHORT get real PnL rewards. HOLD is rewarded when a similar setup lost.
 */
const fs = require('fs');
const path = require('path');
const { AIBrain } = require('./ai_engine');
const exchange = require('./exchange');
const { rlPolicy } = require('./rl_policy');

const FLAGS = { smcEnabled: true, useSessionLevels: true, usePDHPDL: true, useNeuralNet: false };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadBackup() {
  const file = path.join(__dirname, 'data_store.pre-restart.json');
  const live = path.join(__dirname, 'data_store.json');
  const rows = [];
  for (const f of [file, live]) {
    if (!fs.existsSync(f)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const t of raw.broker?.tradeHistory || []) {
        if (!Array.isArray(t.analysis?.features) || t.analysis.features.length !== 15) continue;
        const reward = Math.max(-0.06, Math.min(0.06, (t.profitPercent || 0) / 100));
        const action = t.side === 'SHORT' ? 'SHORT' : 'LONG';
        rows.push({ features: t.analysis.features, action, reward });
        if (reward < 0) rows.push({ features: t.analysis.features, action: 'HOLD', reward: Math.min(0.012, -reward * 0.5) });
      }
    } catch { /* skip broken store */ }
  }
  return rows;
}

async function main() {
  const ai = new AIBrain({});
  await ai.ready();
  if (!rlPolicy.ready) await rlPolicy.init();

  const rows = loadBackup();
  console.log(`[RL] closed-trade lessons: ${rows.length}`);

  for (const symbol of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
    const start = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const bars = await exchange.fetchKlinesSince(symbol, '1h', start);
    const daily = await exchange.fetchKlines(symbol, '1d', 8);
    let n = 0;
    for (let i = 120; i < bars.length - 24; i += 10) {
      const window = bars.slice(i - 119, i + 1);
      let analysis;
      try { analysis = ai.analyzeMarket(window, daily, FLAGS); } catch { continue; }
      if (!analysis?.features || (analysis.signal !== 'BUY' && analysis.signal !== 'SHORT')) continue;
      const entry = bars[i].close;
      const side = analysis.signal === 'SHORT' ? 'SHORT' : 'LONG';
      let hit = null;
      for (let j = i + 1; j <= i + 24; j++) {
        const pnl = side === 'SHORT'
          ? (entry - bars[j].close) / entry - 0.002
          : (bars[j].close - entry) / entry - 0.002;
        if (pnl <= -0.008) { hit = -0.008; break; }
        if (pnl >= 0.016) { hit = 0.016; break; }
      }
      if (hit == null) continue;
      rows.push({ features: analysis.features, action: side, reward: hit });
      if (hit < 0) rows.push({ features: analysis.features, action: 'HOLD', reward: 0.006 });
      n++;
    }
    console.log(`[RL] ${symbol} 1h setups ${n}`);
    await sleep(150);
  }

  console.log(`[RL] training ${rows.length} reward steps`);
  if (rows.length < 20) {
    console.error('[RL] Not enough lessons');
    process.exit(1);
  }
  for (const row of rows) {
    await rlPolicy.learn(row.features, row.action, row.reward);
  }
  await rlPolicy.save();
  console.log(`[RL] Saved rl_policy.json updates=${rlPolicy.updates} baseline=${rlPolicy.baseline.toFixed(4)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

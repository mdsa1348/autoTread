/**
 * backtest_compare.js — Comparative backtest: AutoTread vs baselines
 *
 * Runs 3 strategies on the same historical data and outputs a side-by-side report:
 *   1. AutoTread    — the full rules + MTF + SMC engine
 *   2. MA-Crossover — simple 20/50 EMA golden/death cross
 *   3. Buy & Hold   — buy at bar[0], hold to bar[N]
 *
 * Usage:
 *   node backtest_compare.js
 *   npm run compare
 *
 * Output:
 *   Prints a rich comparison table to stdout
 *   Writes D:\AutoTread_data\compare_report.json (or DATA_DIR if D: absent)
 */

const { runBacktest, summarize, aggregate } = require('./backtest');
const { fetchKlines } = require('./exchange');
const { PaperBroker } = require('./paper_broker');
const { LARGE_DATA_DIR } = require('./paths');
const fs   = require('fs');
const path = require('path');

const REPORT_FILE = path.join(LARGE_DATA_DIR, 'compare_report.json');

// Symbols to compare on
const COMPARE_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];
const INITIAL_BALANCE = 10000;
const FEE_RATE = 0.001; // 0.1% per trade (Binance maker)

// ── EMA helper ────────────────────────────────────────────────────────────────
function ema(values, period) {
  if (!values || values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(...new Array(period - 1).fill(null));
  out.push(e);
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

// ── Strategy 2: MA-Crossover (20/50 EMA) ──────────────────────────────────────
function runMACrossover(candles, initialBalance = INITIAL_BALANCE) {
  if (!candles || candles.length < 55) {
    return { trades: 0, winRate: 0, netProfit: 0, netProfitPercent: 0, profitFactor: null, maxDrawdownPercent: 0, fees: 0 };
  }

  const closes = candles.map(c => c.close);
  const fast = ema(closes, 20);
  const slow = ema(closes, 50);

  let equity = initialBalance;
  let peak = equity;
  let maxDd = 0;
  let totalFees = 0;
  const trades = [];

  let position = null; // { side, entryPrice, qty }

  for (let i = 51; i < candles.length; i++) {
    const f = fast[i];
    const fp = fast[i - 1];
    const s = slow[i];
    const sp = slow[i - 1];
    if (!f || !fp || !s || !sp) continue;

    const price = candles[i].close;
    const isGolden = f > s && fp <= sp; // crossover up
    const isDeath  = f < s && fp >= sp; // crossover down

    if (isGolden && !position) {
      // Open LONG
      const qty = (equity * 0.1) / price; // 10% allocation
      const fee = qty * price * FEE_RATE;
      totalFees += fee;
      equity -= fee;
      position = { side: 'LONG', entryPrice: price, qty, entryEquity: equity };
    } else if (isDeath && position?.side === 'LONG') {
      // Close LONG
      const pnl = (price - position.entryPrice) * position.qty;
      const fee = position.qty * price * FEE_RATE;
      totalFees += fee;
      equity += pnl - fee;
      trades.push({ netProfit: pnl - fee });
      if (equity > peak) peak = equity;
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
      position = null;
    } else if (isDeath && !position) {
      // Open SHORT
      const qty = (equity * 0.1) / price;
      const fee = qty * price * FEE_RATE;
      totalFees += fee;
      equity -= fee;
      position = { side: 'SHORT', entryPrice: price, qty };
    } else if (isGolden && position?.side === 'SHORT') {
      // Close SHORT
      const pnl = (position.entryPrice - price) * position.qty;
      const fee = position.qty * price * FEE_RATE;
      totalFees += fee;
      equity += pnl - fee;
      trades.push({ netProfit: pnl - fee });
      if (equity > peak) peak = equity;
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
      position = null;
    }
  }

  // Close any open position at last bar
  if (position) {
    const price = candles[candles.length - 1].close;
    const pnl = position.side === 'LONG'
      ? (price - position.entryPrice) * position.qty
      : (position.entryPrice - price) * position.qty;
    const fee = position.qty * price * FEE_RATE;
    totalFees += fee;
    equity += pnl - fee;
    trades.push({ netProfit: pnl - fee });
  }

  const wins = trades.filter(t => t.netProfit > 0);
  const losses = trades.filter(t => t.netProfit <= 0);
  const grossWin  = wins.reduce((s, t) => s + t.netProfit, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netProfit, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? null : 0);

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? Math.round(wins.length / trades.length * 100) : 0,
    netProfit: Number((equity - initialBalance).toFixed(2)),
    netProfitPercent: Number(((equity - initialBalance) / initialBalance * 100).toFixed(2)),
    profitFactor: pf == null ? null : Number(pf.toFixed(2)),
    maxDrawdownPercent: Number(maxDd.toFixed(2)),
    fees: Number(totalFees.toFixed(2)),
    finalEquity: Number(equity.toFixed(2))
  };
}

// ── Strategy 3: Buy & Hold ────────────────────────────────────────────────────
function runBuyHold(candles, initialBalance = INITIAL_BALANCE) {
  if (!candles || candles.length < 2) {
    return { netProfit: 0, netProfitPercent: 0, maxDrawdownPercent: 0, fees: 0 };
  }
  const entry = candles[0].close;
  const exit  = candles[candles.length - 1].close;
  const allocUSD = initialBalance * 0.9; // 90% deployed, 10% reserve
  const qty = allocUSD / entry;
  const entryFee = qty * entry * FEE_RATE;
  const exitFee  = qty * exit  * FEE_RATE;
  const pnl = (exit - entry) * qty - entryFee - exitFee;
  const finalEquity = initialBalance + pnl;

  // Max drawdown via equity walk
  let peak = initialBalance;
  let maxDd = 0;
  let equity = initialBalance;
  for (const c of candles) {
    const currentEquity = initialBalance - allocUSD + qty * c.close;
    if (currentEquity > peak) peak = currentEquity;
    const dd = ((peak - currentEquity) / peak) * 100;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    trades: 1,
    wins: pnl > 0 ? 1 : 0,
    losses: pnl <= 0 ? 1 : 0,
    winRate: pnl > 0 ? 100 : 0,
    netProfit: Number(pnl.toFixed(2)),
    netProfitPercent: Number((pnl / initialBalance * 100).toFixed(2)),
    profitFactor: null,
    maxDrawdownPercent: Number(maxDd.toFixed(2)),
    fees: Number((entryFee + exitFee).toFixed(2)),
    finalEquity: Number(finalEquity.toFixed(2))
  };
}

// ── Pretty table printer ──────────────────────────────────────────────────────
function printRow(label, at, ma, bh) {
  const fmt = v => v == null ? '  N/A  ' : String(v).padStart(7);
  console.log(
    `  ${label.padEnd(24)} │ ${fmt(at)} │ ${fmt(ma)} │ ${fmt(bh)}`
  );
}

function printReport(report) {
  const { autoTread: at, maCrossover: ma, buyHold: bh, symbols, generatedAt } = report;
  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  AutoTread vs Baselines — Backtest Comparison Report');
  console.log(`  Symbols: ${symbols.join(', ')}`);
  console.log(`  Generated: ${generatedAt}`);
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  ${'Metric'.padEnd(24)} │ AutoTread │ MA 20/50 │ Buy&Hold`);
  console.log('  ' + '─'.repeat(24) + '─┼─────────┼──────────┼─────────');
  printRow('Trades',             at.trades,              ma.trades,              bh.trades);
  printRow('Win Rate (%)',        at.winRate,             ma.winRate,             bh.winRate);
  printRow('Net Profit ($)',      at.netProfit,           ma.netProfit,           bh.netProfit);
  printRow('Net Profit (%)',      at.netProfitPercent,    ma.netProfitPercent,    bh.netProfitPercent);
  printRow('Profit Factor',       at.profitFactor,        ma.profitFactor,        bh.profitFactor);
  printRow('Max Drawdown (%)',    at.maxDrawdownPercent,  ma.maxDrawdownPercent,  bh.maxDrawdownPercent);
  printRow('Fees Paid ($)',       at.fees,                ma.fees,                bh.fees);
  printRow('Final Equity ($)',    at.finalEquity,         ma.finalEquity,         bh.finalEquity);
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // ── Verdict ──────────────────────────────────────────────────────────────
  const best = [
    { name: 'AutoTread',    pnl: at.netProfitPercent },
    { name: 'MA-Crossover', pnl: ma.netProfitPercent },
    { name: 'Buy & Hold',   pnl: bh.netProfitPercent }
  ].sort((a, b) => b.pnl - a.pnl);

  console.log(`  🏆 Best performer: ${best[0].name} (${best[0].pnl}%)`);
  if (best[0].name === 'AutoTread') {
    console.log('  ✅ AutoTread beats both baselines on this dataset.');
    if (at.maxDrawdownPercent <= bh.maxDrawdownPercent) {
      console.log('  ✅ Lower drawdown than buy-and-hold — risk-adjusted edge confirmed.');
    } else {
      console.log(`  ⚠️  Higher drawdown (${at.maxDrawdownPercent}%) than buy-and-hold (${bh.maxDrawdownPercent}%) — watch risk.`);
    }
  } else {
    console.log(`  ⚠️  AutoTread underperforms ${best[0].name} here. Review settings or add more history.`);
  }
  console.log(`  ⚠️  Backtest ≠ live performance. Slippage, spreads, and market regime shifts are not modelled.\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function runComparison(options = {}) {
  const symbols = options.symbols || COMPARE_SYMBOLS;
  const initialBalance = options.initialBalance || INITIAL_BALANCE;
  console.log(`\n[COMPARE] Fetching ${symbols.length} symbols × 5m history...`);

  // Fetch candles for baselines
  const candlesBySymbol = {};
  for (const sym of symbols) {
    try {
      const c5 = await fetchKlines(sym, '5m', 500);
      candlesBySymbol[sym] = c5 || [];
      console.log(`[COMPARE] ${sym}: ${c5.length} bars`);
    } catch (err) {
      console.error(`[COMPARE] ${sym} fetch failed:`, err.message);
      candlesBySymbol[sym] = [];
    }
  }

  // Run AutoTread backtest
  console.log('\n[COMPARE] Running AutoTread backtest...');
  let atResult;
  try {
    atResult = await runBacktest({ symbols, initialBalance, fiveMinBars: 500 });
  } catch (err) {
    console.error('[COMPARE] AutoTread backtest failed:', err.message);
    atResult = { trades: 0, winRate: 0, netProfit: 0, netProfitPercent: 0, profitFactor: null, maxDrawdownPercent: 0, fees: 0, finalEquity: initialBalance };
  }

  // Run MA-Crossover on aggregated candles across all symbols
  console.log('[COMPARE] Running MA-Crossover baseline...');
  const maResults = symbols.map(sym => runMACrossover(candlesBySymbol[sym], initialBalance / symbols.length));
  const maAgg = aggregateResults(maResults, initialBalance);

  // Run Buy & Hold on aggregated candles
  console.log('[COMPARE] Running Buy & Hold baseline...');
  const bhResults = symbols.map(sym => runBuyHold(candlesBySymbol[sym], initialBalance / symbols.length));
  const bhAgg = aggregateResults(bhResults, initialBalance);

  const report = {
    generatedAt: new Date().toISOString(),
    symbols,
    initialBalance,
    barsPerSymbol: Math.max(...symbols.map(s => (candlesBySymbol[s] || []).length)),
    autoTread: {
      trades: atResult.trades,
      wins: atResult.wins,
      losses: atResult.losses,
      winRate: atResult.winRate,
      netProfit: atResult.netProfit,
      netProfitPercent: atResult.netProfitPercent,
      profitFactor: atResult.profitFactor,
      maxDrawdownPercent: atResult.maxDrawdownPercent,
      fees: atResult.fees,
      finalEquity: Number((initialBalance + atResult.netProfit).toFixed(2))
    },
    maCrossover: maAgg,
    buyHold: bhAgg
  };

  // Save report
  try {
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
    console.log(`\n[COMPARE] Report saved → ${REPORT_FILE}`);
  } catch (err) {
    console.error('[COMPARE] Could not save report:', err.message);
  }

  printReport(report);
  return report;
}

function aggregateResults(results, initialBalance) {
  const total = results.reduce((acc, r) => {
    acc.trades             += r.trades             || 0;
    acc.wins               += r.wins               || 0;
    acc.losses             += r.losses             || 0;
    acc.netProfit          += r.netProfit          || 0;
    acc.fees               += r.fees               || 0;
    acc.maxDrawdownPercent  = Math.max(acc.maxDrawdownPercent, r.maxDrawdownPercent || 0);
    return acc;
  }, { trades: 0, wins: 0, losses: 0, netProfit: 0, fees: 0, maxDrawdownPercent: 0 });

  const winRate = total.trades ? Math.round(total.wins / total.trades * 100) : 0;
  const grossWin  = results.flatMap(r => r.wins  || 0).reduce((a, b) => a + b, 0);
  const grossLoss = results.flatMap(r => r.losses || 0).reduce((a, b) => a + b, 0);

  return {
    trades: total.trades,
    wins: total.wins,
    losses: total.losses,
    winRate,
    netProfit: Number(total.netProfit.toFixed(2)),
    netProfitPercent: Number((total.netProfit / initialBalance * 100).toFixed(2)),
    profitFactor: null, // aggregated PF not meaningful here
    maxDrawdownPercent: Number(total.maxDrawdownPercent.toFixed(2)),
    fees: Number(total.fees.toFixed(2)),
    finalEquity: Number((initialBalance + total.netProfit).toFixed(2))
  };
}

// ── CLI entry ─────────────────────────────────────────────────────────────────
if (require.main === module) {
  runComparison()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('[COMPARE] Fatal:', err);
      process.exit(1);
    });
}

module.exports = { runComparison, runMACrossover, runBuyHold };

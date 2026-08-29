/**
 * Predict the next 5 minutes, then check the outcome.
 * Hits raise confidence for the same side; misses cut it.
 * 1m candles are unchanged — this sits on top of them.
 */

const HORIZON_MS = 5 * 60 * 1000;
const MIN_MOVE = 0.0005; // 0.05% — ignore flat noise
const MAX_RECENT = 120;

function predictNext5m(analysis) {
  let score = 0;
  const m5 = analysis?.mtf && analysis.mtf['5m'];
  if (m5 === 'BULLISH') score += 2;
  else if (m5 === 'BEARISH') score -= 2;
  const sig = analysis?.signal;
  if (sig === 'BUY') score += 1;
  else if (sig === 'SHORT' || sig === 'SELL') score -= 1;
  const nn = analysis?.nnBullishProbability;
  if (nn != null) {
    if (nn >= 58) score += 1;
    else if (nn <= 42) score -= 1;
  }
  const smc = analysis?.smcStructure?.smcSignal || analysis?.smc?.smcSignal || '';
  if (/BUY|BULL/.test(smc)) score += 1;
  if (/SHORT|SELL|BEAR/.test(smc)) score -= 1;
  if (score >= 2) return 'LONG';
  if (score <= -2) return 'SHORT';
  return 'HOLD';
}

class FiveMinBook {
  constructor(saved = null) {
    this.pending = saved?.pending || {};
    this.hits = saved?.hits || 0;
    this.misses = saved?.misses || 0;
    this.lastHit = saved?.lastHit || {};
    this.recent = Array.isArray(saved?.recent) ? saved.recent : [];
  }

  accuracy() {
    const n = this.hits + this.misses;
    return n ? this.hits / n : 0.5;
  }

  exportState() {
    return {
      pending: this.pending,
      hits: this.hits,
      misses: this.misses,
      lastHit: this.lastHit,
      recent: this.recent.slice(0, MAX_RECENT)
    };
  }

  observe(symbol, price, analysis) {
    const now = Date.now();
    const side = predictNext5m(analysis);
    const resolved = this._resolve(symbol, price, now);

    if ((side === 'LONG' || side === 'SHORT') && !this.pending[symbol]) {
      this.pending[symbol] = { t: now, side, px: price };
    }

    const lastHit = this.lastHit[symbol] || null;
    const lastHitAgeMs = lastHit ? now - lastHit.t : null;
    const lastHitFresh = lastHit && lastHitAgeMs != null && lastHitAgeMs < 12 * 60 * 1000;
    analysis.fiveMin = {
      side,
      lastHit: lastHitFresh ? lastHit.side : null,
      lastHitPct: lastHitFresh ? lastHit.pct : null,
      hits: this.hits,
      misses: this.misses,
      accuracy: Number(this.accuracy().toFixed(3)),
      resolved: resolved || null
    };
    return analysis.fiveMin;
  }

  _resolve(symbol, price, now) {
    const pred = this.pending[symbol];
    if (!pred || now - pred.t < HORIZON_MS) return null;
    delete this.pending[symbol];
    const pct = pred.px > 0 ? (price - pred.px) / pred.px : 0;
    if (Math.abs(pct) < MIN_MOVE) {
      return { skipped: true, side: pred.side, pct };
    }
    const actual = pct > 0 ? 'LONG' : 'SHORT';
    const hit = actual === pred.side;
    if (hit) {
      this.hits++;
      this.lastHit[symbol] = { t: now, side: pred.side, pct };
    } else {
      this.misses++;
      if (this.lastHit[symbol] && this.lastHit[symbol].side === pred.side) {
        delete this.lastHit[symbol];
      }
    }
    const row = {
      t: new Date().toISOString(),
      s: symbol,
      side: pred.side,
      hit,
      pct: Number((pct * 100).toFixed(3))
    };
    this.recent.unshift(row);
    if (this.recent.length > MAX_RECENT) this.recent.length = MAX_RECENT;
    return row;
  }
}

module.exports = { FiveMinBook, predictNext5m, HORIZON_MS };

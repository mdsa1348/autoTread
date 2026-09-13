/**
 * Compact 1m analysis trail. Full scanner objects stay in RAM only;
 * this is what we persist so "how it went / why it broke" is not lost.
 */

const fs = require('fs');

const MAX_PER_SYMBOL = 1440; // 24h of 1-minute snapshots
const MAX_PATH_ON_TRADE = 180;
const MIN_ATR_PCT = 0.002; // 0.20% of price — 0.15% was still fee-thin on 1m tape

function slimAnalysis(a) {
  if (!a) return null;
  return {
    signal: a.signal,
    confidence: a.confidence,
    opportunityScore: a.opportunityScore,
    reasons: a.reasons,
    features: a.features || null,
    rawScores: a.rawScores || null,
    rsi: a.rsi,
    atr: a.atr,
    nnBullishProbability: a.nnBullishProbability,
    adx: a.adx ? { adx: a.adx.adx, isTrending: a.adx.isTrending } : null,
    smcStructure: a.smcStructure ? {
      smcSignal: a.smcStructure.smcSignal,
      structureState: a.smcStructure.structureState,
      lastCHoCH: a.smcStructure.lastCHoCH || null,
      lastBOS: a.smcStructure.lastBOS || null
    } : (a.smc || null),
    mtf: a.mtf || null,
    vwap: a.vwap ? { vwapBias: a.vwap.vwapBias, vwap: a.vwap.vwap } : null,
    entrySight: a.entrySight || null,
    fiveMin: a.fiveMin ? {
      side: a.fiveMin.side,
      lastHit: a.fiveMin.lastHit,
      accuracy: a.fiveMin.accuracy
    } : null
  };
}

function compactSnapshot(symbol, price, analysis, extra = {}) {
  const smc = analysis?.smcStructure;
  const mtf = analysis?.mtf;
  return {
    t: extra.t || new Date().toISOString(),
    s: symbol,
    px: price,
    sig: analysis?.signal || 'HOLD',
    conf: analysis?.confidence ?? null,
    opp: analysis?.opportunityScore ?? null,
    rsi: analysis?.rsi != null ? Number(analysis.rsi.toFixed(1)) : null,
    adx: analysis?.adx?.adx != null ? Number(analysis.adx.adx.toFixed(1)) : null,
    chop: analysis?.adx ? !analysis.adx.isTrending : null,
    smc: smc?.smcSignal || null,
    struct: smc?.structureState || null,
    mtf1m: mtf?.['1m'] || null,
    mtf5m: mtf?.['5m'] || null,
    mtf15m: mtf?.['15m'] || null,
    mtf1h: mtf?.['1h'] || null,
    mtf4h: mtf?.['4h'] || null,
    mtfOk: mtf ? !!mtf.isConfirmed : null,
    block: mtf?.mtfRejectionReason || extra.block || null,
    f5: analysis?.fiveMin?.side || null,
    f5hit: analysis?.fiveMin?.lastHit || null,
    why: (analysis?.reasons || '').slice(0, 160),
    pnl: extra.pnl != null ? Number(Number(extra.pnl).toFixed(3)) : null
  };
}

function explainBreak({ side, entryAnalysis, exitAnalysis, exitReason, pnlPct, path }) {
  const bits = [];
  if (exitReason) bits.push(exitReason);

  const entrySig = entryAnalysis?.signal;
  const exitSig = exitAnalysis?.signal;
  if (side === 'LONG' && entrySig === 'BUY' && exitSig === 'SHORT') {
    bits.push('1m signal flipped against the long');
  } else if (side === 'SHORT' && (entrySig === 'SHORT' || entrySig === 'SELL') && exitSig === 'BUY') {
    bits.push('1m signal flipped against the short');
  } else if (exitSig === 'HOLD' && entrySig && entrySig !== 'HOLD') {
    bits.push('Setup faded to HOLD');
  }

  const mtf = exitAnalysis?.mtf;
  if (mtf && mtf.isConfirmed === false && mtf.mtfRejectionReason) {
    bits.push(mtf.mtfRejectionReason);
  }

  const entryTrend = entryAnalysis?.adx?.isTrending;
  const exitTrend = exitAnalysis?.adx?.isTrending;
  if (entryTrend && exitTrend === false) bits.push('ADX went chop — trend died');

  const entrySmc = entryAnalysis?.smcStructure?.smcSignal;
  const exitSmc = exitAnalysis?.smcStructure?.smcSignal;
  if (entrySmc && exitSmc && entrySmc !== exitSmc) {
    bits.push(`SMC ${entrySmc} → ${exitSmc}`);
  }

  if (path && path.length >= 2) {
    const pnls = path.map(p => p.pnl).filter(v => v != null);
    if (pnls.length) {
      const peak = Math.max(...pnls);
      const trough = Math.min(...pnls);
      if (pnlPct < 0 && peak >= 0.3) bits.push(`Gave back a +${peak.toFixed(2)}% peak`);
      if (pnlPct > 0 && trough <= -0.3) bits.push(`Recovered from ${trough.toFixed(2)}%`);
    }
  }

  if (exitAnalysis?.reasons && !String(exitReason || '').includes(exitAnalysis.reasons.slice(0, 40))) {
    bits.push(exitAnalysis.reasons.slice(0, 120));
  }

  return bits.filter(Boolean).join(' · ');
}

class MinuteBook {
  constructor() {
    this.rings = Object.create(null);
    this.lastMinuteKey = Object.create(null);
  }

  record(symbol, price, analysis, extra = {}) {
    if (!symbol || !analysis) return null;
    const snap = compactSnapshot(symbol, price, analysis, extra);
    const minuteKey = String(snap.t).slice(0, 16); // YYYY-MM-DDTHH:MM
    if (this.lastMinuteKey[symbol] === minuteKey) {
      const ring = this.rings[symbol];
      if (ring && ring.length) ring[ring.length - 1] = snap;
      return snap;
    }
    this.lastMinuteKey[symbol] = minuteKey;
    if (!this.rings[symbol]) this.rings[symbol] = [];
    this.rings[symbol].push(snap);
    if (this.rings[symbol].length > MAX_PER_SYMBOL) this.rings[symbol].shift();
    return snap;
  }

  pathSince(symbol, entryIso) {
    const ring = this.rings[symbol] || [];
    if (!entryIso) return ring.slice(-MAX_PATH_ON_TRADE);
    const start = new Date(entryIso).getTime();
    return ring.filter(s => new Date(s.t).getTime() >= start).slice(-MAX_PATH_ON_TRADE);
  }

  exportState() {
    return this.rings;
  }

  loadState(rings) {
    if (!rings || typeof rings !== 'object') return;
    this.rings = rings;
  }

  persist(file) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      updatedAt: new Date().toISOString(),
      rings: this.rings
    }));
    fs.copyFileSync(tmp, file);
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  }

  load(file) {
    if (!fs.existsSync(file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.loadState(raw.rings || raw);
    } catch (e) {
      console.error('[MINUTE] Failed to load analysis log:', e.message);
      try {
        const dest = String(file).replace(/\.json$/i, `.corrupt-${Date.now()}.json`);
        fs.copyFileSync(file, dest);
        console.error(`[MINUTE] Quarantined unreadable log → ${dest}`);
      } catch (copyErr) {
        console.error('[MINUTE] Could not quarantine corrupt log:', copyErr.message);
      }
    }
  }
}

function slimClosedForDisk(t) {
  if (!t) return t;
  const entrySight = t.entrySight || t.analysis?.entrySight || null;
  return {
    ...t,
    analysis: slimAnalysis(t.analysis),
    entrySight,
    whoAgreed: t.whoAgreed || entrySight?.confirms?.join('+') || entrySight?.summary || null,
    minutePath: Array.isArray(t.minutePath) ? t.minutePath.slice(-MAX_PATH_ON_TRADE) : t.minutePath
  };
}

function buildEntrySight(analysis, side) {
  const dir = side === 'SHORT' ? 'SHORT' : 'LONG';
  const m5 = analysis?.mtf?.['5m'] || null;
  const m15 = analysis?.mtf?.['15m'] || null;
  const h1 = analysis?.mtf?.['1h'] || null;
  const px = analysis?.currentPrice || 0;
  const atr = analysis?.atr || 0;
  const atrPct = px > 0 ? atr / px : 0;
  const m5Agree = dir === 'LONG' ? m5 !== 'BEARISH' : m5 !== 'BULLISH';
  const m15Agree = dir === 'LONG' ? m15 !== 'BEARISH' : m15 !== 'BULLISH';
  const h1Agree = dir === 'LONG' ? h1 !== 'BEARISH' : h1 !== 'BULLISH';
  const atrOk = atrPct >= MIN_ATR_PCT;
  const adxOk = !!(analysis?.adx?.isTrending);
  const smcSig = analysis?.smcStructure?.smcSignal || analysis?.smc?.smcSignal || null;
  const smcOk = !!(smcSig && smcSig !== 'NEUTRAL' && !/WEAK/.test(smcSig));
  const b = analysis?.secondOpinion;
  const bOk = dir === 'LONG' ? !!b?.agreeLong : !!b?.agreeShort;
  const rlAct = analysis?.rl?.action || null;
  const rlOk = rlAct === dir;
  const f = analysis?.fiveMin;
  // 5mF only votes when skill is clearly above coin-flip (live book sat ~46%)
  const fSkillOk = (f?.accuracy || 0) >= 0.52;
  const fOk = !!(f && fSkillOk && f.lastHit === dir);
  const votes = analysis?.marketContext?.votes || {};
  const fundOk = votes.FUND === dir;
  const lsrOk = votes.LSR === dir;
  const fngOk = votes.FNG === dir;
  const btcOk = votes.BTC === dir;
  const confirms = [];
  if (adxOk) confirms.push('ADX');
  if (smcOk) confirms.push('SMC');
  if (bOk) confirms.push('B');
  if (rlOk) confirms.push('RL');
  if (fOk) confirms.push('5mF');
  if (fundOk) confirms.push('FUND');
  if (lsrOk) confirms.push('LSR');
  if (fngOk) confirms.push('FNG');
  if (btcOk) confirms.push('BTC');
  // ADX+B alone printed 21% WR / −$25 live — need structure or external context
  const hasStructure = confirms.includes('SMC')
    || confirms.includes('RL')
    || confirms.includes('5mF')
    || confirms.includes('FUND')
    || confirms.includes('BTC');
  const agreed = [];
  if (m5Agree) agreed.push('5m');
  if (m15Agree) agreed.push('15m');
  if (h1Agree) agreed.push('1h');
  if (atrOk) agreed.push('ATR');
  agreed.push(...confirms);
  return {
    side: dir,
    m5,
    m15,
    h1,
    m5Agree,
    m15Agree,
    h1Agree,
    atrPct: Number(atrPct.toFixed(5)),
    atrOk,
    adxOk,
    smc: smcSig,
    smcOk,
    modelB: b?.side || null,
    modelBOk: bOk,
    rl: rlAct,
    rlOk,
    fiveMin: f ? { side: f.side, lastHit: f.lastHit, accuracy: f.accuracy } : null,
    fiveMinOk: fOk,
    fundOk,
    lsrOk,
    fngOk,
    btcOk,
    marketContext: analysis?.marketContext || null,
    confirms,
    confirmHits: confirms.length,
    hasStructure,
    agreed,
    summary: agreed.join('+') || 'none'
  };
}

function slimOpenForDisk(p) {
  if (!p) return p;
  const entrySight = p.entrySight || p.analysis?.entrySight || null;
  return {
    ...p,
    analysis: slimAnalysis(p.analysis),
    entrySight,
    whoAgreed: p.whoAgreed || entrySight?.confirms?.join('+') || entrySight?.summary || null,
    minutePath: Array.isArray(p.minutePath) ? p.minutePath.slice(-120) : p.minutePath
  };
}

module.exports = {
  MinuteBook,
  slimAnalysis,
  compactSnapshot,
  explainBreak,
  slimClosedForDisk,
  slimOpenForDisk,
  buildEntrySight,
  MIN_ATR_PCT,
  MAX_PATH_ON_TRADE
};

/**
 * Free public market context (no API keys).
 * Used as extra votes the bot can learn to trust or ignore.
 * - BTC regime from live 1m closes
 * - Binance futures funding + global long/short
 * - Crypto Fear & Greed (alternative.me)
 */

const FAPI = 'https://fapi.binance.com';
const FNG_URL = 'https://api.alternative.me/fng/?limit=1';

const cache = {
  funding: {},       // symbol -> { rate, mark, t }
  longShort: {},     // symbol -> { longRatio, shortRatio, t }
  fearGreed: null,   // { value, classification, t }
  btcRegime: null,   // { side, ret15m, ret1h, t }
  updatedAt: null
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function retFromCloses(closes, bars) {
  if (!closes || closes.length <= bars) return null;
  const a = closes[closes.length - 1 - bars];
  const b = closes[closes.length - 1];
  if (!a || !b) return null;
  return (b - a) / a;
}

function updateBtcRegime(btcCloses) {
  const ret15m = retFromCloses(btcCloses, 15);
  const ret1h = retFromCloses(btcCloses, 60);
  if (ret15m == null && ret1h == null) return cache.btcRegime;
  let side = 'HOLD';
  // Hard dump / melt-up on BTC — alts usually follow
  if ((ret15m != null && ret15m <= -0.004) || (ret1h != null && ret1h <= -0.012)) side = 'SHORT';
  else if ((ret15m != null && ret15m >= 0.004) || (ret1h != null && ret1h >= 0.012)) side = 'LONG';
  cache.btcRegime = {
    side,
    ret15m: ret15m != null ? Number((ret15m * 100).toFixed(3)) : null,
    ret1h: ret1h != null ? Number((ret1h * 100).toFixed(3)) : null,
    t: Date.now()
  };
  return cache.btcRegime;
}

async function refreshFearGreed() {
  try {
    const raw = await getJson(FNG_URL);
    const row = raw && raw.data && raw.data[0];
    if (!row) return;
    cache.fearGreed = {
      value: Number(row.value),
      classification: row.value_classification || '',
      t: Date.now()
    };
  } catch (e) {
    /* keep last */
  }
}

async function refreshFunding(symbol) {
  try {
    const data = await getJson(`${FAPI}/fapi/v1/premiumIndex?symbol=${symbol}`);
    const rate = parseFloat(data.lastFundingRate);
    if (!Number.isFinite(rate)) return;
    cache.funding[symbol] = {
      rate,
      ratePct: Number((rate * 100).toFixed(4)),
      mark: parseFloat(data.markPrice) || null,
      t: Date.now()
    };
  } catch (e) {
    /* keep last */
  }
}

async function refreshLongShort(symbol) {
  try {
    const data = await getJson(
      `${FAPI}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=1`
    );
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return;
    const longRatio = parseFloat(row.longAccount);
    const shortRatio = parseFloat(row.shortAccount);
    if (!Number.isFinite(longRatio)) return;
    cache.longShort[symbol] = {
      longRatio,
      shortRatio: Number.isFinite(shortRatio) ? shortRatio : 1 - longRatio,
      t: Date.now()
    };
  } catch (e) {
    /* keep last */
  }
}

/**
 * Periodic refresh for symbols we care about (BTC always + open/watchlist sample).
 */
async function refreshContext({ symbols = [], btcCloses = null } = {}) {
  if (btcCloses && btcCloses.length) updateBtcRegime(btcCloses);

  const now = Date.now();
  const fngAge = cache.fearGreed?.t ? now - cache.fearGreed.t : Infinity;
  if (fngAge > 10 * 60 * 1000) await refreshFearGreed();

  const uniq = [...new Set(['BTCUSDT', ...symbols])].slice(0, 12);
  for (const sym of uniq) {
    const fundAge = cache.funding[sym]?.t ? now - cache.funding[sym].t : Infinity;
    const lsAge = cache.longShort[sym]?.t ? now - cache.longShort[sym].t : Infinity;
    if (fundAge > 3 * 60 * 1000) {
      await refreshFunding(sym);
      await sleep(80);
    }
    if (lsAge > 5 * 60 * 1000) {
      await refreshLongShort(sym);
      await sleep(80);
    }
  }
  cache.updatedAt = new Date().toISOString();
  return snapshot();
}

function snapshot() {
  return {
    btcRegime: cache.btcRegime,
    fearGreed: cache.fearGreed,
    funding: { ...cache.funding },
    longShort: { ...cache.longShort },
    updatedAt: cache.updatedAt
  };
}

/**
 * Attach votes onto an analysis object for entrySight / learning.
 * FUND: crowded longs (high funding) favor SHORT; crowded shorts favor LONG.
 * BTC: regime agrees with trade side (alts).
 * FNG: extreme greed favors SHORT, extreme fear favors LONG (mild contrarian).
 * LSR: retail long crowded -> prefer SHORT, and vice versa.
 */
function attachContext(analysis, symbol) {
  const fund = cache.funding[symbol] || cache.funding.BTCUSDT || null;
  const ls = cache.longShort[symbol] || cache.longShort.BTCUSDT || null;
  const fng = cache.fearGreed;
  const btc = cache.btcRegime;

  let fundSide = 'HOLD';
  if (fund && Number.isFinite(fund.rate)) {
    if (fund.rate >= 0.00015) fundSide = 'SHORT';      // longs pay — crowded long
    else if (fund.rate <= -0.00005) fundSide = 'LONG'; // shorts pay — crowded short
  }

  let lsrSide = 'HOLD';
  if (ls && Number.isFinite(ls.longRatio)) {
    if (ls.longRatio >= 0.58) lsrSide = 'SHORT';
    else if (ls.longRatio <= 0.42) lsrSide = 'LONG';
  }

  let fngSide = 'HOLD';
  if (fng && Number.isFinite(fng.value)) {
    if (fng.value >= 75) fngSide = 'SHORT';
    else if (fng.value <= 25) fngSide = 'LONG';
  }

  analysis.marketContext = {
    funding: fund,
    longShort: ls,
    fearGreed: fng,
    btcRegime: btc,
    votes: {
      FUND: fundSide,
      LSR: lsrSide,
      FNG: fngSide,
      BTC: btc?.side || 'HOLD'
    }
  };
  return analysis.marketContext;
}

module.exports = {
  refreshContext,
  attachContext,
  updateBtcRegime,
  snapshot,
  cache
};

/**
 * news_feed.js — Live crypto news & sentiment aggregator
 *
 * Sources (all free / no API key required by default):
 *   1. CryptoPanic public RSS → headline sentiment scoring
 *   2. Alternative.me Fear & Greed 7-day trend (extends market_context.js)
 *   3. CoinGecko trending coins → GitHub-like signal of community momentum
 *   4. GitHub REST API → crypto repo stars/momentum (optional, no key for 60req/h)
 *
 * Exposes:
 *   refreshNews()          — call periodically (every 5–15 min)
 *   attachNewsContext(analysis, symbol) — appends analysis.newsContext
 *   snapshot()             — current cached state
 *   cache                  — raw cache object
 *
 * Vote injected into market_context votes:
 *   NEWS  — LONG / SHORT / HOLD  based on sentiment score
 */

const CRYPTOPANIC_RSS = 'https://cryptopanic.com/api/v1/posts/?auth_token=&public=true&format=json';
// CryptoPanic free public endpoint (no auth token = 60 req/day — ample for our cadence)
const CRYPTOPANIC_PUBLIC = 'https://cryptopanic.com/api/v1/posts/?public=true&format=json';
const COINGECKO_TRENDING  = 'https://api.coingecko.com/api/v3/search/trending';
const GITHUB_API          = 'https://api.github.com/search/repositories?q=crypto+trading+bot&sort=stars&per_page=5';
const FNG_HISTORY_URL     = 'https://api.alternative.me/fng/?limit=7'; // 7-day FNG

// ── Coin → symbol map for news matching ──────────────────────────────────────
const COIN_ALIASES = {
  BTC: 'BTCUSDT', BITCOIN: 'BTCUSDT',
  ETH: 'ETHUSDT', ETHEREUM: 'ETHUSDT',
  SOL: 'SOLUSDT', SOLANA: 'SOLUSDT',
  BNB: 'BNBUSDT',
  XRP: 'XRPUSDT', RIPPLE: 'XRPUSDT',
  DOGE: 'DOGEUSDT', DOGECOIN: 'DOGEUSDT',
  ADA: 'ADAUSDT', CARDANO: 'ADAUSDT',
  AVAX: 'AVAXUSDT', AVALANCHE: 'AVAXUSDT',
  LINK: 'LINKUSDT', CHAINLINK: 'LINKUSDT',
  MATIC: 'POLUSDT', POL: 'POLUSDT', POLYGON: 'POLUSDT',
  DOT: 'DOTUSDT', POLKADOT: 'DOTUSDT',
  PEPE: 'PEPEUSDT', SHIB: 'SHIBUSDT', SHIBA: 'SHIBUSDT',
  SUI: 'SUIUSDT', NEAR: 'NEARUSDT', ATOM: 'ATOMUSDT',
  ARB: 'ARBUSDT', ARBITRUM: 'ARBUSDT',
  OP: 'OPUSDT', OPTIMISM: 'OPUSDT',
  INJ: 'INJUSDT', INJECTIVE: 'INJUSDT',
  WLD: 'WLDUSDT', WORLDCOIN: 'WLDUSDT',
  TON: 'TONUSDT', TONCOIN: 'TONUSDT',
  AAVE: 'AAVEUSDT', UNI: 'UNIUSDT', UNISWAP: 'UNIUSDT',
  LTC: 'LTCUSDT', LITECOIN: 'LTCUSDT',
  BCH: 'BCHUSDT',
  RENDER: 'RENDERUSDT', FET: 'FETUSDT',
};

// ── Positive / negative keyword weights ──────────────────────────────────────
const BULL_WORDS = [
  'rally', 'surges', 'surge', 'bullish', 'breakout', 'breaks out', 'all-time high', 'ath',
  'approval', 'approved', 'etf', 'adoption', 'partnership', 'upgrade', 'launch', 'buy',
  'record', 'milestone', 'soars', 'climbs', 'rises', 'recovers', 'positive', 'gains',
  'accumulate', 'institutional', 'listing'
];
const BEAR_WORDS = [
  'crash', 'dump', 'dumps', 'bearish', 'breakdown', 'ban', 'banned', 'hack', 'hacked',
  'exploit', 'rug', 'scam', 'fraud', 'sec', 'lawsuit', 'arrested', 'sell', 'collapse',
  'plummets', 'falls', 'drops', 'fear', 'panic', 'liquidation', 'delist', 'delisted',
  'vulnerability', 'exploit'
];

function scoreHeadline(text) {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  for (const w of BULL_WORDS) if (lower.includes(w)) score += 1;
  for (const w of BEAR_WORDS) if (lower.includes(w)) score -= 1;
  return Math.max(-3, Math.min(3, score));
}

function extractSymbol(text) {
  if (!text) return null;
  const upper = text.toUpperCase();
  for (const [alias, sym] of Object.entries(COIN_ALIASES)) {
    // word boundary check
    const re = new RegExp(`\\b${alias}\\b`);
    if (re.test(upper)) return sym;
  }
  return null;
}

// ── Internal cache ────────────────────────────────────────────────────────────
const cache = {
  headlines: [],          // [{ title, symbol, score, publishedAt, source }]
  symbolScores: {},       // symbol → { score, count, t }
  globalScore: 0,         // −3..+3 aggregate
  fngTrend: null,         // { current, avg7d, trend: 'rising'|'falling'|'flat' }
  trendingCoins: [],      // [{ symbol, rank }]
  githubTrend: null,      // { stars, repos, t }
  updatedAt: null
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getJson(url, timeoutMs = 8000, headers = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'AutoTread/1.0', ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// ── 1. CryptoPanic headlines ──────────────────────────────────────────────────
async function refreshHeadlines() {
  try {
    const data = await getJson(CRYPTOPANIC_PUBLIC, 6000);
    const results = data?.results || [];
    const fresh = [];
    for (const item of results.slice(0, 30)) {
      const title = item.title || item.headline || '';
      const score = scoreHeadline(title);
      const sym = extractSymbol(title);
      fresh.push({
        title: title.slice(0, 120),
        symbol: sym,
        score,
        publishedAt: item.published_at || item.created_at || null,
        source: 'cryptopanic'
      });
    }
    cache.headlines = fresh;

    // Aggregate per symbol
    cache.symbolScores = {};
    for (const h of fresh) {
      if (!h.symbol) continue;
      const entry = cache.symbolScores[h.symbol] || { score: 0, count: 0 };
      entry.score += h.score;
      entry.count++;
      cache.symbolScores[h.symbol] = entry;
    }
    // Add timestamp
    for (const sym of Object.keys(cache.symbolScores)) {
      cache.symbolScores[sym].t = Date.now();
      cache.symbolScores[sym].avg = cache.symbolScores[sym].score / cache.symbolScores[sym].count;
    }

    // Global market sentiment
    const allScores = fresh.map(h => h.score);
    cache.globalScore = allScores.length
      ? allScores.reduce((a, b) => a + b, 0) / allScores.length
      : 0;
  } catch (e) {
    /* keep last; CryptoPanic occasionally rate-limits */
  }
}

// ── 2. FNG 7-day trend ────────────────────────────────────────────────────────
async function refreshFngTrend() {
  try {
    const raw = await getJson(FNG_HISTORY_URL, 5000);
    const rows = (raw?.data || []).slice(0, 7);
    if (!rows.length) return;
    const values = rows.map(r => Number(r.value)).filter(Number.isFinite);
    if (!values.length) return;
    const current = values[0];
    const avg7d = values.reduce((a, b) => a + b, 0) / values.length;
    const trend = values.length >= 3
      ? (values[0] > values[2] + 3 ? 'rising' : values[0] < values[2] - 3 ? 'falling' : 'flat')
      : 'flat';
    cache.fngTrend = { current, avg7d: Number(avg7d.toFixed(1)), trend, t: Date.now() };
  } catch (e) { /* keep last */ }
}

// ── 3. CoinGecko trending coins ───────────────────────────────────────────────
async function refreshTrending() {
  try {
    const data = await getJson(COINGECKO_TRENDING, 6000);
    const coins = (data?.coins || []).slice(0, 7);
    cache.trendingCoins = coins.map((c, i) => {
      const sym = c.item?.symbol?.toUpperCase();
      const mapped = sym ? (COIN_ALIASES[sym] || (sym + 'USDT')) : null;
      return { symbol: mapped, name: c.item?.name, rank: i + 1, t: Date.now() };
    }).filter(c => c.symbol);
  } catch (e) { /* keep last */ }
}

// ── 4. GitHub trending crypto repos ──────────────────────────────────────────
async function refreshGithub() {
  const token = process.env.GITHUB_TOKEN || '';
  const headers = token ? { Authorization: `token ${token}` } : {};
  try {
    const data = await getJson(GITHUB_API, 5000, headers);
    const items = (data?.items || []).slice(0, 5);
    cache.githubTrend = {
      repos: items.map(r => ({ name: r.full_name, stars: r.stargazers_count, lang: r.language })),
      totalStars: items.reduce((s, r) => s + (r.stargazers_count || 0), 0),
      t: Date.now()
    };
  } catch (e) { /* keep last; GitHub rate-limits unauthenticated at 60/hr */ }
}

// ── Main refresh orchestrator ─────────────────────────────────────────────────
let _lastHeadlineRefresh = 0;
let _lastFngRefresh      = 0;
let _lastTrendRefresh    = 0;
let _lastGithubRefresh   = 0;

async function refreshNews() {
  const now = Date.now();
  const promises = [];

  if (now - _lastHeadlineRefresh > 5 * 60 * 1000) {   // every 5m
    _lastHeadlineRefresh = now;
    promises.push(refreshHeadlines());
  }
  if (now - _lastFngRefresh > 15 * 60 * 1000) {        // every 15m
    _lastFngRefresh = now;
    promises.push(refreshFngTrend());
  }
  if (now - _lastTrendRefresh > 10 * 60 * 1000) {      // every 10m
    _lastTrendRefresh = now;
    promises.push(refreshTrending());
  }
  if (now - _lastGithubRefresh > 60 * 60 * 1000) {     // every 1h
    _lastGithubRefresh = now;
    promises.push(refreshGithub());
  }

  await Promise.allSettled(promises);
  cache.updatedAt = new Date().toISOString();
  return snapshot();
}

// ── Vote calculation ──────────────────────────────────────────────────────────
/**
 * Returns NEWS vote for a symbol: 'LONG' | 'SHORT' | 'HOLD'
 * Priority: symbol-specific score → global score → trending presence
 */
function getNewsVote(symbol) {
  // Symbol-specific score from recent headlines
  const sym = cache.symbolScores[symbol];
  if (sym && Date.now() - sym.t < 30 * 60 * 1000) {
    if (sym.avg >= 1)   return 'LONG';
    if (sym.avg <= -1)  return 'SHORT';
  }

  // Trending coin boost (being in top 7 trending is mildly bullish)
  const isTrending = cache.trendingCoins.some(c => c.symbol === symbol);
  if (isTrending && cache.globalScore >= 0) return 'LONG';

  // Global market sentiment fallback
  if (cache.globalScore >= 0.8)  return 'LONG';
  if (cache.globalScore <= -0.8) return 'SHORT';

  return 'HOLD';
}

/**
 * Attach news context and NEWS vote onto an analysis object.
 * Call this right after market_context.attachContext().
 */
function attachNewsContext(analysis, symbol) {
  const vote = getNewsVote(symbol);
  const symScore = cache.symbolScores[symbol] || null;
  const isTrending = cache.trendingCoins.some(c => c.symbol === symbol);
  const trendRank = cache.trendingCoins.find(c => c.symbol === symbol)?.rank ?? null;
  const recentHeadlines = cache.headlines
    .filter(h => h.symbol === symbol)
    .slice(0, 3);

  analysis.newsContext = {
    vote,
    symbolScore: symScore ? Number(symScore.avg.toFixed(2)) : null,
    globalScore: Number(cache.globalScore.toFixed(2)),
    isTrending,
    trendRank,
    fngTrend: cache.fngTrend,
    recentHeadlines,
    githubTrend: cache.githubTrend,
    updatedAt: cache.updatedAt
  };

  // Inject NEWS into market_context votes so analysis_log.js / ai_engine can train on it
  if (analysis.marketContext && analysis.marketContext.votes) {
    analysis.marketContext.votes.NEWS = vote;
  }

  return analysis.newsContext;
}

function snapshot() {
  return {
    globalScore: cache.globalScore,
    symbolScores: { ...cache.symbolScores },
    trendingCoins: [...cache.trendingCoins],
    fngTrend: cache.fngTrend,
    githubTrend: cache.githubTrend,
    headlineCount: cache.headlines.length,
    updatedAt: cache.updatedAt
  };
}

module.exports = {
  refreshNews,
  attachNewsContext,
  getNewsVote,
  snapshot,
  cache
};

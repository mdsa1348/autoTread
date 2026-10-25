/**
 * exchange_ccxt.js — Multi-exchange data layer using CCXT
 *
 * Works alongside the existing exchange.js (Binance-native). When
 * EXCHANGE_ID is NOT 'binance' (or unset), the data-fetch functions
 * here are used instead, giving access to OKX, Bybit, KuCoin, etc.
 *
 * When EXCHANGE_ID=binance this module is a thin pass-through so the
 * existing exchange.js keeps doing the actual REST + WS work.
 *
 * Usage in server.js / backtest.js:
 *   const { fetchKlines, fetchKlinesSince } = require('./exchange_ccxt');
 *
 * Env vars:
 *   EXCHANGE_ID      — ccxt exchange id (default: binance)
 *   EXCHANGE_API_KEY — optional, for authenticated endpoints
 *   EXCHANGE_SECRET  — optional
 *   EXCHANGE_SANDBOX — true/false (default: false)
 */

const path = require('path');
const fs   = require('fs');

// ── Load .env manually (mirrors exchange.js behaviour) ───────────────────────
function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvFile();

const EXCHANGE_ID  = (process.env.EXCHANGE_ID || 'binance').toLowerCase();
const IS_BINANCE   = EXCHANGE_ID === 'binance';
const API_KEY      = process.env.EXCHANGE_API_KEY || process.env.BINANCE_API_KEY || '';
const API_SECRET   = process.env.EXCHANGE_SECRET  || process.env.BINANCE_API_SECRET || '';
const USE_SANDBOX  = (process.env.EXCHANGE_SANDBOX || '').toLowerCase() === 'true';

console.log(`[CCXT] Exchange: ${EXCHANGE_ID}${USE_SANDBOX ? ' (sandbox)' : ''}`);

// ── CCXT instance (lazy-init so import doesn't throw if ccxt not installed) ──
let _exchange = null;

function getExchange() {
  if (_exchange) return _exchange;
  let ccxt;
  try {
    ccxt = require('ccxt');
  } catch (e) {
    throw new Error('[CCXT] ccxt package not installed. Run: npm install ccxt');
  }
  if (!ccxt[EXCHANGE_ID]) {
    throw new Error(`[CCXT] Unknown exchange "${EXCHANGE_ID}". Available: ${Object.keys(ccxt).slice(0, 20).join(', ')}, ...`);
  }
  const opts = {
    enableRateLimit: true,
    options: { defaultType: 'future' }
  };
  if (API_KEY)    opts.apiKey = API_KEY;
  if (API_SECRET) opts.secret = API_SECRET;

  _exchange = new ccxt[EXCHANGE_ID](opts);

  if (USE_SANDBOX && typeof _exchange.setSandboxMode === 'function') {
    _exchange.setSandboxMode(true);
    console.log('[CCXT] Sandbox mode ON');
  }
  return _exchange;
}

// ── CCXT interval strings ─────────────────────────────────────────────────────
const INTERVAL_MAP = {
  '1m':  '1m',
  '5m':  '5m',
  '15m': '15m',
  '1h':  '1h',
  '4h':  '4h',
  '1d':  '1d'
};

/**
 * Convert a USDT symbol like "BTCUSDT" to a CCXT market symbol "BTC/USDT".
 * Most exchanges accept "BTC/USDT:USDT" for perpetual futures, but we try
 * the simpler form first for maximum compatibility.
 */
function toCcxtSymbol(symbol) {
  if (symbol.endsWith('USDT')) {
    return `${symbol.slice(0, -4)}/USDT:USDT`;
  }
  if (symbol.endsWith('BUSD')) {
    return `${symbol.slice(0, -4)}/BUSD`;
  }
  return symbol;
}

/** Normalise a raw OHLCV array from CCXT to our internal candle format */
function parseOhlcv(row) {
  return {
    time:   row[0],
    open:   parseFloat(row[1]),
    high:   parseFloat(row[2]),
    low:    parseFloat(row[3]),
    close:  parseFloat(row[4]),
    volume: parseFloat(row[5])
  };
}

/**
 * Fetch up to `limit` completed 1m candles for a symbol.
 * On Binance this is a thin wrapper around exchange.fetchKlines so we
 * don't break the existing WebSocket-first architecture.
 */
async function fetchKlines(symbol, interval = '1m', limit = 500) {
  if (IS_BINANCE) {
    // Delegate to native exchange.js which already handles retries, etc.
    return require('./exchange').fetchKlines(symbol, interval, limit);
  }

  const ex = getExchange();
  const ccxtSym = toCcxtSymbol(symbol);
  const tf = INTERVAL_MAP[interval] || interval;

  try {
    const ohlcv = await ex.fetchOHLCV(ccxtSym, tf, undefined, Math.min(1000, limit));
    return (ohlcv || []).map(parseOhlcv);
  } catch (err) {
    // Fall back to spot market symbol if futures symbol fails
    try {
      const spotSym = ccxtSym.replace(':USDT', '');
      const ohlcv = await ex.fetchOHLCV(spotSym, tf, undefined, Math.min(1000, limit));
      return (ohlcv || []).map(parseOhlcv);
    } catch (e2) {
      console.error(`[CCXT] fetchKlines ${symbol} ${interval}:`, e2.message);
      return [];
    }
  }
}

/**
 * Fetch candles from startTime to endTime (paginated).
 */
async function fetchKlinesSince(symbol, interval, startTime, endTime = Date.now()) {
  if (IS_BINANCE) {
    return require('./exchange').fetchKlinesSince(symbol, interval, startTime, endTime);
  }

  const ex = getExchange();
  const ccxtSym = toCcxtSymbol(symbol);
  const tf = INTERVAL_MAP[interval] || interval;
  const out = [];
  let cursor = startTime;

  for (let page = 0; page < 6 && cursor < endTime; page++) {
    try {
      const ohlcv = await ex.fetchOHLCV(ccxtSym, tf, cursor, 1000);
      if (!ohlcv || ohlcv.length === 0) break;
      const parsed = ohlcv.map(parseOhlcv);
      out.push(...parsed);
      const lastTime = parsed[parsed.length - 1].time;
      if (parsed.length < 1000) break;
      cursor = lastTime + 1;
    } catch (err) {
      console.error(`[CCXT] fetchKlinesSince page ${page} ${symbol}:`, err.message);
      break;
    }
  }

  // Deduplicate
  const seen = new Set();
  return out.filter(c => {
    if (seen.has(c.time)) return false;
    seen.add(c.time);
    return true;
  });
}

/**
 * List all available USDT perpetual markets on the active exchange.
 * Useful for dynamic coin discovery beyond the static coins.js list.
 */
async function listUsdtPerpMarkets() {
  if (IS_BINANCE) {
    // Already handled by coins.js static list
    return require('./coins').WATCHED_COINS;
  }
  const ex = getExchange();
  try {
    await ex.loadMarkets();
    return Object.values(ex.markets)
      .filter(m => m.active && m.quote === 'USDT' && (m.type === 'swap' || m.type === 'future'))
      .map(m => m.base + 'USDT')
      .slice(0, 100);
  } catch (err) {
    console.error('[CCXT] listUsdtPerpMarkets:', err.message);
    return [];
  }
}

/**
 * Fetch current ticker (last price, 24h volume, etc.)
 */
async function fetchTicker(symbol) {
  if (IS_BINANCE) return null; // Native websocket handles this
  const ex = getExchange();
  try {
    return await ex.fetchTicker(toCcxtSymbol(symbol));
  } catch (err) {
    console.error(`[CCXT] fetchTicker ${symbol}:`, err.message);
    return null;
  }
}

module.exports = {
  EXCHANGE_ID,
  IS_BINANCE,
  fetchKlines,
  fetchKlinesSince,
  listUsdtPerpMarkets,
  fetchTicker,
  getExchange,
  toCcxtSymbol
};

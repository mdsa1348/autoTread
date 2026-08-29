/**
 * Binance REST + signed futures API + 1m kline websocket.
 * Paper mode uses the public spot data endpoints. Live mode uses USDT-M futures.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

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

function envFlag(name, defaultValue = false) {
  const v = (process.env[name] || '').toLowerCase();
  if (!v) return defaultValue;
  return v === '1' || v === 'true' || v === 'yes';
}

const TRADING_MODE = (process.env.TRADING_MODE || 'paper').toLowerCase() === 'live' ? 'live' : 'paper';
const USE_TESTNET = TRADING_MODE === 'live' ? envFlag('BINANCE_TESTNET', true) : false;
const CONFIRM_LIVE = (process.env.CONFIRM_LIVE || '').toUpperCase() === 'YES';
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || '';
const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';
const FUTURES_LEVERAGE = Math.max(1, Math.min(5, parseInt(process.env.FUTURES_LEVERAGE || '1', 10) || 1));
const MAX_DAILY_LOSS_PERCENT = Math.max(0.5, Math.min(25, parseFloat(process.env.MAX_DAILY_LOSS_PERCENT || '5')));

function restBase() {
  if (TRADING_MODE !== 'live') return 'https://api.binance.com';
  if (USE_TESTNET) return 'https://testnet.binancefuture.com';
  return 'https://fapi.binance.com';
}

function klineBase() {
  if (TRADING_MODE !== 'live') return { host: 'https://api.binance.com', path: '/api/v3/klines' };
  if (USE_TESTNET) return { host: 'https://testnet.binancefuture.com', path: '/fapi/v1/klines' };
  return { host: 'https://fapi.binance.com', path: '/fapi/v1/klines' };
}

function wsKlineUrl(streams) {
  const joined = streams.join('/');
  if (TRADING_MODE !== 'live') {
    return `wss://stream.binance.com:9443/stream?streams=${joined}`;
  }
  if (USE_TESTNET) return `wss://stream.binancefuture.com/stream?streams=${joined}`;
  return `wss://fstream.binance.com/stream?streams=${joined}`;
}

function parseKlineRow(c) {
  return {
    time: c[0],
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5])
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTransientNetError(err) {
  const m = String((err && err.message) || err || '');
  const status = err && err.httpStatus;
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  return /fetch failed|aborted|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|socket|network|offline|UND_ERR|certificate/i.test(m);
}

async function restGetOnce(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${text.slice(0, 180)}`);
      err.httpStatus = res.status;
      throw err;
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function checkInternet() {
  try {
    await restGetOnce('https://api.binance.com/api/v3/ping', 5000);
    return true;
  } catch {
    try {
      await restGetOnce('https://api.binance.com/api/v3/time', 5000);
      return true;
    } catch {
      return false;
    }
  }
}

async function waitForInternet(label = 'network') {
  let delay = 3000;
  if (await checkInternet()) return true;
  while (true) {
    console.warn(`[NET] No internet (${label}). Waiting ${Math.round(delay / 1000)}s then rechecking...`);
    await sleep(delay);
    if (await checkInternet()) {
      console.log('[NET] Internet back. Resuming.');
      return true;
    }
    delay = Math.min(60000, Math.round(delay * 1.4));
  }
}

async function restGet(url, timeoutMs = 8000, maxAttempts = 4) {
  let delay = 1500;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await restGetOnce(url, timeoutMs);
    } catch (err) {
      lastErr = err;
      const status = err && err.httpStatus;
      if (status && status >= 400 && status < 500 && status !== 429) throw err;
      if (attempt >= maxAttempts) break;
      console.warn(`[NET] ${err.message} — retry ${attempt}/${maxAttempts} in ${Math.round(delay / 1000)}s`);
      await sleep(delay);
      delay = Math.min(15000, Math.round(delay * 1.5));
    }
  }
  throw lastErr;
}

async function fetchKlines(symbol, interval = '1m', limit = 500) {
  const { host, path: kpath } = klineBase();
  const url = `${host}${kpath}?symbol=${symbol}&interval=${interval}&limit=${Math.min(1000, limit)}`;
  const data = await restGet(url, 8000);
  return Array.isArray(data) ? data.map(parseKlineRow) : [];
}

async function fetchKlinesSince(symbol, interval, startTime, endTime = Date.now()) {
  const { host, path: kpath } = klineBase();
  const out = [];
  let cursor = startTime;
  for (let page = 0; page < 6 && cursor < endTime; page++) {
    const url = `${host}${kpath}?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endTime}&limit=1000`;
    let rows;
    try {
      rows = await restGet(url, 10000);
    } catch (err) {
      console.error(`[EXCHANGE] kline page failed ${symbol} ${interval}:`, err.message);
      break;
    }
    if (!Array.isArray(rows) || rows.length === 0) break;
    const parsed = rows.map(parseKlineRow);
    out.push(...parsed);
    const lastTime = parsed[parsed.length - 1].time;
    if (parsed.length < 1000) break;
    cursor = lastTime + 1;
  }
  const dedup = [];
  const seen = new Set();
  for (const bar of out) {
    if (seen.has(bar.time)) continue;
    seen.add(bar.time);
    dedup.push(bar);
  }
  return dedup;
}

function signedQuery(params) {
  const qs = new URLSearchParams(params).toString();
  const signature = crypto.createHmac('sha256', API_SECRET).update(qs).digest('hex');
  return `${qs}&signature=${signature}`;
}

async function futuresSigned(method, pathname, params = {}) {
  if (!API_KEY || !API_SECRET) throw new Error('BINANCE_API_KEY / BINANCE_API_SECRET missing');
  const payload = { ...params, timestamp: Date.now(), recvWindow: 5000 };
  const qs = signedQuery(payload);
  const url = `${restBase()}${pathname}?${qs}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'X-MBX-APIKEY': API_KEY },
      signal: controller.signal
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    if (!res.ok) {
      const msg = body.msg || body.raw || text.slice(0, 180);
      throw new Error(`Binance ${method} ${pathname} ${res.status}: ${msg}`);
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

let filtersCache = null;
async function getSymbolFilters(symbol) {
  if (!filtersCache) {
    const info = await restGet(`${restBase()}/fapi/v1/exchangeInfo`, 12000);
    filtersCache = {};
    for (const s of info.symbols || []) {
      const lot = (s.filters || []).find(f => f.filterType === 'LOT_SIZE') || {};
      const price = (s.filters || []).find(f => f.filterType === 'PRICE_FILTER') || {};
      const notional = (s.filters || []).find(f => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL') || {};
      filtersCache[s.symbol] = {
        stepSize: parseFloat(lot.stepSize || '0.001'),
        minQty: parseFloat(lot.minQty || '0'),
        tickSize: parseFloat(price.tickSize || '0.01'),
        minNotional: parseFloat(notional.minNotional || notional.notional || '5')
      };
    }
  }
  return filtersCache[symbol] || { stepSize: 0.001, minQty: 0, tickSize: 0.01, minNotional: 5 };
}

function roundToStep(value, step) {
  if (!step || step <= 0) return value;
  const precision = Math.max(0, Math.round(-Math.log10(step)));
  const rounded = Math.floor(value / step + 1e-12) * step;
  return Number(rounded.toFixed(precision));
}

function roundPrice(value, tick) {
  if (!tick || tick <= 0) return value;
  const precision = Math.max(0, Math.round(-Math.log10(tick)));
  const rounded = Math.round(value / tick) * tick;
  return Number(rounded.toFixed(precision));
}

async function futuresAccount() {
  const acct = await futuresSigned('GET', '/fapi/v2/account');
  const totalWallet = parseFloat(acct.totalWalletBalance || acct.totalMarginBalance || 0);
  const available = parseFloat(acct.availableBalance || 0);
  const unrealized = parseFloat(acct.totalUnrealizedProfit || 0);
  return {
    totalWalletBalance: totalWallet,
    availableBalance: available,
    totalUnrealizedProfit: unrealized,
    totalEquity: totalWallet + unrealized
  };
}

async function futuresPositions() {
  const rows = await futuresSigned('GET', '/fapi/v2/positionRisk');
  return (rows || [])
    .map(p => ({
      symbol: p.symbol,
      positionAmt: parseFloat(p.positionAmt || 0),
      entryPrice: parseFloat(p.entryPrice || 0),
      unrealizedProfit: parseFloat(p.unRealizedProfit || 0),
      leverage: parseFloat(p.leverage || 1)
    }))
    .filter(p => Math.abs(p.positionAmt) > 0);
}

async function setLeverage(symbol, leverage = FUTURES_LEVERAGE) {
  try {
    await futuresSigned('POST', '/fapi/v1/leverage', { symbol, leverage });
  } catch (err) {
    console.error(`[EXCHANGE] leverage ${symbol}:`, err.message);
  }
}

async function marketOrder(symbol, side, quantity) {
  return futuresSigned('POST', '/fapi/v1/order', {
    symbol,
    side,
    type: 'MARKET',
    quantity: String(quantity),
    newOrderRespType: 'RESULT'
  });
}

async function closePositionMarket(symbol, side, quantity) {
  return futuresSigned('POST', '/fapi/v1/order', {
    symbol,
    side,
    type: 'MARKET',
    quantity: String(quantity),
    reduceOnly: 'true',
    newOrderRespType: 'RESULT'
  });
}

async function placeCloseStop(symbol, side, stopPrice) {
  return futuresSigned('POST', '/fapi/v1/order', {
    symbol,
    side,
    type: 'STOP_MARKET',
    stopPrice: String(stopPrice),
    closePosition: 'true',
    workingType: 'CONTRACT_PRICE'
  });
}

async function cancelOrder(symbol, orderId) {
  return futuresSigned('DELETE', '/fapi/v1/order', { symbol, orderId });
}

async function openOrders(symbol) {
  return futuresSigned('GET', '/fapi/v1/openOrders', { symbol });
}

async function cancelCloseStops(symbol) {
  const orders = await openOrders(symbol);
  for (const o of orders || []) {
    if (o.type === 'STOP_MARKET' && (o.closePosition === true || o.closePosition === 'true')) {
      try { await cancelOrder(symbol, o.orderId); } catch (e) { /* already filled */ }
    }
  }
}

class KlineSocket {
  constructor(symbols, onKline) {
    this.symbols = symbols;
    this.onKline = onKline;
    this.sockets = [];
    this.closed = false;
  }

  start() {
    this.closed = false;
    this.sockets = [];
    const chunkSize = 40;
    for (let i = 0; i < this.symbols.length; i += chunkSize) {
      this.openChunk(this.symbols.slice(i, i + chunkSize));
    }
  }

  stop() {
    this.closed = true;
    for (const ws of this.sockets) {
      try { ws.close(); } catch (e) { /* ignore */ }
    }
    this.sockets = [];
  }

  openChunk(chunk, reconnectMs = 2000) {
    if (this.closed) return;
    const streams = chunk.map(s => `${s.toLowerCase()}@kline_1m`);
    const url = wsKlineUrl(streams);
    const ws = new WebSocket(url);
    this.sockets.push(ws);

    ws.on('open', () => {
      console.log(`[WS] 1m kline stream connected (${chunk.length} symbols)`);
    });

    ws.on('message', (buf) => {
      try {
        const msg = JSON.parse(buf.toString());
        const k = msg.data && msg.data.k;
        if (!k) return;
        this.onKline(k.s, {
          time: k.t,
          open: parseFloat(k.o),
          high: parseFloat(k.h),
          low: parseFloat(k.l),
          close: parseFloat(k.c),
          volume: parseFloat(k.v),
          closed: k.x === true
        });
      } catch (e) {
        /* ignore malformed frames */
      }
    });

    ws.on('close', () => {
      this.sockets = this.sockets.filter(s => s !== ws);
      if (this.closed) return;
      console.log(`[WS] chunk disconnected, retry in ${reconnectMs}ms`);
      setTimeout(() => this.openChunk(chunk, Math.min(60000, Math.max(2000, reconnectMs * 2))), reconnectMs);
    });

    ws.on('error', (err) => {
      console.error('[WS] error:', err.message);
    });
  }
}

function assertLiveConfig() {
  if (TRADING_MODE !== 'live') return;
  if (!CONFIRM_LIVE) {
    throw new Error('Live mode refused: set CONFIRM_LIVE=YES in .env (paper is the default).');
  }
  if (!API_KEY || !API_SECRET) {
    throw new Error('Live mode requires BINANCE_API_KEY and BINANCE_API_SECRET.');
  }
  if (!CONTROL_TOKEN || CONTROL_TOKEN.length < 8) {
    throw new Error('Live mode requires CONTROL_TOKEN (8+ chars) to protect dashboard actions.');
  }
}

module.exports = {
  TRADING_MODE,
  USE_TESTNET,
  CONTROL_TOKEN,
  FUTURES_LEVERAGE,
  MAX_DAILY_LOSS_PERCENT,
  API_KEY,
  loadEnvFile,
  assertLiveConfig,
  checkInternet,
  waitForInternet,
  fetchKlines,
  fetchKlinesSince,
  futuresAccount,
  futuresPositions,
  setLeverage,
  marketOrder,
  closePositionMarket,
  placeCloseStop,
  cancelCloseStops,
  getSymbolFilters,
  roundToStep,
  roundPrice,
  KlineSocket
};

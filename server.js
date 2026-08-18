const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { AIBrain } = require('./ai_engine');
const { PaperBroker } = require('./paper_broker');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data_store.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Coins to monitor and trade
const WATCHED_COINS = ['BTCUSDT', 'BNBUSDT', 'SOLUSDT', 'ETHUSDT', 'DOGEUSDT', 'XRPUSDT', 'AVAXUSDT'];

// Load persistence state
let savedState = { ai: null, broker: null };
if (fs.existsSync(DATA_FILE)) {
  try {
    savedState = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('Error loading data_store.json:', e.message);
  }
}

const ai = new AIBrain(savedState.ai);
const broker = new PaperBroker(10000, 0.001, savedState.broker);

// Auto-save state every 30 seconds
setInterval(() => {
  try {
    const dataToSave = {
      ai: ai.exportState(),
      broker: broker.exportState(),
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2), 'utf8');
  } catch (err) {
    console.error('Auto-save error:', err.message);
  }
}, 30000);

// In-memory candle and price caches
const marketCache = {};
let isBotActive = true;

// Helper: fetch historical klines from Binance Public API
async function fetchBinanceKlines(symbol, interval = '5m', limit = 60) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.map(c => ({
      time: c[0],
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5])
    }));
  } catch (e) {
    console.error(`Failed to fetch klines for ${symbol}:`, e.message);
    return null;
  }
}

// Master Market Loop: Runs every 4 seconds
async function marketTradingTick() {
  const currentPrices = {};

  for (const symbol of WATCHED_COINS) {
    const candles = await fetchBinanceKlines(symbol, '5m', 50);
    if (!candles || candles.length === 0) continue;

    const latestCandle = candles[candles.length - 1];
    const currentPrice = latestCandle.close;
    currentPrices[symbol] = currentPrice;

    // Update trailing SL/TP & check exit conditions on active positions
    broker.updatePositionsWithPrice(symbol, currentPrice, ai);

    // AI Market Analysis
    const analysis = ai.analyzeMarket(candles);
    marketCache[symbol] = {
      symbol,
      price: currentPrice,
      candles: candles.slice(-30),
      analysis,
      updatedAt: new Date().toISOString()
    };

    // Auto-Trading Decision (If bot is active)
    if (isBotActive && analysis.signal === 'BUY' && analysis.confidence >= 55) {
      broker.openPosition(symbol, currentPrice, analysis, 0.15);
    }
  }

  // Also broadcast or log summary
}

// Initial Warmup and Start loop
(async () => {
  console.log('🚀 AI Trading Engine Booting up...');
  await marketTradingTick();
  setInterval(marketTradingTick, 5000); // Check every 5 seconds
})();

// API Endpoints
app.get('/api/state', (req, res) => {
  const prices = {};
  for (const [sym, data] of Object.entries(marketCache)) {
    prices[sym] = data.price;
  }

  res.json({
    isBotActive,
    watchedCoins: WATCHED_COINS,
    marketData: marketCache,
    portfolio: broker.getPortfolioMetrics(prices),
    positions: broker.positions,
    tradeHistory: broker.tradeHistory.slice(0, 30),
    aiMetrics: ai.exportState()
  });
});

app.post('/api/bot/toggle', (req, res) => {
  isBotActive = !isBotActive;
  res.json({ success: true, isBotActive });
});

app.post('/api/bot/reset', (req, res) => {
  broker.resetAccount(10000);
  res.json({ success: true, message: 'Account reset to $10,000 USDT' });
});

app.post('/api/trade/manual-buy', (req, res) => {
  const { symbol } = req.body;
  const market = marketCache[symbol];
  if (!market) return res.status(400).json({ success: false, error: 'Symbol data unavailable' });

  const result = broker.openPosition(symbol, market.price, market.analysis, 0.15);
  res.json(result);
});

app.post('/api/trade/close', (req, res) => {
  const { positionId } = req.body;
  const pos = broker.positions.find(p => p.id === positionId);
  if (!pos) return res.status(404).json({ success: false, error: 'Position not found' });

  const market = marketCache[pos.symbol];
  const exitPrice = market ? market.price : pos.entryPrice;
  const closed = broker.closePosition(pos.id, exitPrice, 'Manual User Close', ai);
  res.json({ success: true, closed });
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🌐 Autonomous AI Trading Dashboard Live on: http://localhost:${PORT}`);
  console.log(`📊 Tracking Coins: ${WATCHED_COINS.join(', ')}`);
  console.log(`🤖 AI Engine: Continuous Online Learning & Trailing SL/TP Active`);
  console.log(`======================================================\n`);
});

/**
 * Deep Neural Network & Advanced Technical Indicators Engine
 * Incorporates: TensorFlow.js Deep Learning + MACD + ADX + SMC Structure +
 *               PDH/PDL + Session Levels + CVD + VWAP + ORB + Initial Balance + FVG + POC
 */

const fs = require('fs');
const path = require('path');
const tf = require('@tensorflow/tfjs');

const { NN_MODEL_FILE, NN_MODEL_LIVE_FILE } = require('./paths');
const secondOpinion = require('./second_opinion');
const { rlPolicy } = require('./rl_policy');
const { buildEntrySight } = require('./analysis_log');
const MIN_NN_TRADES = 20;
const TRAINABLE_CONFIRMS = ['ADX', 'SMC', 'B', 'RL', '5mF', 'FUND', 'LSR', 'FNG', 'BTC'];

// Indicator helper functions
function calcEMA(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcEMASeries(values, period) {
  if (!values || values.length < period) return [];
  const k = 2 / (period + 1);
  const result = [];
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(ema);
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function calcRSI(closes, period = 14) {
  if (!closes || closes.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) - diff) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 0;
  let trList = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trList.push(tr);
  }
  const recentTR = trList.slice(-period);
  return recentTR.reduce((sum, v) => sum + v, 0) / period;
}

function calcBollingerBands(closes, period = 20, multiplier = 2) {
  if (!closes || closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return {
    upper: mean + multiplier * stdDev,
    middle: mean,
    lower: mean - multiplier * stdDev,
    bandwidth: (mean > 0) ? ((2 * multiplier * stdDev) / mean) * 100 : 0
  };
}

// MACD
function calcMACD(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (!closes || closes.length < slowPeriod + signalPeriod) {
    return { macd: 0, signal: 0, histogram: 0, bullishCross: false, bearishCross: false };
  }
  const fastEMA = calcEMASeries(closes, fastPeriod);
  const slowEMA = calcEMASeries(closes, slowPeriod);
  const offset = fastEMA.length - slowEMA.length;
  const macdLine = [];
  for (let i = 0; i < slowEMA.length; i++) {
    macdLine.push(fastEMA[i + offset] - slowEMA[i]);
  }
  const signalLine = calcEMASeries(macdLine, signalPeriod);
  if (!signalLine || signalLine.length === 0) {
    return { macd: 0, signal: 0, histogram: 0, bullishCross: false, bearishCross: false };
  }
  const currentMACD = macdLine[macdLine.length - 1];
  const currentSignal = signalLine[signalLine.length - 1];
  const histogram = currentMACD - currentSignal;
  const prevMACD = macdLine[macdLine.length - 2] || currentMACD;
  const prevSignal = signalLine[signalLine.length - 2] || currentSignal;
  const bullishCross = prevMACD <= prevSignal && currentMACD > currentSignal;
  const bearishCross = prevMACD >= prevSignal && currentMACD < currentSignal;
  return { macd: currentMACD, signal: currentSignal, histogram, bullishCross, bearishCross };
}

// Wilder ADX: smooth TR / +DM / -DM, then DX, then ADX as smoothed DX
function calcADX(candles, period = 14) {
  if (!candles || candles.length < period * 2 + 1) {
    return { adx: 20, plusDI: 20, minusDI: 20, isTrending: false, isChoppy: true };
  }

  const trList = [];
  const plusDMList = [];
  const minusDMList = [];

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevHigh = candles[i - 1].high;
    const prevLow = candles[i - 1].low;
    const prevClose = candles[i - 1].close;
    trList.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    const upMove = high - prevHigh;
    const downMove = prevLow - low;
    plusDMList.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMList.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  let smTR = trList.slice(0, period).reduce((a, b) => a + b, 0);
  let smPDM = plusDMList.slice(0, period).reduce((a, b) => a + b, 0);
  let smMDM = minusDMList.slice(0, period).reduce((a, b) => a + b, 0);

  const dxList = [];
  const diAt = (tr, pdm, mdm) => {
    const plusDI = tr === 0 ? 0 : (pdm / tr) * 100;
    const minusDI = tr === 0 ? 0 : (mdm / tr) * 100;
    const diSum = plusDI + minusDI;
    const dx = diSum === 0 ? 0 : (Math.abs(plusDI - minusDI) / diSum) * 100;
    return { plusDI, minusDI, dx };
  };

  dxList.push(diAt(smTR, smPDM, smMDM).dx);
  let lastDI = diAt(smTR, smPDM, smMDM);

  for (let i = period; i < trList.length; i++) {
    smTR = smTR - smTR / period + trList[i];
    smPDM = smPDM - smPDM / period + plusDMList[i];
    smMDM = smMDM - smMDM / period + minusDMList[i];
    lastDI = diAt(smTR, smPDM, smMDM);
    dxList.push(lastDI.dx);
  }

  if (dxList.length < period) {
    const adx = lastDI.dx;
    return { adx, plusDI: lastDI.plusDI, minusDI: lastDI.minusDI, isTrending: adx >= 22, isChoppy: adx < 18 };
  }

  let adx = dxList.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxList.length; i++) {
    adx = (adx * (period - 1) + dxList[i]) / period;
  }
  adx = Math.min(100, Math.max(0, adx));

  return {
    adx,
    plusDI: lastDI.plusDI,
    minusDI: lastDI.minusDI,
    isTrending: adx >= 22,
    isChoppy: adx < 18
  };
}

// ============================================================
// CUMULATIVE VOLUME DELTA (CVD)
// Approximates aggressive buy vs sell volume per candle
// ============================================================
function calcCVD(candles) {
  if (!candles || candles.length < 5) return { cvd: 0, deltaTrend: 'NEUTRAL', buyPressure: 50 };
  let cumulativeDelta = 0;
  const deltas = [];
  for (const c of candles) {
    const range = c.high - c.low || 1;
    // Estimate buy/sell split from candle body position
    const bullFraction = (c.close - c.low) / range;
    const buyVol = c.volume * bullFraction;
    const sellVol = c.volume * (1 - bullFraction);
    const delta = buyVol - sellVol;
    cumulativeDelta += delta;
    deltas.push(delta);
  }
  const recentDeltas = deltas.slice(-10);
  const avgDelta = recentDeltas.reduce((a, b) => a + b, 0) / recentDeltas.length;
  const totalVol = candles.slice(-10).reduce((a, c) => a + c.volume, 0) || 1;
  const buyPressure = Math.max(0, Math.min(100, 50 + (avgDelta / (totalVol / 10)) * 50));
  let deltaTrend = 'NEUTRAL';
  if (buyPressure > 60) deltaTrend = 'BUYING';
  else if (buyPressure < 40) deltaTrend = 'SELLING';
  return { cvd: cumulativeDelta, deltaTrend, buyPressure: Math.round(buyPressure) };
}

// ============================================================
// PREVIOUS DAY HIGH / LOW (PDH / PDL)
// Calculates from daily candle history (1d klines)
// ============================================================
function calcPreviousDayLevels(dailyCandles) {
  if (!dailyCandles || dailyCandles.length < 2) {
    return { pdh: null, pdl: null, isAbovePDH: false, isBelowPDL: false, pdmid: null };
  }
  // Previous day = second-to-last completed daily candle
  const prevDay = dailyCandles[dailyCandles.length - 2];
  const today = dailyCandles[dailyCandles.length - 1];
  return {
    pdh: prevDay.high,      // Previous Day High – strong resistance
    pdl: prevDay.low,       // Previous Day Low  – strong support
    pdmid: (prevDay.high + prevDay.low) / 2, // Previous Day Midpoint (equilibrium)
    todayOpen: today.open,
    isAbovePDH: today.close > prevDay.high,   // Bullish breakout
    isBelowPDL: today.close < prevDay.low,    // Bearish breakout
    pdRange: prevDay.high - prevDay.low
  };
}

// ============================================================
// TRADING SESSION HIGHS & LOWS (Tokyo / London / New York)
// Using UTC timestamps from the 1m candle stream
// ============================================================
function calcSessionLevels(candles1m) {
  if (!candles1m || candles1m.length < 10) {
    return { tokyo: null, london: null, newyork: null, currentSession: 'OFFHOURS' };
  }

  const tokyoHighs = [], tokyoLows = [];
  const londonHighs = [], londonLows = [];
  const nyHighs = [], nyLows = [];
  const now = Date.now();
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayStartMs = dayStart.getTime();

  for (const c of candles1m) {
    const t = c.time;
    if (t < dayStartMs) continue; // Only today's candles
    const hour = new Date(t).getUTCHours();
    // Tokyo: 00:00 - 09:00 UTC
    if (hour >= 0 && hour < 9) { tokyoHighs.push(c.high); tokyoLows.push(c.low); }
    // London: 07:00 - 16:00 UTC
    if (hour >= 7 && hour < 16) { londonHighs.push(c.high); londonLows.push(c.low); }
    // New York: 13:00 - 22:00 UTC
    if (hour >= 13 && hour < 22) { nyHighs.push(c.high); nyLows.push(c.low); }
  }

  const nowHour = new Date().getUTCHours();
  // Overlaps: Tokyo/London 07–09, London/NY 13–16. Prefer the later liquid session.
  let currentSession = 'OFFHOURS';
  if (nowHour >= 13 && nowHour < 22) currentSession = 'NEW_YORK';
  else if (nowHour >= 7 && nowHour < 16) currentSession = 'LONDON';
  else if (nowHour >= 0 && nowHour < 9) currentSession = 'TOKYO';

  const makeSession = (highs, lows) => {
    if (!highs.length) return null;
    return { high: Math.max(...highs), low: Math.min(...lows), mid: (Math.max(...highs) + Math.min(...lows)) / 2 };
  };

  return {
    tokyo: makeSession(tokyoHighs, tokyoLows),
    london: makeSession(londonHighs, londonLows),
    newyork: makeSession(nyHighs, nyLows),
    currentSession
  };
}

// ============================================================
// VWAP (Volume Weighted Average Price) + Session Bias
// The institutional "fair price" anchor for the session
// ============================================================
function calcVWAP(candles1m) {
  if (!candles1m || candles1m.length < 5) return { vwap: null, vwapBias: 'NEUTRAL', distPercent: 0 };

  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayStartMs = dayStart.getTime();

  let cumTPV = 0; // Typical Price * Volume
  let cumVol = 0;

  for (const c of candles1m) {
    if (c.time < dayStartMs) continue; // Only today's candles
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumTPV += typicalPrice * c.volume;
    cumVol += c.volume;
  }

  if (cumVol === 0) return { vwap: null, vwapBias: 'NEUTRAL', distPercent: 0 };

  const vwap = cumTPV / cumVol;
  const currentPrice = candles1m[candles1m.length - 1].close;
  const distPercent = ((currentPrice - vwap) / vwap) * 100;

  // VWAP Bias: Price above VWAP = bullish; below = bearish
  let vwapBias = 'NEUTRAL';
  if (distPercent > 0.05) vwapBias = 'ABOVE';   // Above VWAP → bulls in control
  else if (distPercent < -0.05) vwapBias = 'BELOW'; // Below VWAP → bears in control

  return { vwap, vwapBias, distPercent };
}

// ============================================================
// ORB (Opening Range Breakout)
// First 30 minutes of the trading session (NY open = 09:30 UTC-5)
// Creates IBH/IBL-like key levels for day traders
// ============================================================
function calcORB(candles1m, orbMinutes = 30) {
  if (!candles1m || candles1m.length < 5) {
    return { orbHigh: null, orbLow: null, orbBias: 'NEUTRAL', isAboveORB: false, isBelowORB: false };
  }

  // NY open at 09:30 EST = 14:30 UTC
  const now = new Date();
  const todayBase = new Date();
  todayBase.setUTCHours(14, 30, 0, 0); // NY open
  const orbEnd = new Date(todayBase.getTime() + orbMinutes * 60 * 1000);

  const orbCandles = candles1m.filter(c => c.time >= todayBase.getTime() && c.time <= orbEnd.getTime());

  // Fallback: use first orbMinutes candles of any available session
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const todayCandles = candles1m.filter(c => c.time >= dayStart.getTime());
  const orbSource = orbCandles.length >= 5 ? orbCandles : todayCandles.slice(0, orbMinutes);

  if (orbSource.length < 3) return { orbHigh: null, orbLow: null, orbBias: 'NEUTRAL', isAboveORB: false, isBelowORB: false };

  const orbHigh = Math.max(...orbSource.map(c => c.high));
  const orbLow  = Math.min(...orbSource.map(c => c.low));
  const orbMid  = (orbHigh + orbLow) / 2;
  const orbRange = orbHigh - orbLow;
  const currentPrice = candles1m[candles1m.length - 1].close;

  // Extension targets (like the chart shows +0.5x, +1.0x, -0.5x, -1.0x)
  const ext1Up   = orbHigh + orbRange * 0.5;
  const ext2Up   = orbHigh + orbRange * 1.0;
  const ext1Down = orbLow  - orbRange * 0.5;
  const ext2Down = orbLow  - orbRange * 1.0;

  const isAboveORB = currentPrice > orbHigh;
  const isBelowORB = currentPrice < orbLow;
  let orbBias = 'INSIDE';
  if (isAboveORB) orbBias = 'BULLISH_BREAKOUT';
  else if (isBelowORB) orbBias = 'BEARISH_BREAKDOWN';

  return { orbHigh, orbLow, orbMid, orbRange, isAboveORB, isBelowORB, orbBias, ext1Up, ext2Up, ext1Down, ext2Down };
}

// ============================================================
// INITIAL BALANCE (IB) - First hour high/low
// IBH = Initial Balance High (first 60m)
// IBL = Initial Balance Low (first 60m)
// Extensions: +0.5x, +1.0x (bullish targets), -0.5x, -1.0x (bearish targets)
// ============================================================
function calcInitialBalance(candles1m) {
  if (!candles1m || candles1m.length < 10) {
    return { ibh: null, ibl: null, ibMid: null, ibBias: 'UNDEFINED' };
  }

  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const ibEnd = new Date(dayStart.getTime() + 60 * 60 * 1000); // First 60 minutes

  const ibCandles = candles1m.filter(c => c.time >= dayStart.getTime() && c.time < ibEnd.getTime());

  // Fallback: use first 60 candles of the day
  const todayCandles = candles1m.filter(c => c.time >= dayStart.getTime());
  const ibSource = ibCandles.length >= 10 ? ibCandles : todayCandles.slice(0, 60);

  if (ibSource.length < 5) return { ibh: null, ibl: null, ibMid: null, ibBias: 'UNDEFINED' };

  const ibh = Math.max(...ibSource.map(c => c.high));  // Initial Balance High
  const ibl = Math.min(...ibSource.map(c => c.low));   // Initial Balance Low
  const ibMid = (ibh + ibl) / 2;
  const ibRange = ibh - ibl;
  const currentPrice = candles1m[candles1m.length - 1].close;

  // Extension levels (as shown on chart)
  const target05Up   = ibh + ibRange * 0.5;   // +0.5x extension (first target)
  const target1Up    = ibh + ibRange * 1.0;   // +1.0x extension (main target)
  const target05Down = ibl - ibRange * 0.5;   // -0.5x extension
  const target1Down  = ibl - ibRange * 1.0;   // -1.0x extension

  // Bias determination
  let ibBias = 'INSIDE';
  if (currentPrice > ibh) ibBias = 'ABOVE_IBH_BULLISH';
  else if (currentPrice < ibl) ibBias = 'BELOW_IBL_BEARISH';
  else if (currentPrice > ibMid) ibBias = 'UPPER_HALF_BULLISH';
  else ibBias = 'LOWER_HALF_BEARISH';

  // Score: distance to nearest extension = trade target
  const nearTarget05 = currentPrice > ibh && Math.abs(currentPrice - target05Up) / currentPrice < 0.005;
  const nearTarget1  = currentPrice > ibh && Math.abs(currentPrice - target1Up)  / currentPrice < 0.005;

  return { ibh, ibl, ibMid, ibRange, ibBias, target05Up, target1Up, target05Down, target1Down, nearTarget05, nearTarget1 };
}

// ============================================================
// FVG (Fair Value Gap) – 3-Candle Imbalance Detection
// Bullish FVG: candle[i-2].high < candle[i].low  (gap UP, price will likely return to fill)
// Bearish FVG: candle[i-2].low  > candle[i].high (gap DOWN, price will likely return to fill)
// ============================================================
function calcFVG(candles) {
  if (!candles || candles.length < 10) return { bullishFVGs: [], bearishFVGs: [], nearestFVG: null, fvgScore: 0 };

  const bullishFVGs = [];
  const bearishFVGs = [];
  const lookback = Math.min(candles.length, 30); // Scan last 30 candles

  for (let i = 2; i < lookback; i++) {
    const c0 = candles[candles.length - lookback + i - 2]; // oldest
    const c2 = candles[candles.length - lookback + i];     // newest

    // Bullish FVG: gap between c0 high and c2 low (price must fill this gap)
    if (c2.low > c0.high) {
      bullishFVGs.push({
        type: 'BULLISH_FVG',
        top: c2.low,
        bottom: c0.high,
        mid: (c2.low + c0.high) / 2,
        size: c2.low - c0.high,
        candleIndex: i
      });
    }

    // Bearish FVG: gap between c0 low and c2 high (price must fill this gap)
    if (c2.high < c0.low) {
      bearishFVGs.push({
        type: 'BEARISH_FVG',
        top: c0.low,
        bottom: c2.high,
        mid: (c0.low + c2.high) / 2,
        size: c0.low - c2.high,
        candleIndex: i
      });
    }
  }

  const currentPrice = candles[candles.length - 1].close;
  let nearestFVG = null;
  let fvgScore = 0;
  let minDist = Infinity;

  // Find the nearest unmitigated FVG
  for (const fvg of [...bullishFVGs, ...bearishFVGs]) {
    const distToMid = Math.abs(currentPrice - fvg.mid) / currentPrice;
    if (distToMid < minDist) {
      minDist = distToMid;
      nearestFVG = fvg;
    }
  }

  // Score: if price is at a bullish FVG bottom → buy; at bearish FVG top → sell
  if (nearestFVG && minDist < 0.005) {
    if (nearestFVG.type === 'BULLISH_FVG' && currentPrice <= nearestFVG.bottom * 1.002) {
      fvgScore = 1.5;  // Bullish FVG support = strong buy zone
    } else if (nearestFVG.type === 'BEARISH_FVG' && currentPrice >= nearestFVG.top * 0.998) {
      fvgScore = -1.5; // Bearish FVG resistance = strong sell zone
    }
  }

  return { bullishFVGs: bullishFVGs.slice(-3), bearishFVGs: bearishFVGs.slice(-3), nearestFVG, fvgScore };
}

// ============================================================
// POC (Point of Control) – Highest Volume Price Level
// The price at which the most volume was traded → strong magnet
// ============================================================
function calcPOC(candles, priceBuckets = 50) {
  if (!candles || candles.length < 10) return { poc: null, pocScore: 0, isNearPOC: false };

  const recentCandles = candles.slice(-Math.min(candles.length, 60));
  const highs  = recentCandles.map(c => c.high);
  const lows   = recentCandles.map(c => c.low);
  const priceMin = Math.min(...lows);
  const priceMax = Math.max(...highs);
  const priceRange = priceMax - priceMin;
  if (priceRange === 0) return { poc: null, pocScore: 0, isNearPOC: false };

  const bucketSize = priceRange / priceBuckets;
  const volumeProfile = new Array(priceBuckets).fill(0);

  for (const c of recentCandles) {
    // Distribute volume uniformly across each candle's price range
    const bucketStart = Math.floor((c.low - priceMin) / bucketSize);
    const bucketEnd   = Math.min(priceBuckets - 1, Math.floor((c.high - priceMin) / bucketSize));
    const span = Math.max(1, bucketEnd - bucketStart + 1);
    for (let b = bucketStart; b <= bucketEnd; b++) {
      volumeProfile[Math.min(b, priceBuckets - 1)] += c.volume / span;
    }
  }

  // Find the bucket with the highest volume = POC
  const maxBucket = volumeProfile.indexOf(Math.max(...volumeProfile));
  const poc = priceMin + (maxBucket + 0.5) * bucketSize;

  const currentPrice = candles[candles.length - 1].close;
  const isNearPOC = Math.abs(currentPrice - poc) / currentPrice < 0.004;

  // POC acts as a magnet: price above POC = bullish, below = bearish
  let pocScore = 0;
  if (currentPrice > poc) pocScore = 0.5;   // Above POC = mild bullish
  else if (currentPrice < poc) pocScore = -0.5; // Below POC = mild bearish
  if (isNearPOC) pocScore *= 2; // At POC = strong level, amplify

  return { poc, pocScore, isNearPOC, volumeProfile: volumeProfile.slice(0, 10) }; // Only send top slice to UI
}

// ============================================================
// SMART MONEY CONCEPTS (SMC) MARKET STRUCTURE ENGINE
// Detects: Swing Points, Strong/Weak Highs/Lows, CHoCH, BOS
// ============================================================
function emptySmc() {
  return {
    structureState: 'UNDEFINED',
    swingHighs: [], swingLows: [],
    lastCHoCH: null, lastBOS: null,
    smcSignal: 'NEUTRAL',
    strongHigh: null, strongLow: null,
    weakHigh: null, weakLow: null,
    score: 0
  };
}

function calcMarketStructure(candles) {
  if (!candles || candles.length < 20) return emptySmc();

  const pivotLookback = 3;
  const swingHighs = [];
  const swingLows = [];

  for (let i = pivotLookback; i < candles.length - pivotLookback; i++) {
    const c = candles[i];
    let isSwingHigh = true;
    let isSwingLow = true;
    for (let j = 1; j <= pivotLookback; j++) {
      if (candles[i - j].high >= c.high || candles[i + j].high >= c.high) isSwingHigh = false;
      if (candles[i - j].low <= c.low || candles[i + j].low <= c.low) isSwingLow = false;
    }
    if (isSwingHigh) swingHighs.push({ price: c.high, time: c.time, index: i });
    if (isSwingLow) swingLows.push({ price: c.low, time: c.time, index: i });
  }

  if (swingHighs.length < 2 || swingLows.length < 2) {
    return { ...emptySmc(), structureState: 'RANGING', swingHighs, swingLows };
  }

  const lastSH = swingHighs[swingHighs.length - 1];
  const prevSH = swingHighs[swingHighs.length - 2];
  const lastSL = swingLows[swingLows.length - 1];
  const prevSL = swingLows[swingLows.length - 2];

  const isHigherHigh = lastSH.price > prevSH.price;
  const isLowerHigh = lastSH.price < prevSH.price;
  const isHigherLow = lastSL.price > prevSL.price;
  const isLowerLow = lastSL.price < prevSL.price;

  const strongHigh = isLowerHigh ? lastSH : prevSH;
  const weakHigh = isHigherHigh ? lastSH : prevSH;
  const strongLow = isHigherLow ? lastSL : prevSL;
  const weakLow = isLowerLow ? lastSL : prevSL;

  const currentPrice = candles[candles.length - 1].close;

  // Walk swings in time order so CHoCH and later BOS can both exist as history.
  const swings = [
    ...swingHighs.map(s => ({ ...s, kind: 'HIGH' })),
    ...swingLows.map(s => ({ ...s, kind: 'LOW' }))
  ].sort((a, b) => a.index - b.index);

  let trend = 'RANGING';
  let lastHigh = null;
  let prevHigh = null;
  let lastLow = null;
  let prevLow = null;
  const chochEvents = [];
  const bosEvents = [];

  const bootstrapTrend = () => {
    if (trend !== 'RANGING') return;
    if (!lastHigh || !prevHigh || !lastLow || !prevLow) return;
    if (lastHigh.price > prevHigh.price && lastLow.price > prevLow.price) trend = 'UPTREND';
    else if (lastHigh.price < prevHigh.price && lastLow.price < prevLow.price) trend = 'DOWNTREND';
  };

  for (const s of swings) {
    if (s.kind === 'HIGH') {
      prevHigh = lastHigh;
      lastHigh = s;
      bootstrapTrend();
      if (!prevHigh) continue;
      if (trend === 'DOWNTREND' && s.price > prevHigh.price) {
        chochEvents.push({
          type: 'BULLISH_CHOCH',
          level: prevHigh.price,
          index: s.index,
          time: s.time,
          description: 'Bullish CHoCH – Watch for Reversal'
        });
        trend = 'UPTREND';
      } else if (trend === 'UPTREND' && s.price > prevHigh.price) {
        bosEvents.push({
          type: 'BULLISH_BOS',
          level: prevHigh.price,
          index: s.index,
          time: s.time,
          description: 'Bullish BOS – Trend Continuation'
        });
      }
    } else {
      prevLow = lastLow;
      lastLow = s;
      bootstrapTrend();
      if (!prevLow) continue;
      if (trend === 'UPTREND' && s.price < prevLow.price) {
        chochEvents.push({
          type: 'BEARISH_CHOCH',
          level: prevLow.price,
          index: s.index,
          time: s.time,
          description: 'Bearish CHoCH – Watch for Reversal'
        });
        trend = 'DOWNTREND';
      } else if (trend === 'DOWNTREND' && s.price < prevLow.price) {
        bosEvents.push({
          type: 'BEARISH_BOS',
          level: prevLow.price,
          index: s.index,
          time: s.time,
          description: 'Bearish BOS – Trend Continuation'
        });
      }
    }
  }

  // Unconfirmed live breaks on the current close (not yet a swing).
  if (trend === 'DOWNTREND' && lastSH && currentPrice > lastSH.price) {
    chochEvents.push({
      type: 'BULLISH_CHOCH',
      level: lastSH.price,
      index: candles.length - 1,
      time: candles[candles.length - 1].time,
      live: true,
      description: 'Bullish CHoCH – Watch for Reversal'
    });
    trend = 'BULLISH_CHOCH';
  } else if (trend === 'UPTREND' && lastSL && currentPrice < lastSL.price) {
    chochEvents.push({
      type: 'BEARISH_CHOCH',
      level: lastSL.price,
      index: candles.length - 1,
      time: candles[candles.length - 1].time,
      live: true,
      description: 'Bearish CHoCH – Watch for Reversal'
    });
    trend = 'BEARISH_CHOCH';
  } else if (trend === 'UPTREND' && lastSH && currentPrice > lastSH.price) {
    bosEvents.push({
      type: 'BULLISH_BOS',
      level: lastSH.price,
      index: candles.length - 1,
      time: candles[candles.length - 1].time,
      live: true,
      description: 'Bullish BOS – Trend Continuation'
    });
  } else if (trend === 'DOWNTREND' && lastSL && currentPrice < lastSL.price) {
    bosEvents.push({
      type: 'BEARISH_BOS',
      level: lastSL.price,
      index: candles.length - 1,
      time: candles[candles.length - 1].time,
      live: true,
      description: 'Bearish BOS – Trend Continuation'
    });
  }

  if (trend === 'RANGING') {
    if (isHigherHigh && isHigherLow) trend = 'UPTREND';
    else if (isLowerHigh && isLowerLow) trend = 'DOWNTREND';
  }

  const lastCHoCH = chochEvents.length ? chochEvents[chochEvents.length - 1] : null;
  const lastBOS = bosEvents.length ? bosEvents[bosEvents.length - 1] : null;

  let smcSignal = 'NEUTRAL';
  let score = 0;
  if (lastCHoCH?.type === 'BULLISH_CHOCH') score += 1.5;
  if (lastCHoCH?.type === 'BEARISH_CHOCH') score -= 1.5;
  if (lastBOS?.type === 'BULLISH_BOS') { score += 2.0; smcSignal = 'BULLISH_BOS'; }
  if (lastBOS?.type === 'BEARISH_BOS') { score -= 2.0; smcSignal = 'BEARISH_BOS'; }

  const bosAfterChoch = lastCHoCH && lastBOS && lastBOS.index >= lastCHoCH.index;

  if (bosAfterChoch && lastCHoCH.type === 'BULLISH_CHOCH' && lastBOS.type === 'BULLISH_BOS') {
    const demandZone = strongLow.price;
    if (currentPrice <= demandZone * 1.005) {
      smcSignal = 'SMC_BUY_PULLBACK';
      score += 2.5;
    }
  } else if (bosAfterChoch && lastCHoCH.type === 'BEARISH_CHOCH' && lastBOS.type === 'BEARISH_BOS') {
    const supplyZone = strongHigh.price;
    if (currentPrice >= supplyZone * 0.995) {
      smcSignal = 'SMC_SHORT_PULLBACK';
      score -= 2.5;
    }
  }

  if (smcSignal === 'NEUTRAL' || smcSignal === 'BULLISH_BOS' || smcSignal === 'BEARISH_BOS') {
    if (Math.abs(currentPrice - strongLow.price) / currentPrice < 0.003) {
      smcSignal = 'STRONG_LOW_BUY';
      score += 1.5;
    } else if (Math.abs(currentPrice - strongHigh.price) / currentPrice < 0.003) {
      smcSignal = 'STRONG_HIGH_SELL';
      score -= 1.5;
    } else if (currentPrice <= weakLow.price * 1.001) {
      smcSignal = 'WEAK_LOW_SELL';
      score -= 0.8;
    } else if (currentPrice >= weakHigh.price * 0.999) {
      smcSignal = 'WEAK_HIGH_BUY';
      score += 0.8;
    }
  }

  return {
    structureState: trend,
    swingHighs: swingHighs.slice(-5),
    swingLows: swingLows.slice(-5),
    lastCHoCH,
    lastBOS,
    smcSignal,
    strongHigh,
    strongLow,
    weakHigh,
    weakLow,
    score
  };
}

// ============================================================
// PRICE PROXIMITY TO KEY LEVELS (PDH/PDL, Session, ORB, IB, FVG, POC, VWAP, SMC)
// Returns score contribution and level analysis
// ============================================================
function evaluateKeyLevels(currentPrice, pdLevels, sessionLevels, smcStructure, orbData, ibData, fvgData, pocData, vwapData) {
  let score = 0;
  const keyLevelSignals = [];

  // --- PDH / PDL ---
  if (pdLevels && pdLevels.pdh && pdLevels.pdl) {
    const pdhDist = Math.abs(currentPrice - pdLevels.pdh) / currentPrice;
    const pdlDist = Math.abs(currentPrice - pdLevels.pdl) / currentPrice;
    if (pdLevels.isAbovePDH) { score += 1.5; keyLevelSignals.push('Above PDH (Bullish Breakout)'); }
    else if (pdLevels.isBelowPDL) { score -= 1.5; keyLevelSignals.push('Below PDL (Bearish Breakdown)'); }
    else if (pdhDist < 0.003) { score -= 0.8; keyLevelSignals.push(`Near PDH Resistance`); }
    else if (pdlDist < 0.003) { score += 0.8; keyLevelSignals.push(`Near PDL Support`); }
  }

  // --- Session Levels ---
  if (sessionLevels) {
    const sessionKey = { TOKYO: 'tokyo', LONDON: 'london', NEW_YORK: 'newyork' }[sessionLevels.currentSession];
    const session = (sessionKey && sessionLevels[sessionKey]) ||
                    sessionLevels.london || sessionLevels.newyork;
    if (session) {
      const highDist = Math.abs(currentPrice - session.high) / currentPrice;
      const lowDist  = Math.abs(currentPrice - session.low)  / currentPrice;
      if (highDist < 0.002) { score -= 0.6; keyLevelSignals.push('At Session High (Resistance)'); }
      if (lowDist  < 0.002) { score += 0.6; keyLevelSignals.push('At Session Low (Support)'); }
    }
  }

  // --- VWAP Bias ---
  if (vwapData && vwapData.vwap) {
    if (vwapData.vwapBias === 'ABOVE') { score += 0.8; keyLevelSignals.push(`Above VWAP (${vwapData.distPercent.toFixed(2)}%) – Bullish`); }
    else if (vwapData.vwapBias === 'BELOW') { score -= 0.8; keyLevelSignals.push(`Below VWAP (${vwapData.distPercent.toFixed(2)}%) – Bearish`); }
    // VWAP retest: price returning to VWAP after being far = potential bounce
    if (Math.abs(vwapData.distPercent) < 0.05) { keyLevelSignals.push('At VWAP (Key Level)'); }
  }

  // --- ORB (Opening Range Breakout) ---
  if (orbData && orbData.orbHigh) {
    if (orbData.isAboveORB) { score += 1.2; keyLevelSignals.push(`ORB Breakout ↑ ($${orbData.orbHigh.toFixed(4)})`); }
    else if (orbData.isBelowORB) { score -= 1.2; keyLevelSignals.push(`ORB Breakdown ↓ ($${orbData.orbLow.toFixed(4)})`); }
    // At ORB edge = potential breakout zone
    const highDist = Math.abs(currentPrice - orbData.orbHigh) / currentPrice;
    const lowDist  = Math.abs(currentPrice - orbData.orbLow) / currentPrice;
    if (highDist < 0.002 && !orbData.isAboveORB) { score += 0.5; keyLevelSignals.push('Testing ORB High'); }
    if (lowDist  < 0.002 && !orbData.isBelowORB) { score -= 0.5; keyLevelSignals.push('Testing ORB Low'); }
  }

  // --- Initial Balance (IB) ---
  if (ibData && ibData.ibh) {
    if (ibData.ibBias === 'ABOVE_IBH_BULLISH') { score += 1.0; keyLevelSignals.push(`Above IBH ($${ibData.ibh.toFixed(4)}) – Bullish`); }
    else if (ibData.ibBias === 'BELOW_IBL_BEARISH') { score -= 1.0; keyLevelSignals.push(`Below IBL ($${ibData.ibl.toFixed(4)}) – Bearish`); }
    // Near extension targets
    if (ibData.nearTarget05) keyLevelSignals.push('Near IB +0.5x Target');
    if (ibData.nearTarget1)  keyLevelSignals.push('Near IB +1.0x Target');
  }

  // --- FVG (Fair Value Gap) ---
  if (fvgData && fvgData.fvgScore !== 0) {
    score += fvgData.fvgScore;
    if (fvgData.fvgScore > 0) keyLevelSignals.push(`Bullish FVG Support Zone`);
    else keyLevelSignals.push(`Bearish FVG Resistance Zone`);
  }

  // --- POC (Point of Control) ---
  if (pocData && pocData.poc) {
    score += pocData.pocScore;
    if (pocData.isNearPOC) keyLevelSignals.push(`At POC ($${pocData.poc.toFixed(4)}) – High Volume Node`);
    else if (pocData.pocScore > 0) keyLevelSignals.push(`Price Above POC – Bullish`);
    else keyLevelSignals.push(`Price Below POC – Bearish`);
  }

  return { keyLevelScore: score, keyLevelSignals };
}

function packBars(candles, group) {
  if (!Array.isArray(candles) || candles.length < group) return [];
  const out = [];
  for (let i = 0; i + group <= candles.length; i += group) {
    const slice = candles.slice(i, i + group);
    out.push({
      time: slice[0].time || slice[0].openTime,
      openTime: slice[0].openTime || slice[0].time,
      open: slice[0].open,
      high: Math.max(...slice.map(c => Number(c.high))),
      low: Math.min(...slice.map(c => Number(c.low))),
      close: slice[slice.length - 1].close,
      volume: slice.reduce((s, c) => s + Number(c.volume || 0), 0)
    });
  }
  return out;
}

// Evaluate Macro Trend on higher timeframe candles
function evaluateMacroTrend(candles) {
  if (!candles || candles.length < 15) {
    return { trend: 'NEUTRAL', score: 0, rsi: 50, emaTrend: 'FLAT' };
  }
  const closes = candles.map(c => c.close);
  const currentPrice = closes[closes.length - 1];
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const rsi = calcRSI(closes, 14);
  const macd = calcMACD(closes, 12, 26, 9);
  let score = 0;
  if (ema9 && ema21) {
    if (ema9 > ema21 && currentPrice >= ema9) score += 1.5;
    else if (ema9 < ema21 && currentPrice <= ema9) score -= 1.5;
  }
  if (macd.histogram > 0) score += 1.0;
  else if (macd.histogram < 0) score -= 1.0;
  if (rsi > 55) score += 0.5;
  else if (rsi < 45) score -= 0.5;
  let trend = 'NEUTRAL';
  if (score >= 1.5) trend = 'BULLISH';
  else if (score <= -1.5) trend = 'BEARISH';
  return { trend, score, rsi: Math.round(rsi), macdHist: macd.histogram, price: currentPrice };
}

class AIBrain {
  constructor(savedState = null) {
    this.learningRate = 0.05;
    this.totalTradesLearned = savedState?.totalTradesLearned || 0;
    this.winRate = savedState?.winRate || 0;
    this.successfulTrades = savedState?.successfulTrades || 0;
    this.totalProfitRealized = savedState?.totalProfitRealized || 0;
    this.experienceMemory = savedState?.experienceMemory || [];
    this.confirmWeights = {
      '5m': 1, '15m': 1, '1h': 1, ATR: 1, ADX: 1, SMC: 1, B: 1, RL: 1, '5mF': 1,
      FUND: 1, LSR: 1, FNG: 1, BTC: 1,
      ...(savedState?.confirmWeights || {})
    };
    this.nnFrozen = false;
    this.nnLoss = savedState?.nnLoss || 0.22;
    const DEFAULT_WEIGHTS = {
      emaTrend: 1.20,
      rsiMomentum: 1.05,
      macdMomentum: 1.25,
      adxTrendStrength: 1.10,
      bollingerBreakout: 0.90,
      volumeSurge: 0.80,
      neuralNetPredictor: 1.45,
      smcStructure: 1.60,    // Smart Money Concepts (CHoCH, BOS, Strong/Weak)
      keyLevels: 1.30,       // PDH/PDL + Session levels
      cvdPressure: 0.95,     // Cumulative Volume Delta
      vwapBias: 1.10,        // VWAP session bias
      orbLevel: 1.20,        // Opening Range Breakout
      initialBalance: 1.15,  // Initial Balance High/Low extensions
      fvgImbalance: 1.40,    // Fair Value Gap (imbalance fill zones)
      pocLevel: 0.85         // Point of Control (volume magnet)
    };

    this.weights = { ...DEFAULT_WEIGHTS, ...(savedState?.weights || {}) };

    this.nnModel = null;
    this.nnReady = false;
    this.nnLoadedFromDisk = false;
    this._trainQueue = Promise.resolve();
    this.nnInitPromise = this.initNeuralNetwork();
  }

  async ready() {
    await this.nnInitPromise;
  }

  buildFreshNetwork() {
    const model = tf.sequential();
    model.add(tf.layers.dense({ units: 40, activation: 'relu', inputShape: [15] }));
    model.add(tf.layers.dropout({ rate: 0.1 }));
    model.add(tf.layers.dense({ units: 20, activation: 'relu' }));
    model.add(tf.layers.dense({ units: 1, activation: 'sigmoid' }));
    model.compile({ optimizer: tf.train.adam(0.006), loss: 'binaryCrossentropy' });
    return model;
  }

  async loadModelFromFile(file) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const buf = Buffer.from(raw.weightData, 'base64');
    const weightData = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    this.nnModel = await tf.loadLayersModel(tf.io.fromMemory({
      modelTopology: raw.modelTopology,
      weightSpecs: raw.weightSpecs,
      weightData
    }));
    this.nnModel.compile({ optimizer: tf.train.adam(0.002), loss: 'binaryCrossentropy' });
    this.nnLoadedFromDisk = true;
    this.nnReady = true;
  }

  async initNeuralNetwork() {
    const liveExists = fs.existsSync(NN_MODEL_LIVE_FILE);
    const yearExists = fs.existsSync(NN_MODEL_FILE);
    if (liveExists || yearExists) {
      try {
        const file = liveExists ? NN_MODEL_LIVE_FILE : NN_MODEL_FILE;
        await this.loadModelFromFile(file);
        this.nnFrozen = false;
        console.log(`[NN] Loaded Model A from ${path.basename(file)} — 1m closes still train it; year file nn_model.json is not overwritten`);
        await secondOpinion.loadModelB();
        await rlPolicy.init();
        return;
      } catch (err) {
        console.error('[NN] Failed to load Model A, rebuilding:', err.message);
      }
    }

    this.nnModel = this.buildFreshNetwork();
    await this.replayTrainFromMemory();
    await secondOpinion.loadModelB();
    await rlPolicy.init();
    console.log(`[NN] Fresh 15-input net. Ready=${this.nnReady} (needs a saved model or ${MIN_NN_TRADES} trained samples).`);
  }

  async replayTrainFromMemory() {
    const samples = (this.experienceMemory || []).filter(m =>
      Array.isArray(m.features) && m.features.length === 15 && typeof m.target === 'number'
    );
    if (samples.length < 5 || !this.nnModel) return;
    const xs = tf.tensor2d(samples.map(s => s.features));
    const ys = tf.tensor2d(samples.map(s => [s.target]));
    try {
      const info = await this.nnModel.fit(xs, ys, {
        epochs: Math.min(12, Math.max(4, Math.floor(samples.length / 2))),
        batchSize: Math.min(8, samples.length),
        shuffle: true,
        verbose: 0
      });
      this.nnLoss = info.history.loss[info.history.loss.length - 1];
      this.nnLoadedFromDisk = true;
      this.nnReady = samples.length >= MIN_NN_TRADES || this.totalTradesLearned >= MIN_NN_TRADES;
      await this.saveNeuralNet(NN_MODEL_LIVE_FILE);
      console.log(`[NN] Replay-trained on ${samples.length} stored samples. Loss=${this.nnLoss.toFixed(4)}`);
    } catch (err) {
      console.error('[NN] Replay train failed:', err.message);
    } finally {
      xs.dispose();
      ys.dispose();
    }
  }

  async saveNeuralNet(file = NN_MODEL_FILE) {
    if (!this.nnModel) return;
    try {
      await this.nnModel.save(tf.io.withSaveHandler(async (artifacts) => {
        fs.writeFileSync(file, JSON.stringify({
          modelTopology: artifacts.modelTopology,
          weightSpecs: artifacts.weightSpecs,
          weightData: Buffer.from(artifacts.weightData).toString('base64'),
          savedAt: new Date().toISOString()
        }));
        return { modelArtifactsInfo: { dateSaved: new Date(), modelTopologyType: 'JSON' } };
      }));
    } catch (err) {
      console.error('[NN] Save failed:', err.message);
    }
  }

  // Extract 15 normalized feature vectors (upgraded from 11)
  extractFeatures(candles, smcStructure = null, pdLevels = null, cvdData = null, vwapData = null, orbData = null, ibData = null, fvgData = null, pocData = null) {
    const closes = candles.map(c => c.close);
    const currentPrice = closes[closes.length - 1];
    const prevPrice = closes[closes.length - 2] || currentPrice;
    const priceReturn = (currentPrice - prevPrice) / prevPrice;

    const rsi = calcRSI(closes, 14) / 100;
    const ema9 = calcEMA(closes, 9);
    const ema21 = calcEMA(closes, 21);
    const emaDiff = (ema9 && ema21) ? (ema9 - ema21) / currentPrice : 0;

    const atr = calcATR(candles, 14);
    const normATR = atr / currentPrice;

    const volumes = candles.map(c => c.volume);
    const avgVol = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const volRatio = Math.min(3, volumes[volumes.length - 1] / (avgVol || 1)) / 3;

    const bb = calcBollingerBands(closes, 20, 2);
    const bbPos = bb ? (currentPrice - bb.lower) / (bb.upper - bb.lower || 1) : 0.5;

    const macdData = calcMACD(closes, 12, 26, 9);
    const normHist = Math.max(-1, Math.min(1, (macdData.histogram / (currentPrice * 0.002 || 1))));

    const adxData = calcADX(candles, 14);
    const normADX = adxData.adx / 100;

    // Feature 9: SMC Structure score
    const normSMC = smcStructure ? Math.max(-1, Math.min(1, smcStructure.score / 3)) : 0;

    // Feature 10: PDH/PDL position
    let normPDL = 0;
    if (pdLevels && pdLevels.pdh && pdLevels.pdl) {
      if (pdLevels.isAbovePDH) normPDL = 1;
      else if (pdLevels.isBelowPDL) normPDL = -1;
      else {
        const pdRange = pdLevels.pdRange || 1;
        normPDL = ((currentPrice - pdLevels.pdl) / pdRange) * 2 - 1;
      }
    }

    // Feature 11: CVD buy pressure
    const normCVD = cvdData ? (cvdData.buyPressure - 50) / 50 : 0;

    // Feature 12: VWAP bias (above=+1, below=-1, neutral=0)
    const normVWAP = vwapData ? (vwapData.vwapBias === 'ABOVE' ? 1 : vwapData.vwapBias === 'BELOW' ? -1 : 0) : 0;

    // Feature 13: ORB bias (above ORB = bullish, below = bearish, inside = 0)
    const normORB = orbData ? (orbData.isAboveORB ? 1 : orbData.isBelowORB ? -1 : 0) : 0;

    // Feature 14: IB bias encoded
    const ibBiasMap = { 'ABOVE_IBH_BULLISH': 1, 'UPPER_HALF_BULLISH': 0.5, 'INSIDE': 0, 'LOWER_HALF_BEARISH': -0.5, 'BELOW_IBL_BEARISH': -1, 'UNDEFINED': 0 };
    const normIB = ibData ? (ibBiasMap[ibData.ibBias] ?? 0) : 0;

    // Feature 15: FVG + POC combined score
    const fvgScore = fvgData ? Math.max(-1, Math.min(1, fvgData.fvgScore / 1.5)) : 0;
    const pocScore = pocData ? Math.max(-1, Math.min(1, pocData.pocScore)) : 0;
    const normFVGPOC = (fvgScore + pocScore) / 2;

    return [
      Math.max(-1, Math.min(1, priceReturn * 25)),  // 1: Price momentum
      Math.max(0, Math.min(1, rsi)),                  // 2: RSI
      Math.max(-1, Math.min(1, emaDiff * 60)),        // 3: EMA alignment
      Math.max(0, Math.min(1, normATR * 60)),         // 4: Volatility
      volRatio,                                        // 5: Volume ratio
      Math.max(0, Math.min(1, bbPos)),                // 6: Bollinger position
      normHist,                                        // 7: MACD histogram
      normADX,                                         // 8: ADX trend strength
      normSMC,                                         // 9: SMC structure
      normPDL,                                         // 10: PDH/PDL position
      normCVD,                                         // 11: CVD pressure
      normVWAP,                                        // 12: VWAP bias
      normORB,                                         // 13: ORB bias
      normIB,                                          // 14: Initial Balance bias
      normFVGPOC                                       // 15: FVG + POC combined
    ];
  }

  predictWithNeuralNet(features) {
    if (!this.nnReady || !this.nnModel) return 0.5;
    try {
      const inputTensor = tf.tensor2d([features]);
      const prediction = this.nnModel.predict(inputTensor);
      const prob = prediction.dataSync()[0];
      inputTensor.dispose();
      prediction.dispose();
      return prob;
    } catch (e) {
      return 0.5;
    }
  }

  // Full 1m market analysis combining Indicators + SMC + PDH/PDL + CVD + Neural Net
  analyzeMarket(candles, dailyCandles = null, featureFlags = {}) {
    if (!candles || candles.length < 35) {
      return { signal: 'HOLD', confidence: 0, reason: 'Insufficient candle history', opportunityScore: 0 };
    }

    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    const currentPrice = closes[closes.length - 1];

    const ema9 = calcEMA(closes, 9);
    const ema21 = calcEMA(closes, 21);
    const ema50 = calcEMA(closes, 50);
    const rsi14 = calcRSI(closes, 14);
    const atr14 = calcATR(candles, 14);
    const bb = calcBollingerBands(closes, 20, 2);
    const macdData = calcMACD(closes, 12, 26, 9);
    const adxData = calcADX(candles, 14);

    // New indicators
    const smcOn = featureFlags.smcEnabled !== false;
    const sessionOn = featureFlags.useSessionLevels !== false;
    const pdhOn = featureFlags.usePDHPDL !== false;

    const cvdData = calcCVD(candles);
    const smcStructure = smcOn ? calcMarketStructure(candles) : emptySmc();
    const pdLevels = pdhOn ? calcPreviousDayLevels(dailyCandles) : { pdh: null, pdl: null, isAbovePDH: false, isBelowPDL: false, pdmid: null };
    const sessionLevels = sessionOn ? calcSessionLevels(candles) : { tokyo: null, london: null, newyork: null, currentSession: 'OFFHOURS' };

    const vwapData = sessionOn ? calcVWAP(candles) : { vwap: null, vwapBias: 'NEUTRAL', distPercent: 0 };
    const orbData  = sessionOn ? calcORB(candles) : { orbHigh: null, orbLow: null, orbBias: 'NEUTRAL', isAboveORB: false, isBelowORB: false };
    const ibData   = sessionOn ? calcInitialBalance(candles) : { ibh: null, ibl: null, ibMid: null, ibBias: 'UNDEFINED' };
    const fvgData  = calcFVG(candles);
    const pocData  = calcPOC(candles);

    const { keyLevelScore, keyLevelSignals } = evaluateKeyLevels(
      currentPrice, pdLevels, sessionLevels, smcStructure,
      orbData, ibData, fvgData, pocData, vwapData
    );

    const avgVolume = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const currentVolume = volumes[volumes.length - 1];
    const isVolumeSurge = currentVolume > avgVolume * 1.25;

    const features = this.extractFeatures(candles, smcStructure, pdLevels, cvdData, vwapData, orbData, ibData, fvgData, pocData);
    const nnBullishProbability = featureFlags.useNeuralNet === false
      ? 0.5
      : this.predictWithNeuralNet(features);

    if (featureFlags.symbol) {
      secondOpinion.queryExternal(featureFlags.symbol, closes).catch(() => {});
    }
    const opinion = secondOpinion.consult(features, featureFlags.symbol, closes);

    // --- Scoring Engine ---
    let scoreEMA = 0;
    if (ema9 && ema21 && ema50) {
      if (ema9 > ema21 && currentPrice > ema9) scoreEMA += 1;
      if (ema21 > ema50) scoreEMA += 1;
      if (ema9 < ema21 && currentPrice < ema9) scoreEMA -= 1;
      if (ema21 < ema50) scoreEMA -= 1;
    }

    const bearTrend = adxData.isTrending && adxData.minusDI > adxData.plusDI;
    const bullTrend = adxData.isTrending && adxData.plusDI > adxData.minusDI;

    let scoreRSI = 0;
    if (bearTrend) {
      if (rsi14 > 70) scoreRSI -= 1.5;
      else if (rsi14 > 55) scoreRSI -= 0.6;
    } else if (bullTrend) {
      if (rsi14 < 30) scoreRSI += 1.5;
      else if (rsi14 < 45) scoreRSI += 0.6;
    } else if (rsi14 < 30) scoreRSI += 1.5;
    else if (rsi14 < 45) scoreRSI += 0.6;
    else if (rsi14 > 70) scoreRSI -= 1.5;
    else if (rsi14 > 55) scoreRSI -= 0.6;

    let scoreMACD = 0;
    if (macdData.bullishCross || (macdData.histogram > 0 && macdData.macd > macdData.signal)) {
      scoreMACD += macdData.bullishCross ? 1.5 : 0.8;
    } else if (macdData.bearishCross || (macdData.histogram < 0 && macdData.macd < macdData.signal)) {
      scoreMACD -= macdData.bearishCross ? 1.5 : 0.8;
    }

    let scoreADX = 0;
    if (adxData.isTrending) {
      scoreADX = (adxData.plusDI > adxData.minusDI) ? 1.0 : -1.0;
    }

    let scoreBB = 0;
    if (bb) {
      if (bullTrend && currentPrice <= bb.lower * 1.002) scoreBB += 1.2;
      else if (bearTrend && currentPrice >= bb.upper * 0.998) scoreBB -= 1.2;
      else if (!adxData.isTrending) {
        if (currentPrice <= bb.lower * 1.002) scoreBB += 1.2;
        else if (currentPrice >= bb.upper * 0.998) scoreBB -= 1.2;
      }
    }

    const scoreVol = isVolumeSurge ? 1.0 : 0.0;
    const scoreNN = (this.nnReady && featureFlags.useNeuralNet !== false)
      ? (nnBullishProbability - 0.5) * 3
      : 0;

    // SMC structural score
    const scoreSMC = Math.max(-2.5, Math.min(2.5, smcStructure.score));

    // CVD pressure score
    let scoreCVD = 0;
    if (cvdData.deltaTrend === 'BUYING') scoreCVD = 0.8;
    else if (cvdData.deltaTrend === 'SELLING') scoreCVD = -0.8;

    // Key levels score (PDH/PDL + Session + VWAP + ORB + IB + FVG + POC)
    const scoreKeyLevels = Math.max(-3.0, Math.min(3.0, keyLevelScore));

    // VWAP directional score
    const scoreVWAP = vwapData?.vwapBias === 'ABOVE' ? 0.8 : vwapData?.vwapBias === 'BELOW' ? -0.8 : 0;

    // ORB directional score
    const scoreORB = orbData?.isAboveORB ? 1.0 : orbData?.isBelowORB ? -1.0 : 0;

    // Initial Balance bias score
    const ibBiasScores = { 'ABOVE_IBH_BULLISH': 1.0, 'UPPER_HALF_BULLISH': 0.4, 'INSIDE': 0, 'LOWER_HALF_BEARISH': -0.4, 'BELOW_IBL_BEARISH': -1.0, 'UNDEFINED': 0 };
    const scoreIB = ibBiasScores[ibData?.ibBias] || 0;

    // FVG score
    const scoreFVG = fvgData?.fvgScore || 0;

    // POC score
    const scorePOC = pocData?.pocScore || 0;

    const buyScore = (
      Math.max(0, scoreEMA)        * this.weights.emaTrend +
      Math.max(0, scoreRSI)        * this.weights.rsiMomentum +
      Math.max(0, scoreMACD)       * this.weights.macdMomentum +
      Math.max(0, scoreADX)        * this.weights.adxTrendStrength +
      Math.max(0, scoreBB)         * this.weights.bollingerBreakout +
      (scoreEMA > 0 ? scoreVol * this.weights.volumeSurge : 0) +
      Math.max(0, scoreNN)         * this.weights.neuralNetPredictor +
      Math.max(0, scoreSMC)        * this.weights.smcStructure +
      Math.max(0, scoreKeyLevels)  * this.weights.keyLevels +
      Math.max(0, scoreCVD)        * this.weights.cvdPressure +
      Math.max(0, scoreVWAP)       * this.weights.vwapBias +
      Math.max(0, scoreORB)        * this.weights.orbLevel +
      Math.max(0, scoreIB)         * this.weights.initialBalance +
      Math.max(0, scoreFVG)        * this.weights.fvgImbalance +
      Math.max(0, scorePOC)        * this.weights.pocLevel
    );

    const sellScore = (
      Math.max(0, -scoreEMA)       * this.weights.emaTrend +
      Math.max(0, -scoreRSI)       * this.weights.rsiMomentum +
      Math.max(0, -scoreMACD)      * this.weights.macdMomentum +
      Math.max(0, -scoreADX)       * this.weights.adxTrendStrength +
      Math.max(0, -scoreBB)        * this.weights.bollingerBreakout +
      (scoreEMA < 0 ? scoreVol * this.weights.volumeSurge : 0) +
      Math.max(0, -scoreNN)        * this.weights.neuralNetPredictor +
      Math.max(0, -scoreSMC)       * this.weights.smcStructure +
      Math.max(0, -scoreKeyLevels) * this.weights.keyLevels +
      Math.max(0, -scoreCVD)       * this.weights.cvdPressure +
      Math.max(0, -scoreVWAP)      * this.weights.vwapBias +
      Math.max(0, -scoreORB)       * this.weights.orbLevel +
      Math.max(0, -scoreIB)        * this.weights.initialBalance +
      Math.max(0, -scoreFVG)       * this.weights.fvgImbalance +
      Math.max(0, -scorePOC)       * this.weights.pocLevel
    );

    const netScore = buyScore - sellScore;
    const maxPotentialScore = (
      2   * this.weights.emaTrend +
      1.5 * this.weights.rsiMomentum +
      1.5 * this.weights.macdMomentum +
      1.0 * this.weights.adxTrendStrength +
      1.2 * this.weights.bollingerBreakout +
      1.0 * this.weights.volumeSurge +
      ((this.nnReady && featureFlags.useNeuralNet !== false) ? 1.5 * this.weights.neuralNetPredictor : 0) +
      (smcOn ? 2.5 * this.weights.smcStructure : 0) +
      3.0 * this.weights.keyLevels +
      0.8 * this.weights.cvdPressure +
      0.8 * this.weights.vwapBias +
      1.0 * this.weights.orbLevel +
      1.0 * this.weights.initialBalance +
      1.5 * this.weights.fvgImbalance +
      0.5 * this.weights.pocLevel
    );

    const safeMax = maxPotentialScore > 0 ? maxPotentialScore : 15.0;
    const confidence = isNaN(netScore) ? 50 : Math.min(100, Math.max(0, Math.round((Math.abs(netScore) / safeMax) * 100)));

    let opportunityScore = Math.round(
      (confidence * 0.40) +
      (Math.min(50, adxData.adx || 20) * 0.20) +
      (isVolumeSurge ? 8 : 0) +
      (Math.abs(scoreSMC || 0) > 1 ? 10 : 0) +
      (Math.abs(scoreKeyLevels || 0) > 0.5 ? 7 : 0) +
      (cvdData.deltaTrend !== 'NEUTRAL' ? 5 : 0) +
      (Math.abs(scoreFVG || 0) > 0 ? 8 : 0) +        // FVG hit = high conviction
      (orbData?.isAboveORB || orbData?.isBelowORB ? 7 : 0) +  // ORB breakout
      (ibData?.ibBias !== 'INSIDE' && ibData?.ibBias !== 'UNDEFINED' ? 5 : 0) // IB directional
    );
    opportunityScore = isNaN(opportunityScore) ? 50 : Math.min(100, Math.max(0, opportunityScore));


    let decision = 'HOLD';
    const primaryReasons = [];
    const isSmcPullbackBuy = smcOn && smcStructure.smcSignal === 'SMC_BUY_PULLBACK';
    const isSmcPullbackShort = smcOn && smcStructure.smcSignal === 'SMC_SHORT_PULLBACK';

    if (adxData.isChoppy && !isSmcPullbackBuy && !isSmcPullbackShort) {
      decision = 'CHOP_SKIP';
      primaryReasons.push(`Choppy/Flat Range (ADX: ${adxData.adx.toFixed(1)})`);
    } else if (isSmcPullbackBuy && netScore >= 0) {
      decision = 'BUY';
      primaryReasons.push('SMC Buy Pullback (CHoCH→BOS→Demand)');
    } else if (isSmcPullbackShort && netScore <= 0) {
      decision = 'SHORT';
      primaryReasons.push('SMC Short Pullback (CHoCH→BOS→Supply)');
    } else if (netScore > 3.2 && confidence >= 55 && (bullTrend || scoreEMA > 0)) {
      decision = 'BUY';
      if (scoreNN > 0.4) primaryReasons.push(`Neural Net Bullish (${(nnBullishProbability * 100).toFixed(0)}%)`);
      if (scoreMACD > 0) primaryReasons.push('MACD Bullish Cross');
      if (scoreEMA > 0) primaryReasons.push('EMA Trend Align');
      if (adxData.isTrending) primaryReasons.push(`ADX Trend Strong (${adxData.adx.toFixed(0)})`);
      if (isVolumeSurge) primaryReasons.push('Volume Surge');
    } else if (netScore < -3.2 && confidence >= 55 && (bearTrend || scoreEMA < 0)) {
      decision = 'SHORT';
      if (scoreNN < -0.4) primaryReasons.push(`Neural Net Bearish (${(nnBullishProbability * 100).toFixed(0)}%)`);
      if (scoreMACD < 0) primaryReasons.push('MACD Bearish');
      if (scoreEMA < 0) primaryReasons.push('EMA Bearish Trend');
      if (adxData.isTrending) primaryReasons.push('ADX Strong Bear Move');
    }

    // Add FVG, ORB, IB signals to reasons
    if (fvgData?.fvgScore > 0) primaryReasons.push('📦 Bullish FVG Fill Zone');
    else if (fvgData?.fvgScore < 0) primaryReasons.push('📦 Bearish FVG Fill Zone');
    if (orbData?.isAboveORB) primaryReasons.push(`🚀 ORB Breakout ↑`);
    else if (orbData?.isBelowORB) primaryReasons.push(`⬇️ ORB Breakdown`);
    if (vwapData?.vwapBias === 'ABOVE') primaryReasons.push('VWAP Bullish Bias');
    else if (vwapData?.vwapBias === 'BELOW') primaryReasons.push('VWAP Bearish Bias');
    if (ibData?.ibBias === 'ABOVE_IBH_BULLISH') primaryReasons.push(`🏛️ Above IBH (${ibData.ibh?.toFixed(4)})`);
    else if (ibData?.ibBias === 'BELOW_IBL_BEARISH') primaryReasons.push(`🏛️ Below IBL`);

    if (opinion && opinion.pBull != null) {
      if ((decision === 'BUY' && opinion.agreeLong) || (decision === 'SHORT' && opinion.agreeShort)) {
        opportunityScore = Math.min(100, opportunityScore + 6);
        primaryReasons.push(`2nd opinion agrees (${opinion.summary})`);
      } else if ((decision === 'BUY' && opinion.agreeShort) || (decision === 'SHORT' && opinion.agreeLong)) {
        opportunityScore = Math.max(0, opportunityScore - 6);
        primaryReasons.push(`2nd opinion disagrees (${opinion.summary})`);
      }
    }

    const rl = (rlPolicy.ready && Array.isArray(features) && features.length === 15)
      ? rlPolicy.act(features)
      : { action: 'HOLD', index: 0, probs: [1, 0, 0] };
    if (decision === 'BUY' || decision === 'SHORT') {
      const want = decision === 'BUY' ? 'LONG' : 'SHORT';
      if (rl.action === want) {
        opportunityScore = Math.min(100, opportunityScore + 4);
        primaryReasons.push(`RL agrees ${rl.action} (${(rl.probs[rl.index] * 100).toFixed(0)}%)`);
      } else if (rl.action === 'HOLD') {
        primaryReasons.push(`RL hold (${(rl.probs[0] * 100).toFixed(0)}%)`);
      } else {
        opportunityScore = Math.max(0, opportunityScore - 4);
        primaryReasons.push(`RL leans ${rl.action} (${(rl.probs[rl.index] * 100).toFixed(0)}%)`);
      }
    }

    return {
      signal: decision,
      confidence,
      opportunityScore,
      currentPrice,
      atr: atr14 || (currentPrice * 0.005),
      rsi: rsi14,
      ema9, ema21, ema50,
      bb,
      macd: macdData,
      adx: adxData,
      cvd: cvdData,
      vwap: vwapData,
      orb: orbData,
      ib: ibData,
      fvg: fvgData,
      poc: pocData,
      smcStructure,
      pdLevels,
      sessionLevels,
      keyLevelSignals,
      isVolumeSurge,
      features,
      nnBullishProbability: this.nnReady ? Math.round(nnBullishProbability * 100) : null,
      nnReady: this.nnReady,
      secondOpinion: opinion,
      rl: {
        action: rl.action,
        hold: Math.round((rl.probs[0] || 0) * 100),
        long: Math.round((rl.probs[1] || 0) * 100),
        short: Math.round((rl.probs[2] || 0) * 100)
      },
      reasons: primaryReasons.length ? primaryReasons.join(' + ') : 'Analyzing / Market Neutral',
      rawScores: { scoreEMA, scoreRSI, scoreMACD, scoreADX, scoreBB, scoreVol, scoreNN, scoreSMC, scoreCVD, scoreKeyLevels, scoreVWAP, scoreORB, scoreIB, scoreFVG, scorePOC, netScore }
    };
  }

  // Cross-Timeframe Confirmation (1m fill + 5m/15m/1h votes)
  analyzeMultiTimeframe(candles1m, candles5m, candles1h, candles4h, mtfStrictness = '5m_15m_1h', dailyCandles = null, featureFlags = {}) {
    const analysis1m = this.analyzeMarket(candles1m, dailyCandles, featureFlags);
    const candles15m = featureFlags.candles15m || packBars(candles5m, 3);
    const mtf5m = evaluateMacroTrend(candles5m);
    const mtf15m = evaluateMacroTrend(candles15m);
    const mtf1h = evaluateMacroTrend(candles1h);
    const mtf4h = evaluateMacroTrend(candles4h);

    let isConfirmed = true;
    let mtfRejectionReason = null;
    const wants = (tf) => String(mtfStrictness || '').split('_').includes(tf);

    if (analysis1m.signal === 'BUY') {
      if (wants('5m') && mtf5m.trend === 'BEARISH') { isConfirmed = false; mtfRejectionReason = 'Blocked: 5m Bearish'; }
      if (wants('15m') && mtf15m.trend === 'BEARISH') { isConfirmed = false; mtfRejectionReason = 'Blocked: 15m Bearish'; }
      if (wants('1h') && mtf1h.trend === 'BEARISH') { isConfirmed = false; mtfRejectionReason = 'Blocked: 1h Downtrend'; }
      if (wants('4h') && mtf4h.trend === 'BEARISH') { isConfirmed = false; mtfRejectionReason = 'Blocked: 4h Downtrend'; }
    } else if (analysis1m.signal === 'SHORT') {
      if (wants('5m') && mtf5m.trend === 'BULLISH') { isConfirmed = false; mtfRejectionReason = 'Blocked: 5m Bullish'; }
      if (wants('15m') && mtf15m.trend === 'BULLISH') { isConfirmed = false; mtfRejectionReason = 'Blocked: 15m Bullish'; }
      if (wants('1h') && mtf1h.trend === 'BULLISH') { isConfirmed = false; mtfRejectionReason = 'Blocked: 1h Uptrend'; }
      if (wants('4h') && mtf4h.trend === 'BULLISH') { isConfirmed = false; mtfRejectionReason = 'Blocked: 4h Uptrend'; }
    }

    const merged = {
      ...analysis1m,
      mtf: {
        '1m': analysis1m.signal,
        '5m': mtf5m.trend,
        '15m': mtf15m.trend,
        '1h': mtf1h.trend,
        '4h': mtf4h.trend,
        isConfirmed,
        mtfRejectionReason
      }
    };
    if (analysis1m.signal === 'BUY' || analysis1m.signal === 'SHORT') {
      const dir = analysis1m.signal === 'SHORT' ? 'SHORT' : 'LONG';
      merged.entrySight = buildEntrySight(merged, dir);
      let bonus = 0;
      for (const tag of TRAINABLE_CONFIRMS) {
        if (merged.entrySight.agreed.includes(tag)) {
          bonus += ((Number(this.confirmWeights[tag]) || 1) - 1) * 5;
        }
      }
      if (bonus) {
        merged.opportunityScore = Math.min(100, Math.max(0, Math.round((merged.opportunityScore || 0) + bonus)));
      }
    }
    return merged;
  }

  // Online Deep Learning Training Step
  async trainNeuralNetOnline(features, targetLabel, opts = {}) {
    if (!this.nnModel || !Array.isArray(features) || features.length !== 15) return;
    try {
      const xs = tf.tensor2d([features]);
      const ys = tf.tensor2d([[targetLabel]]);
      const info = await this.nnModel.fit(xs, ys, { epochs: 1, batchSize: 1, verbose: 0 });
      this.nnLoss = info.history.loss[0];
      xs.dispose();
      ys.dispose();
      if (this.totalTradesLearned >= MIN_NN_TRADES) this.nnReady = true;
      if (opts.persist !== false) await this.saveNeuralNet(opts.persistFile || NN_MODEL_LIVE_FILE);
      if (opts.quiet !== true) {
        console.log(`[NN] Live-learned 1m close. Loss=${this.nnLoss.toFixed(4)} (saved nn_model.live.json, year file untouched)`);
      }
    } catch (err) {
      console.error('Online training error:', err.message);
    }
  }

  async replayExperiences(count = 4) {
    const pool = (this.experienceMemory || []).filter(e => Array.isArray(e.features) && e.features.length === 15);
    if (pool.length < 2) return;
    const n = Math.min(count, pool.length);
    for (let i = 0; i < n; i++) {
      const pick = pool[Math.floor(Math.random() * pool.length)];
      await this.trainNeuralNetOnline(pick.features, pick.target, { persist: false, quiet: true });
    }
  }

  // Continuous Adaptive Learning from Closed Trades
  learnFromTrade(trade) {
    this.totalTradesLearned++;
    const isWin = trade.netProfit > 0;
    if (isWin) this.successfulTrades++;
    this.totalProfitRealized += trade.netProfit;
    this.winRate = Math.round((this.successfulTrades / this.totalTradesLearned) * 100);

    const reward = trade.profitPercent / 100;

    // Reward-shaped target (not just win/lose): +4% ≈ 1.0, -4% ≈ 0.0
    const target = Math.max(0, Math.min(1, 0.5 + (trade.profitPercent || 0) / 8));
    if (trade.analysis && trade.analysis.features) {
      const rlAction = (trade.side === 'SHORT') ? 'SHORT' : 'LONG';
      this._trainQueue = this._trainQueue
        .then(() => this.trainNeuralNetOnline(trade.analysis.features, target, { persistFile: NN_MODEL_LIVE_FILE }))
        .then(() => this.replayExperiences(2))
        .then(() => this.saveNeuralNet(NN_MODEL_LIVE_FILE))
        .then(() => rlPolicy.learn(trade.analysis.features, rlAction, reward))
        .then(() => {
          if (reward < 0) return rlPolicy.learn(trade.analysis.features, 'HOLD', Math.min(0.012, -reward * 0.5));
        })
        .catch(err => console.error('[NN] Train queue error:', err.message));
    }

    // Adaptively adjust all 15 indicator weights based on trade outcome
    if (trade.analysis && trade.analysis.rawScores) {
      const {
        scoreEMA, scoreRSI, scoreMACD, scoreADX, scoreBB, scoreVol,
        scoreNN, scoreSMC, scoreCVD, scoreKeyLevels,
        scoreVWAP, scoreORB, scoreIB, scoreFVG, scorePOC
      } = trade.analysis.rawScores;

      // Positive reward = winning trade, reinforce contributing signals
      // Negative reward = losing trade, reduce weights of contributing signals
      const adj = (w, s) => Math.max(0.2, Math.min(3.0, w + (reward * this.learningRate * Math.abs(s || 0))));

      if (scoreEMA)        this.weights.emaTrend          = adj(this.weights.emaTrend, scoreEMA);
      if (scoreRSI)        this.weights.rsiMomentum        = adj(this.weights.rsiMomentum, scoreRSI);
      if (scoreMACD)       this.weights.macdMomentum       = adj(this.weights.macdMomentum, scoreMACD);
      if (scoreADX)        this.weights.adxTrendStrength   = adj(this.weights.adxTrendStrength, scoreADX);
      if (scoreBB)         this.weights.bollingerBreakout  = adj(this.weights.bollingerBreakout, scoreBB);
      if (scoreVol)        this.weights.volumeSurge        = adj(this.weights.volumeSurge, scoreVol);
      if (scoreNN)         this.weights.neuralNetPredictor = adj(this.weights.neuralNetPredictor, scoreNN);
      if (scoreSMC)        this.weights.smcStructure       = adj(this.weights.smcStructure, scoreSMC);
      if (scoreCVD)        this.weights.cvdPressure        = adj(this.weights.cvdPressure, scoreCVD);
      if (scoreKeyLevels)  this.weights.keyLevels          = adj(this.weights.keyLevels, scoreKeyLevels);
      // NEW: Learn from VWAP, ORB, IB, FVG, POC performance
      if (scoreVWAP)       this.weights.vwapBias           = adj(this.weights.vwapBias, scoreVWAP);
      if (scoreORB)        this.weights.orbLevel           = adj(this.weights.orbLevel, scoreORB);
      if (scoreIB)         this.weights.initialBalance     = adj(this.weights.initialBalance, scoreIB);
      if (scoreFVG)        this.weights.fvgImbalance       = adj(this.weights.fvgImbalance, scoreFVG);
      if (scorePOC)        this.weights.pocLevel           = adj(this.weights.pocLevel, scorePOC);
    }

    const sight = trade.entrySight || trade.analysis?.entrySight;
    if (sight && Array.isArray(sight.agreed)) {
      const bump = reward >= 0 ? 0.04 : -0.05;
      for (const tag of sight.agreed) {
        if (!TRAINABLE_CONFIRMS.includes(tag)) continue;
        const cur = Number(this.confirmWeights[tag] ?? 1);
        this.confirmWeights[tag] = Math.max(0.3, Math.min(2.5, cur + bump));
      }
    }

    this.experienceMemory.unshift({
      id: trade.id, symbol: trade.symbol, side: trade.side || 'LONG',
      entryPrice: trade.entryPrice, exitPrice: trade.exitPrice,
      netProfit: trade.netProfit, profitPercent: trade.profitPercent,
      exitReason: trade.exitReason,
      breakDown: trade.breakDown || trade.exitReason,
      timestamp: new Date().toISOString(),
      features: trade.analysis?.features || null,
      target,
      reward,
      smcSignal:  trade.analysis?.smcStructure?.smcSignal || trade.analysis?.smc?.smcSignal || null,
      vwapBias:   trade.analysis?.vwap?.vwapBias           || null,
      orbBias:    trade.analysis?.orb?.orbBias             || null,
      ibBias:     trade.analysis?.ib?.ibBias               || null,
      fvgActive:  (trade.analysis?.fvg?.fvgScore || 0) !== 0,
      pocNear:    trade.analysis?.poc?.isNearPOC           || false,
      pdh:        trade.analysis?.pdLevels?.pdh            || null,
      entrySight: sight || null,
      newWeights: { ...this.weights },
      confirmWeights: { ...this.confirmWeights }
    });
    if (this.experienceMemory.length > 200) this.experienceMemory.length = 200;

    console.log(`[AI LEARNING] Trade #${this.totalTradesLearned} [${trade.symbol} ${trade.side || 'LONG'}] ${isWin ? '✅ WIN' : '❌ LOSS'} (${trade.profitPercent.toFixed(2)}%) | saw ${sight?.summary || 'n/a'} | ${trade.breakDown || trade.exitReason || 'n/a'}`);
  }

  exportState() {
    return {
      weights: this.weights,
      totalTradesLearned: this.totalTradesLearned,
      winRate: this.winRate,
      successfulTrades: this.successfulTrades,
      totalProfitRealized: this.totalProfitRealized,
      experienceMemory: this.experienceMemory,
      nnLoss: this.nnLoss,
      nnReady: this.nnReady,
      nnLoadedFromDisk: this.nnLoadedFromDisk,
      minTradesForNn: MIN_NN_TRADES,
      confirmWeights: this.confirmWeights,
      nnFrozen: false,
      nnLiveLearning: true
    };
  }
}

module.exports = { AIBrain, evaluateMacroTrend };

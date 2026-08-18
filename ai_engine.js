/**
 * Deep Neural Network & Technical Indicators Engine
 * Incorporates TensorFlow.js Deep Learning + Adaptive Q-Learning
 */

const tf = require('@tensorflow/tfjs');

// Indicator helper functions
function calcEMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length <= period) return 50;
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
  if (candles.length < period + 1) return 0;
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
  if (closes.length < period) return null;
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

class AIBrain {
  constructor(savedState = null) {
    this.learningRate = 0.05;
    this.totalTradesLearned = savedState?.totalTradesLearned || 0;
    this.winRate = savedState?.winRate || 0;
    this.successfulTrades = savedState?.successfulTrades || 0;
    this.totalProfitRealized = savedState?.totalProfitRealized || 0;
    this.experienceMemory = savedState?.experienceMemory || [];
    this.nnLoss = savedState?.nnLoss || 0.25;

    // Adaptive strategy weights
    this.weights = savedState?.weights || {
      emaTrend: 1.25,
      rsiMomentum: 1.10,
      bollingerBreakout: 0.95,
      volumeSurge: 0.85,
      neuralNetPredictor: 1.40 // High weight for Deep Neural Net predictions
    };

    this.trainingBuffer = []; // Pairs of [Features, Target] for online gradient descent
    this.initNeuralNetwork();
  }

  // Build a 3-Layer Deep Neural Network
  initNeuralNetwork() {
    this.nnModel = tf.sequential();
    
    // Layer 1: Input (6 features) -> 16 Dense Nodes (ReLU)
    this.nnModel.add(tf.layers.dense({
      units: 16,
      activation: 'relu',
      inputShape: [6]
    }));

    // Layer 2: Hidden 8 Dense Nodes (ReLU)
    this.nnModel.add(tf.layers.dense({
      units: 8,
      activation: 'relu'
    }));

    // Layer 3: Output Node (Sigmoid: probability of profitable upward move [0 to 1])
    this.nnModel.add(tf.layers.dense({
      units: 1,
      activation: 'sigmoid'
    }));

    this.nnModel.compile({
      optimizer: tf.train.adam(0.01),
      loss: 'binaryCrossentropy'
    });

    console.log('🧠 [DEEP LEARNING] TensorFlow.js Sequential Neural Net Loaded.');
  }

  // Extract normalized numerical feature vectors for the Neural Net
  extractFeatures(candles) {
    const closes = candles.map(c => c.close);
    const currentPrice = closes[closes.length - 1];
    const prevPrice = closes[closes.length - 2];
    const priceReturn = (currentPrice - prevPrice) / prevPrice; // -0.05 to +0.05

    const rsi = calcRSI(closes, 14) / 100; // Normalized 0 to 1
    const ema9 = calcEMA(closes, 9);
    const ema21 = calcEMA(closes, 21);
    const emaDiff = (ema9 && ema21) ? (ema9 - ema21) / currentPrice : 0;

    const atr = calcATR(candles, 14);
    const normATR = atr / currentPrice;

    const volumes = candles.map(c => c.volume);
    const avgVol = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const volRatio = Math.min(3, volumes[volumes.length - 1] / (avgVol || 1)) / 3; // Normalized 0 to 1

    const bb = calcBollingerBands(closes, 20, 2);
    const bbPos = bb ? (currentPrice - bb.lower) / (bb.upper - bb.lower || 1) : 0.5;

    return [
      Math.max(-1, Math.min(1, priceReturn * 20)),
      Math.max(0, Math.min(1, rsi)),
      Math.max(-1, Math.min(1, emaDiff * 50)),
      Math.max(0, Math.min(1, normATR * 50)),
      volRatio,
      Math.max(0, Math.min(1, bbPos))
    ];
  }

  // Neural Net Forward Inference Pass
  predictWithNeuralNet(features) {
    try {
      const inputTensor = tf.tensor2d([features]);
      const prediction = this.nnModel.predict(inputTensor);
      const prob = prediction.dataSync()[0];
      inputTensor.dispose();
      prediction.dispose();
      return prob; // Value between 0 (bearish) and 1 (strong bullish)
    } catch (e) {
      return 0.5;
    }
  }

  // Analyze market state combining Indicators + Deep Neural Net
  analyzeMarket(candles) {
    if (!candles || candles.length < 30) {
      return { signal: 'HOLD', confidence: 0, reason: 'Insufficient candle history' };
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

    const avgVolume = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const currentVolume = volumes[volumes.length - 1];
    const isVolumeSurge = currentVolume > avgVolume * 1.25;

    // Feature extraction & Deep Neural Net Inference
    const features = this.extractFeatures(candles);
    const nnBullishProbability = this.predictWithNeuralNet(features);

    // Indicator Scores
    let scoreEMA = 0;
    if (ema9 && ema21 && ema50) {
      if (ema9 > ema21 && currentPrice > ema9) scoreEMA += 1;
      if (ema21 > ema50) scoreEMA += 1;
      if (ema9 < ema21 && currentPrice < ema9) scoreEMA -= 1;
      if (ema21 < ema50) scoreEMA -= 1;
    }

    let scoreRSI = 0;
    if (rsi14 < 32) scoreRSI += 1.5;
    else if (rsi14 < 45) scoreRSI += 0.5;
    else if (rsi14 > 68) scoreRSI -= 1.5;
    else if (rsi14 > 55) scoreRSI -= 0.5;

    let scoreBB = 0;
    if (bb) {
      if (currentPrice <= bb.lower * 1.002) scoreBB += 1.2;
      else if (currentPrice >= bb.upper * 0.998) scoreBB -= 1.2;
    }

    let scoreVol = isVolumeSurge ? 1.0 : 0.0;

    // Neural Net Score (Scale 0..1 to -1.5..+1.5)
    const scoreNN = (nnBullishProbability - 0.5) * 3;

    // Weighted Ensemble Calculation
    const buyScore = (
      Math.max(0, scoreEMA) * this.weights.emaTrend +
      Math.max(0, scoreRSI) * this.weights.rsiMomentum +
      Math.max(0, scoreBB) * this.weights.bollingerBreakout +
      (scoreEMA > 0 ? scoreVol * this.weights.volumeSurge : 0) +
      Math.max(0, scoreNN) * this.weights.neuralNetPredictor
    );

    const sellScore = (
      Math.max(0, -scoreEMA) * this.weights.emaTrend +
      Math.max(0, -scoreRSI) * this.weights.rsiMomentum +
      Math.max(0, -scoreBB) * this.weights.bollingerBreakout +
      Math.max(0, -scoreNN) * this.weights.neuralNetPredictor
    );

    const netScore = buyScore - sellScore;
    const maxPotentialScore = (
      2 * this.weights.emaTrend +
      1.5 * this.weights.rsiMomentum +
      1.2 * this.weights.bollingerBreakout +
      1.0 * this.weights.volumeSurge +
      1.5 * this.weights.neuralNetPredictor
    );

    const confidence = Math.min(100, Math.round((Math.abs(netScore) / maxPotentialScore) * 100));

    let decision = 'HOLD';
    let primaryReasons = [];

    if (netScore > 2.0 && confidence >= 48) {
      decision = 'BUY';
      if (scoreNN > 0.4) primaryReasons.push(`Neural Net Bullish (${(nnBullishProbability*100).toFixed(0)}%)`);
      if (scoreEMA > 0) primaryReasons.push(`EMA Trend Align`);
      if (scoreRSI > 0) primaryReasons.push(`RSI Oversold (${rsi14.toFixed(1)})`);
      if (scoreBB > 0) primaryReasons.push(`Bollinger Lower Bounce`);
      if (isVolumeSurge) primaryReasons.push(`Volume Spike`);
    } else if (netScore < -2.0 && confidence >= 48) {
      decision = 'SELL_SIGNAL';
      if (scoreNN < -0.4) primaryReasons.push(`Neural Net Bearish (${(nnBullishProbability*100).toFixed(0)}%)`);
      if (scoreEMA < 0) primaryReasons.push(`EMA Bearish Trend`);
      if (scoreRSI < 0) primaryReasons.push(`RSI Overbought (${rsi14.toFixed(1)})`);
    }

    return {
      signal: decision,
      confidence: confidence,
      currentPrice: currentPrice,
      atr: atr14 || (currentPrice * 0.005),
      rsi: rsi14,
      ema9, ema21, ema50,
      bb,
      isVolumeSurge,
      features,
      nnBullishProbability: Math.round(nnBullishProbability * 100),
      reasons: primaryReasons.length ? primaryReasons.join(' + ') : 'Analyzing / Market Neutral',
      rawScores: { scoreEMA, scoreRSI, scoreBB, scoreVol, scoreNN, netScore }
    };
  }

  // Online Deep Learning Training Step (Backpropagation Gradient Descent)
  async trainNeuralNetOnline(features, targetLabel) {
    try {
      const xs = tf.tensor2d([features]);
      const ys = tf.tensor2d([[targetLabel]]); // 1.0 for Win, 0.0 for Loss

      const info = await this.nnModel.fit(xs, ys, {
        epochs: 3,
        batchSize: 1,
        verbose: 0
      });

      this.nnLoss = info.history.loss[0];
      xs.dispose();
      ys.dispose();
      console.log(`🧠 [DEEP LEARNING FIT] Neural Net updated via Backprop. Loss: ${this.nnLoss.toFixed(4)}`);
    } catch (err) {
      console.error('Online training error:', err.message);
    }
  }

  // Dual-Level Continuous Learning
  learnFromTrade(trade) {
    this.totalTradesLearned++;
    const isWin = trade.netProfit > 0;
    if (isWin) this.successfulTrades++;
    this.totalProfitRealized += trade.netProfit;
    this.winRate = Math.round((this.successfulTrades / this.totalTradesLearned) * 100);

    const reward = trade.profitPercent / 100;

    // 1. Train Deep Neural Network with trade outcome
    if (trade.analysis && trade.analysis.features) {
      const target = isWin ? 1.0 : 0.0;
      this.trainNeuralNetOnline(trade.analysis.features, target);
    }

    // 2. Adjust Reinforcement Strategy Weights
    if (trade.analysis && trade.analysis.rawScores) {
      const { scoreEMA, scoreRSI, scoreBB, scoreVol, scoreNN } = trade.analysis.rawScores;

      if (scoreEMA > 0) this.weights.emaTrend = Math.max(0.2, Math.min(3.0, this.weights.emaTrend + (reward * this.learningRate * scoreEMA)));
      if (scoreRSI > 0) this.weights.rsiMomentum = Math.max(0.2, Math.min(3.0, this.weights.rsiMomentum + (reward * this.learningRate * scoreRSI)));
      if (scoreBB > 0) this.weights.bollingerBreakout = Math.max(0.2, Math.min(3.0, this.weights.bollingerBreakout + (reward * this.learningRate * scoreBB)));
      if (scoreVol > 0) this.weights.volumeSurge = Math.max(0.2, Math.min(3.0, this.weights.volumeSurge + (reward * this.learningRate * scoreVol)));
      if (scoreNN > 0) this.weights.neuralNetPredictor = Math.max(0.2, Math.min(3.0, this.weights.neuralNetPredictor + (reward * this.learningRate * scoreNN)));
    }

    this.experienceMemory.unshift({
      id: trade.id,
      symbol: trade.symbol,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      netProfit: trade.netProfit,
      profitPercent: trade.profitPercent,
      exitReason: trade.exitReason,
      timestamp: new Date().toISOString(),
      newWeights: { ...this.weights }
    });
    if (this.experienceMemory.length > 100) this.experienceMemory.pop();

    console.log(`[AI LEARNING] Trade #${this.totalTradesLearned} [${trade.symbol}] Closed: ${isWin ? 'WIN' : 'LOSS'} (${trade.profitPercent.toFixed(2)}%). Neural Net & Weights Updated.`);
  }

  exportState() {
    return {
      weights: this.weights,
      totalTradesLearned: this.totalTradesLearned,
      winRate: this.winRate,
      successfulTrades: this.successfulTrades,
      totalProfitRealized: this.totalProfitRealized,
      experienceMemory: this.experienceMemory,
      nnLoss: this.nnLoss
    };
  }
}

module.exports = { AIBrain };

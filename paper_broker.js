/**
 * Simulated Paper Broker with 0.1% Fee Deduction, Dual Direction (LONG & SHORT),
 * Dynamic Trailing Stop-Loss, and Take-Profit
 */

const { slimAnalysis, explainBreak, buildEntrySight } = require('./analysis_log');

function utcDayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function pricesFromPositionPnl(pos, feeRate) {
  const slPct = (pos.slPnlPercent ?? -1) / 100;
  const tpPct = (pos.tpPnlPercent ?? 2) / 100;
  const qty = pos.quantity || 0;
  const inv = pos.investedUSDT || 0;
  if (qty <= 0 || inv <= 0) return { sl: pos.stopLoss, tp: pos.takeProfit };
  const isShort = pos.side === 'SHORT';
  if (!isShort) {
    return {
      sl: inv * (1 + slPct) / (qty * (1 - feeRate)),
      tp: inv * (1 + tpPct) / (qty * (1 - feeRate))
    };
  }
  const rhsSl = pos.entryPrice * qty - (pos.entryFee || 0) - inv * slPct;
  const rhsTp = pos.entryPrice * qty - (pos.entryFee || 0) - inv * tpPct;
  return {
    sl: rhsSl / (qty * (1 + feeRate)),
    tp: rhsTp / (qty * (1 + feeRate))
  };
}

class PaperBroker {
  constructor(initialBalance = 10000, feeRate = 0.001, savedState = null) {
    this.initialBalance = initialBalance;
    this.balance = savedState?.balance ?? initialBalance; // Free USDT
    this.feeRate = feeRate; // 0.1% per trade
    this.positions = savedState?.positions || []; // Active open trades
    this.tradeHistory = savedState?.tradeHistory || []; // Completed trades
    this.totalFeesPaid = savedState?.totalFeesPaid || 0;
    this.peakBalance = savedState?.peakBalance || initialBalance;
    this.tradeCounter = savedState?.tradeCounter || 0;
    this.dayStamp = savedState?.dayStamp || utcDayStamp();
    this.dayStartEquity = savedState?.dayStartEquity || (savedState?.balance ?? initialBalance);
    this.dayRealizedPnL = savedState?.dayRealizedPnL || 0;
    this.circuitBroken = !!savedState?.circuitBroken;
    this.circuitReason = savedState?.circuitReason || null;
    this.maxDailyLossPercent = savedState?.maxDailyLossPercent || 3;
    if (this.positions.length) {
      this.positions.forEach((pos) => this.ensurePositionStops(pos));
    }
  }

  utcDayStamp() {
    return utcDayStamp();
  }

  rollDayIfNeeded(equityHint) {
    const today = utcDayStamp();
    if (this.dayStamp !== today) {
      this.dayStamp = today;
      this.dayStartEquity = equityHint || (this.balance);
      this.dayRealizedPnL = 0;
      this.circuitBroken = false;
      this.circuitReason = null;
    }
  }

  tripCircuit(reason) {
    this.circuitBroken = true;
    this.circuitReason = reason;
    console.error(`[RISK] Circuit breaker: ${reason}`);
  }

  // Open a new Long or Short position with configurable risk options
  async openPosition(symbol, currentPrice, analysis, side = 'LONG', options = {}) {
    // Check if we already have an open position for this symbol
    const existing = this.positions.find(p => p.symbol === symbol);
    if (existing) return { success: false, reason: 'Already in open position' };
    this.rollDayIfNeeded(this.balance);
    if (this.circuitBroken) return { success: false, reason: this.circuitReason || 'Daily loss limit reached' };

    const sizingMode = options.sizingMode || 'PERCENT'; // 'PERCENT' or 'FIXED_USD'
    const riskMode = options.riskMode || 'PERCENT';     // 'PERCENT' or 'FIXED_USD'
    const allocationPercent = options.allocationPercent || 0.15;
    const fixedTradeAmountUSD = options.fixedTradeAmountUSD || 10.0;
    const maxRiskPercent = options.maxRiskPerTradePercent || 0.02;
    const fixedRiskUSD = options.fixedRiskUSD || 1.0; // e.g. $1 or $2 max risk
    const slMultiplier = options.slMultiplier || 1.5;
    const tpMultiplier = options.tpMultiplier || 2.5;
    const stopPct = Math.max(0.5, Math.min(3, Number(options.positionStopPercent) || 0.8)) / 100;
    const tpPct = Math.max(0.8, Math.min(6, Number(options.positionTpPercent) || 1.6)) / 100;
    const slMode = options.slMode || 'POSITION';

    const atr = analysis.atr || (currentPrice * 0.008);
    const slDistance = slMode === 'POSITION'
      ? currentPrice * stopPct
      : Math.max(atr * slMultiplier, currentPrice * 0.008);
    const slPercent = slDistance / currentPrice;
    if ((2 * this.feeRate) > slPercent * 0.4) {
      return { success: false, reason: 'Stop too tight versus round-trip fees' };
    }

    // 1. Calculate Base Sizing by Mode (Fixed $ vs %)
    let baseAmountUSDT = (sizingMode === 'FIXED_USD')
      ? Math.min(fixedTradeAmountUSD, this.balance)
      : (this.balance * allocationPercent);

    // 2. Calculate Risk Cap by Mode (Fixed $ Risk vs % Equity Risk)
    let riskSizedAmount = Infinity;
    if (riskMode === 'FIXED_USD') {
      // Risk is fixed dollar (e.g., $1 or $2 max loss on SL)
      riskSizedAmount = fixedRiskUSD / slPercent;
    } else {
      // Risk is % of total account balance
      const maxRiskBudgetUSDT = this.balance * maxRiskPercent;
      riskSizedAmount = maxRiskBudgetUSDT / slPercent;
    }

    // Final position size
    const tradeAmountUSDT = Math.min(baseAmountUSDT, riskSizedAmount, this.balance);
    if (tradeAmountUSDT < 2) return { success: false, reason: 'Insufficient balance (min $2 required)' };


    const entryFee = tradeAmountUSDT * this.feeRate;
    const netTradeAmount = tradeAmountUSDT - entryFee;
    const quantity = netTradeAmount / currentPrice;

    this.balance -= tradeAmountUSDT;
    this.totalFeesPaid += entryFee;
    this.tradeCounter++;


    let initialSL, initialTP;
    if (slMode === 'POSITION') {
      const draft = {
        side,
        entryPrice: currentPrice,
        quantity,
        investedUSDT: tradeAmountUSDT,
        entryFee,
        slPnlPercent: -(stopPct * 100),
        tpPnlPercent: tpPct * 100
      };
      const px = pricesFromPositionPnl(draft, this.feeRate);
      initialSL = px.sl;
      initialTP = px.tp;
    } else if (side === 'SHORT') {
      initialSL = currentPrice + slDistance;
      initialTP = currentPrice - (slDistance * tpMultiplier);
    } else {
      initialSL = currentPrice - slDistance;
      initialTP = currentPrice + (slDistance * tpMultiplier);
    }

    const entrySight = analysis?.entrySight || buildEntrySight(analysis, side);
    const position = {
      id: `TRD-${this.tradeCounter}-${Date.now().toString().slice(-4)}`,
      symbol: symbol,
      side: side, // 'LONG' or 'SHORT'
      entryTime: new Date().toISOString(),
      entryPrice: currentPrice,
      highestPrice: currentPrice, // Tracks peak price for LONG
      lowestPrice: currentPrice,  // Tracks lowest price for SHORT
      quantity: quantity,
      investedUSDT: tradeAmountUSDT,
      netInvestedUSDT: netTradeAmount,
      entryFee: entryFee,
      stopLoss: initialSL,
      takeProfit: initialTP,
      initialStopLoss: initialSL,
      trailingActivated: false,
      trailingOffset: slDistance,
      slMode: slMode,
      slPnlPercent: slMode === 'POSITION' ? -(stopPct * 100) : null,
      tpPnlPercent: slMode === 'POSITION' ? (tpPct * 100) : null,
      positionRiskPercent: slMode === 'POSITION' ? (stopPct * 100) : null,
      breakevenPrice: side === 'SHORT'
        ? currentPrice * (1 - 2 * this.feeRate)
        : currentPrice * (1 + 2 * this.feeRate),
      status: 'OPEN',
      analysis: slimAnalysis(analysis) || analysis,
      entrySight,
      whoAgreed: (entrySight.confirms || []).join('+') || entrySight.summary || 'none',
      minutePath: []
    };

    this.positions.push(position);
    const saw = position.whoAgreed || position.entrySight?.summary || 'n/a';
    console.log(`[BROKER] OPEN ${side}: ${symbol} @ $${currentPrice.toFixed(4)} | SL: $${initialSL.toFixed(4)} | TP: $${initialTP.toFixed(4)} | Fee: $${entryFee.toFixed(4)} | agreed ${saw}`);
    return { success: true, position };
  }

  applyTrailingStop(pos, currentPrice) {
    if (pos.slMode === 'POSITION' || pos.slPnlPercent != null) return;
    const isShort = pos.side === 'SHORT';
    const offset = pos.trailingOffset || 0;
    const be = pos.breakevenPrice || (isShort
      ? pos.entryPrice * (1 - 2 * this.feeRate)
      : pos.entryPrice * (1 + 2 * this.feeRate));
    const halfR = isShort
      ? pos.entryPrice - offset * 0.5
      : pos.entryPrice + offset * 0.5;
    const oneR = isShort
      ? pos.entryPrice - offset
      : pos.entryPrice + offset;

    if (!isShort) {
      if (currentPrice > pos.highestPrice) pos.highestPrice = currentPrice;
      if (currentPrice >= halfR && be > pos.stopLoss) pos.stopLoss = be;
      if (currentPrice >= oneR) {
        const proposedSL = Math.max(be, currentPrice - offset);
        if (proposedSL > pos.stopLoss) pos.stopLoss = proposedSL;
        if (currentPrice >= pos.takeProfit * 0.96) {
          pos.takeProfit = currentPrice + offset * 1.5;
        }
      }
      pos.trailingActivated = pos.stopLoss >= be - 1e-12;
    } else {
      if (currentPrice < (pos.lowestPrice || pos.entryPrice)) pos.lowestPrice = currentPrice;
      if (currentPrice <= halfR && be < pos.stopLoss) pos.stopLoss = be;
      if (currentPrice <= oneR) {
        const proposedSL = Math.min(be, currentPrice + offset);
        if (proposedSL < pos.stopLoss) pos.stopLoss = proposedSL;
        if (currentPrice <= pos.takeProfit * 1.04) {
          pos.takeProfit = currentPrice - offset * 1.5;
        }
      }
      pos.trailingActivated = pos.stopLoss <= be + 1e-12;
    }
  }

  ensurePositionStops(pos) {
    if (pos.slPnlPercent == null) {
      pos.slMode = 'POSITION';
      pos.slPnlPercent = -0.8;
      pos.tpPnlPercent = 1.6;
      pos.positionRiskPercent = 0.8;
    }
    const px = pricesFromPositionPnl(pos, this.feeRate);
    if (!pos.trailingActivated) {
      pos.stopLoss = px.sl;
      pos.takeProfit = px.tp;
    }
  }

  applyPositionPnlTrail(pos, pnlPct) {
    const risk = pos.positionRiskPercent || 0.8;
    // Only protect after a full 1R; lock ~0.45% so fees do not erase the win.
    if (pnlPct >= risk) {
      if ((pos.slPnlPercent || -risk) < 0.45) {
        pos.slPnlPercent = 0.45;
        pos.trailingActivated = true;
      }
    }
    if (pnlPct >= risk * 1.25) {
      const lock = Math.max(0.45, pnlPct - risk * 0.45);
      if (lock > (pos.slPnlPercent || 0)) pos.slPnlPercent = lock;
      pos.trailingActivated = true;
    }
    const px = pricesFromPositionPnl(pos, this.feeRate);
    pos.stopLoss = px.sl;
    pos.takeProfit = px.tp;
  }

  // Update market prices and dynamically trail Stop-Loss / trigger TP
  async updatePositionsWithPrice(symbol, currentPrice, aiBrain, extras = {}) {
    const closedTrades = [];
    const snapshot = extras.snapshot || null;
    const exitAnalysis = extras.exitAnalysis || null;

    for (let i = this.positions.length - 1; i >= 0; i--) {
      const pos = this.positions[i];
      if (pos.symbol !== symbol) continue;

      const isShort = pos.side === 'SHORT';
      this.ensurePositionStops(pos);

      let unrealizedNetPnL;
      if (!isShort) {
        const currentGrossValue = pos.quantity * currentPrice;
        const estimatedExitFee = currentGrossValue * this.feeRate;
        unrealizedNetPnL = (currentGrossValue - estimatedExitFee) - pos.investedUSDT;
      } else {
        const priceDiff = pos.entryPrice - currentPrice;
        const grossPnL = priceDiff * pos.quantity;
        const exitNotional = pos.quantity * currentPrice;
        const estimatedExitFee = exitNotional * this.feeRate;
        unrealizedNetPnL = grossPnL - pos.entryFee - estimatedExitFee;
      }

      pos.currentPrice = currentPrice;
      pos.unrealizedPnL = unrealizedNetPnL;
      pos.unrealizedPnLPercent = (unrealizedNetPnL / pos.investedUSDT) * 100;
      const pnlPct = pos.unrealizedPnLPercent;

      if (snapshot) {
        if (!pos.minutePath) pos.minutePath = [];
        const point = { ...snapshot, pnl: Number(pnlPct.toFixed(3)) };
        const last = pos.minutePath[pos.minutePath.length - 1];
        const minuteKey = String(point.t || '').slice(0, 16);
        const lastKey = last ? String(last.t || '').slice(0, 16) : '';
        if (last && lastKey === minuteKey) pos.minutePath[pos.minutePath.length - 1] = point;
        else pos.minutePath.push(point);
        if (pos.minutePath.length > 240) pos.minutePath.shift();
      }

      if (pos.slMode === 'POSITION' || pos.slPnlPercent != null) {
        this.applyPositionPnlTrail(pos, pnlPct);
      } else {
        this.applyTrailingStop(pos, currentPrice);
      }

      let shouldClose = false;
      let exitReason = '';
      const slPnl = pos.slPnlPercent ?? -0.8;
      const tpPnl = pos.tpPnlPercent ?? 1.6;

      if (pnlPct <= slPnl) {
        shouldClose = true;
        exitReason = (pos.trailingActivated && unrealizedNetPnL > 0)
          ? 'Trailing stop (profit locked)'
          : 'Position stop';
      } else if (pnlPct >= tpPnl) {
        shouldClose = true;
        exitReason = 'Position take-profit';
      } else {
        // Cut losers early when thesis dies or the trade goes stale (losses held ~3h).
        const holdMs = pos.entryTime ? (Date.now() - new Date(pos.entryTime).getTime()) : 0;
        const holdMin = holdMs / 60000;
        const sig = exitAnalysis?.signal || null;
        const againstLong = pos.side === 'LONG' && (sig === 'SHORT' || sig === 'SELL' || sig === 'CHOP_SKIP');
        const againstShort = pos.side === 'SHORT' && (sig === 'BUY' || sig === 'CHOP_SKIP');
        if ((againstLong || againstShort) && pnlPct < 0.35 && holdMin >= 8) {
          shouldClose = true;
          exitReason = 'Thesis faded';
        } else if (holdMin >= 90 && pnlPct < 0.35) {
          shouldClose = true;
          exitReason = 'Stale exit';
        }
      }

      if (shouldClose) {
        const closed = await this.closePosition(pos.id, currentPrice, exitReason, aiBrain, { exitAnalysis });
        if (closed) closedTrades.push(closed);
      }
    }

    return closedTrades;
  }

  // Close position and execute fee calculation
  async closePosition(positionId, exitPrice, reason, aiBrain, extras = {}) {
    const index = this.positions.findIndex(p => p.id === positionId);
    if (index === -1) return null;

    const pos = this.positions[index];
    const isShort = pos.side === 'SHORT';

    let netProfit, profitPercent, returnedEquity, exitFee, totalFees;

    if (!isShort) {
      // Long Exit
      const grossExitValue = pos.quantity * exitPrice;
      exitFee = grossExitValue * this.feeRate;
      const netExitValue = grossExitValue - exitFee;
      totalFees = pos.entryFee + exitFee;
      netProfit = netExitValue - pos.investedUSDT;
      profitPercent = (netProfit / pos.investedUSDT) * 100;
      returnedEquity = netExitValue;
    } else {
      // Short Exit
      const exitNotional = pos.quantity * exitPrice;
      exitFee = exitNotional * this.feeRate;
      totalFees = pos.entryFee + exitFee;
      const grossPnL = (pos.entryPrice - exitPrice) * pos.quantity;
      netProfit = grossPnL - totalFees;
      profitPercent = (netProfit / pos.investedUSDT) * 100;
      returnedEquity = pos.investedUSDT + netProfit;
    }

    this.balance += Math.max(0, returnedEquity);
    this.totalFeesPaid += exitFee;
    if (this.balance > this.peakBalance) this.peakBalance = this.balance;
    this.rollDayIfNeeded(this.balance);
    this.dayRealizedPnL += netProfit;
    const cap = (this.dayStartEquity || this.initialBalance || 1) * ((this.maxDailyLossPercent || 3) / 100);
    if (this.dayRealizedPnL <= -cap) {
      this.tripCircuit(`Daily loss limit hit (${this.maxDailyLossPercent || 3}%)`);
    }

    const honestReason = (typeof reason === 'string' && /profit locked/i.test(reason) && netProfit <= 0)
      ? 'Stop-Loss Hit'
      : reason;

    const path = Array.isArray(pos.minutePath) ? pos.minutePath : [];
    const breakDown = explainBreak({
      side: pos.side,
      entryAnalysis: pos.analysis,
      exitAnalysis: extras.exitAnalysis || null,
      exitReason: honestReason,
      pnlPct: profitPercent,
      path
    });

    const closedRecord = {
      ...pos,
      analysis: slimAnalysis(pos.analysis) || pos.analysis,
      minutePath: path.slice(-180),
      breakDown,
      exitTime: new Date().toISOString(),
      exitPrice: exitPrice,
      exitFee: exitFee,
      totalFees: totalFees,
      netProfit: netProfit,
      profitPercent: profitPercent,
      exitReason: honestReason,
      status: 'CLOSED'
    };

    // Remove from active positions and save to history
    this.positions.splice(index, 1);
    this.tradeHistory.unshift(closedRecord);
    if (this.tradeHistory.length > 800) this.tradeHistory.length = 800;

    console.log(`[BROKER] CLOSED ${pos.side || 'LONG'}: ${pos.symbol} @ $${exitPrice.toFixed(4)} | Net PnL: ${netProfit >= 0 ? '+' : ''}$${netProfit.toFixed(2)} (${profitPercent.toFixed(2)}%) | ${honestReason}`);

    // AI CONTINUOUS LEARNING HOOK
    if (aiBrain && typeof aiBrain.learnFromTrade === 'function') {
      aiBrain.learnFromTrade(closedRecord);
    }

    return closedRecord;
  }

  // Get current full portfolio metrics
  getPortfolioMetrics(currentPrices = {}) {
    let activeHoldingsValue = 0;
    let totalUnrealizedPnL = 0;

    for (const pos of this.positions) {
      const price = currentPrices[pos.symbol] || pos.entryPrice;
      const isShort = pos.side === 'SHORT';

      if (!isShort) {
        const grossVal = pos.quantity * price;
        const exitFee = grossVal * this.feeRate;
        const netVal = grossVal - exitFee;
        activeHoldingsValue += netVal;
        totalUnrealizedPnL += (netVal - pos.investedUSDT);
      } else {
        const grossPnL = (pos.entryPrice - price) * pos.quantity;
        const exitFee = (pos.quantity * price) * this.feeRate;
        const netShortValue = pos.investedUSDT + (grossPnL - pos.entryFee - exitFee);
        activeHoldingsValue += Math.max(0, netShortValue);
        totalUnrealizedPnL += (grossPnL - pos.entryFee - exitFee);
      }
    }

    const totalEquity = this.balance + activeHoldingsValue;
    if (totalEquity > this.peakBalance) this.peakBalance = totalEquity;
    const totalNetProfit = totalEquity - this.initialBalance;
    const totalNetProfitPercent = (totalNetProfit / this.initialBalance) * 100;
    const maxDrawdownPercent = this.peakBalance > 0
      ? ((this.peakBalance - totalEquity) / this.peakBalance) * 100
      : 0;

    return {
      freeBalance: this.balance,
      activeHoldingsValue: activeHoldingsValue,
      totalEquity: totalEquity,
      initialBalance: this.initialBalance,
      totalNetProfit: totalNetProfit,
      totalNetProfitPercent: totalNetProfitPercent,
      realizedPnL: this.tradeHistory.reduce((s, t) => s + (t.netProfit || 0), 0),
      totalUnrealizedPnL: totalUnrealizedPnL,
      totalFeesPaid: this.totalFeesPaid,
      openPositionsCount: this.positions.length,
      closedTradesCount: this.tradeHistory.length,
      peakEquity: this.peakBalance,
      maxDrawdownPercent
    };
  }

  resetAccount(newBalance = 10000) {
    this.initialBalance = newBalance;
    this.balance = newBalance;
    this.positions = [];
    this.tradeHistory = [];
    this.totalFeesPaid = 0;
    this.peakBalance = newBalance;
    this.tradeCounter = 0;
    this.dayStamp = utcDayStamp();
    this.dayStartEquity = newBalance;
    this.dayRealizedPnL = 0;
    this.circuitBroken = false;
    this.circuitReason = null;
  }

  exportState() {
    return {
      initialBalance: this.initialBalance,
      balance: this.balance,
      positions: this.positions,
      tradeHistory: this.tradeHistory,
      totalFeesPaid: this.totalFeesPaid,
      peakBalance: this.peakBalance,
      tradeCounter: this.tradeCounter,
      dayStamp: this.dayStamp,
      dayStartEquity: this.dayStartEquity,
      dayRealizedPnL: this.dayRealizedPnL,
      circuitBroken: this.circuitBroken,
      circuitReason: this.circuitReason,
      maxDailyLossPercent: this.maxDailyLossPercent
    };
  }
}

module.exports = { PaperBroker };

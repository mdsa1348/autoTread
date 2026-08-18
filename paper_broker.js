/**
 * Simulated Paper Broker with 0.1% Fee Deduction, Dynamic Trailing Stop-Loss, and Take-Profit
 */

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
  }

  // Open a new Long position
  openPosition(symbol, currentPrice, analysis, allocationPercent = 0.15) {
    // Check if we already have an open position for this symbol
    const existing = this.positions.find(p => p.symbol === symbol);
    if (existing) return { success: false, reason: 'Already in open position' };

    // Max 15% of current available balance per trade for safe risk management
    const tradeAmountUSDT = Math.min(this.balance * allocationPercent, this.balance);
    if (tradeAmountUSDT < 10) return { success: false, reason: 'Insufficient balance' };

    const entryFee = tradeAmountUSDT * this.feeRate;
    const netTradeAmount = tradeAmountUSDT - entryFee;
    const quantity = netTradeAmount / currentPrice;

    this.balance -= tradeAmountUSDT;
    this.totalFeesPaid += entryFee;
    this.tradeCounter++;

    // Initial Stop-Loss & Take-Profit calculation
    // SL = Entry - (1.5 * ATR) or 1.2% minimum distance
    const atr = analysis.atr || (currentPrice * 0.008);
    const slDistance = Math.max(atr * 1.5, currentPrice * 0.008);
    const initialSL = currentPrice - slDistance;
    
    // TP = Entry + (2.5 * SL distance) for healthy 1:2.5 Risk/Reward
    const initialTP = currentPrice + (slDistance * 2.5);

    const position = {
      id: `TRD-${this.tradeCounter}-${Date.now().toString().slice(-4)}`,
      symbol: symbol,
      entryTime: new Date().toISOString(),
      entryPrice: currentPrice,
      highestPrice: currentPrice, // Tracks maximum price achieved to move Trailing SL
      quantity: quantity,
      investedUSDT: tradeAmountUSDT,
      netInvestedUSDT: netTradeAmount,
      entryFee: entryFee,
      stopLoss: initialSL,
      takeProfit: initialTP,
      initialStopLoss: initialSL,
      trailingActivated: false,
      trailingOffset: slDistance, // Distance to keep trailing behind highest price
      status: 'OPEN',
      analysis: analysis
    };

    this.positions.push(position);
    console.log(`[BROKER] OPEN LONG: ${symbol} @ $${currentPrice.toFixed(2)} | SL: $${initialSL.toFixed(2)} | TP: $${initialTP.toFixed(2)} | Fee: $${entryFee.toFixed(4)}`);
    return { success: true, position };
  }

  // Update market prices and dynamically trail Stop-Loss / trigger TP
  updatePositionsWithPrice(symbol, currentPrice, aiBrain) {
    const closedTrades = [];

    for (let i = this.positions.length - 1; i >= 0; i--) {
      const pos = this.positions[i];
      if (pos.symbol !== symbol) continue;

      // 1. Check if price moved to a new all-time high since entry
      if (currentPrice > pos.highestPrice) {
        pos.highestPrice = currentPrice;

        // DYNAMIC TRAILING STOP LOSS:
        // As price moves up, raise the Stop-Loss so we lock in profits!
        const proposedSL = currentPrice - pos.trailingOffset;
        
        // Once price is above entry by 1x ATR, lock Stop-Loss at Break-Even (Entry + Fee)
        const breakEvenPrice = pos.entryPrice * (1 + (this.feeRate * 2.5));
        if (proposedSL > pos.stopLoss) {
          pos.stopLoss = Math.max(pos.stopLoss, proposedSL);
          pos.trailingActivated = true;
          console.log(`[TRAILING SL] ${symbol} Peak: $${pos.highestPrice.toFixed(2)} -> SL Raised to: $${pos.stopLoss.toFixed(2)}`);
        }

        // Also dynamically advance Take-Profit if it's strongly breaking out
        if (currentPrice >= pos.takeProfit * 0.95) {
          pos.takeProfit = currentPrice + (pos.trailingOffset * 1.5);
          console.log(`[DYNAMIC TP] ${symbol} Target Expanded to: $${pos.takeProfit.toFixed(2)}`);
        }
      }

      // Calculate current unrealized PnL
      const currentGrossValue = pos.quantity * currentPrice;
      const estimatedExitFee = currentGrossValue * this.feeRate;
      const unrealizedNetPnL = (currentGrossValue - estimatedExitFee) - pos.investedUSDT;
      pos.currentPrice = currentPrice;
      pos.unrealizedPnL = unrealizedNetPnL;
      pos.unrealizedPnLPercent = (unrealizedNetPnL / pos.investedUSDT) * 100;

      // 2. CHECK EXIT CONDITIONS
      let shouldClose = false;
      let exitReason = '';

      // A) Hit Dynamic Trailing Stop-Loss
      if (currentPrice <= pos.stopLoss) {
        shouldClose = true;
        exitReason = pos.trailingActivated ? 'Trailing Stop-Loss Hit (Profit Locked)' : 'Stop-Loss Hit';
      }
      // B) Hit Take-Profit
      else if (currentPrice >= pos.takeProfit) {
        shouldClose = true;
        exitReason = 'Take-Profit Target Reached';
      }

      if (shouldClose) {
        const closed = this.closePosition(pos.id, currentPrice, exitReason, aiBrain);
        if (closed) closedTrades.push(closed);
      }
    }

    return closedTrades;
  }

  // Close position and execute fee calculation
  closePosition(positionId, exitPrice, reason, aiBrain) {
    const index = this.positions.findIndex(p => p.id === positionId);
    if (index === -1) return null;

    const pos = this.positions[index];
    const grossExitValue = pos.quantity * exitPrice;
    const exitFee = grossExitValue * this.feeRate;
    const netExitValue = grossExitValue - exitFee;
    const totalFees = pos.entryFee + exitFee;
    const netProfit = netExitValue - pos.investedUSDT;
    const profitPercent = (netProfit / pos.investedUSDT) * 100;

    this.balance += netExitValue;
    this.totalFeesPaid += exitFee;
    if (this.balance > this.peakBalance) this.peakBalance = this.balance;

    const closedRecord = {
      ...pos,
      exitTime: new Date().toISOString(),
      exitPrice: exitPrice,
      grossExitValue: grossExitValue,
      exitFee: exitFee,
      totalFees: totalFees,
      netExitValue: netExitValue,
      netProfit: netProfit,
      profitPercent: profitPercent,
      exitReason: reason,
      status: 'CLOSED'
    };

    // Remove from active positions and save to history
    this.positions.splice(index, 1);
    this.tradeHistory.unshift(closedRecord);
    if (this.tradeHistory.length > 200) this.tradeHistory.pop();

    console.log(`[BROKER] CLOSED: ${pos.symbol} @ $${exitPrice.toFixed(2)} | Net PnL: ${netProfit >= 0 ? '+' : ''}$${netProfit.toFixed(2)} (${profitPercent.toFixed(2)}%) | Reason: ${reason}`);

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
      const grossVal = pos.quantity * price;
      const exitFee = grossVal * this.feeRate;
      const netVal = grossVal - exitFee;
      activeHoldingsValue += netVal;
      totalUnrealizedPnL += (netVal - pos.investedUSDT);
    }

    const totalEquity = this.balance + activeHoldingsValue;
    const totalNetProfit = totalEquity - this.initialBalance;
    const totalNetProfitPercent = (totalNetProfit / this.initialBalance) * 100;

    return {
      freeBalance: this.balance,
      activeHoldingsValue: activeHoldingsValue,
      totalEquity: totalEquity,
      initialBalance: this.initialBalance,
      totalNetProfit: totalNetProfit,
      totalNetProfitPercent: totalNetProfitPercent,
      totalUnrealizedPnL: totalUnrealizedPnL,
      totalFeesPaid: this.totalFeesPaid,
      openPositionsCount: this.positions.length,
      closedTradesCount: this.tradeHistory.length
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
  }

  exportState() {
    return {
      initialBalance: this.initialBalance,
      balance: this.balance,
      positions: this.positions,
      tradeHistory: this.tradeHistory,
      totalFeesPaid: this.totalFeesPaid,
      peakBalance: this.peakBalance,
      tradeCounter: this.tradeCounter
    };
  }
}

module.exports = { PaperBroker };

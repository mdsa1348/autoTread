const { PaperBroker } = require('./paper_broker');
const exchange = require('./exchange');

class LiveBroker extends PaperBroker {
  constructor(savedState = null) {
    const liveState = savedState && savedState.live ? savedState : null;
    super(liveState?.initialBalance || 0, 0.0004, liveState);
    this.live = true;
    this.synced = false;
    this.circuitBroken = !!(liveState && liveState.circuitBroken);
    this.circuitReason = (liveState && liveState.circuitReason) || null;
    this.maxDailyLossPercent = exchange.MAX_DAILY_LOSS_PERCENT;
    this.dayStartEquity = (liveState && liveState.dayStartEquity) || null;
    this.dayRealizedPnL = (liveState && liveState.dayRealizedPnL) || 0;
    this.dayStamp = (liveState && liveState.dayStamp) || utcDayStamp();
  }

  async syncFromExchange() {
    const acct = await exchange.futuresAccount();
    this.balance = acct.availableBalance;
    if (!this.initialBalance || this.initialBalance <= 0) {
      this.initialBalance = acct.totalWalletBalance || acct.totalEquity;
    }
    if (!this.peakBalance || this.peakBalance < acct.totalEquity) {
      this.peakBalance = acct.totalEquity;
    }
    if (this.dayStamp !== utcDayStamp()) {
      this.dayStamp = utcDayStamp();
      this.dayStartEquity = acct.totalEquity;
      this.dayRealizedPnL = 0;
      this.circuitBroken = false;
      this.circuitReason = null;
    }
    if (!this.dayStartEquity) this.dayStartEquity = acct.totalEquity;

    const remote = await exchange.futuresPositions();
    const remoteBySym = new Map(remote.map(p => [p.symbol, p]));

    this.positions = this.positions.filter(pos => {
      const r = remoteBySym.get(pos.symbol);
      if (!r) {
        console.log(`[LIVE] Dropping local ${pos.symbol} — not on exchange`);
        return false;
      }
      pos.quantity = Math.abs(r.positionAmt);
      pos.entryPrice = r.entryPrice || pos.entryPrice;
      pos.side = r.positionAmt < 0 ? 'SHORT' : 'LONG';
      remoteBySym.delete(pos.symbol);
      return true;
    });

    for (const r of remoteBySym.values()) {
      this.tradeCounter++;
      this.positions.push({
        id: `LIVE-${this.tradeCounter}-${Date.now().toString().slice(-4)}`,
        symbol: r.symbol,
        side: r.positionAmt < 0 ? 'SHORT' : 'LONG',
        entryTime: new Date().toISOString(),
        entryPrice: r.entryPrice,
        highestPrice: r.entryPrice,
        lowestPrice: r.entryPrice,
        quantity: Math.abs(r.positionAmt),
        investedUSDT: Math.abs(r.positionAmt) * r.entryPrice,
        netInvestedUSDT: Math.abs(r.positionAmt) * r.entryPrice,
        entryFee: 0,
        stopLoss: r.positionAmt < 0 ? r.entryPrice * 1.012 : r.entryPrice * 0.988,
        takeProfit: r.positionAmt < 0 ? r.entryPrice * 0.97 : r.entryPrice * 1.03,
        initialStopLoss: r.positionAmt < 0 ? r.entryPrice * 1.012 : r.entryPrice * 0.988,
        trailingActivated: false,
        trailingOffset: r.entryPrice * 0.008,
        status: 'OPEN',
        analysis: { reasons: 'Imported from exchange' },
        imported: true
      });
      console.log(`[LIVE] Imported exchange position ${r.symbol} ${r.positionAmt}`);
    }

    this.synced = true;
    return acct;
  }

  assertSafeToTrade() {
    if (this.circuitBroken) {
      return { success: false, reason: this.circuitReason || 'Circuit breaker tripped' };
    }
    const cap = (this.dayStartEquity || this.initialBalance || 1) * (exchange.MAX_DAILY_LOSS_PERCENT / 100);
    if (this.dayRealizedPnL <= -cap) {
      this.tripCircuit(`Daily loss limit hit (${exchange.MAX_DAILY_LOSS_PERCENT}% of start-of-day equity)`);
      return { success: false, reason: this.circuitReason };
    }
    return { success: true };
  }

  tripCircuit(reason) {
    this.circuitBroken = true;
    this.circuitReason = reason;
    console.error(`[LIVE] CIRCUIT BREAKER: ${reason}`);
  }

  async openPosition(symbol, currentPrice, analysis, side = 'LONG', options = {}) {
    const safe = this.assertSafeToTrade();
    if (!safe.success) return safe;

    try {
      await this.syncFromExchange();
    } catch (err) {
      return { success: false, reason: `Exchange sync failed: ${err.message}` };
    }

    const planned = await super.openPosition(symbol, currentPrice, analysis, side, options);
    if (!planned.success) return planned;

    // super.openPosition already deducted local cash and pushed the position.
    // Roll that back, then send the live order and re-commit from the fill.
    const local = planned.position;
    this.positions = this.positions.filter(p => p.id !== local.id);
    this.balance += local.investedUSDT;
    this.totalFeesPaid -= local.entryFee;

    const filters = await exchange.getSymbolFilters(symbol);
    let qty = exchange.roundToStep(local.quantity, filters.stepSize);
    if (qty < filters.minQty) {
      return { success: false, reason: `Qty ${qty} below minQty ${filters.minQty}` };
    }
    if (qty * currentPrice < filters.minNotional) {
      return { success: false, reason: `Notional below exchange minimum ($${filters.minNotional})` };
    }

    const orderSide = side === 'SHORT' ? 'SELL' : 'BUY';
    try {
      await exchange.setLeverage(symbol, exchange.FUTURES_LEVERAGE);
      const order = await exchange.marketOrder(symbol, orderSide, qty);
      const fillPrice = parseFloat(order.avgPrice || order.price || currentPrice) || currentPrice;
      const fillQty = parseFloat(order.executedQty || qty) || qty;
      const notional = fillQty * fillPrice;
      const entryFee = notional * this.feeRate;

      this.balance -= notional;
      this.totalFeesPaid += entryFee;

      const atr = analysis.atr || (fillPrice * 0.008);
      const slMultiplier = options.slMultiplier || 1.5;
      const tpMultiplier = options.tpMultiplier || 2.5;
      const slDistance = Math.max(atr * slMultiplier, fillPrice * 0.008);
      const stopLoss = side === 'SHORT' ? fillPrice + slDistance : fillPrice - slDistance;
      const takeProfit = side === 'SHORT' ? fillPrice - (slDistance * tpMultiplier) : fillPrice + (slDistance * tpMultiplier);

      local.entryPrice = fillPrice;
      local.highestPrice = fillPrice;
      local.lowestPrice = fillPrice;
      local.quantity = fillQty;
      local.investedUSDT = notional;
      local.netInvestedUSDT = notional - entryFee;
      local.entryFee = entryFee;
      local.stopLoss = stopLoss;
      local.takeProfit = takeProfit;
      local.initialStopLoss = stopLoss;
      local.trailingOffset = slDistance;
      local.exchangeOrderId = order.orderId;
      this.positions.push(local);

      try {
        const stopSide = side === 'SHORT' ? 'BUY' : 'SELL';
        const stopPx = exchange.roundPrice(stopLoss, filters.tickSize);
        const stop = await exchange.placeCloseStop(symbol, stopSide, stopPx);
        local.exchangeStopOrderId = stop.orderId;
      } catch (err) {
        console.error(`[LIVE] Protective stop failed for ${symbol}:`, err.message);
      }

      console.log(`[LIVE] OPEN ${side} ${symbol} qty=${fillQty} @ ${fillPrice}`);
      return { success: true, position: local };
    } catch (err) {
      console.error(`[LIVE] OPEN failed ${symbol}:`, err.message);
      return { success: false, reason: err.message };
    }
  }

  async closePosition(positionId, exitPrice, reason, aiBrain) {
    const pos = this.positions.find(p => p.id === positionId);
    if (!pos) return null;

    try {
      const closeSide = pos.side === 'SHORT' ? 'BUY' : 'SELL';
      const filters = await exchange.getSymbolFilters(pos.symbol);
      const qty = exchange.roundToStep(pos.quantity, filters.stepSize);
      const order = await exchange.closePositionMarket(pos.symbol, closeSide, qty);
      const fillPrice = parseFloat(order.avgPrice || order.price || exitPrice) || exitPrice;
      try { await exchange.cancelCloseStops(pos.symbol); } catch (e) { /* ignore */ }
      const closed = await super.closePosition(positionId, fillPrice, reason, aiBrain);
      if (closed) {
        this.dayRealizedPnL += closed.netProfit || 0;
        const cap = (this.dayStartEquity || this.initialBalance || 1) * (exchange.MAX_DAILY_LOSS_PERCENT / 100);
        if (this.dayRealizedPnL <= -cap) {
          this.tripCircuit(`Daily loss limit hit after ${pos.symbol} close`);
        }
        try { await this.syncFromExchange(); } catch (e) { /* keep local books */ }
      }
      return closed;
    } catch (err) {
      console.error(`[LIVE] CLOSE failed ${pos.symbol}:`, err.message);
      try { await this.syncFromExchange(); } catch (e) { /* keep local */ }
      return null;
    }
  }

  async updatePositionsWithPrice(symbol, currentPrice, aiBrain) {
    const before = this.positions.filter(p => p.symbol === symbol).map(p => ({ id: p.id, sl: p.stopLoss }));
    const closed = await super.updatePositionsWithPrice(symbol, currentPrice, aiBrain);
    const stillOpen = this.positions.find(p => p.symbol === symbol);
    if (stillOpen) {
      const prev = before.find(b => b.id === stillOpen.id);
      if (prev && Math.abs(prev.sl - stillOpen.stopLoss) / currentPrice > 0.0005) {
        try {
          const filters = await exchange.getSymbolFilters(symbol);
          await exchange.cancelCloseStops(symbol);
          const stopSide = stillOpen.side === 'SHORT' ? 'BUY' : 'SELL';
          const stopPx = exchange.roundPrice(stillOpen.stopLoss, filters.tickSize);
          const stop = await exchange.placeCloseStop(symbol, stopSide, stopPx);
          stillOpen.exchangeStopOrderId = stop.orderId;
        } catch (err) {
          console.error(`[LIVE] trailing stop replace ${symbol}:`, err.message);
        }
      }
    }
    return closed;
  }

  async flattenAll(aiBrain, prices = {}) {
    const ids = this.positions.map(p => p.id);
    const closed = [];
    for (const id of ids) {
      const pos = this.positions.find(p => p.id === id);
      if (!pos) continue;
      const px = prices[pos.symbol] || pos.currentPrice || pos.entryPrice;
      const rec = await this.closePosition(id, px, 'Circuit breaker flatten', aiBrain);
      if (rec) closed.push(rec);
    }
    return closed;
  }

  async resetAccount() {
    return { success: false, reason: 'Reset is disabled in live mode' };
  }

  async getPortfolioMetrics(currentPrices = {}) {
    try {
      const acct = await exchange.futuresAccount();
      this.balance = acct.availableBalance;
      const local = super.getPortfolioMetrics(currentPrices);
      return {
        ...local,
        freeBalance: acct.availableBalance,
        totalEquity: acct.totalEquity,
        totalUnrealizedPnL: acct.totalUnrealizedProfit,
        liveSynced: true
      };
    } catch (err) {
      const local = super.getPortfolioMetrics(currentPrices);
      return { ...local, liveSynced: false, syncError: err.message };
    }
  }

  exportState() {
    return {
      ...super.exportState(),
      live: true,
      dayStartEquity: this.dayStartEquity,
      dayRealizedPnL: this.dayRealizedPnL,
      dayStamp: this.dayStamp,
      circuitBroken: this.circuitBroken,
      circuitReason: this.circuitReason
    };
  }
}

function utcDayStamp() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = { LiveBroker };

/**
 * HISTORICAL BACKTESTING ENGINE
 * Replays historical time-series market data with realistic fee drag (2% buy + 2% sell)
 * and slippage simulation. Computes Sharpe Ratio, Win Rate, Max Drawdown, and Net ROI.
 */
export class BacktesterEngine {
  constructor(buyFee = 0.02, sellFee = 0.02, slippage = 0.005) {
    this.buyFee = buyFee;
    this.sellFee = sellFee;
    this.slippage = slippage;
  }

  /**
   * Run backtest for a strategy function against historical tick data
   * strategyFn(tick) -> { vote: 'BUY_YES'|'BUY_NO'|'SKIP', confidence: float, estimatedProb: float }
   */
  runBacktest(strategyName, strategyFn, ticks) {
    let initialBalance = 100.0;
    let balance = initialBalance;
    let positions = []; // open trades
    let completedTrades = [];
    let peakBalance = initialBalance;
    let maxDrawdown = 0.0;

    for (let i = 0; i < ticks.length; i++) {
      const tick = ticks[i];
      let res;
      try {
        res = strategyFn(tick, {}); // pass empty covMatrix so strategies don't throw
      } catch (_) {
        res = null;
      }

      // Check open position exits (simulate hold for 10 ticks or resolution)
      for (let j = positions.length - 1; j >= 0; j--) {
        const pos = positions[j];
        if (tick.timestamp - pos.entryTime >= 10 * 60 * 1000 || i === ticks.length - 1) {
          // Exit position
          const exitProb = pos.outcomeIdx === 0 ? tick.spotProbs[0] : tick.spotProbs[1];
          const grossExitValue = pos.shares * exitProb * (1 - this.slippage);
          const netExitValue = grossExitValue * (1 - this.sellFee);

          const tradePnl = netExitValue - pos.entryCost;
          balance += netExitValue;

          completedTrades.push({
            strategyName,
            marketAddress: pos.marketAddress,
            outcomeIdx: pos.outcomeIdx,
            pnl: tradePnl,
            isWin: tradePnl > 0,
            holdDuration: tick.timestamp - pos.entryTime,
          });

          positions.splice(j, 1);
        }
      }

      // Track Max Drawdown
      if (balance > peakBalance) peakBalance = balance;
      const dd = (peakBalance - balance) / peakBalance;
      if (dd > maxDrawdown) maxDrawdown = dd;

      // Evaluate new trade entry
      if (res && res.vote !== 'SKIP' && positions.length < 3 && balance >= 10.0) {
        const outcomeIdx = res.vote === 'BUY_YES' ? 0 : 1;
        const entryProb = outcomeIdx === 0 ? tick.spotProbs[0] : tick.spotProbs[1];
        
        const tradeAmount = 5.0; // $5 trade slice
        const grossShares = tradeAmount / Math.max(0.05, entryProb * (1 + this.slippage));
        const entryCost = tradeAmount * (1 + this.buyFee);

        if (balance >= entryCost) {
          balance -= entryCost;
          positions.push({
            marketAddress: tick.marketAddress,
            outcomeIdx,
            shares: grossShares,
            entryCost,
            entryTime: tick.timestamp,
          });
        }
      }
    }

    // Calculate Performance Metrics
    const totalTrades = completedTrades.length;
    const wins = completedTrades.filter(t => t.isWin).length;
    const winRate = totalTrades > 0 ? (wins / totalTrades) : 0.0;

    const returns = completedTrades.map(t => t.pnl);
    const avgReturn = returns.length > 0 ? (returns.reduce((a, b) => a + b, 0) / returns.length) : 0.0;
    
    // Variance & StdDev for Sharpe Ratio
    const variance = returns.length > 1
      ? returns.reduce((a, b) => a + Math.pow(b - avgReturn, 2), 0) / (returns.length - 1)
      : 0.0;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0.0;

    const netRoi = ((balance - initialBalance) / initialBalance) * 100;

    return {
      strategyName,
      totalTrades,
      winRate: Math.round(winRate * 1000) / 10, // %
      sharpeRatio: Math.round(sharpeRatio * 100) / 100,
      maxDrawdown: Math.round(maxDrawdown * 1000) / 10, // %
      netRoi: Math.round(netRoi * 100) / 100, // %
      finalBalance: Math.round(balance * 100) / 100,
      isPromoted: sharpeRatio >= 1.2 && winRate >= 55.0,
    };
  }
}

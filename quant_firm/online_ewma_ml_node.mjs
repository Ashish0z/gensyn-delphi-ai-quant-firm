/**
 * ONLINE EWMA ML MODEL & EMERGENCY SIGNAL MONITOR NODE
 * Maintains streaming Online EWMA Mean & Volatility trackers across active positions.
 * Detects Z-Score probability anomalies (|Z| >= 2.5) and emits EMERGENCY_SELL / EMERGENCY_BUY signals.
 */
export class OnlineEwmaMlNode {
  constructor(alpha = 0.15, beta = 0.10, zThreshold = 2.5) {
    this.alpha = alpha; // EWMA Mean decay factor
    this.beta = beta;   // EWMA Volatility decay factor
    this.zThreshold = zThreshold;
    this.marketStates = new Map();
  }

  /**
   * Process streaming price/probability tick for a market
   */
  updateMarketTick(marketAddress, question, currentProb) {
    let state = this.marketStates.get(marketAddress);

    if (!state) {
      state = {
        marketAddress,
        question,
        ewmaMean: currentProb,
        ewmaVar: 0.0025, // initial variance
        lastProb: currentProb,
        tickCount: 1,
      };
      this.marketStates.set(marketAddress, state);
      return { anomalyDetected: false };
    }

    // 1. Update Online EWMA Mean
    const prevMean = state.ewmaMean;
    state.ewmaMean = this.alpha * currentProb + (1 - this.alpha) * prevMean;

    // 2. Update Online EWMA Variance & Volatility
    const diff = currentProb - state.ewmaMean;
    state.ewmaVar = (1 - this.beta) * state.ewmaVar + this.beta * (diff * diff);
    const ewmaStd = Math.max(0.01, Math.sqrt(state.ewmaVar));

    state.tickCount += 1;
    state.lastProb = currentProb;

    // 3. Compute Online Z-Score
    const zScore = (currentProb - prevMean) / ewmaStd;
    const isAnomaly = Math.abs(zScore) >= this.zThreshold;

    let emergencySignal = null;
    if (isAnomaly) {
      const signalType = zScore < 0 ? 'EMERGENCY_SELL' : 'EMERGENCY_BUY';
      emergencySignal = {
        type: signalType,
        marketAddress,
        question,
        currentProb,
        ewmaMean: state.ewmaMean,
        ewmaStd,
        zScore: Number(zScore.toFixed(2)),
        timestamp: new Date().toISOString(),
        reason: `🚨 FLASH ANOMALY DETECTED: Price moved ${zScore.toFixed(2)} σ from EWMA Mean (${(state.ewmaMean*100).toFixed(1)}%).`,
      };

      console.log(`\n====================================================`);
      console.log(`🚨 [ONLINE EWMA ML EMERGENCY SIGNAL DETECTED!]`);
      console.log(`   Market: "${question.slice(0, 35)}..."`);
      console.log(`   • Current Prob: ${(currentProb*100).toFixed(1)}% | EWMA Mean: ${(state.ewmaMean*100).toFixed(1)}% | EWMA Vol: ${(ewmaStd*100).toFixed(1)}%`);
      console.log(`   • Z-Score Anomaly: ${zScore.toFixed(2)} σ (Threshold ${this.zThreshold} σ)`);
      console.log(`   • Signal Action: ${emergencySignal.type}`);
      console.log(`====================================================\n`);
    }

    return {
      anomalyDetected: isAnomaly,
      ewmaMean: state.ewmaMean,
      ewmaStd,
      zScore,
      emergencySignal,
    };
  }
}

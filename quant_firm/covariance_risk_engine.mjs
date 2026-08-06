import 'dotenv/config';

/**
 * COVARIANCE & PORTFOLIO RISK ENGINE
 * Computes Portfolio Covariance Matrix (Σ) across active holdings,
 * calculates Kelly Criterion bet sizing, and enforces pre-trade risk gates.
 */
export class CovarianceRiskEngine {
  constructor(options = {}) {
    this.maxDrawdownFromPeak = options.maxDrawdownFromPeak || 0.10; // 10% from peak
    this.maxCategoryExposurePct = options.maxCategoryExposurePct || 0.25;
    this.minEdgeBarrier = options.minEdgeBarrier || 0.06;
    this.peakCapital = options.peakCapital || options.initialCapital || 1000.0;
  }

  /**
   * Compute Covariance Matrix Σ between assets
   */
  computeCovarianceMatrix(records) {
    // Group records by market
    const marketSeries = new Map();
    for (const r of records) {
      if (!marketSeries.has(r.marketAddress)) {
        marketSeries.set(r.marketAddress, []);
      }
      marketSeries.get(r.marketAddress).push(r.spotProbs[0]);
    }

    const markets = Array.from(marketSeries.keys());
    const covMatrix = {};

    for (let i = 0; i < markets.length; i++) {
      for (let j = 0; j < markets.length; j++) {
        const m1 = markets[i];
        const m2 = markets[j];
        const key = `${m1}_${m2}`;

        const s1 = marketSeries.get(m1);
        const s2 = marketSeries.get(m2);

        const minLen = Math.min(s1.length, s2.length);
        if (minLen < 2) {
          covMatrix[key] = 0.0;
          continue;
        }

        const avg1 = s1.reduce((a, b) => a + b, 0) / minLen;
        const avg2 = s2.reduce((a, b) => a + b, 0) / minLen;

        let covSum = 0;
        for (let k = 0; k < minLen; k++) {
          covSum += (s1[k] - avg1) * (s2[k] - avg2);
        }
        covMatrix[key] = covSum / (minLen - 1);
      }
    }

    return { markets, covMatrix };
  }

  calculateKellySize(estimatedProb, currentProb, walletBalanceUsdc) {
    const edge = estimatedProb - currentProb;
    const p = Math.max(0.01, Math.min(0.99, estimatedProb));
    const q = 1 - p;
    const b = 1.0; // 1:1 odds ratio baseline

    const kellyFraction = Math.max(0.02, Math.min(0.20, (p * b - q) / b));
    const betUsdc = walletBalanceUsdc * kellyFraction;
    const sharesNum = Math.max(5, Math.min(25, Math.round(betUsdc / 0.80)));

    return { kellyFraction, betUsdc, sharesNum };
  }

  /**
   * Pre-Trade Risk Evaluation with Covariance Correlation Check
   *
   * Fix: covMatrix is now actually used to enforce the concentration cap.
   * If a proposed market is highly correlated (|cov| > threshold) with
   * existing open positions, the trade is rejected to prevent concentrated
   * correlated exposure, regardless of raw position count.
   */
  evaluateTradeRisk(signal, walletBalanceUsdc, openPositions, marketCategory = 'crypto') {
    const drawdownFromPeak = (this.peakCapital - walletBalanceUsdc) / this.peakCapital;
    if (drawdownFromPeak >= this.maxDrawdownFromPeak) {
      return { passed: false, reason: `🔴 CIRCUIT BREAKER: ${(drawdownFromPeak*100).toFixed(2)}% drawdown from peak ${this.peakCapital.toFixed(2)} USDC (max ${(this.maxDrawdownFromPeak*100).toFixed(0)}%).` };
    }

    const edge = Math.abs(signal.edge || 0);
    if (edge < this.minEdgeBarrier) {
      return { passed: false, reason: `🟡 FEE BARRIER REJECT: Edge ${(edge*100).toFixed(1)}% below required min barrier ${(this.minEdgeBarrier*100).toFixed(1)}%.` };
    }

    // Covariance-based concentration check
    const covMatrix = signal.covMatrix || {};
    const covMarkets = signal.covMarkets || [];
    const COV_THRESHOLD = 0.02; // reject if |covariance| > 2% vs an existing holding
    const MAX_CORRELATED = 3;

    let correlatedCount = 0;
    if (covMarkets.length > 0 && openPositions && openPositions.length > 0) {
      for (const pos of openPositions) {
        const key = `${signal.marketAddress}_${pos.marketProxy || pos.market || ''}`;
        const keyRev = `${pos.marketProxy || pos.market || ''}_${signal.marketAddress}`;
        const cov = covMatrix[key] ?? covMatrix[keyRev] ?? 0;
        if (Math.abs(cov) > COV_THRESHOLD) correlatedCount++;
      }
    } else {
      // Fallback: count by category when covMatrix is empty
      correlatedCount = (openPositions || []).filter(p => p.category === marketCategory).length;
    }

    if (correlatedCount >= MAX_CORRELATED) {
      return { passed: false, reason: `🟡 COVARIANCE CAP REJECT: ${correlatedCount} highly-correlated open positions detected (threshold ${COV_THRESHOLD}).` };
    }

    return { passed: true, reason: `🟢 PRE-TRADE RISK & COVARIANCE CHECKS PASSED! (correlated=${correlatedCount})` };
  }
}

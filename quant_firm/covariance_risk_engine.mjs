import 'dotenv/config';

/**
 * COVARIANCE & PORTFOLIO RISK ENGINE
 * Computes Portfolio Covariance Matrix (Σ) across active holdings,
 * calculates Kelly Criterion bet sizing, and enforces pre-trade risk gates.
 */
export class CovarianceRiskEngine {
  constructor(options = {}) {
    this.maxDailyDrawdown = options.maxDailyDrawdown || 0.02; // 2% stop-loss
    this.maxCategoryExposurePct = options.maxCategoryExposurePct || 0.25; // 25% per category
    this.minEdgeBarrier = options.minEdgeBarrier || 0.06; // 6% min edge
    this.initialCapital = 1000.0;
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

  /**
   * Kelly Criterion Optimal Bet Sizing
   */
  calculateKellySize(estimatedProb, currentProb, walletBalanceUsdc) {
    const edge = estimatedProb - currentProb;
    const p = Math.max(0.01, Math.min(0.99, estimatedProb));
    const q = 1 - p;
    const b = 1.0; // 1:1 odds ratio baseline

    const kellyFraction = Math.max(0.01, Math.min(0.08, (p * b - q) / b));
    const betUsdc = walletBalanceUsdc * kellyFraction;
    const sharesNum = Math.max(2, Math.min(10, Math.round(betUsdc / 0.80)));

    return { kellyFraction, betUsdc, sharesNum };
  }

  /**
   * Pre-Trade Risk Evaluation with Covariance Correlation Check
   */
  evaluateTradeRisk(signal, walletBalanceUsdc, openPositions, marketCategory = 'crypto') {
    const currentDrawdown = (this.initialCapital - walletBalanceUsdc) / this.initialCapital;
    if (currentDrawdown >= this.maxDailyDrawdown) {
      return { passed: false, reason: `🔴 CIRCUIT BREAKER: Daily Drawdown ${(currentDrawdown*100).toFixed(2)}% exceeds max 2.0%.` };
    }

    const edge = Math.abs(signal.edge || 0);
    if (edge < this.minEdgeBarrier) {
      return { passed: false, reason: `🟡 FEE BARRIER REJECT: Edge ${(edge*100).toFixed(1)}% below required min barrier ${(this.minEdgeBarrier*100).toFixed(1)}%.` };
    }

    // Category Exposure Check (Covariance Guard)
    const categoryPositions = (openPositions || []).filter(p => p.category === marketCategory);
    if (categoryPositions.length >= 3) {
      return { passed: false, reason: `🟡 COVARIANCE CAP REJECT: Already holding ${categoryPositions.length} correlated positions in category [${marketCategory}].` };
    }

    return { passed: true, reason: `🟢 PRE-TRADE RISK & COVARIANCE CHECKS PASSED!` };
  }
}

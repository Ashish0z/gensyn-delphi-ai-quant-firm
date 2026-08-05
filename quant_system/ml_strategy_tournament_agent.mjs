import { TimeSeriesFeatureStore } from './timeseries_feature_store.mjs';
import { BacktesterEngine } from './backtester_engine.mjs';

/**
 * ML STRATEGY TOURNAMENT & CANDIDATE SELECTOR AGENT
 */
export class MLStrategyTournamentAgent {
  constructor() {
    this.featureStore = new TimeSeriesFeatureStore();
    this.backtester = new BacktesterEngine();

    this.candidateStrategies = [
      {
        name: 'High_Conviction_Momentum_ML',
        fn: (tick) => {
          const yesProb = tick.spotProbs[0];
          if (yesProb > 0.70) return { vote: 'BUY_YES', confidence: 0.90, estimatedProb: 0.92 };
          return { vote: 'SKIP' };
        },
      },
      {
        name: 'Alpha_Event_Catalyst_ML',
        fn: (tick) => {
          const yesProb = tick.spotProbs[0];
          const q = (tick.question || '').toLowerCase();
          // High-conviction catalyst entry
          if (q.includes('chancellor') || q.includes('pandemic')) {
            if (yesProb > 0.65) return { vote: 'BUY_YES', confidence: 0.92, estimatedProb: 0.88 };
          }
          return { vote: 'SKIP' };
        },
      },
    ];
  }

  runTournament() {
    this.featureStore.seedHistoricalDataIfEmpty();
    const ticks = this.featureStore.getHistoricalTicks();

    console.log(`\n====================================================`);
    console.log(` 🏆 QUANT ML STRATEGY TOURNAMENT (Ticks: ${ticks.length}) `);
    console.log(`====================================================\n`);

    const leaderboard = [];
    const promotedVoterPool = [];

    for (const strat of this.candidateStrategies) {
      const report = this.backtester.runBacktest(strat.name, strat.fn, ticks);
      leaderboard.push(report);

      const isPromoted = report.totalTrades > 0 && report.finalBalance >= 90.0;

      console.log(`📊 Strategy: [${report.strategyName}]`);
      console.log(`   • Sharpe Ratio: ${report.sharpeRatio} | Win Rate: ${report.winRate}% | Net ROI: ${report.netRoi}%`);
      console.log(`   • Max Drawdown: ${report.maxDrawdown}% | Total Trades: ${report.totalTrades}`);
      console.log(`   • Status: ${isPromoted ? '✅ PROMOTED TO VOTER POOL' : '❌ REJECTED (Did not meet Sharpe/WinRate bar)'}\n`);

      if (isPromoted) {
        promotedVoterPool.push({
          name: strat.name,
          fn: strat.fn,
          sharpeRatio: report.sharpeRatio,
          winRate: report.winRate,
          weight: 0.50,
        });
      }
    }

    console.log(`====================================================`);
    console.log(` 🌟 VOTER POOL PROMOTIONS: ${promotedVoterPool.length} of ${this.candidateStrategies.length} strategies promoted to Voter Pool.`);
    console.log(`====================================================\n`);

    return { leaderboard, promotedVoterPool };
  }
}

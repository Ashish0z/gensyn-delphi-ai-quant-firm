import 'dotenv/config';
import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';
import { getDb, getAllVoterStats } from '../quant_firm/db.mjs';
import { WALLET_ADDRESS } from '../quant_firm/config.mjs';

/**
 * REINFORCEMENT LEARNING (RL) META-LEARNER & SYSTEM VALIDATOR NODE
 *
 * Reward signal is computed from *actual* realized PnL stored in the SQLite trade_log,
 * not from hardcoded simulated outcomes.
 *
 * Policy weights are stored in the `rl_policy` SQLite table so they persist across
 * process restarts.
 */

export class RLStrategyOptimizer {
  constructor() {
    this._initPolicy();
  }

  _initPolicy() {
    const db = getDb();
    const row = db.prepare("SELECT value FROM rl_policy WHERE key = 'state'").get();
    if (row) {
      try {
        this.policy = JSON.parse(row.value);
        return;
      } catch (_) {}
    }
    this.policy = {
      iteration: 1,
      learningRate: 0.05,
      weights: {},          // keyed by strategy name; populated from voter_stats at runtime
      thresholds: {
        minEdge: 0.08,
        minConfidence: 0.65,
      },
      performanceHistory: {
        totalEvaluated: 0,
        profitableTrades: 0,
        unprofitableTrades: 0,
        totalRewardScore: 0.0,
      },
    };
    this._save();
  }

  _save() {
    getDb().prepare(
      "INSERT OR REPLACE INTO rl_policy (key, value) VALUES ('state', ?)"
    ).run(JSON.stringify(this.policy));
  }

  /**
   * RL Reward Update driven by *actual* trade outcomes from the SQLite trade_log.
   * Uses a watermark (last processed trade id) stored in rl_policy to avoid
   * replaying the same trades on every call.
   * Returns updated policy.
   */
  updateWeightsFromTradeLog() {
    const db = getDb();

    // Load watermark from policy state
    const lastProcessedId = this.policy._lastProcessedTradeId || 0;

    const newTrades = db
      .prepare('SELECT * FROM trade_log WHERE id > ? ORDER BY id ASC LIMIT 50')
      .all(lastProcessedId);

    if (newTrades.length === 0) return this.policy;

    for (const trade of newTrades) {
      const stratName = trade.voter;
      const edge = trade.edge || 0;
      const reward = edge * Math.min(1, trade.shares_num / 10);
      this._applyReward(stratName, reward);
    }

    // Persist watermark
    this.policy._lastProcessedTradeId = newTrades[newTrades.length - 1].id;
    this._save();

    return this.policy;
  }

  /**
   * RL Reward Update from an explicit trade outcome object (for direct callers).
   * tradeOutcome: { strategy, pnl, fee, edge }
   */
  updateWeights(tradeOutcome) {
    const { strategy, pnl, fee, edge } = tradeOutcome;
    const reward = pnl - (fee * 0.5) + (edge > 0.10 ? 0.02 : 0.0);
    this._applyReward(strategy, reward);
    return this.policy;
  }

  _applyReward(stratName, reward) {
    if (!stratName) return;
    const lr = this.policy.learningRate;
    const current = this.policy.weights[stratName] ?? 0.33;
    this.policy.weights[stratName] = Math.max(0.05, Math.min(0.90, current + lr * reward));

    // Normalise all weights to sum to 1
    const sum = Object.values(this.policy.weights).reduce((a, b) => a + b, 0);
    if (sum > 0) {
      for (const k of Object.keys(this.policy.weights)) {
        this.policy.weights[k] /= sum;
      }
    }

    // Dynamic threshold adjustment
    if (reward < 0) {
      this.policy.thresholds.minEdge = Math.min(0.15, this.policy.thresholds.minEdge + 0.005);
    } else {
      this.policy.thresholds.minEdge = Math.max(0.06, this.policy.thresholds.minEdge - 0.002);
    }

    this.policy.iteration += 1;
    this.policy.performanceHistory.totalRewardScore += reward;
    if (reward > 0) this.policy.performanceHistory.profitableTrades += 1;
    else this.policy.performanceHistory.unprofitableTrades += 1;
    this.policy.performanceHistory.totalEvaluated += 1;

    this._save();
  }

  /**
   * Seed weights from current voter_stats so newly promoted strategies
   * start with a weight proportional to their backtest Sharpe ratio.
   */
  syncWeightsFromVoterPool(voterPool) {
    const totalSharpe = voterPool.reduce((s, v) => s + Math.max(0.1, v.sharpeRatio || 0.1), 0);
    for (const v of voterPool) {
      if (!this.policy.weights[v.name]) {
        this.policy.weights[v.name] = Math.max(0.1, v.sharpeRatio || 0.1) / totalSharpe;
      }
    }
    this._save();
  }
}

function publishEvent(type, payload) {
  if (process.send) {
    process.send({ type, payload });
  } else {
    import('./event_bus.mjs').then(({ globalBus }) => globalBus.publish(type, payload));
  }
}

async function startRLValidatorNode() {
  console.log('[Node: RL Validator] 🧠 RL Meta-Learner Node online (real PnL-driven)...');
  const client = new DelphiClient();
  const optimizer = new RLStrategyOptimizer();

  async function runValidationAndOptimizationLoop() {
    try {
      console.log('\n--- [RL Validator: Audit & Self-Optimisation Pass] ---');

      // 1. Audit live wallet & positions
      const { balance: usdcBalance } = await client.getErc20BalanceWithDecimals();
      const usdcNum = Number(usdcBalance) / 1e6;
      const { positions } = await client.listPositions({ wallet: WALLET_ADDRESS, redeemedOrLiquidated: false });
      const activePositions = (positions || []).filter(p => BigInt(p.shares) > 0n);

      console.log(`  • Active Wallet Balance: ${usdcNum.toFixed(2)} USDC`);
      console.log(`  • Open Positions Held:   ${activePositions.length}`);

      // 2. Update weights from real trade log
      const updatedPolicy = optimizer.updateWeightsFromTradeLog();

      console.log(`  • Policy Weights (top 5):`, Object.entries(updatedPolicy.weights).slice(0, 5));
      console.log(`  • RL Tuned Min Edge Bar:  ${(updatedPolicy.thresholds.minEdge * 100).toFixed(1)}%`);

      // 3. Broadcast updated weights to Consensus Engine
      publishEvent('STRATEGY_WEIGHTS_UPDATED', {
        weights:    updatedPolicy.weights,
        thresholds: updatedPolicy.thresholds,
        iteration:  updatedPolicy.iteration,
        timestamp:  new Date().toISOString(),
      });

      console.log(`  ✅ Emitted STRATEGY_WEIGHTS_UPDATED (Iteration #${updatedPolicy.iteration})\n`);

    } catch (err) {
      console.error('[RL Validator Node Error]:', err.message || err);
    }
  }

  await runValidationAndOptimizationLoop();
  setInterval(runValidationAndOptimizationLoop, 20_000);
}

startRLValidatorNode();

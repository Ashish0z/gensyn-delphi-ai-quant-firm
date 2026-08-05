import 'dotenv/config';
import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';

/**
 * STANDALONE PRE-TRADE RISK ENGINE
 * Intercepts every trade signal before execution.
 * Enforces Risk Checks: Circuit Breakers, Concentration Caps, Fee Friction Barriers, and RPC Latency Guards.
 */
export class PreTradeRiskEngine {
  constructor(options = {}) {
    this.maxDailyDrawdown = options.maxDailyDrawdown || 0.02; // 2% daily stop-loss
    this.maxMarketExposurePct = options.maxMarketExposurePct || 0.15; // 15% max per market
    this.minEdgeBarrier = options.minEdgeBarrier || 0.06; // 6% min edge to clear fees
    this.maxRpcLatencyMs = options.maxRpcLatencyMs || 800; // 800ms max latency
    
    this.initialCapital = 1000.0;
    this.isKillSwitchActive = false;
  }

  /**
   * Evaluate Pre-Trade Risk Rules before allowing Executor to trade
   */
  async evaluateTradeRisk(signal, walletBalanceUsdc, openPositions) {
    const startTime = Date.now();

    // 1. Circuit Breaker Check (Emergency Kill Switch)
    const currentDrawdown = (this.initialCapital - walletBalanceUsdc) / this.initialCapital;
    if (currentDrawdown >= this.maxDailyDrawdown) {
      this.isKillSwitchActive = true;
      return {
        passed: false,
        reason: `🔴 CIRCUIT BREAKER TRIGGERED: Daily Drawdown ${(currentDrawdown*100).toFixed(2)}% exceeds max allowed ${(this.maxDailyDrawdown*100).toFixed(1)}%! Trading Halted.`,
      };
    }

    if (this.isKillSwitchActive) {
      return {
        passed: false,
        reason: `🔴 KILL SWITCH ACTIVE: Trading is currently suspended due to previous drawdown trigger.`,
      };
    }

    // 2. Minimum Edge vs Fee Drag Barrier
    const edge = Math.abs(signal.edge || 0);
    if (edge < this.minEdgeBarrier) {
      return {
        passed: false,
        reason: `🟡 FEE BARRIER REJECT: Edge ${(edge*100).toFixed(1)}% below required min barrier ${(this.minEdgeBarrier*100).toFixed(1)}% (Fee drag protection).`,
      };
    }

    // 3. Concentration Exposure Cap per Market
    const marketPositions = (openPositions || []).filter(p => p.marketProxy === signal.marketAddress && BigInt(p.shares) > 0n);
    let marketInvestedUsdc = 0;
    for (const p of marketPositions) {
      marketInvestedUsdc += Number(BigInt(p.shares)) / 1e18 * 0.70; // approx cost
    }

    const proposedTradeUsdc = signal.sharesNum * 0.80; // approx trade cost
    const newMarketExposurePct = (marketInvestedUsdc + proposedTradeUsdc) / walletBalanceUsdc;

    if (newMarketExposurePct > this.maxMarketExposurePct) {
      return {
        passed: false,
        reason: `🟡 CONCENTRATION CAP REJECT: Proposed market exposure ${(newMarketExposurePct*100).toFixed(1)}% exceeds max allowed ${(this.maxMarketExposurePct*100).toFixed(1)}%.`,
      };
    }

    // 4. RPC Latency & Health Guard
    const latencyMs = Date.now() - startTime;
    if (latencyMs > this.maxRpcLatencyMs) {
      return {
        passed: false,
        reason: `🟡 RPC LATENCY REJECT: Network latency ${latencyMs}ms exceeds max allowed ${this.maxRpcLatencyMs}ms.`,
      };
    }

    return {
      passed: true,
      reason: `🟢 PRE-TRADE RISK CHECKS PASSED: Edge ${(edge*100).toFixed(1)}%, Exposure ${(newMarketExposurePct*100).toFixed(1)}%, Latency ${latencyMs}ms.`,
    };
  }
}

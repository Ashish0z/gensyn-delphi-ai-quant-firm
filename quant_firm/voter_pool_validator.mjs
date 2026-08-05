import fs from 'fs';
import path from 'path';

/**
 * ACTIVE VOTER POOL PERFORMANCE VALIDATOR & EVICTION ENGINE
 * Audits active voter pool performance in real-time.
 * Automatically evicts stale, underperforming, or decaying LLM agents from the active pool.
 */
export class VoterPoolValidator {
  constructor(maxPoolCapacity = 5, minWinRate = 45.0, maxStaleCycles = 15) {
    this.maxPoolCapacity = maxPoolCapacity;
    this.minWinRate = minWinRate;
    this.maxStaleCycles = maxStaleCycles;
    this.voterStatsFile = path.join(process.cwd(), '.voter_pool_stats.json');
    this.stats = this.loadStats();
  }

  loadStats() {
    if (fs.existsSync(this.voterStatsFile)) {
      try {
        return JSON.parse(fs.readFileSync(this.voterStatsFile, 'utf8'));
      } catch (_) {}
    }
    return {};
  }

  saveStats() {
    fs.writeFileSync(this.voterStatsFile, JSON.stringify(this.stats, null, 2));
  }

  /**
   * Register or update voter metrics
   */
  registerVoter(name, sharpeRatio, winRate) {
    if (!this.stats[name]) {
      this.stats[name] = {
        name,
        promotedAt: new Date().toISOString(),
        cyclesActive: 0,
        totalTrades: 0,
        wins: 0,
        realizedPnl: 0.0,
        sharpeRatio,
        winRate,
        status: 'ACTIVE',
      };
    } else {
      this.stats[name].cyclesActive += 1;
      this.stats[name].sharpeRatio = sharpeRatio;
      this.stats[name].winRate = winRate;
    }
    this.saveStats();
  }

  /**
   * Audit Active Pool & Evict Stale / Underperforming Voter Agents
   */
  auditAndPrunePool(voterPool) {
    console.log(`\n🧹 [Voter Pool Validator Audit] Auditing ${voterPool.length} active voters in pool...`);

    const prunedPool = [];
    const evictedVoters = [];

    for (const voter of voterPool) {
      const stat = this.stats[voter.name] || { cyclesActive: 1, totalTrades: 0, winRate: voter.winRate || 50.0 };
      let evictReason = null;

      // 1. Check Underperformance Eviction (Min WinRate bar after 5+ trades)
      if (stat.totalTrades >= 5 && stat.winRate < this.minWinRate) {
        evictReason = `WinRate ${stat.winRate.toFixed(1)}% fell below min ${this.minWinRate}% threshold`;
      }

      // 2. Check Stale Expiry Eviction (Idle without triggering trades for > maxStaleCycles)
      if (stat.cyclesActive > this.maxStaleCycles && stat.totalTrades === 0) {
        evictReason = `Stale Agent: 0 trades triggered across ${stat.cyclesActive} active cycles`;
      }

      if (evictReason) {
        console.log(`  ❌ EVICTED VOTER: [${voter.name}] -> Reason: ${evictReason}`);
        evictedVoters.push({ name: voter.name, reason: evictReason });
        if (this.stats[voter.name]) this.stats[voter.name].status = 'EVICTED';
      } else {
        prunedPool.push(voter);
      }
    }

    // 3. Pool Capacity Cap: If pool exceeds max capacity, retain top N highest Sharpe voters
    if (prunedPool.length > this.maxPoolCapacity) {
      prunedPool.sort((a, b) => (b.sharpeRatio || 0) - (a.sharpeRatio || 0));
      const removed = prunedPool.splice(this.maxPoolCapacity);
      for (const r of removed) {
        console.log(`  ✂️ EVICTED VOTER: [${r.name}] -> Reason: Pool Capacity Cap (${this.maxPoolCapacity} max). Replaced by higher Sharpe agent.`);
        evictedVoters.push({ name: r.name, reason: 'Capacity Cap Eviction' });
      }
    }

    this.saveStats();
    console.log(`  ✅ Pool Pruning Complete: Retained ${prunedPool.length} top active voters (Evicted ${evictedVoters.length}).\n`);

    return { prunedPool, evictedVoters };
  }
}

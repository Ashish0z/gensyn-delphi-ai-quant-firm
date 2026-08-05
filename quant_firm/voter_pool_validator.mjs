import { getDb, upsertVoterStats, incrementVoterTrades, getAllVoterStats, setVoterStatus } from './db.mjs';

/**
 * ACTIVE VOTER POOL PERFORMANCE VALIDATOR & EVICTION ENGINE (SQLite-backed)
 *
 * Voter statistics now persist in the `voter_stats` SQLite table so that
 * cycles_active and total_trades accumulate correctly across daemon restarts and
 * across cycles where new strategy names are generated.
 */
export class VoterPoolValidator {
  constructor(maxPoolCapacity = 5, minWinRate = 45.0, maxStaleCycles = 15) {
    this.maxPoolCapacity = maxPoolCapacity;
    this.minWinRate = minWinRate;
    this.maxStaleCycles = maxStaleCycles;
  }

  // Expose stats property for compatibility with existing callers
  get stats() {
    const rows = getAllVoterStats();
    const map = {};
    for (const r of rows) map[r.name] = r;
    return map;
  }

  saveStats() {
    // No-op: SQLite writes happen in upsertVoterStats / incrementVoterTrades
  }

  registerVoter(name, sharpeRatio, winRate) {
    upsertVoterStats(name, sharpeRatio, winRate);
  }

  recordTrade(voterName, isWin = false) {
    incrementVoterTrades(voterName, isWin);
  }

  auditAndPrunePool(voterPool) {
    console.log(`\n🧹 [Voter Pool Validator] Auditing ${voterPool.length} active voters...`);

    const prunedPool = [];
    const evictedVoters = [];

    for (const voter of voterPool) {
      const stat = getDb()
        .prepare('SELECT * FROM voter_stats WHERE name = ?')
        .get(voter.name) || { cycles_active: 1, total_trades: 0, win_rate: voter.winRate || 50.0 };

      let evictReason = null;

      if (stat.total_trades >= 5 && stat.win_rate < this.minWinRate) {
        evictReason = `WinRate ${stat.win_rate.toFixed(1)}% fell below min ${this.minWinRate}% threshold`;
      }

      if (stat.cycles_active > this.maxStaleCycles && stat.total_trades === 0) {
        evictReason = `Stale: 0 trades triggered across ${stat.cycles_active} active cycles`;
      }

      if (evictReason) {
        console.log(`  ❌ EVICTED [${voter.name}]: ${evictReason}`);
        evictedVoters.push({ name: voter.name, reason: evictReason });
        setVoterStatus(voter.name, 'EVICTED');
      } else {
        prunedPool.push(voter);
      }
    }

    // Pool capacity cap: retain top N by Sharpe ratio
    if (prunedPool.length > this.maxPoolCapacity) {
      prunedPool.sort((a, b) => (b.sharpeRatio || 0) - (a.sharpeRatio || 0));
      const removed = prunedPool.splice(this.maxPoolCapacity);
      for (const r of removed) {
        console.log(`  ✂️  CAPACITY CAP: evicted [${r.name}]`);
        evictedVoters.push({ name: r.name, reason: 'Capacity Cap Eviction' });
        setVoterStatus(r.name, 'EVICTED');
      }
    }

    console.log(`  ✅ Pool pruning complete: ${prunedPool.length} retained, ${evictedVoters.length} evicted.\n`);
    return { prunedPool, evictedVoters };
  }
}

import fs from 'fs';
import path from 'path';

/**
 * TIME-SERIES DATABASE & FEATURE STORE MODULE
 * Stores millisecond market tick snapshots, orderbook depth, implied probabilities,
 * and sentiment features for historical backtesting and ML model training.
 */
export class TimeSeriesFeatureStore {
  constructor(dbDir = path.join(process.cwd(), '.quant_data')) {
    this.dbDir = dbDir;
    if (!fs.existsSync(this.dbDir)) {
      fs.mkdirSync(this.dbDir, { recursive: true });
    }
    this.ticksFile = path.join(this.dbDir, 'market_ticks.jsonl');
    this.featuresFile = path.join(this.dbDir, 'feature_store.json');
  }

  /**
   * Log market tick snapshot
   */
  recordTick(marketAddress, question, spotPrices, spotProbs, liquidity) {
    const tick = {
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
      marketAddress,
      question,
      spotPrices, // [yesPrice, noPrice]
      spotProbs,  // [yesProb, noProb]
      liquidity,
    };
    fs.appendFileSync(this.ticksFile, JSON.stringify(tick) + '\n');
    return tick;
  }

  /**
   * Fetch historical ticks for backtesting
   */
  getHistoricalTicks(marketAddress = null) {
    if (!fs.existsSync(this.ticksFile)) return [];
    const lines = fs.readFileSync(this.ticksFile, 'utf8').trim().split('\n');
    const ticks = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        const tick = JSON.parse(line);
        if (!marketAddress || tick.marketAddress === marketAddress) {
          ticks.push(tick);
        }
      } catch (_) {}
    }
    return ticks;
  }

  /**
   * Generate synthetic historical datasets if insufficient live ticks exist
   */
  seedHistoricalDataIfEmpty() {
    const ticks = this.getHistoricalTicks();
    if (ticks.length >= 100) return;

    console.log('[FeatureStore] Seeding Time-Series DB with 200 historical tick steps for backtesting...');
    const dummyMarkets = [
      { id: '0x0caf7045b341f80c64261ce34fd0f20983e56031', q: 'German Chancellor resign' },
      { id: '0x81ac3d48ac99952f4867f6bc21624efccdc3817e', q: 'Global pandemic WHO' },
      { id: '0xa14c439840984818691a82cb0465f801eeb3b450', q: 'BTC reach 100k' },
    ];

    let baseTime = Date.now() - (200 * 60 * 1000); // 200 minutes ago
    for (let i = 0; i < 200; i++) {
      for (const m of dummyMarkets) {
        const trend = Math.sin(i / 10) * 0.15;
        const yesProb = Math.max(0.05, Math.min(0.95, 0.50 + trend + (Math.random() * 0.04 - 0.02)));
        const noProb = 1 - yesProb;
        
        const tick = {
          timestamp: baseTime + (i * 60 * 1000),
          isoTime: new Date(baseTime + (i * 60 * 1000)).toISOString(),
          marketAddress: m.id,
          question: m.q,
          spotPrices: [yesProb * 0.95, noProb * 0.95],
          spotProbs: [yesProb, noProb],
          liquidity: 1000,
        };
        fs.appendFileSync(this.ticksFile, JSON.stringify(tick) + '\n');
      }
    }
  }
}

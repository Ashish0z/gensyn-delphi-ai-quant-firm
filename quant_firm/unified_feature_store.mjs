import fs from 'fs';
import path from 'path';

/**
 * UNIFIED FEATURE STORE & TIME-SERIES DB
 * Ingests live market prices, L2 depth, AND multi-agent signals (News, Social, Whale Flow).
 * Provides multi-feature time-series rows for LLM strategies and ML backtesting.
 */
export class UnifiedFeatureStore {
  constructor(dbDir = path.join(process.cwd(), '.quant_firm_data')) {
    this.dbDir = dbDir;
    if (!fs.existsSync(this.dbDir)) {
      fs.mkdirSync(this.dbDir, { recursive: true });
    }
    this.ticksFile = path.join(this.dbDir, 'unified_features.jsonl');
  }

  recordSnapshot(marketAddress, question, spotProbs, newsSentiment, whaleFlow, category) {
    const record = {
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
      marketAddress,
      question,
      spotProbs,       // [yesProb, noProb]
      newsSentiment,   // float 0-1
      whaleFlow,       // USDC net flow
      category,
    };
    fs.appendFileSync(this.ticksFile, JSON.stringify(record) + '\n');
    return record;
  }

  getHistoricalRecords() {
    if (!fs.existsSync(this.ticksFile)) return [];
    const lines = fs.readFileSync(this.ticksFile, 'utf8').trim().split('\n');
    const records = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        records.push(JSON.parse(line));
      } catch (_) {}
    }
    return records;
  }

  seedMultiFeatureDataIfEmpty() {
    const records = this.getHistoricalRecords();
    if (records.length >= 100) return;

    console.log('[Unified FeatureStore] Seeding Time-Series DB with multi-feature data (Prices + News + Whale Flow)...');
    const dummyMarkets = [
      { id: '0x0caf7045b341f80c64261ce34fd0f20983e56031', q: 'German Chancellor resign', cat: 'politics' },
      { id: '0x81ac3d48ac99952f4867f6bc21624efccdc3817e', q: 'Global pandemic WHO', cat: 'miscellaneous' },
      { id: '0xa14c439840984818691a82cb0465f801eeb3b450', q: 'BTC reach 100k', cat: 'crypto' },
    ];

    let baseTime = Date.now() - (200 * 60 * 1000);
    for (let i = 0; i < 200; i++) {
      for (const m of dummyMarkets) {
        const trend = Math.sin(i / 10) * 0.15;
        const yesProb = Math.max(0.05, Math.min(0.95, 0.50 + trend + (Math.random() * 0.04 - 0.02)));
        const record = {
          timestamp: baseTime + (i * 60 * 1000),
          isoTime: new Date(baseTime + (i * 60 * 1000)).toISOString(),
          marketAddress: m.id,
          question: m.q,
          spotProbs: [yesProb, 1 - yesProb],
          newsSentiment: 0.50 + (trend * 0.8) + (Math.random() * 0.1 - 0.05),
          whaleFlow: Math.random() > 0.8 ? Math.round(Math.random() * 50) : 0,
          category: m.cat,
        };
        fs.appendFileSync(this.ticksFile, JSON.stringify(record) + '\n');
      }
    }
  }
}

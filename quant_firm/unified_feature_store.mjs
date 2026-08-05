import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';

/**
 * UNIFIED FEATURE STORE & TIME-SERIES DB (SQLite-backed)
 * Ingests live market prices, L2 depth, AND multi-agent signals (News, Social, Whale Flow).
 * Provides multi-feature time-series rows for LLM strategies and ML backtesting.
 *
 * Storage: SQLite database at <cwd>/data/quant_firm.db
 * Schema:   market_ticks (timestamp, market_address, question, yes_prob, no_prob,
 *                         news_sentiment, whale_flow, category)
 */
export class UnifiedFeatureStore {
  constructor(dbPath = path.join(process.cwd(), 'data', 'quant_firm.db')) {
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS market_ticks (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp       INTEGER NOT NULL,
        iso_time        TEXT    NOT NULL,
        market_address  TEXT    NOT NULL,
        question        TEXT    NOT NULL,
        yes_prob        REAL    NOT NULL,
        no_prob         REAL    NOT NULL,
        news_sentiment  REAL    NOT NULL DEFAULT 0.5,
        whale_flow      REAL    NOT NULL DEFAULT 0,
        category        TEXT    NOT NULL DEFAULT 'miscellaneous'
      );
      CREATE INDEX IF NOT EXISTS idx_ticks_market ON market_ticks (market_address);
      CREATE INDEX IF NOT EXISTS idx_ticks_time   ON market_ticks (timestamp);
    `);

    this._insert = this.db.prepare(`
      INSERT INTO market_ticks
        (timestamp, iso_time, market_address, question, yes_prob, no_prob, news_sentiment, whale_flow, category)
      VALUES
        (@timestamp, @iso_time, @market_address, @question, @yes_prob, @no_prob, @news_sentiment, @whale_flow, @category)
    `);
  }

  recordSnapshot(marketAddress, question, spotProbs, newsSentiment, whaleFlow, category) {
    const now = Date.now();
    const row = {
      timestamp:      now,
      iso_time:       new Date(now).toISOString(),
      market_address: marketAddress,
      question,
      yes_prob:       spotProbs[0],
      no_prob:        spotProbs[1] ?? (1 - spotProbs[0]),
      news_sentiment: newsSentiment,
      whale_flow:     whaleFlow,
      category:       category || 'miscellaneous',
    };
    this._insert.run(row);
    // Return in the shape the rest of the codebase expects
    return {
      timestamp:     now,
      isoTime:       row.iso_time,
      marketAddress: row.market_address,
      question,
      spotProbs:     [row.yes_prob, row.no_prob],
      newsSentiment: row.news_sentiment,
      whaleFlow:     row.whale_flow,
      category:      row.category,
    };
  }

  getHistoricalRecords(limit = 5000) {
    const rows = this.db
      .prepare(`SELECT * FROM market_ticks ORDER BY timestamp ASC LIMIT ?`)
      .all(limit);
    return rows.map(r => ({
      timestamp:     r.timestamp,
      isoTime:       r.iso_time,
      marketAddress: r.market_address,
      question:      r.question,
      spotProbs:     [r.yes_prob, r.no_prob],
      newsSentiment: r.news_sentiment,
      whaleFlow:     r.whale_flow,
      category:      r.category,
    }));
  }

  getTickCount() {
    return this.db.prepare('SELECT COUNT(*) AS cnt FROM market_ticks').get().cnt;
  }

  seedMultiFeatureDataIfEmpty() {
    if (this.getTickCount() >= 100) return;

    console.log('[Unified FeatureStore] Seeding SQLite DB with synthetic multi-feature data...');
    const dummyMarkets = [
      { id: '0x0caf7045b341f80c64261ce34fd0f20983e56031', q: 'Will the German Chancellor resign?', cat: 'politics' },
      { id: '0x81ac3d48ac99952f4867f6bc21624efccdc3817e', q: 'Will WHO declare a new pandemic?', cat: 'miscellaneous' },
      { id: '0xa14c439840984818691a82cb0465f801eeb3b450', q: 'Will BTC reach $100k in 2025?', cat: 'crypto' },
    ];

    const insertMany = this.db.transaction((rows) => {
      for (const r of rows) this._insert.run(r);
    });

    const rows = [];
    const baseTime = Date.now() - (300 * 60 * 1000); // 300 minutes of history
    for (let i = 0; i < 300; i++) {
      for (const m of dummyMarkets) {
        const trend = Math.sin(i / 12) * 0.15;
        const yesProb = Math.max(0.05, Math.min(0.95, 0.50 + trend + (Math.random() * 0.04 - 0.02)));
        const ts = baseTime + i * 60_000;
        rows.push({
          timestamp:      ts,
          iso_time:       new Date(ts).toISOString(),
          market_address: m.id,
          question:       m.q,
          yes_prob:       yesProb,
          no_prob:        1 - yesProb,
          news_sentiment: Math.max(0, Math.min(1, 0.50 + trend * 0.8 + (Math.random() * 0.1 - 0.05))),
          whale_flow:     Math.random() > 0.8 ? Math.round(Math.random() * 50) : 0,
          category:       m.cat,
        });
      }
    }
    insertMany(rows);
    console.log(`[Unified FeatureStore] Seeded ${rows.length} ticks into SQLite.`);
  }
}

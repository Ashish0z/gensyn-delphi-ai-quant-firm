import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';

/**
 * Shared SQLite database singleton.
 * Tables:
 *   trade_log    – every executed trade
 *   voter_stats  – persistent voter strategy performance tracking
 *   rl_policy    – serialised RL policy JSON (single-row key-value)
 */

const DB_PATH = path.join(process.cwd(), 'data', 'quant_firm.db');

let _db = null;

export function getDb() {
  if (_db) return _db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS trade_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp     TEXT    NOT NULL,
      market        TEXT    NOT NULL,
      question      TEXT    NOT NULL,
      voter         TEXT    NOT NULL,
      vote          TEXT    NOT NULL,
      outcome_idx   INTEGER NOT NULL,
      outcome_label TEXT    NOT NULL,
      shares_num    REAL    NOT NULL,
      edge          REAL    NOT NULL,
      risk_reason   TEXT,
      tx_hash       TEXT
    );

    CREATE TABLE IF NOT EXISTS voter_stats (
      name           TEXT PRIMARY KEY,
      promoted_at    TEXT NOT NULL,
      cycles_active  INTEGER NOT NULL DEFAULT 0,
      total_trades   INTEGER NOT NULL DEFAULT 0,
      wins           INTEGER NOT NULL DEFAULT 0,
      realized_pnl   REAL    NOT NULL DEFAULT 0.0,
      sharpe_ratio   REAL    NOT NULL DEFAULT 0.0,
      win_rate       REAL    NOT NULL DEFAULT 50.0,
      status         TEXT    NOT NULL DEFAULT 'ACTIVE'
    );

    CREATE TABLE IF NOT EXISTS rl_policy (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  return _db;
}

/* ── Trade log helpers ── */

export function appendTrade(entry) {
  getDb().prepare(`
    INSERT INTO trade_log
      (timestamp, market, question, voter, vote, outcome_idx, outcome_label, shares_num, edge, risk_reason, tx_hash)
    VALUES
      (@timestamp, @market, @question, @voter, @vote, @outcome_idx, @outcome_label, @shares_num, @edge, @risk_reason, @tx_hash)
  `).run(entry);
}

export function getRecentTrades(limit = 200) {
  return getDb()
    .prepare('SELECT * FROM trade_log ORDER BY id DESC LIMIT ?')
    .all(limit);
}

export function getTradePnlSince(isoTimestamp) {
  // Returns sum of realized pnl for trades after the given timestamp.
  // We don't store pnl directly at insert time; callers must update or track separately.
  return getDb()
    .prepare(`SELECT COUNT(*) AS cnt FROM trade_log WHERE timestamp >= ?`)
    .get(isoTimestamp);
}

/* ── Voter stats helpers ── */

export function upsertVoterStats(name, sharpeRatio, winRate) {
  const existing = getDb().prepare('SELECT * FROM voter_stats WHERE name = ?').get(name);
  if (!existing) {
    getDb().prepare(`
      INSERT INTO voter_stats (name, promoted_at, sharpe_ratio, win_rate)
      VALUES (?, ?, ?, ?)
    `).run(name, new Date().toISOString(), sharpeRatio, winRate);
  } else {
    getDb().prepare(`
      UPDATE voter_stats
      SET cycles_active = cycles_active + 1,
          sharpe_ratio  = ?,
          win_rate      = ?
      WHERE name = ?
    `).run(sharpeRatio, winRate, name);
  }
}

export function incrementVoterTrades(name, isWin = false) {
  getDb().prepare(`
    UPDATE voter_stats
    SET total_trades = total_trades + 1,
        wins         = wins + ?
    WHERE name = ?
  `).run(isWin ? 1 : 0, name);
}

export function getVoterStats(name) {
  return getDb().prepare('SELECT * FROM voter_stats WHERE name = ?').get(name);
}

export function getAllVoterStats() {
  return getDb().prepare('SELECT * FROM voter_stats ORDER BY sharpe_ratio DESC').all();
}

export function setVoterStatus(name, status) {
  getDb().prepare('UPDATE voter_stats SET status = ? WHERE name = ?').run(status, name);
}

import { EventEmitter } from 'events';
import { getDb } from '../quant_firm/db.mjs';

/**
 * Event Bus — in-process EventEmitter with optional Redis pub/sub backend.
 *
 * When REDIS_URL is set in the environment, events are published to Redis so that
 * separate Node.js processes (or future containerised microservices) can subscribe.
 * Without Redis the bus is purely in-process, which is sufficient for the default
 * single-machine daemon deployment.
 *
 * Events are always persisted to the SQLite `event_log` table for observability.
 */
export class DistributedEventBus extends EventEmitter {
  constructor() {
    super();
    this._ensureTable();
    this._redisPublisher = null;
    this._redisSubscriber = null;
    this._initRedis(); // async – does nothing if REDIS_URL is unset
  }

  _ensureTable() {
    try {
      getDb().exec(`
        CREATE TABLE IF NOT EXISTS event_log (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT    NOT NULL,
          type      TEXT    NOT NULL,
          payload   TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_event_log_type ON event_log (type);
      `);
    } catch (_) {}
  }

  async _initRedis() {
    const url = process.env.REDIS_URL;
    if (!url) return;
    try {
      // Dynamic import so the module is not required when Redis is not used.
      const { createClient } = await import('redis');
      this._redisPublisher = createClient({ url });
      this._redisSubscriber = createClient({ url });
      await this._redisPublisher.connect();
      await this._redisSubscriber.connect();

      // Forward any Redis message back into the in-process EventEmitter so
      // locally-attached listeners also fire.
      await this._redisSubscriber.pSubscribe('delphi:*', (message, channel) => {
        try {
          const event = JSON.parse(message);
          // Avoid re-emitting events we published ourselves (simple source check)
          if (event._origin !== process.pid) {
            super.emit(event.type, event.payload);
            super.emit('*', event);
          }
        } catch (_) {}
      });

      console.log(`[EventBus] Redis pub/sub connected (${url})`);
    } catch (err) {
      console.warn(`[EventBus] Redis unavailable – falling back to in-process bus. (${err.message})`);
      this._redisPublisher = null;
      this._redisSubscriber = null;
    }
  }

  publish(eventType, payload) {
    const event = {
      timestamp: new Date().toISOString(),
      type:      eventType,
      payload,
      _origin:   process.pid,
    };

    // 1. Persist to SQLite
    try {
      getDb().prepare(
        'INSERT INTO event_log (timestamp, type, payload) VALUES (?, ?, ?)'
      ).run(event.timestamp, eventType, JSON.stringify(payload));
    } catch (_) {}

    // 2. Publish to Redis (fire-and-forget)
    if (this._redisPublisher) {
      this._redisPublisher
        .publish(`delphi:${eventType}`, JSON.stringify(event))
        .catch(() => {});
    }

    // 3. Emit in-process
    this.emit(eventType, payload);
    this.emit('*', event);
  }
}

export const globalBus = new DistributedEventBus();

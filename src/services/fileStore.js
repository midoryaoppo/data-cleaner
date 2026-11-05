'use strict';

const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const { gzip, gunzip } = require('node:zlib');
const config = require('../config');
const database = require('../db/database');

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

class MemoryFileStore {
  constructor({
    ttlMs = config.fileTtlMs,
    maxEntries = config.maxStoredFiles,
    sweepMs = 60_000,
  } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.timer = setInterval(() => {
      this.sweep().catch(() => {
        /* Memory sweep cannot fail. */
      });
    }, sweepMs);
    this.timer.unref?.();
  }

  async put(value) {
    const id = randomUUID();
    const now = Date.now();
    this.entries.set(id, {
      ...value,
      id,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    });
    await this.enforceLimit();
    return id;
  }

  async get(id) {
    if (typeof id !== 'string') return null;
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(id);
      return null;
    }
    return entry;
  }

  async delete(id) {
    this.entries.delete(id);
  }

  async sweep() {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }

  async enforceLimit() {
    while (this.entries.size > this.maxEntries) {
      const oldestId = this.entries.keys().next().value;
      this.entries.delete(oldestId);
    }
  }

  async health() {
    return {
      ready: true,
      driver: 'memory',
      entries: this.entries.size,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
      message: 'Files are stored in memory and expire after the configured TTL.',
    };
  }

  async clear() {
    this.entries.clear();
  }

  async close() {
    clearInterval(this.timer);
  }

  get size() {
    return this.entries.size;
  }
}

class PostgresFileStore {
  constructor({
    ttlMs = config.fileTtlMs,
    maxEntries = config.maxStoredFiles,
    sweepMs = 60_000,
    db = database,
  } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.db = db;
    this.timer = setInterval(() => {
      this.sweep().catch((error) => {
        console.error('[tidydata] Could not purge expired files:', error.message);
      });
    }, sweepMs);
    this.timer.unref?.();
  }

  async put(value) {
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + this.ttlMs);
    const payload = await gzipAsync(
      Buffer.from(
        JSON.stringify({
          headers: value.dataset.headers,
          rows: value.dataset.rows,
        }),
        'utf8',
      ),
    );

    await this.db.query(
      `INSERT INTO files (id, kind, source_id, name, format, size, payload, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        value.kind,
        value.sourceId || null,
        value.name,
        value.format,
        value.size,
        payload,
        expiresAt,
      ],
    );

    await this.enforceLimit();
    return id;
  }

  async get(id) {
    if (!isUuid(id)) return null;
    const { rows } = await this.db.query(
      `SELECT id, kind, source_id, name, format, size, payload, created_at, expires_at
       FROM files
       WHERE id = $1 AND expires_at > now()`,
      [id],
    );
    if (rows.length === 0) return null;

    const row = rows[0];
    const dataset = JSON.parse((await gunzipAsync(row.payload)).toString('utf8'));
    return {
      id: row.id,
      kind: row.kind,
      sourceId: row.source_id,
      name: row.name,
      format: row.format,
      size: row.size,
      dataset,
      createdAt: new Date(row.created_at).getTime(),
      expiresAt: new Date(row.expires_at).getTime(),
    };
  }

  async delete(id) {
    if (!isUuid(id)) return;
    await this.db.query('DELETE FROM files WHERE id = $1', [id]);
  }

  async sweep() {
    await this.db.query('DELETE FROM files WHERE expires_at <= now()');
  }

  async enforceLimit() {
    await this.db.query(
      `DELETE FROM files WHERE id IN (
         SELECT id FROM files ORDER BY created_at DESC OFFSET $1::int
       )`,
      [this.maxEntries],
    );
  }

  async health() {
    try {
      const { rows } = await this.db.query(
        'SELECT count(*)::int AS count FROM files WHERE expires_at > now()',
      );
      return {
        ready: true,
        driver: 'postgres',
        entries: rows[0].count,
        maxEntries: this.maxEntries,
        ttlMs: this.ttlMs,
        message: 'Files are stored in PostgreSQL and expire after the configured TTL.',
      };
    } catch (error) {
      return {
        ready: false,
        driver: 'postgres',
        entries: null,
        maxEntries: this.maxEntries,
        ttlMs: this.ttlMs,
        message: error.message,
      };
    }
  }

  async clear() {
    await this.db.query('DELETE FROM files');
  }

  async close() {
    clearInterval(this.timer);
  }
}

const fileStore = database.isEnabled()
  ? new PostgresFileStore()
  : new MemoryFileStore();

module.exports = { fileStore, MemoryFileStore, PostgresFileStore, isUuid };

'use strict';

const { randomUUID } = require('node:crypto');
const config = require('../config');

/**
 * Small, expiring, in-memory store for parsed and cleaned datasets.
 * Nothing is written to disk; entries are purged after the configured TTL.
 */
class FileStore {
  constructor({ ttlMs = config.fileTtlMs, maxEntries = config.maxStoredFiles, sweepMs = 60_000 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.timer = setInterval(() => this.sweep(), sweepMs);
    this.timer.unref?.();
  }

  put(value) {
    const id = randomUUID();
    const now = Date.now();
    this.entries.set(id, {
      ...value,
      id,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    });
    this.enforceLimit();
    return id;
  }

  get(id) {
    if (typeof id !== 'string') return null;
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(id);
      return null;
    }
    return entry;
  }

  delete(id) {
    return this.entries.delete(id);
  }

  sweep() {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }

  enforceLimit() {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
    }
  }

  clear() {
    this.entries.clear();
  }

  health() {
    return {
      ready: this.entries instanceof Map,
      driver: 'memory',
      entries: this.size,
      maxEntries: this.maxEntries,
      ttlMinutes: Math.round(this.ttlMs / 60_000),
    };
  }

  close() {
    clearInterval(this.timer);
  }

  get size() {
    return this.entries.size;
  }
}

module.exports = { FileStore, fileStore: new FileStore() };

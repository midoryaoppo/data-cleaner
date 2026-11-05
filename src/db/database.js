'use strict';

const { Pool } = require('pg');
const config = require('../config');

let pool = null;
let lastError = null;
let lastCheckedAt = null;
let lastLatencyMs = null;

function isEnabled() {
  return Boolean(config.database.url);
}

function getPool() {
  if (!isEnabled()) return null;
  if (pool) return pool;

  pool = new Pool({
    connectionString: config.database.url,
    max: config.database.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'tidydata',
    ...(config.database.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  pool.on('error', (error) => {
    lastError = error;
    console.error('[tidydata] Unexpected PostgreSQL pool error:', error.message);
  });

  return pool;
}

async function query(text, params) {
  const activePool = getPool();
  if (!activePool) {
    throw new Error('DATABASE_URL is not configured.');
  }
  return activePool.query(text, params);
}

async function withTransaction(callback) {
  const activePool = getPool();
  if (!activePool) {
    throw new Error('DATABASE_URL is not configured.');
  }

  const client = await activePool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[tidydata] PostgreSQL rollback failed:', rollbackError.message);
    }
    throw error;
  } finally {
    client.release();
  }
}

async function health() {
  if (!isEnabled()) {
    return {
      configured: false,
      required: config.database.required,
      ready: null,
      status: 'not_configured',
      driver: 'none',
      message: 'DATABASE_URL is not configured; the in-memory stores are in use.',
    };
  }

  const startedAt = Date.now();
  try {
    await query('SELECT 1');
    lastError = null;
    lastLatencyMs = Date.now() - startedAt;
    lastCheckedAt = new Date().toISOString();
    return {
      configured: true,
      required: config.database.required,
      ready: true,
      status: 'ready',
      driver: 'postgres',
      latencyMs: lastLatencyMs,
      checkedAt: lastCheckedAt,
      message: 'PostgreSQL connection is healthy.',
    };
  } catch (error) {
    lastError = error;
    lastLatencyMs = Date.now() - startedAt;
    lastCheckedAt = new Date().toISOString();
    return {
      configured: true,
      required: config.database.required,
      ready: false,
      status: 'error',
      driver: 'postgres',
      latencyMs: lastLatencyMs,
      checkedAt: lastCheckedAt,
      message: error.message,
    };
  }
}

async function close() {
  if (!pool) return;
  const activePool = pool;
  pool = null;
  await activePool.end();
}

function status() {
  return {
    configured: isEnabled(),
    required: config.database.required,
    poolMax: config.database.poolMax,
    ssl: config.database.ssl,
    lastError: lastError ? lastError.message : null,
    lastCheckedAt,
    lastLatencyMs,
  };
}

module.exports = {
  close,
  getPool,
  health,
  isEnabled,
  query,
  status,
  withTransaction,
};

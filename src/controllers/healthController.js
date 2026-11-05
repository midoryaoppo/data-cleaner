'use strict';

const pkg = require('../../package.json');
const config = require('../config');
const database = require('../db/database');
const { fileStore } = require('../services/fileStore');
const { billingStore } = require('../services/billingStore');

function bytes(value) {
  return {
    bytes: value,
    megabytes: Number((value / (1024 * 1024)).toFixed(2)),
  };
}

function formatUptime(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const parts = [];

  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);
  parts.push(`${seconds % 60}s`);
  return parts.join(' ');
}

async function health(req, res) {
  const [fileStoreHealth, billingStoreHealth, databaseHealth] = await Promise.all([
    fileStore.health(),
    billingStore.health(),
    database.health(),
  ]);
  const databaseReady = databaseHealth.ready === null ? true : databaseHealth.ready;
  const storesReady = Boolean(
    fileStoreHealth.ready && billingStoreHealth.ready && databaseReady,
  );
  const usage = process.memoryUsage();
  const uptimeSeconds = Math.round(process.uptime());

  const body = {
    status: storesReady ? 'ok' : 'degraded',
    service: 'tidydata',
    name: 'tidydata',
    version: pkg.version,
    environment: config.env,
    pid: process.pid,
    node: process.version,
    timestamp: new Date().toISOString(),
    startedAt: new Date(Date.now() - uptimeSeconds * 1000).toISOString(),
    uptimeSeconds,
    uptime: formatUptime(uptimeSeconds),
    memory: {
      rss: bytes(usage.rss),
      heapTotal: bytes(usage.heapTotal),
      heapUsed: bytes(usage.heapUsed),
      external: bytes(usage.external),
      arrayBuffers: bytes(usage.arrayBuffers),
      heapUsedPercent:
        usage.heapTotal > 0
          ? Number(((usage.heapUsed / usage.heapTotal) * 100).toFixed(1))
          : 0,
    },
    stores: {
      ready: storesReady,
      persistence: config.database.enabled ? 'postgres' : 'in-memory',
      fileStore: fileStoreHealth,
      billingStore: billingStoreHealth,
      database: databaseHealth,
    },
  };

  res.status(storesReady ? 200 : 503).set('Cache-Control', 'no-store').json(body);
}

module.exports = { health };

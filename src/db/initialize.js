'use strict';

const config = require('../config');
const database = require('./database');
const { migrate } = require('./migrate');

async function initializeDatabase() {
  if (!database.isEnabled()) {
    if (config.isProduction) {
      throw new Error(
        'DATABASE_URL is required in production. Create a PostgreSQL database and set DATABASE_URL before starting TidyData.',
      );
    }
    console.warn(
      '[tidydata] DATABASE_URL is not set. Using in-memory stores; files and purchases will be lost on restart.',
    );
    return { mode: 'memory', migrations: { applied: [], skipped: true } };
  }

  const migrations = config.database.autoMigrate
    ? await migrate()
    : { applied: [], skipped: true, reason: 'AUTO_MIGRATE=false' };

  const health = await database.health();
  if (!health.ready) {
    throw new Error(`PostgreSQL is not ready: ${health.message}`);
  }

  return { mode: 'postgres', migrations };
}

module.exports = { initializeDatabase };

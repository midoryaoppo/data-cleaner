'use strict';

const app = require('./src/app');
const config = require('./src/config');
const database = require('./src/db/database');
const { initializeDatabase } = require('./src/db/initialize');
const { fileStore } = require('./src/services/fileStore');

let server = null;
let shuttingDown = false;

async function closeStores() {
  await Promise.allSettled([fileStore.close(), database.close()]);
}

async function start() {
  const initialization = await initializeDatabase();
  if (initialization.mode === 'postgres') {
    const applied = initialization.migrations.applied;
    console.log(
      `[tidydata] PostgreSQL ready${applied.length ? ` (${applied.length} migration(s) applied)` : ''}.`,
    );
  }

  server = app.listen(config.port, config.host, () => {
    const shownHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
    console.log('');
    console.log('  TidyData is running');
    console.log(`  http://${shownHost}:${config.port}`);
    console.log(
      `  Environment: ${config.env} | Max upload: ${config.maxFileSizeMb} MB | Persistence: ${config.database.enabled ? 'postgres' : 'memory'}`,
    );
    console.log('');
  });

  // Behind managed reverse proxies, keep idle sockets alive long enough for the
  // platform health checks and rolling deploys to reuse connections safely.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  server.on('error', async (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${config.port} is already in use. Set PORT to another value in .env.`);
    } else {
      console.error('Could not start the server:', error);
    }
    await closeStores();
    process.exit(1);
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}. Closing TidyData...`);

  const finish = () => {
    closeStores().finally(() => process.exit(0));
  };

  if (!server) {
    finish();
    return;
  }

  server.close(finish);
  // Release keep-alive connections so the platform can complete the deploy
  // immediately instead of waiting for idle sockets to time out.
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch(async (error) => {
  console.error('[tidydata] Could not start the server:', error.message);
  if (error.stack) console.error(error.stack);
  await closeStores();
  process.exit(1);
});

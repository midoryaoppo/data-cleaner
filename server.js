'use strict';

const app = require('./src/app');
const config = require('./src/config');
const { fileStore } = require('./src/services/fileStore');

const server = app.listen(config.port, config.host, () => {
  const shownHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log('');
  console.log('  TidyData is running');
  console.log(`  http://${shownHost}:${config.port}`);
  console.log(`  Environment: ${config.env} | Max upload: ${config.maxFileSizeMb} MB`);
  console.log('');
});

// Behind managed reverse proxies, keep idle sockets alive long enough for the
// platform health checks and rolling deploys to reuse connections safely.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Set PORT to another value in .env.`);
  } else {
    console.error('Could not start the server:', error);
  }
  process.exitCode = 1;
});

function shutdown(signal) {
  console.log(`\nReceived ${signal}. Closing TidyData...`);
  server.close(() => {
    fileStore.close();
    process.exit(0);
  });
  // Release keep-alive connections so the platform can complete the deploy
  // immediately instead of waiting for idle sockets to time out.
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

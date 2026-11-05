'use strict';

const database = require('../src/db/database');
const { migrate } = require('../src/db/migrate');

async function main() {
  if (!database.isEnabled()) {
    throw new Error('DATABASE_URL is required to run migrations.');
  }

  const result = await migrate();
  if (result.applied.length === 0) {
    console.log('[tidydata] Database is up to date; no migrations applied.');
  } else {
    console.log(`[tidydata] Applied ${result.applied.length} migration(s).`);
  }
}

main()
  .catch((error) => {
    console.error('[tidydata] Database migration failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await database.close();
  });

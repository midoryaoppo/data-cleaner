'use strict';

const fs = require('node:fs');
const path = require('node:path');
const database = require('./database');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'db', 'migrations');
const MIGRATION_LOCK_KEY = 72_431_031;

function migrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

async function migrate() {
  if (!database.isEnabled()) {
    return { applied: [], skipped: true, reason: 'DATABASE_URL is not configured.' };
  }

  const pool = database.getPool();
  const client = await pool.connect();
  const applied = [];

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const alreadyApplied = new Set(rows.map((row) => row.name));

    for (const file of migrationFiles()) {
      if (alreadyApplied.has(file)) continue;

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        console.log(`[tidydata] Applied database migration: ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Database migration ${file} failed: ${error.message}`, {
          cause: error,
        });
      }
    }

    return { applied, skipped: false };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } catch (error) {
      console.error('[tidydata] Could not release migration lock:', error.message);
    }
    client.release();
  }
}

module.exports = { migrate, migrationFiles };

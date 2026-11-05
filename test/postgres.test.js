'use strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';

const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { PostgresBillingStore } = require('../src/services/billingStore');
const { PostgresFileStore } = require('../src/services/fileStore');

let pg;
let db;
let billingStore;
let fileStore;

before(async () => {
  pg = new PGlite();
  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '001_initial.sql'),
    'utf8',
  );
  await pg.exec(migration);

  // PGlite implements the node-postgres query shape, but reports affected rows
  // as `affectedRows` rather than `rowCount`. Normalize that for the stores.
  db = {
    query: async (text, params) => {
      const result = await pg.query(text, params);
      return {
        ...result,
        rowCount: result.rowCount ?? result.affectedRows ?? 0,
      };
    },
  };

  billingStore = new PostgresBillingStore({ db });
  fileStore = new PostgresFileStore({ db, sweepMs: 60_000 });
});

after(async () => {
  await fileStore.close();
  await billingStore.close();
  await pg.close();
});

test('persists single-pass credits and monthly subscription entitlements', async () => {
  const single = await billingStore.create({ plan: 'single', sessionId: 'cs_pg_single' });
  assert.match(single.id, /^[0-9a-f-]{36}$/i);
  assert.equal(single.plan, 'single');
  assert.equal(single.status, 'active');
  assert.equal(single.remainingExports, 1);

  const sameSession = await billingStore.create({ plan: 'single', sessionId: 'cs_pg_single' });
  assert.equal(sameSession.id, single.id);

  const consumed = await billingStore.consumeExport(single.id);
  assert.equal(consumed.remainingExports, 0);
  assert.equal((await billingStore.consumeExport(single.id)).remainingExports, 0);

  const monthly = await billingStore.create({
    plan: 'monthly',
    sessionId: 'cs_pg_monthly',
    subscriptionId: 'sub_pg_monthly',
    stripeCustomerId: 'cus_pg_customer',
    customerEmail: 'buyer@example.com',
  });
  assert.equal(monthly.remainingExports, null);
  assert.equal(monthly.stripeCustomerId, 'cus_pg_customer');
  assert.equal(monthly.customerEmail, 'buyer@example.com');

  const duplicateSubscription = await billingStore.create({
    plan: 'monthly',
    sessionId: 'cs_pg_monthly_retry',
    subscriptionId: 'sub_pg_monthly',
  });
  assert.equal(duplicateSubscription.id, monthly.id);

  assert.equal((await billingStore.getBySubscription('sub_pg_monthly')).id, monthly.id);

  const beforeRenewal = (await billingStore.get(monthly.id)).expiresAt;
  assert.equal(await billingStore.extendSubscription('sub_pg_monthly'), true);
  assert.ok((await billingStore.get(monthly.id)).expiresAt > beforeRenewal);

  assert.equal(await billingStore.revokeBySubscription('sub_pg_monthly'), true);
  assert.equal(await billingStore.get(monthly.id), null);
  assert.equal(await billingStore.extendSubscription('sub_pg_monthly'), false);

  const health = await billingStore.health();
  assert.equal(health.ready, true);
  assert.equal(health.driver, 'postgres');
  assert.ok(health.entitlements >= 1);
});

test('claims webhook events atomically and releases failed claims', async () => {
  assert.equal(await billingStore.claimEvent('evt_pg_claim'), true);
  assert.equal(await billingStore.claimEvent('evt_pg_claim'), false);
  assert.equal(await billingStore.hasProcessedEvent('evt_pg_claim'), true);

  await billingStore.releaseEvent('evt_pg_claim');
  assert.equal(await billingStore.hasProcessedEvent('evt_pg_claim'), false);
  assert.equal(await billingStore.claimEvent('evt_pg_claim'), true);
});

test('round-trips gzipped datasets through the files table and enforces TTL', async () => {
  const id = await fileStore.put({
    kind: 'source',
    name: 'people.csv',
    format: 'csv',
    size: 24,
    dataset: {
      headers: ['name', 'age'],
      rows: [
        ['Alice', 30],
        ['Bob', 31],
      ],
    },
  });

  const entry = await fileStore.get(id);
  assert.equal(entry.kind, 'source');
  assert.equal(entry.name, 'people.csv');
  assert.deepEqual(entry.dataset.headers, ['name', 'age']);
  assert.deepEqual(entry.dataset.rows, [
    ['Alice', 30],
    ['Bob', 31],
  ]);

  const health = await fileStore.health();
  assert.equal(health.ready, true);
  assert.equal(health.driver, 'postgres');
  assert.ok(health.entries >= 1);

  await fileStore.delete(id);
  assert.equal(await fileStore.get(id), null);

  const expiringStore = new PostgresFileStore({ db, ttlMs: 25, sweepMs: 60_000 });
  try {
    const expiringId = await expiringStore.put({
      kind: 'cleaned',
      name: 'short.csv',
      format: 'csv',
      size: 2,
      dataset: { headers: ['a'], rows: [[1]] },
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(await expiringStore.get(expiringId), null);
  } finally {
    await expiringStore.close();
  }
});

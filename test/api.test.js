'use strict';

process.env.DATABASE_URL = '';

const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');
const config = require('../src/config');
const { fileStore } = require('../src/services/fileStore');
const { billingStore } = require('../src/services/billingStore');

let server;
let baseUrl;
const samplePath = path.join(__dirname, '..', 'src', 'fixtures', 'sample.csv');

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fileStore.close();
});

async function uploadSample() {
  const form = new FormData();
  const file = fs.readFileSync(samplePath);
  form.append('file', new Blob([file], { type: 'text/csv' }), 'sample.csv');
  const response = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: form });
  const payload = await response.json();
  assert.equal(response.status, 201);
  return payload.file;
}

test('serves the app shell and a health check', async () => {
  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /TidyData/);

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  const payload = await health.json();
  assert.equal(payload.status, 'ok');
});

test('reports memory, uptime, and store readiness from both health routes', async () => {
  for (const route of ['/health', '/api/health']) {
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const payload = await response.json();
    assert.equal(payload.status, 'ok');
    assert.equal(payload.service, 'tidydata');
    assert.equal(payload.environment, config.env);
    assert.equal(typeof payload.pid, 'number');
    assert.match(payload.node, /^v\d+\./);
    assert.ok(payload.uptimeSeconds >= 0);
    assert.match(payload.uptime, /\d+s$/);
    assert.ok(!Number.isNaN(Date.parse(payload.timestamp)));
    assert.ok(!Number.isNaN(Date.parse(payload.startedAt)));

    for (const key of ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers']) {
      assert.equal(typeof payload.memory[key].bytes, 'number');
      assert.equal(typeof payload.memory[key].megabytes, 'number');
    }
    assert.ok(payload.memory.rss.bytes > 0);
    assert.ok(payload.memory.heapTotal.bytes > 0);
    assert.ok(payload.memory.heapUsedPercent >= 0);

    assert.equal(payload.stores.ready, true);
    assert.equal(payload.stores.persistence, 'in-memory');
    assert.equal(payload.stores.fileStore.ready, true);
    assert.equal(payload.stores.fileStore.driver, 'memory');
    assert.equal(payload.stores.billingStore.ready, true);
    assert.equal(payload.stores.billingStore.driver, 'memory');
    assert.equal(payload.stores.database.configured, false);
    assert.equal(payload.stores.database.required, false);
    assert.equal(payload.stores.database.ready, null);
    assert.equal(payload.stores.database.status, 'not_configured');
    assert.equal(payload.stores.database.driver, 'none');
  }
});

test('returns 503 and degraded status when a store is unavailable', async () => {
  const originalHealth = billingStore.health;
  billingStore.health = async () => ({ ready: false, driver: 'memory' });

  try {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const payload = await response.json();
    assert.equal(payload.status, 'degraded');
    assert.equal(payload.stores.ready, false);
    assert.equal(payload.stores.billingStore.ready, false);
  } finally {
    billingStore.health = originalHealth;
  }
});

test('allows configured CORS origins and omits headers for unknown origins', async () => {
  const allowedOrigin = new URL(config.appUrl).origin;
  assert.ok(config.corsOrigins.includes(allowedOrigin));

  const allowed = await fetch(`${baseUrl}/api/health`, {
    headers: { Origin: allowedOrigin },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), allowedOrigin);
  assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');

  const denied = await fetch(`${baseUrl}/api/health`, {
    headers: { Origin: 'https://not-allowed.invalid' },
  });
  assert.equal(denied.status, 200);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);

  const preflight = await fetch(`${baseUrl}/api/health`, {
    method: 'OPTIONS',
    headers: {
      Origin: allowedOrigin,
      'Access-Control-Request-Method': 'GET',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), allowedOrigin);
  assert.match(preflight.headers.get('access-control-allow-methods'), /GET/);

  const deniedPreflight = await fetch(`${baseUrl}/api/health`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://not-allowed.invalid',
      'Access-Control-Request-Method': 'GET',
    },
  });
  assert.equal(deniedPreflight.headers.get('access-control-allow-origin'), null);
});

test('uploads, previews, cleans, and downloads the sample end to end', async () => {
  const file = await uploadSample();
  assert.equal(file.rowCount, 15);
  assert.equal(file.columnCount, 11);
  assert.equal(file.truncated, false);
  assert.ok(file.headers.includes('Full Name'));
  assert.ok(file.id);

  const cleanResponse = await fetch(`${baseUrl}/api/clean`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId: file.id, options: {} }),
  });
  const cleanPayload = await cleanResponse.json();
  assert.equal(cleanResponse.status, 200);

  const cleaned = cleanPayload.cleaned;
  assert.equal(cleaned.stats.rowsIn, 15);
  assert.equal(cleaned.stats.rowsOut, 12);
  assert.equal(cleaned.stats.duplicatesRemoved, 2);
  assert.equal(cleaned.stats.emptyRowsRemoved, 1);
  assert.equal(cleaned.stats.emptyColumnsDropped, 1);
  assert.deepEqual(cleaned.headers.slice(0, 3), ['id', 'full_name', 'e_mail']);
  assert.equal(cleaned.rows[0][1], 'Alice Johnson');
  assert.equal(cleaned.rows[0][5], true);
  assert.equal(cleaned.rows[0][7], 1234.5);
  assert.equal(cleaned.rows[0][8], 'VIP');
  assert.ok(cleaned.expiresAt > Date.now());

  const csvResponse = await fetch(`${baseUrl}/api/download/${cleaned.id}?format=csv`);
  assert.equal(csvResponse.status, 200);
  assert.match(csvResponse.headers.get('content-type'), /text\/csv/);
  assert.match(csvResponse.headers.get('content-disposition'), /attachment; filename="sample-cleaned\.csv"/);
  const csvBytes = Buffer.from(await csvResponse.arrayBuffer());
  assert.deepEqual([...csvBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const csv = csvBytes.toString('utf8');
  assert.ok(csv.startsWith('\uFEFFid,full_name,e_mail'));
  assert.ok(csv.includes('\n1,Alice Johnson,alice@example.com,29,New York,true,2024-01-15,1234.5,VIP,A-001'));

  const jsonResponse = await fetch(`${baseUrl}/api/download/${cleaned.id}?format=json`);
  assert.equal(jsonResponse.status, 200);
  const json = await jsonResponse.json();
  assert.equal(json.length, 12);
  assert.equal(json[0].full_name, 'Alice Johnson');
  assert.equal(json[0].subscribed, true);
  assert.equal(json[0].score, 1234.5);
  assert.equal(json[0].signup_date, '2024-01-15');
});

test('applies custom options and single-column deduplication', async () => {
  const file = await uploadSample();
  const response = await fetch(`${baseUrl}/api/clean`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileId: file.id,
      options: {
        dedupeColumn: 2,
        removeEmptyRows: false,
        dropEmptyColumns: false,
        normalizeHeaders: false,
        normalizeDates: false,
        emptyToNull: false,
      },
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.ok(payload.cleaned.headers.includes('E-mail'));
  assert.equal(payload.cleaned.stats.emptyRowsRemoved, 0);
  assert.ok(payload.cleaned.stats.duplicatesRemoved >= 0);
});

test('validates requests and cleans up stored files', async () => {
  const missing = await fetch(`${baseUrl}/api/clean`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, 'MISSING_FILE_ID');

  const invalidFormat = await fetch(`${baseUrl}/api/download/not-a-real-file?format=csv`);
  assert.equal(invalidFormat.status, 404);

  const file = await uploadSample();
  const cleanResponse = await fetch(`${baseUrl}/api/clean`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId: file.id, options: {} }),
  });
  const cleaned = (await cleanResponse.json()).cleaned;

  const badFormat = await fetch(`${baseUrl}/api/download/${cleaned.id}?format=xml`);
  assert.equal(badFormat.status, 400);
  assert.equal((await badFormat.json()).error.code, 'INVALID_FORMAT');

  const deletion = await fetch(`${baseUrl}/api/files/${file.id}`, { method: 'DELETE' });
  assert.equal(deletion.status, 204);

  const afterDelete = await fetch(`${baseUrl}/api/clean`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId: file.id, options: {} }),
  });
  assert.equal(afterDelete.status, 404);
});

test('rejects a missing file upload and unknown API routes', async () => {
  const emptyUpload = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: new FormData() });
  assert.equal(emptyUpload.status, 400);

  const unknown = await fetch(`${baseUrl}/api/nope`);
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, 'NOT_FOUND');
});

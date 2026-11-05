'use strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.ENABLE_BILLING_SANDBOX = 'true';
process.env.BILLING_SECRET = 'test-billing-secret';
process.env.FREE_TIER_MAX_ROWS = '10';
process.env.FREE_TIER_MAX_FILE_MB = '1';
process.env.HIGH_VOLUME_ROW_LIMIT = '5';
process.env.PREMIUM_EXPORT_FORMATS = 'ndjson,tsv';
process.env.BULK_MAX_FILES = '5';
process.env.STRIPE_SECRET_KEY = '';
process.env.STRIPE_WEBHOOK_SECRET = '';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');
const { fileStore } = require('../src/services/fileStore');
const { billingStore } = require('../src/services/billingStore');

let server;
let baseUrl;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fileStore.close();
  await billingStore.clear();
});

function csvWithRows(count, label = 'row') {
  const lines = ['id,name'];
  for (let index = 1; index <= count; index += 1) {
    lines.push(`${index},${label} ${index}`);
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

async function uploadBuffer(buffer, filename = 'data.csv') {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'text/csv' }), filename);
  const response = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: form });
  const payload = await response.json();
  assert.equal(response.status, 201, JSON.stringify(payload));
  return payload;
}

async function cleanFile(fileId, cookie) {
  return fetch(`${baseUrl}/api/clean`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ fileId, options: {} }),
  });
}

async function sandboxCheckout(plan) {
  const response = await fetch(`${baseUrl}/api/billing/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan, sandbox: true }),
  });
  assert.equal(response.status, 201);
  const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  const cookie = cookies.map((value) => value.split(';')[0]).join('; ');
  assert.match(cookie, /^td_export_pass=/);
  return { cookie, body: await response.json() };
}

test('exposes the free tier and gates large files at clean time', async () => {
  const statusResponse = await fetch(`${baseUrl}/api/billing/status`);
  const status = (await statusResponse.json()).billing;
  assert.equal(status.freeTier.maxRows, 10);
  assert.equal(status.freeTier.maxFileSizeMb, 1);
  assert.equal(status.highVolumeRowLimit, 5);
  assert.deepEqual(status.premiumExportFormats, ['ndjson', 'tsv']);
  assert.equal(status.bulkMaxFiles, 5);

  const small = await uploadBuffer(csvWithRows(2));
  assert.equal(small.access.allowed, true);
  assert.equal(small.access.premium, false);

  const smallClean = await cleanFile(small.file.id);
  assert.equal(smallClean.status, 200);
  const smallCleaned = (await smallClean.json()).cleaned;

  const csv = await fetch(`${baseUrl}/api/download/${smallCleaned.id}?format=csv`);
  assert.equal(csv.status, 200);

  const json = await fetch(`${baseUrl}/api/download/${smallCleaned.id}?format=json`);
  assert.equal(json.status, 200);

  const premiumFormat = await fetch(`${baseUrl}/api/download/${smallCleaned.id}?format=ndjson`);
  assert.equal(premiumFormat.status, 402);
  const premiumBody = await premiumFormat.json();
  assert.equal(premiumBody.error.code, 'PAYMENT_REQUIRED');
  assert.equal(premiumBody.access.reason, 'PREMIUM_FORMAT');
  assert.match(premiumBody.error.message, /premium format/i);
  assert.equal(premiumBody.billing.freeTier.maxRows, 10);

  const large = await uploadBuffer(csvWithRows(12));
  assert.equal(large.access.allowed, false);
  assert.equal(large.access.reason, 'FREE_ROW_LIMIT');

  const blockedClean = await cleanFile(large.file.id);
  assert.equal(blockedClean.status, 402);
  const blockedBody = await blockedClean.json();
  assert.equal(blockedBody.error.code, 'PAYMENT_REQUIRED');
  assert.equal(blockedBody.error.details.reason, 'FREE_ROW_LIMIT');
  assert.match(blockedBody.error.message, /free plan cleans up to 10 rows/i);
});

test('a sandbox pass unlocks the saved large file and premium exports immediately', async () => {
  const large = await uploadBuffer(csvWithRows(12));
  const blocked = await cleanFile(large.file.id);
  assert.equal(blocked.status, 402);

  const { cookie, body } = await sandboxCheckout('single');
  assert.equal(body.entitlement.remainingExports, 1);

  const unblocked = await cleanFile(large.file.id, cookie);
  assert.equal(unblocked.status, 200);
  const cleaned = (await unblocked.json()).cleaned;
  assert.equal(cleaned.rowCount, 12);

  const ndjson = await fetch(`${baseUrl}/api/download/${cleaned.id}?format=ndjson`, {
    headers: { Cookie: cookie },
  });
  assert.equal(ndjson.status, 200);
  assert.match(ndjson.headers.get('content-type'), /application\/x-ndjson/);
  const lines = (await ndjson.text()).trim().split('\n');
  assert.equal(lines.length, 12);
  assert.equal(JSON.parse(lines[0]).name, 'row 1');

  const afterUse = await fetch(`${baseUrl}/api/billing/status`, {
    headers: { Cookie: cookie },
  });
  const status = (await afterUse.json()).billing;
  assert.equal(status.entitlement.remainingExports, 0);
  assert.equal(status.premium, false);

  const blockedAgain = await fetch(`${baseUrl}/api/download/${cleaned.id}?format=csv`, {
    headers: { Cookie: cookie },
  });
  assert.equal(blockedAgain.status, 402);
  assert.equal((await blockedAgain.json()).access.reason, 'NO_CREDITS');
});

test('enforces the free file-size limit and keeps the file for a post-payment retry', async () => {
  const padding = 'x'.repeat(1024 * 1024 + 128 * 1024);
  const oversized = Buffer.from(`id,notes\n1,${padding}\n2,small\n`, 'utf8');
  const uploaded = await uploadBuffer(oversized, 'wide.csv');
  assert.equal(uploaded.access.allowed, false);
  assert.equal(uploaded.access.reason, 'FREE_FILE_SIZE_LIMIT');

  const blocked = await cleanFile(uploaded.file.id);
  assert.equal(blocked.status, 402);
  const blockedBody = await blocked.json();
  assert.equal(blockedBody.error.details.reason, 'FREE_FILE_SIZE_LIMIT');
  assert.match(blockedBody.error.message, /free plan cleans files up to 1 MB/i);

  const { cookie } = await sandboxCheckout('monthly');
  const allowed = await cleanFile(uploaded.file.id, cookie);
  assert.equal(allowed.status, 200);

  const download = await fetch(
    `${baseUrl}/api/download/${(await allowed.json()).cleaned.id}?format=csv`,
    { headers: { Cookie: cookie } },
  );
  assert.equal(download.status, 200);
});

test('bulk processing is premium-only and cleans multiple files in one request', async () => {
  const first = await uploadBuffer(csvWithRows(2, 'first'));
  const second = await uploadBuffer(csvWithRows(2, 'second'));

  const blocked = await fetch(`${baseUrl}/api/clean/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds: [first.file.id, second.file.id], options: {} }),
  });
  assert.equal(blocked.status, 402);
  const blockedBody = await blocked.json();
  assert.equal(blockedBody.error.code, 'PAYMENT_REQUIRED');
  assert.equal(blockedBody.error.details.reason, 'BULK_PREMIUM');

  const { cookie } = await sandboxCheckout('monthly');
  const bulk = await fetch(`${baseUrl}/api/clean/bulk`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({ fileIds: [first.file.id, second.file.id], options: {} }),
  });
  assert.equal(bulk.status, 200);
  const bulkBody = await bulk.json();
  assert.equal(bulkBody.count, 2);
  assert.equal(bulkBody.cleaned.length, 2);
  assert.equal(bulkBody.cleaned[0].sourceId, first.file.id);
  assert.equal(bulkBody.cleaned[1].sourceId, second.file.id);

  const download = await fetch(`${baseUrl}/api/download/${bulkBody.cleaned[0].id}?format=csv`, {
    headers: { Cookie: cookie },
  });
  assert.equal(download.status, 200);
});

'use strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.ENABLE_BILLING_SANDBOX = 'true';
process.env.BILLING_SECRET = 'test-billing-secret';
process.env.HIGH_VOLUME_ROW_LIMIT = '2';
process.env.STRIPE_SECRET_KEY = '';
process.env.STRIPE_WEBHOOK_SECRET = '';

const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');
const config = require('../src/config');
const { fileStore } = require('../src/services/fileStore');
const { billingStore } = require('../src/services/billingStore');
const billing = require('../src/services/billing');

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
  await billingStore.clear();
});

function cookieHeader(response) {
  const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  return cookies.map((cookie) => cookie.split(';')[0]).join('; ');
}

async function uploadAndClean() {
  const form = new FormData();
  const file = fs.readFileSync(samplePath);
  form.append('file', new Blob([file], { type: 'text/csv' }), 'sample.csv');

  const uploadResponse = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: form });
  assert.equal(uploadResponse.status, 201);
  const uploaded = (await uploadResponse.json()).file;

  const cleanResponse = await fetch(`${baseUrl}/api/clean`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId: uploaded.id, options: {} }),
  });
  assert.equal(cleanResponse.status, 200);
  return (await cleanResponse.json()).cleaned;
}

test('reports billing configuration and gates high-volume exports', async () => {
  const statusResponse = await fetch(`${baseUrl}/api/billing/status`);
  assert.equal(statusResponse.status, 200);
  const status = (await statusResponse.json()).billing;

  assert.equal(status.sandboxEnabled, true);
  assert.equal(status.stripeConfigured, false);
  assert.equal(status.stripeMode, 'disabled');
  assert.equal(status.highVolumeRowLimit, 2);
  assert.equal(status.prices.single.display, '$5');
  assert.equal(status.prices.monthly.display, '$19');
  assert.equal(status.entitlement, null);

  const cleaned = await uploadAndClean();
  assert.equal(cleaned.rowCount, 12);

  const blocked = await fetch(`${baseUrl}/api/download/${cleaned.id}?format=csv`);
  assert.equal(blocked.status, 402);
  const blockedBody = await blocked.json();
  assert.equal(blockedBody.error.code, 'PAYMENT_REQUIRED');
  assert.match(blockedBody.error.message, /free downloads cover up to 2 rows/i);
  assert.equal(blockedBody.billing.highVolumeRowLimit, 2);
});

test('sandbox single pass is granted, consumes one credit, and then blocks', async () => {
  const cleaned = await uploadAndClean();

  const checkout = await fetch(`${baseUrl}/api/billing/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: 'single', sandbox: true }),
  });
  assert.equal(checkout.status, 201);
  const checkoutBody = await checkout.json();
  assert.equal(checkoutBody.sandbox, true);
  assert.equal(checkoutBody.entitlement.plan, 'single');
  assert.equal(checkoutBody.entitlement.remainingExports, 1);
  assert.equal(checkoutBody.billing.entitlement.remainingExports, 1);

  const cookie = cookieHeader(checkout);
  assert.match(cookie, /^td_export_pass=/);
  assert.match(checkout.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(checkout.headers.get('set-cookie'), /SameSite=Lax/i);

  const statusWithPass = await fetch(`${baseUrl}/api/billing/status`, {
    headers: { Cookie: cookie },
  });
  const passStatus = (await statusWithPass.json()).billing;
  assert.equal(passStatus.entitlement.plan, 'single');
  assert.equal(passStatus.entitlement.remainingExports, 1);

  const download = await fetch(`${baseUrl}/api/download/${cleaned.id}?format=json`, {
    headers: { Cookie: cookie },
  });
  assert.equal(download.status, 200);
  assert.equal((await download.json()).length, 12);

  const afterUse = await fetch(`${baseUrl}/api/billing/status`, {
    headers: { Cookie: cookie },
  });
  const afterStatus = (await afterUse.json()).billing;
  assert.equal(afterStatus.entitlement.remainingExports, 0);
  assert.equal(afterStatus.entitlement.active, false);

  const blocked = await fetch(`${baseUrl}/api/download/${cleaned.id}?format=csv`, {
    headers: { Cookie: cookie },
  });
  assert.equal(blocked.status, 402);
  const blockedBody = await blocked.json();
  assert.match(blockedBody.error.message, /credit has been used/i);
});

test('sandbox monthly subscription allows unlimited high-volume exports', async () => {
  const cleaned = await uploadAndClean();

  const checkout = await fetch(`${baseUrl}/api/billing/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: 'monthly', sandbox: true }),
  });
  assert.equal(checkout.status, 201);
  const checkoutBody = await checkout.json();
  assert.equal(checkoutBody.entitlement.plan, 'monthly');
  assert.equal(checkoutBody.entitlement.remainingExports, null);

  const cookie = cookieHeader(checkout);

  const first = await fetch(`${baseUrl}/api/download/${cleaned.id}?format=csv`, {
    headers: { Cookie: cookie },
  });
  assert.equal(first.status, 200);

  const second = await fetch(`${baseUrl}/api/download/${cleaned.id}?format=json`, {
    headers: { Cookie: cookie },
  });
  assert.equal(second.status, 200);

  const status = await fetch(`${baseUrl}/api/billing/status`, {
    headers: { Cookie: cookie },
  });
  const monthlyStatus = (await status.json()).billing;
  assert.equal(monthlyStatus.entitlement.plan, 'monthly');
  assert.equal(monthlyStatus.entitlement.active, true);
  assert.equal(monthlyStatus.entitlement.remainingExports, null);
});

test('rejects invalid plans and cannot be forced into sandbox when disabled', async () => {
  const invalid = await fetch(`${baseUrl}/api/billing/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: 'yearly', sandbox: true }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'INVALID_PLAN');

  const previous = config.billing.sandboxEnabled;
  config.billing.sandboxEnabled = false;
  try {
    const forced = await fetch(`${baseUrl}/api/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'single', sandbox: true }),
    });
    assert.equal(forced.status, 403);
    assert.equal((await forced.json()).error.code, 'SANDBOX_DISABLED');
  } finally {
    config.billing.sandboxEnabled = previous;
  }
});

test('webhook renewals, deduplication, and cancellations use the subscription ledger', async () => {
  const entitlement = await billingStore.create({
    plan: 'monthly',
    subscriptionId: 'sub_nested_invoice_test',
  });
  const originalExpiry = entitlement.expiresAt;

  const renewal = {
    id: 'evt_test_renewal',
    type: 'invoice.paid',
    data: {
      object: {
        parent: {
          subscription_details: {
            subscription: 'sub_nested_invoice_test',
          },
        },
      },
    },
  };

  await billing.handleWebhook(renewal);
  const renewed = await billingStore.get(entitlement.id);
  assert.ok(renewed.expiresAt > originalExpiry);
  const expiryAfterFirstDelivery = renewed.expiresAt;

  // Stripe can deliver the same event more than once; do not extend twice.
  await billing.handleWebhook(renewal);
  assert.equal((await billingStore.get(entitlement.id)).expiresAt, expiryAfterFirstDelivery);

  await billing.handleWebhook({
    id: 'evt_test_cancellation',
    type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_nested_invoice_test' } },
  });
  assert.equal(await billingStore.get(entitlement.id), null);
});

test('releases a failed webhook claim so Stripe can retry the event', async () => {
  const event = {
    id: 'evt_test_retry_after_failure',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_retry_after_failure',
        mode: 'payment',
        payment_status: 'paid',
        metadata: { plan: 'single' },
      },
    },
  };

  const originalCreate = billingStore.create;
  let attempts = 0;
  billingStore.create = async function createWithFailure(...args) {
    attempts += 1;
    if (attempts === 1) throw new Error('simulated webhook processing failure');
    return originalCreate.apply(this, args);
  };

  try {
    await assert.rejects(billing.handleWebhook(event), /simulated webhook processing failure/);
    assert.equal(await billingStore.hasProcessedEvent(event.id), false);
    assert.equal(await billingStore.getBySession(event.data.object.id), null);

    await billing.handleWebhook(event);
    assert.equal(attempts, 2);
    assert.equal(await billingStore.hasProcessedEvent(event.id), true);
    assert.ok(await billingStore.getBySession(event.data.object.id));
  } finally {
    billingStore.create = originalCreate;
  }
});

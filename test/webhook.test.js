'use strict';

process.env.NODE_ENV = 'test';
process.env.BILLING_SECRET = 'test-billing-secret';
process.env.STRIPE_SECRET_KEY = 'sk_test_webhook';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_webhook_secret';
process.env.ENABLE_BILLING_SANDBOX = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Stripe = require('stripe');
const app = require('../src/app');
const billing = require('../src/services/billing');
const { billingStore } = require('../src/services/billingStore');
const { fileStore } = require('../src/services/fileStore');

const stripe = new Stripe('sk_test_webhook');
const webhookSecret = 'whsec_test_webhook_secret';

let server;
let baseUrl;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fileStore.close();
  billingStore.clear();
});

function signatureFor(payload) {
  return stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
}

async function postWebhook(path, payload, signature = signatureFor(payload)) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(signature ? { 'Stripe-Signature': signature } : {}),
    },
    body: payload,
  });
}

test('the public /api/webhook verifies signatures and grants access immediately', async () => {
  const event = {
    id: 'evt_checkout_single_test',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_webhook_single',
        mode: 'payment',
        payment_status: 'paid',
        metadata: { plan: 'single' },
      },
    },
  };
  const payload = JSON.stringify(event);
  const response = await postWebhook('/api/webhook', payload);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true });

  const entitlement = billingStore.getBySession('cs_test_webhook_single');
  assert.ok(entitlement);
  assert.equal(entitlement.plan, 'single');
  assert.equal(entitlement.remainingExports, 1);

  // The success redirect can reuse the webhook-created entitlement without a
  // second Stripe API call, even if Stripe is temporarily unavailable.
  const same = await billing.completeStripeCheckout('cs_test_webhook_single');
  assert.equal(same.id, entitlement.id);
});

test('deduplicates repeated event IDs and supports the legacy webhook alias', async () => {
  const event = {
    id: 'evt_checkout_duplicate_test',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_webhook_duplicate_a',
        mode: 'payment',
        payment_status: 'paid',
        metadata: { plan: 'single' },
      },
    },
  };
  const payload = JSON.stringify(event);
  assert.equal((await postWebhook('/api/webhook', payload)).status, 200);
  assert.ok(billingStore.getBySession('cs_test_webhook_duplicate_a'));

  const duplicateWithNewSession = JSON.stringify({
    ...event,
    data: {
      object: {
        ...event.data.object,
        id: 'cs_test_webhook_duplicate_b',
      },
    },
  });
  assert.equal((await postWebhook('/api/webhook', duplicateWithNewSession)).status, 200);
  assert.equal(billingStore.getBySession('cs_test_webhook_duplicate_b'), null);

  const monthly = {
    id: 'evt_checkout_monthly_alias_test',
    type: 'checkout.session.async_payment_succeeded',
    data: {
      object: {
        id: 'cs_test_webhook_monthly',
        mode: 'subscription',
        payment_status: 'paid',
        subscription: 'sub_test_webhook_monthly',
        metadata: { plan: 'monthly' },
      },
    },
  };
  const aliasPayload = JSON.stringify(monthly);
  const aliasResponse = await postWebhook('/api/billing/webhook', aliasPayload);
  assert.equal(aliasResponse.status, 200);

  const entitlement = billingStore.getBySession('cs_test_webhook_monthly');
  assert.ok(entitlement);
  assert.equal(entitlement.plan, 'monthly');
  assert.equal(entitlement.subscriptionId, 'sub_test_webhook_monthly');
});

test('rejects missing and invalid Stripe signatures', async () => {
  const payload = JSON.stringify({
    id: 'evt_invalid_signature_test',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_invalid' } },
  });

  const missing = await postWebhook('/api/webhook', payload, null);
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, 'MISSING_SIGNATURE');

  const invalid = await postWebhook('/api/webhook', payload, 't=1,v1=not-a-real-signature');
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'INVALID_SIGNATURE');
});

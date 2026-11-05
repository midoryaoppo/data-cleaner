'use strict';

const crypto = require('node:crypto');
const Stripe = require('stripe');
const config = require('../config');
const { AppError } = require('../errors');
const { billingStore } = require('./billingStore');

const COOKIE_NAME = 'td_export_pass';
const SUPPORTED_EXPORT_FORMATS = ['csv', 'json', 'ndjson', 'tsv'];

let stripe = null;
if (config.billing.stripeSecretKey) {
  try {
    stripe = new Stripe(config.billing.stripeSecretKey, {
      appInfo: { name: 'TidyData', version: '1.0.0' },
    });
  } catch (error) {
    console.error('[tidydata] Could not initialise Stripe:', error.message);
  }
}

function stripeMode() {
  if (!stripe) return 'disabled';
  const key = config.billing.stripeSecretKey;
  return key.startsWith('sk_live_') || key.startsWith('rk_live_') ? 'live' : 'test';
}

function subscriptionIdFrom(value) {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && typeof value.id === 'string') return value.id;
  return null;
}

function invoiceSubscriptionId(invoice) {
  if (!invoice || typeof invoice !== 'object') return null;

  // Newer Stripe API versions moved the subscription under invoice.parent.
  const parentDetails =
    invoice.parent && invoice.parent.subscription_details
      ? invoice.parent.subscription_details
      : null;

  return (
    subscriptionIdFrom(invoice.subscription) ||
    subscriptionIdFrom(parentDetails && parentDetails.subscription) ||
    null
  );
}

function checkoutCustomer(session) {
  if (!session || typeof session !== 'object') {
    return { stripeCustomerId: null, customerEmail: null };
  }
  const details = session.customer_details;
  return {
    stripeCustomerId: subscriptionIdFrom(session.customer),
    customerEmail:
      (details && typeof details.email === 'string' && details.email) ||
      (typeof session.customer_email === 'string' && session.customer_email) ||
      null,
  };
}

function formatPrice(cents) {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: config.billing.currency.toUpperCase(),
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    }).format(cents / 100);
  } catch (error) {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function signToken(entitlement) {
  const payload = Buffer.from(
    JSON.stringify({ eid: entitlement.id, plan: entitlement.plan }),
    'utf8',
  ).toString('base64url');
  const signature = crypto
    .createHmac('sha256', config.billing.secret)
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payload, signature] = parts;
  if (!payload || !signature) return null;

  const expected = crypto
    .createHmac('sha256', config.billing.secret)
    .update(payload)
    .digest('base64url');
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (
      !parsed ||
      typeof parsed.eid !== 'string' ||
      (parsed.plan !== 'single' && parsed.plan !== 'monthly')
    ) {
      return null;
    }
    return parsed;
  } catch (error) {
    return null;
  }
}

function setEntitlementCookie(res, entitlement) {
  res.cookie(COOKIE_NAME, signToken(entitlement), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    path: '/',
    // The entitlement ledger is the source of truth for expiry. A long-lived
    // cookie lets monthly renewals keep working without a new browser session.
    maxAge: 400 * 24 * 60 * 60 * 1000,
  });
}

function clearEntitlementCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    path: '/',
  });
}

async function getRequestEntitlement(req) {
  const cookieValue = req.cookies ? req.cookies[COOKIE_NAME] : null;
  const payload = verifyToken(cookieValue);
  if (!payload) return null;
  const entitlement = await billingStore.get(payload.eid);
  if (!entitlement || entitlement.plan !== payload.plan) return null;
  return entitlement;
}

function hasPremiumAccess(entitlement) {
  if (!entitlement) return false;
  if (entitlement.plan === 'monthly') return true;
  return entitlement.plan === 'single' && entitlement.remainingExports > 0;
}

function freeTierLimits() {
  return {
    maxRows: config.billing.freeTierMaxRows,
    maxFileSizeBytes: config.billing.freeTierMaxFileSizeBytes,
    maxFileSizeMb: config.billing.freeTierMaxFileSizeMb,
  };
}

function normalizeExportFormat(format) {
  const normalized = String(format || 'csv').trim().toLowerCase();
  return SUPPORTED_EXPORT_FORMATS.includes(normalized) ? normalized : null;
}

function toPublicAccess(access) {
  if (!access) return null;
  return {
    allowed: Boolean(access.allowed),
    premium: Boolean(access.premium),
    reason: access.reason || null,
    limits: access.limits || freeTierLimits(),
  };
}

async function evaluateDatasetAccess(req, { rowCount = 0, size = 0 } = {}) {
  const entitlement = await getRequestEntitlement(req);
  const limits = freeTierLimits();

  if (hasPremiumAccess(entitlement)) {
    return { allowed: true, premium: true, entitlement, reason: null, limits };
  }

  let reason = null;
  if (rowCount > limits.maxRows) reason = 'FREE_ROW_LIMIT';
  else if (size > limits.maxFileSizeBytes) reason = 'FREE_FILE_SIZE_LIMIT';

  return {
    allowed: reason === null,
    premium: false,
    entitlement: entitlement || null,
    reason,
    limits,
  };
}

async function evaluateExportAccess(req, rowCount, format = 'csv') {
  const normalizedFormat = normalizeExportFormat(format) || 'csv';
  const highVolume = rowCount > config.billing.highVolumeRowLimit;
  const premiumFormat = config.billing.premiumExportFormats.includes(normalizedFormat);
  const entitlement = await getRequestEntitlement(req);
  const premium = hasPremiumAccess(entitlement);

  if (premiumFormat && !premium) {
    return {
      allowed: false,
      highVolume,
      premiumFormat,
      entitlement,
      reason: entitlement ? 'NO_CREDITS' : 'PREMIUM_FORMAT',
      format: normalizedFormat,
    };
  }

  if (!highVolume) {
    return {
      allowed: true,
      highVolume: false,
      premiumFormat,
      entitlement,
      billable: Boolean(premium && premiumFormat && entitlement.plan === 'single'),
      format: normalizedFormat,
    };
  }

  if (!premium) {
    return {
      allowed: false,
      highVolume: true,
      premiumFormat,
      entitlement,
      reason: entitlement ? 'NO_CREDITS' : 'NO_ENTITLEMENT',
      format: normalizedFormat,
    };
  }

  return {
    allowed: true,
    highVolume: true,
    premiumFormat,
    entitlement,
    billable: entitlement.plan === 'single',
    format: normalizedFormat,
  };
}

function toPublicEntitlement(entitlement) {
  if (!entitlement) return null;
  const active =
    entitlement.plan === 'monthly' ? true : entitlement.remainingExports > 0;
  return {
    plan: entitlement.plan,
    active,
    remainingExports: entitlement.remainingExports,
    expiresAt: entitlement.expiresAt,
    sandbox: entitlement.sandbox,
  };
}

async function getStatus(req) {
  const entitlement = await getRequestEntitlement(req);
  return {
    sandboxEnabled: config.billing.sandboxEnabled,
    stripeConfigured: Boolean(stripe),
    stripeMode: stripeMode(),
    highVolumeRowLimit: config.billing.highVolumeRowLimit,
    freeTier: freeTierLimits(),
    premiumExportFormats: config.billing.premiumExportFormats.slice(),
    bulkMaxFiles: config.billing.bulkMaxFiles,
    prices: {
      single: {
        amountCents: config.billing.singlePriceCents,
        display: formatPrice(config.billing.singlePriceCents),
        label: 'one premium export',
      },
      monthly: {
        amountCents: config.billing.monthlyPriceCents,
        display: formatPrice(config.billing.monthlyPriceCents),
        label: 'unlimited premium exports',
        interval: 'month',
      },
    },
    entitlement: toPublicEntitlement(entitlement),
    premium: hasPremiumAccess(entitlement),
  };
}

function assertPlan(plan) {
  if (plan !== 'single' && plan !== 'monthly') {
    throw new AppError(400, 'Choose either the "single" export pass or the "monthly" plan.', {
      code: 'INVALID_PLAN',
    });
  }
}

async function createStripeCheckout(plan) {
  if (!stripe) {
    throw new AppError(
      503,
      'Stripe is not configured. Use sandbox checkout or add STRIPE_SECRET_KEY to your .env file.',
      { code: 'STRIPE_NOT_CONFIGURED' },
    );
  }

  const isSubscription = plan === 'monthly';
  const priceId = isSubscription
    ? config.billing.monthlyPriceId
    : config.billing.singlePriceId;

  const priceData = {
    currency: config.billing.currency,
    unit_amount: isSubscription
      ? config.billing.monthlyPriceCents
      : config.billing.singlePriceCents,
    product_data: {
      name: isSubscription ? 'TidyData Pro — monthly' : 'TidyData export pass',
      description: isSubscription
        ? 'Unlimited large-file cleaning, bulk processing, and premium exports while subscribed.'
        : 'One premium export: large-file cleaning, bulk processing, and NDJSON/TSV downloads for 24 hours.',
    },
    ...(isSubscription ? { recurring: { interval: 'month' } } : {}),
  };

  const sessionOptions = {
    mode: isSubscription ? 'subscription' : 'payment',
    line_items: [
      priceId
        ? { price: priceId, quantity: 1 }
        : { price_data: priceData, quantity: 1 },
    ],
    success_url: `${config.appUrl}/api/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.appUrl}/?checkout=cancelled`,
    allow_promotion_codes: true,
    metadata: { plan, source: 'tidydata' },
    ...(isSubscription
      ? { subscription_data: { metadata: { plan, source: 'tidydata' } } }
      : { customer_creation: 'always' }),
  };

  try {
    const session = await stripe.checkout.sessions.create(sessionOptions);
    return session;
  } catch (error) {
    console.error('[tidydata] Stripe checkout error:', error);
    throw new AppError(
      502,
      'Stripe could not start the checkout. Check your Stripe keys and try again.',
      { code: 'STRIPE_CHECKOUT_FAILED' },
    );
  }
}

async function startSandboxCheckout(plan) {
  if (!config.billing.sandboxEnabled) {
    throw new AppError(
      403,
      'Sandbox checkout is disabled. Configure Stripe to accept payments.',
      { code: 'SANDBOX_DISABLED' },
    );
  }

  return billingStore.create({
    plan,
    sessionId: `sandbox_${crypto.randomUUID()}`,
    sandbox: true,
  });
}

async function checkout(plan, { sandbox = false } = {}) {
  assertPlan(plan);
  if (sandbox) {
    return { sandbox: true, entitlement: await startSandboxCheckout(plan), url: null };
  }

  const session = await createStripeCheckout(plan);
  return { sandbox: false, entitlement: null, url: session.url, sessionId: session.id };
}

async function completeStripeCheckout(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new AppError(400, 'Missing Stripe checkout session.', { code: 'MISSING_SESSION' });
  }

  // The webhook may have already granted access. Reuse that entitlement so a
  // temporary Stripe API failure cannot block the browser from getting its
  // signed cookie after a successful payment.
  const existing = await billingStore.getBySession(sessionId);
  if (existing) return existing;

  if (!stripe) {
    throw new AppError(503, 'Stripe is not configured on this server.', {
      code: 'STRIPE_NOT_CONFIGURED',
    });
  }

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (error) {
    console.error('[tidydata] Could not retrieve Stripe session:', error.message);
    throw new AppError(400, 'That checkout session could not be verified.', {
      code: 'INVALID_SESSION',
    });
  }

  if (session.status !== 'complete') {
    throw new AppError(400, 'This checkout has not been completed yet.', {
      code: 'CHECKOUT_INCOMPLETE',
    });
  }

  const alreadyGranted = await billingStore.getBySession(session.id);
  if (alreadyGranted) return alreadyGranted;

  const plan = session.metadata && session.metadata.plan === 'monthly' ? 'monthly' : 'single';
  if (plan === 'single' && session.payment_status !== 'paid') {
    throw new AppError(400, 'The payment has not been confirmed yet.', {
      code: 'PAYMENT_PENDING',
    });
  }
  if (plan === 'monthly' && session.mode !== 'subscription') {
    throw new AppError(400, 'This subscription checkout is incomplete.', {
      code: 'SUBSCRIPTION_INCOMPLETE',
    });
  }

  return billingStore.create({
    plan,
    sessionId: session.id,
    subscriptionId: subscriptionIdFrom(session.subscription),
    sandbox: false,
    ...checkoutCustomer(session),
  });
}

function verifyWebhook(rawBody, signature) {
  if (!stripe || !config.billing.stripeWebhookSecret) {
    throw new AppError(503, 'Stripe webhooks are not configured.', {
      code: 'WEBHOOK_NOT_CONFIGURED',
    });
  }
  if (!signature) {
    throw new AppError(400, 'Missing Stripe signature.', { code: 'MISSING_SIGNATURE' });
  }
  try {
    return stripe.webhooks.constructEvent(
      rawBody,
      signature,
      config.billing.stripeWebhookSecret,
    );
  } catch (error) {
    throw new AppError(400, 'Invalid Stripe webhook signature.', {
      code: 'INVALID_SIGNATURE',
    });
  }
}

async function handleWebhook(event) {
  if (!event || typeof event !== 'object') return;

  let claimed = false;
  if (typeof event.id === 'string' && event.id) {
    claimed = await billingStore.claimEvent(event.id);
    if (!claimed) return;
  }

  try {
    await processWebhookEvent(event);
  } catch (error) {
    // Release the claim so Stripe can retry an event that failed partway
    // through instead of treating it as permanently processed.
    if (claimed) {
      try {
        await billingStore.releaseEvent(event.id);
      } catch (releaseError) {
        console.error('[tidydata] Could not release webhook event:', releaseError.message);
      }
    }
    throw error;
  }
}

async function processWebhookEvent(event) {
  if (
    event.type === 'checkout.session.completed' ||
    event.type === 'checkout.session.async_payment_succeeded'
  ) {
    const session = event.data.object;
    if (session && session.id) {
      const plan = session.metadata && session.metadata.plan === 'monthly' ? 'monthly' : 'single';
      const paid =
        session.payment_status === 'paid' ||
        session.payment_status === 'no_payment_required' ||
        session.mode === 'subscription';
      if (paid) {
        await billingStore.create({
          plan,
          sessionId: session.id,
          subscriptionId: subscriptionIdFrom(session.subscription),
          sandbox: false,
          ...checkoutCustomer(session),
        });
      }
    }
  } else if (event.type === 'invoice.paid') {
    const invoice = event.data.object;
    const subscriptionId = invoiceSubscriptionId(invoice);
    if (subscriptionId) await billingStore.extendSubscription(subscriptionId);
  } else if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    if (subscription && subscription.id) {
      await billingStore.revokeBySubscription(subscription.id);
    }
  }
}

async function consumeExport(entitlement) {
  if (entitlement && entitlement.plan === 'single') {
    await billingStore.consumeExport(entitlement.id);
  }
}

module.exports = {
  COOKIE_NAME,
  SUPPORTED_EXPORT_FORMATS,
  checkout,
  clearEntitlementCookie,
  completeStripeCheckout,
  consumeExport,
  evaluateDatasetAccess,
  evaluateExportAccess,
  freeTierLimits,
  getRequestEntitlement,
  getStatus,
  handleWebhook,
  hasPremiumAccess,
  normalizeExportFormat,
  setEntitlementCookie,
  toPublicAccess,
  toPublicEntitlement,
  verifyWebhook,
};

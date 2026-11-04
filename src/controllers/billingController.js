'use strict';

const billing = require('../services/billing');

function status(req, res) {
  const entitlement = billing.getRequestEntitlement(req);
  if (entitlement) billing.setEntitlementCookie(res, entitlement);
  res.json({ billing: billing.getStatus(req) });
}

async function checkout(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const plan = body.plan;
  const sandbox = body.sandbox === true;

  const result = await billing.checkout(plan, { sandbox });

  if (result.sandbox) {
    billing.setEntitlementCookie(res, result.entitlement);
    res.status(201).json({
      sandbox: true,
      entitlement: billing.toPublicEntitlement(result.entitlement),
      billing: { ...billing.getStatus(req), entitlement: billing.toPublicEntitlement(result.entitlement) },
    });
    return;
  }

  res.status(201).json({
    sandbox: false,
    url: result.url,
    sessionId: result.sessionId,
  });
}

async function success(req, res) {
  try {
    const entitlement = await billing.completeStripeCheckout(
      typeof req.query.session_id === 'string' ? req.query.session_id : '',
    );
    billing.setEntitlementCookie(res, entitlement);
    res.redirect(303, `/?checkout=success&plan=${encodeURIComponent(entitlement.plan)}`);
  } catch (error) {
    console.error('[tidydata] Stripe success verification failed:', error.message);
    res.redirect(303, '/?checkout=failed');
  }
}

function webhook(req, res) {
  const event = billing.verifyWebhook(req.body, req.headers['stripe-signature']);
  billing.handleWebhook(event);
  res.json({ received: true });
}

module.exports = { status, checkout, success, webhook };

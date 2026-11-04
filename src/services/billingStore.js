'use strict';

const { randomUUID } = require('node:crypto');
const config = require('../config');

/**
 * In-memory entitlement ledger. Swap this for a database in production so
 * purchases survive restarts and can be reconciled with Stripe webhooks.
 */
class BillingStore {
  constructor() {
    this.entitlements = new Map();
    this.sessionIndex = new Map();
    this.subscriptionIndex = new Map();
    this.processedEvents = new Map();
  }

  create({ plan, sessionId = null, subscriptionId = null, sandbox = false }) {
    if (plan !== 'single' && plan !== 'monthly') {
      throw new Error(`Unknown billing plan: ${plan}`);
    }

    if (sessionId && this.sessionIndex.has(sessionId)) {
      const existing = this.get(this.sessionIndex.get(sessionId));
      if (existing) return existing;
    }

    const now = Date.now();
    const ttlHours =
      plan === 'single' ? config.billing.singlePassHours : config.billing.subscriptionDays * 24;
    const entitlement = {
      id: randomUUID(),
      plan,
      remainingExports: plan === 'single' ? 1 : null,
      sessionId,
      subscriptionId,
      sandbox: Boolean(sandbox),
      createdAt: now,
      expiresAt: now + ttlHours * 60 * 60 * 1000,
      revokedAt: null,
    };

    this.entitlements.set(entitlement.id, entitlement);
    if (sessionId) this.sessionIndex.set(sessionId, entitlement.id);
    if (subscriptionId) this.subscriptionIndex.set(subscriptionId, entitlement.id);
    return entitlement;
  }

  get(id) {
    const entitlement = this.entitlements.get(id);
    if (!entitlement) return null;
    if (entitlement.revokedAt || entitlement.expiresAt <= Date.now()) {
      return null;
    }
    return entitlement;
  }

  getBySession(sessionId) {
    const id = this.sessionIndex.get(sessionId);
    return id ? this.get(id) : null;
  }

  consumeExport(id) {
    const entitlement = this.get(id);
    if (!entitlement || entitlement.plan !== 'single') return entitlement;
    entitlement.remainingExports = Math.max(0, entitlement.remainingExports - 1);
    return entitlement;
  }

  revokeBySubscription(subscriptionId) {
    const id = this.subscriptionIndex.get(subscriptionId);
    if (!id) return false;
    const entitlement = this.entitlements.get(id);
    if (!entitlement) return false;
    entitlement.revokedAt = Date.now();
    return true;
  }

  extendSubscription(subscriptionId) {
    const id = this.subscriptionIndex.get(subscriptionId);
    if (!id) return false;
    const entitlement = this.entitlements.get(id);
    if (!entitlement || entitlement.revokedAt) return false;
    const base = Math.max(Date.now(), entitlement.expiresAt);
    entitlement.expiresAt = base + config.billing.subscriptionDays * 24 * 60 * 60 * 1000;
    return true;
  }

  revoke(id) {
    const entitlement = this.entitlements.get(id);
    if (!entitlement) return false;
    entitlement.revokedAt = Date.now();
    return true;
  }

  hasProcessedEvent(eventId) {
    return this.processedEvents.has(eventId);
  }

  markEventProcessed(eventId) {
    this.processedEvents.set(eventId, Date.now());
    while (this.processedEvents.size > 5000) {
      const oldest = this.processedEvents.keys().next().value;
      this.processedEvents.delete(oldest);
    }
  }

  health() {
    return {
      ready: this.entitlements instanceof Map && this.processedEvents instanceof Map,
      driver: 'memory',
      entitlements: this.entitlements.size,
      processedEvents: this.processedEvents.size,
    };
  }

  clear() {
    this.entitlements.clear();
    this.sessionIndex.clear();
    this.subscriptionIndex.clear();
    this.processedEvents.clear();
  }

  get size() {
    return this.entitlements.size;
  }
}

module.exports = { BillingStore, billingStore: new BillingStore() };

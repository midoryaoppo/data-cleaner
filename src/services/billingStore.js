'use strict';

const { randomUUID } = require('node:crypto');
const config = require('../config');
const database = require('../db/database');

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function assertPlan(plan) {
  if (plan !== 'single' && plan !== 'monthly') {
    throw new Error(`Unknown billing plan: ${plan}`);
  }
}

function accessTtlMs(plan) {
  const hours =
    plan === 'single' ? config.billing.singlePassHours : config.billing.subscriptionDays * 24;
  return hours * 60 * 60 * 1000;
}

function internalSessionId() {
  return `internal_${randomUUID()}`;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    plan: row.plan,
    status: row.status,
    remainingExports: row.remaining_exports === null ? null : Number(row.remaining_exports),
    sessionId: row.session_id,
    subscriptionId: row.subscription_id,
    stripeCustomerId: row.stripe_customer_id,
    customerEmail: row.customer_email,
    sandbox: Boolean(row.sandbox),
    createdAt: new Date(row.created_at).getTime(),
    expiresAt: new Date(row.expires_at).getTime(),
    revokedAt: row.revoked_at ? new Date(row.revoked_at).getTime() : null,
  };
}

/**
 * In-memory entitlement ledger used for tests and local development without a
 * DATABASE_URL. The method surface intentionally matches PostgresBillingStore.
 */
class MemoryBillingStore {
  constructor() {
    this.entitlements = new Map();
    this.sessionIndex = new Map();
    this.subscriptionIndex = new Map();
    this.processedEvents = new Map();
  }

  async create({
    plan,
    sessionId = null,
    subscriptionId = null,
    sandbox = false,
    stripeCustomerId = null,
    customerEmail = null,
  }) {
    assertPlan(plan);

    if (sessionId && this.sessionIndex.has(sessionId)) {
      const existing = this.entitlements.get(this.sessionIndex.get(sessionId));
      if (existing) return existing;
    }
    if (subscriptionId && this.subscriptionIndex.has(subscriptionId)) {
      const existing = this.entitlements.get(this.subscriptionIndex.get(subscriptionId));
      if (existing) return existing;
    }

    const now = Date.now();
    const effectiveSessionId = sessionId || internalSessionId();
    const entitlement = {
      id: randomUUID(),
      plan,
      status: 'active',
      remainingExports: plan === 'single' ? 1 : null,
      sessionId: effectiveSessionId,
      subscriptionId,
      stripeCustomerId,
      customerEmail,
      sandbox: Boolean(sandbox),
      createdAt: now,
      expiresAt: now + accessTtlMs(plan),
      revokedAt: null,
    };

    this.entitlements.set(entitlement.id, entitlement);
    this.sessionIndex.set(effectiveSessionId, entitlement.id);
    if (subscriptionId) this.subscriptionIndex.set(subscriptionId, entitlement.id);
    return entitlement;
  }

  async get(id) {
    const entitlement = this.entitlements.get(id);
    if (!entitlement) return null;
    if (entitlement.status !== 'active' || entitlement.expiresAt <= Date.now()) {
      return null;
    }
    return entitlement;
  }

  async getBySession(sessionId) {
    if (typeof sessionId !== 'string') return null;
    const id = this.sessionIndex.get(sessionId);
    return id ? this.get(id) : null;
  }

  async getBySubscription(subscriptionId) {
    if (typeof subscriptionId !== 'string') return null;
    const id = this.subscriptionIndex.get(subscriptionId);
    return id ? this.get(id) : null;
  }

  async consumeExport(id) {
    const entitlement = await this.get(id);
    if (!entitlement || entitlement.plan !== 'single') return entitlement;
    entitlement.remainingExports = Math.max(0, entitlement.remainingExports - 1);
    return entitlement;
  }

  async revokeBySubscription(subscriptionId) {
    if (typeof subscriptionId !== 'string') return false;
    const id = this.subscriptionIndex.get(subscriptionId);
    if (!id) return false;
    const entitlement = this.entitlements.get(id);
    if (!entitlement) return false;
    if (entitlement.status !== 'revoked') {
      entitlement.status = 'revoked';
      entitlement.revokedAt = Date.now();
    }
    return true;
  }

  async extendSubscription(subscriptionId) {
    if (typeof subscriptionId !== 'string') return false;
    const id = this.subscriptionIndex.get(subscriptionId);
    if (!id) return false;
    const entitlement = this.entitlements.get(id);
    if (!entitlement || entitlement.status !== 'active') return false;
    const base = Math.max(Date.now(), entitlement.expiresAt);
    entitlement.expiresAt = base + config.billing.subscriptionDays * 24 * 60 * 60 * 1000;
    return true;
  }

  async revoke(id) {
    const entitlement = this.entitlements.get(id);
    if (!entitlement) return false;
    if (entitlement.status !== 'revoked') {
      entitlement.status = 'revoked';
      entitlement.revokedAt = Date.now();
    }
    return true;
  }

  async hasProcessedEvent(eventId) {
    return this.processedEvents.has(eventId);
  }

  async claimEvent(eventId) {
    if (this.processedEvents.has(eventId)) return false;
    this.markEventProcessed(eventId);
    return true;
  }

  async releaseEvent(eventId) {
    this.processedEvents.delete(eventId);
  }

  async markEventProcessed(eventId) {
    this.processedEvents.set(eventId, Date.now());
    while (this.processedEvents.size > 5000) {
      const oldest = this.processedEvents.keys().next().value;
      this.processedEvents.delete(oldest);
    }
  }

  async health() {
    return {
      ready: this.entitlements instanceof Map && this.processedEvents instanceof Map,
      driver: 'memory',
      entitlements: this.entitlements.size,
      processedEvents: this.processedEvents.size,
    };
  }

  async clear() {
    this.entitlements.clear();
    this.sessionIndex.clear();
    this.subscriptionIndex.clear();
    this.processedEvents.clear();
  }

  async close() {
    // Nothing to close.
  }

  async count() {
    return this.entitlements.size;
  }

  get size() {
    return this.entitlements.size;
  }
}

/**
 * PostgreSQL-backed entitlement ledger. Every method is async so callers must
 * await it; the memory adapter implements the same contract for tests.
 */
class PostgresBillingStore {
  constructor({ db = database } = {}) {
    this.db = db;
  }

  async create({
    plan,
    sessionId = null,
    subscriptionId = null,
    sandbox = false,
    stripeCustomerId = null,
    customerEmail = null,
  }) {
    assertPlan(plan);

    const now = Date.now();
    const effectiveSessionId = sessionId || internalSessionId();
    const id = randomUUID();
    const expiresAt = new Date(now + accessTtlMs(plan));
    const remainingExports = plan === 'single' ? 1 : null;

    const inserted = await this.db.query(
      `INSERT INTO entitlements
         (id, plan, status, remaining_exports, session_id, subscription_id,
          stripe_customer_id, customer_email, sandbox, expires_at)
       VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        id,
        plan,
        remainingExports,
        effectiveSessionId,
        subscriptionId,
        stripeCustomerId,
        customerEmail,
        Boolean(sandbox),
        expiresAt,
      ],
    );

    if (inserted.rows.length > 0) return mapRow(inserted.rows[0]);

    // A concurrent webhook or redirect already created this entitlement. Reuse
    // the existing row so retries are idempotent.
    const bySession = await this.db.query(
      'SELECT * FROM entitlements WHERE session_id = $1 LIMIT 1',
      [effectiveSessionId],
    );
    if (bySession.rows.length > 0) return mapRow(bySession.rows[0]);

    if (subscriptionId) {
      const bySubscription = await this.db.query(
        'SELECT * FROM entitlements WHERE subscription_id = $1 LIMIT 1',
        [subscriptionId],
      );
      if (bySubscription.rows.length > 0) return mapRow(bySubscription.rows[0]);
    }

    throw new Error('Could not create the billing entitlement.');
  }

  async get(id) {
    if (!isUuid(id)) return null;
    const { rows } = await this.db.query(
      `SELECT * FROM entitlements
       WHERE id = $1 AND status = 'active' AND expires_at > now()
       LIMIT 1`,
      [id],
    );
    return mapRow(rows[0]);
  }

  async getBySession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return null;
    const { rows } = await this.db.query(
      `SELECT * FROM entitlements
       WHERE session_id = $1 AND status = 'active' AND expires_at > now()
       LIMIT 1`,
      [sessionId],
    );
    return mapRow(rows[0]);
  }

  async getBySubscription(subscriptionId) {
    if (typeof subscriptionId !== 'string' || !subscriptionId) return null;
    const { rows } = await this.db.query(
      `SELECT * FROM entitlements
       WHERE subscription_id = $1 AND status = 'active' AND expires_at > now()
       LIMIT 1`,
      [subscriptionId],
    );
    return mapRow(rows[0]);
  }

  async consumeExport(id) {
    if (!isUuid(id)) return null;
    const { rows } = await this.db.query(
      `UPDATE entitlements
       SET remaining_exports = GREATEST(remaining_exports - 1, 0),
           updated_at = now()
       WHERE id = $1 AND plan = 'single' AND status = 'active' AND expires_at > now()
       RETURNING *`,
      [id],
    );
    return mapRow(rows[0]) || this.get(id);
  }

  async revokeBySubscription(subscriptionId) {
    if (typeof subscriptionId !== 'string' || !subscriptionId) return false;
    const { rowCount } = await this.db.query(
      `UPDATE entitlements
       SET status = 'revoked', revoked_at = COALESCE(revoked_at, now()), updated_at = now()
       WHERE subscription_id = $1`,
      [subscriptionId],
    );
    return rowCount > 0;
  }

  async extendSubscription(subscriptionId) {
    if (typeof subscriptionId !== 'string' || !subscriptionId) return false;
    const { rowCount } = await this.db.query(
      `UPDATE entitlements
       SET expires_at = GREATEST(expires_at, now()) + $2::interval,
           updated_at = now()
       WHERE subscription_id = $1 AND status = 'active'`,
      [subscriptionId, `${config.billing.subscriptionDays * 24} hours`],
    );
    return rowCount > 0;
  }

  async revoke(id) {
    if (!isUuid(id)) return false;
    const { rowCount } = await this.db.query(
      `UPDATE entitlements
       SET status = 'revoked', revoked_at = COALESCE(revoked_at, now()), updated_at = now()
       WHERE id = $1`,
      [id],
    );
    return rowCount > 0;
  }

  async hasProcessedEvent(eventId) {
    if (typeof eventId !== 'string' || !eventId) return false;
    const { rows } = await this.db.query(
      'SELECT 1 FROM processed_webhook_events WHERE event_id = $1 LIMIT 1',
      [eventId],
    );
    return rows.length > 0;
  }

  async claimEvent(eventId) {
    if (typeof eventId !== 'string' || !eventId) return false;
    const { rows } = await this.db.query(
      `INSERT INTO processed_webhook_events (event_id)
       VALUES ($1)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [eventId],
    );
    return rows.length > 0;
  }

  async releaseEvent(eventId) {
    if (typeof eventId !== 'string' || !eventId) return;
    await this.db.query('DELETE FROM processed_webhook_events WHERE event_id = $1', [eventId]);
  }

  async markEventProcessed(eventId) {
    if (typeof eventId !== 'string' || !eventId) return;
    await this.db.query(
      `INSERT INTO processed_webhook_events (event_id)
       VALUES ($1)
       ON CONFLICT (event_id) DO NOTHING`,
      [eventId],
    );
  }

  async health() {
    try {
      const { rows } = await this.db.query(
        `SELECT
           (SELECT count(*)::int FROM entitlements
             WHERE status = 'active' AND expires_at > now()) AS entitlements,
           (SELECT count(*)::int FROM processed_webhook_events) AS processed_events`,
      );
      return {
        ready: true,
        driver: 'postgres',
        entitlements: rows[0].entitlements,
        processedEvents: rows[0].processed_events,
      };
    } catch (error) {
      return {
        ready: false,
        driver: 'postgres',
        entitlements: null,
        processedEvents: null,
        message: error.message,
      };
    }
  }

  async clear() {
    await this.db.query('DELETE FROM entitlements');
    await this.db.query('DELETE FROM processed_webhook_events');
  }

  async close() {
    // The shared database pool is closed by the server/database module.
  }

  async count() {
    const { rows } = await this.db.query('SELECT count(*)::int AS count FROM entitlements');
    return rows[0].count;
  }
}

const billingStore = database.isEnabled()
  ? new PostgresBillingStore()
  : new MemoryBillingStore();

module.exports = {
  BillingStore: MemoryBillingStore,
  MemoryBillingStore,
  PostgresBillingStore,
  billingStore,
  isUuid,
};

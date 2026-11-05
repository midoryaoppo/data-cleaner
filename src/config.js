'use strict';

const crypto = require('node:crypto');
require('dotenv').config({ quiet: true });

function intFromEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(Math.max(raw, min), max);
}

function boolFromEnv(name, fallback) {
  const value = String(process.env[name] ?? '').trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  return fallback;
}

function normalizeUrl(value, defaultProtocol = 'https') {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '');
  return `${defaultProtocol}://${trimmed}`.replace(/\/+$/, '');
}

function normalizeOrigin(value, defaultProtocol = 'https') {
  try {
    const url = new URL(normalizeUrl(value, defaultProtocol));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch (error) {
    return '';
  }
}

function parseOrigins(value, defaultProtocol = 'https') {
  return String(value || '')
    .split(',')
    .map((origin) => normalizeOrigin(origin, defaultProtocol))
    .filter(Boolean);
}

const EXPORT_FORMATS = ['csv', 'json', 'ndjson', 'tsv'];

function parseExportFormats(value) {
  const raw = String(value ?? '').trim();
  if (raw.toLowerCase() === 'none') return [];
  const source = raw || 'ndjson,tsv';
  return Array.from(
    new Set(
      source
        .split(',')
        .map((format) => format.trim().toLowerCase())
        .filter((format) => EXPORT_FORMATS.includes(format)),
    ),
  );
}

const port = intFromEnv('PORT', 3000, { min: 1, max: 65535 });
const env = process.env.NODE_ENV || 'development';
const isProduction = env === 'production';
const host = process.env.HOST || (isProduction ? '0.0.0.0' : '127.0.0.1');
const maxFileSizeMb = intFromEnv('MAX_FILE_SIZE_MB', 10, { min: 1, max: 100 });
const freeTierMaxFileSizeMb = intFromEnv('FREE_TIER_MAX_FILE_MB', 1, { min: 1, max: 100 });
const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;

// APP_URL wins. Render and Railway provide their public host automatically so
// the first deploy has working Stripe redirect URLs before a custom domain is set.
const renderUrl = normalizeUrl(process.env.RENDER_EXTERNAL_URL, 'https');
const railwayDomain = String(process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
const railwayUrl = railwayDomain ? normalizeUrl(railwayDomain, 'https') : '';
const appUrl = normalizeUrl(
  process.env.APP_URL || renderUrl || railwayUrl || `http://${displayHost}:${port}`,
  isProduction ? 'https' : 'http',
);

const corsOrigins = Array.from(
  new Set([
    normalizeOrigin(appUrl, isProduction ? 'https' : 'http'),
    ...parseOrigins(process.env.CORS_ORIGIN, isProduction ? 'https' : 'http'),
  ].filter(Boolean)),
);

const config = {
  env,
  isProduction,
  port,
  host,
  appUrl,
  maxFileSizeBytes: maxFileSizeMb * 1024 * 1024,
  maxFileSizeMb,
  maxRows: intFromEnv('MAX_ROWS', 200_000, { min: 1 }),
  maxColumns: intFromEnv('MAX_COLUMNS', 200, { min: 1 }),
  previewRows: 50,
  fileTtlMs: intFromEnv('FILE_TTL_MINUTES', 30, { min: 1, max: 1440 }) * 60 * 1000,
  maxStoredFiles: 80,
  trustProxy: boolFromEnv('TRUST_PROXY', isProduction),
  corsOrigins,
  billing: {
    stripeSecretKey: (process.env.STRIPE_SECRET_KEY || '').trim(),
    stripeWebhookSecret: (process.env.STRIPE_WEBHOOK_SECRET || '').trim(),
    sandboxEnabled: boolFromEnv('ENABLE_BILLING_SANDBOX', !isProduction),
    secret: process.env.BILLING_SECRET || crypto.randomBytes(32).toString('hex'),
    highVolumeRowLimit: intFromEnv('HIGH_VOLUME_ROW_LIMIT', 5000, { min: 0 }),
    freeTierMaxRows: intFromEnv('FREE_TIER_MAX_ROWS', 500, { min: 0 }),
    freeTierMaxFileSizeMb,
    freeTierMaxFileSizeBytes: freeTierMaxFileSizeMb * 1024 * 1024,
    premiumExportFormats: parseExportFormats(process.env.PREMIUM_EXPORT_FORMATS),
    bulkMaxFiles: intFromEnv('BULK_MAX_FILES', 10, { min: 2, max: 50 }),
    currency: (process.env.STRIPE_CURRENCY || 'usd').toLowerCase(),
    singlePriceCents: intFromEnv('SINGLE_EXPORT_PRICE_CENTS', 500, { min: 1 }),
    monthlyPriceCents: intFromEnv('MONTHLY_PRICE_CENTS', 1900, { min: 1 }),
    singlePriceId: (process.env.STRIPE_PRICE_SINGLE_ID || '').trim(),
    monthlyPriceId: (process.env.STRIPE_PRICE_MONTHLY_ID || '').trim(),
    singlePassHours: intFromEnv('SINGLE_EXPORT_PASS_HOURS', 24, { min: 1, max: 168 }),
    subscriptionDays: intFromEnv('SUBSCRIPTION_ACCESS_DAYS', 31, { min: 1, max: 366 }),
  },
};

module.exports = config;

'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { rateLimit } = require('express-rate-limit');
const config = require('./config');
const apiRouter = require('./routes/api');
const billingController = require('./controllers/billingController');
const healthController = require('./controllers/healthController');
const { asyncHandler } = require('./utils/asyncHandler');
const { notFoundHandler, errorHandler } = require('./middleware/errors');

const app = express();
const publicDir = path.join(__dirname, '..', 'public');
const viewFile = path.join(publicDir, 'views', 'index.html');

app.disable('x-powered-by');

// Render and Railway terminate TLS at a single reverse proxy. Trusting exactly
// that hop gives express-rate-limit and req.secure the real client IP/protocol
// without trusting arbitrary X-Forwarded-* values.
if (config.trustProxy) app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);
app.use(compression());
app.use(cookieParser());

const corsOrigins = config.corsOrigins;

app.use(
  '/api',
  cors({
    origin(origin, callback) {
      // Same-origin requests and server-to-server calls have no Origin header.
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, corsOrigins.includes(origin));
    },
    credentials: corsOrigins.length > 0,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Stripe-Signature'],
    maxAge: 86_400,
  }),
);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many requests. Please wait a few minutes and try again.',
    },
  },
});

const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many checkout attempts. Please wait a few minutes and try again.',
    },
  },
});

app.post(
  ['/api/webhook', '/api/billing/webhook'],
  express.raw({ type: 'application/json', limit: '1mb' }),
  asyncHandler(billingController.webhook),
);

app.use('/api/billing/checkout', checkoutLimiter);

app.use(
  '/api',
  express.json({ limit: '200kb' }),
  apiLimiter,
  (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  },
  apiRouter,
);

app.use('/api', (req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'That API endpoint does not exist.' },
  });
});

app.get('/health', healthController.health);

app.get('/', (req, res) => {
  res.sendFile(viewFile);
});

app.use(
  express.static(publicDir, {
    etag: true,
    maxAge: config.isProduction ? '1h' : 0,
    extensions: ['html'],
  }),
);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;

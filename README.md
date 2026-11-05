# TidyData — Data Cleaner & Converter

TidyData is a full-stack CSV/JSON cleaner built with Node.js, Express, and Tailwind CSS. Upload a messy file, clean it up, preview every change, and download production-ready CSV or JSON. A hands-off freemium flow lets anyone clean small files for free while Stripe Checkout unlocks large datasets, bulk cleaning, and premium export formats immediately after payment.

## Features

- **Upload CSV, TSV, JSON, or NDJSON** up to 10 MB by default.
- **Clean automatically**: remove duplicate rows, drop empty rows/columns, trim whitespace, normalize headers, fix null/empty cells, and normalize numbers, booleans, and dates.
- **Live before/after preview** of the first 50 rows, with full statistics for the whole file.
- **Convert formats**: export CSV or JSON for free; NDJSON and TSV are premium formats.
- **Spreadsheet-friendly CSV**: UTF-8 BOM and CRLF line endings for Excel compatibility.
- **Durable by default**: with `DATABASE_URL` set, entitlements, webhook event IDs, and uploaded/cleaned datasets are stored in PostgreSQL and survive restarts and redeploys. Files still expire after `FILE_TTL_MINUTES`.
- **Automatic migrations**: SQL migrations run on startup (and via `npm run db:migrate`) with a PostgreSQL advisory lock for safe concurrent deploys.
- **Freemium limits**: free users can preview any supported file, clean files up to `FREE_TIER_MAX_ROWS` / `FREE_TIER_MAX_FILE_MB`, and download CSV/JSON. Large files, bulk jobs, and premium formats require a pass.
- **Stripe Checkout**: $5 one-time pass or $19/month for unlimited large-file cleaning, bulk processing, and premium exports.
- **Automatic webhook access**: `POST /api/webhook` verifies Stripe signatures, grants the entitlement immediately, and the success redirect sets a signed browser cookie. If the webhook arrives first, the redirect reuses that entitlement instead of calling Stripe again.
- **Autonomous upgrade flow**: a blocked large file remains available in the file store; after payment the browser restores the saved workspace and automatically retries the clean.
- **Sandbox mode**: complete the whole purchase flow without a real card or charge.
- **Server-enforced gating**: clean, download, format, and bulk endpoints all enforce entitlements independently of the UI.
- **Production-ready deployment**: Render/Railway manifests, proxy-aware CORS, and a detailed `/health` endpoint for uptime and readiness monitoring.
- **Responsive UI** with dark mode, keyboard-accessible dialogs, toasts, and inline errors.

## Requirements

- Node.js **20 or newer**
- npm 9 or newer
- A modern browser
- PostgreSQL **13 or newer** for durable production storage (optional for local development)

## Quick start

Run these commands from the project directory:

```powershell
cd C:\Users\midorya\Desktop\data-cleaner
npm install
Copy-Item .env.example .env
npm run build:css
npm start
```

Then open <http://127.0.0.1:3000>. With `DATABASE_URL` empty, local development uses the in-memory stores and resets on restart.

To develop against PostgreSQL, create a database, set `DATABASE_URL`, and start the app; migrations run automatically:

```dotenv
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/tidydata
AUTO_MIGRATE=true
```

```powershell
npm run db:migrate   # optional manual migration run
npm start
```

For development with automatic server restarts and Tailwind rebuilds:

```powershell
npm run dev
```

`npm run dev` runs the server with `node --watch` and Tailwind in watch mode. The prebuilt CSS is already included, so `npm run build:css` is only needed after editing HTML/JS classes or `src/styles/tailwind.css`.

## Data persistence

TidyData selects its store implementation at startup:

- `DATABASE_URL` set â€” PostgreSQL stores entitlements, Stripe webhook deduplication state, and uploaded/cleaned datasets.
- `DATABASE_URL` empty â€” in-memory stores are used for tests and local development. `NODE_ENV=production` refuses to start without a database.

PostgreSQL schema (`db/migrations/001_initial.sql`):

- `entitlements` â€” plan, active/revoked status, export credits, session ID, Stripe customer/subscription IDs, customer email, sandbox flag, expiry, and revoked timestamp.
- `processed_webhook_events` â€” Stripe event IDs claimed atomically so retries are not processed twice.
- `files` â€” file kind/source relationship, name, format, size, gzipped dataset payload (`bytea`), creation time, and expiry.

Uploaded files are still temporary: expired rows are purged every 60 seconds and every read requires `expires_at > now()`. Billing entitlements persist until their configured access window ends or Stripe sends a cancellation webhook.

Migrations are tracked in `schema_migrations` and wrapped in a transaction under a PostgreSQL advisory lock, so multiple instances can start or deploy concurrently. The server runs them automatically when `AUTO_MIGRATE=true`; `npm run db:migrate` runs the same migration runner manually.

## Pricing and billing

| Plan | Price | What you get |
| --- | --- | --- |
| Free | $0 | Preview any supported file; clean/download up to `FREE_TIER_MAX_ROWS` rows and `FREE_TIER_MAX_FILE_MB` per file; CSV/JSON exports |
| Export pass | $5 one-time | One premium export credit, 24 hours of large-file access, bulk processing, NDJSON/TSV exports |
| Monthly | $19/month | Unlimited large-file cleaning, bulk processing, and premium exports while the subscription is active |

How gating works:

- Free users may upload and preview files up to the global `MAX_FILE_SIZE_MB` limit.
- `POST /api/clean` returns HTTP `402 Payment Required` when the file exceeds `FREE_TIER_MAX_ROWS` or `FREE_TIER_MAX_FILE_MB`.
- The uploaded source file stays in the file store after a `402`, so the browser can retry the same file after checkout without re-uploading.
- `POST /api/clean/bulk` requires an active premium entitlement and accepts up to `BULK_MAX_FILES` source files.
- CSV and JSON are free export formats. `PREMIUM_EXPORT_FORMATS` defaults to `ndjson,tsv`; those formats return `402` without an active entitlement.
- `HIGH_VOLUME_ROW_LIMIT` is a second, export-side guard: downloads above that row count require an entitlement even if the file was cleaned earlier.
- A single pass consumes one credit on the first premium/high-volume download. A monthly entitlement is unlimited and does not consume credits.
- A `402` response includes `billing`, `access`, and `error.details` so a client can render a contextual paywall.

### Autonomous upgrade flow

1. User uploads a large file. Upload succeeds so the preview is visible.
2. Clicking **Clean data** returns `402` with the free-tier limits and opens checkout.
3. The workspace (source file id, options, and cleaned file if present) is saved in `sessionStorage`.
4. Stripe Checkout completes. `POST /api/webhook` verifies the signature and records the entitlement immediately.
5. Stripe redirects to `/api/billing/success?session_id=...`. The server reuses the webhook entitlement when present, otherwise verifies the session with Stripe, then sets the signed `td_export_pass` cookie.
6. The browser returns to `/`, restores the saved workspace, verifies billing, and automatically retries the clean. The user can download immediately.

### Sandbox checkout (default in development)

No Stripe keys are required to try the payment UI:

- Sandbox mode is enabled by default outside production.
- Open the checkout modal from the Pricing section, the paywall, or the `Unlock` button.
- Leave **Sandbox mode** switched on and click **Complete sandbox purchase**.
- The server immediately issues a signed entitlement cookie, and the client resumes the pending clean or download.
- Sandbox checkout can be disabled server-side with `ENABLE_BILLING_SANDBOX=false`; the client cannot enable it when it is disabled.

### Real Stripe Checkout

1. Copy `.env.example` to `.env`.
2. Add your Stripe test or live secret key:

   ```dotenv
   STRIPE_SECRET_KEY=sk_test_...
   APP_URL=http://127.0.0.1:3000
   ENABLE_BILLING_SANDBOX=false
   BILLING_SECRET=generate-a-long-random-string
   ```

3. Start the app and open the checkout modal. With sandbox disabled, the pay button redirects to Stripe Checkout.
4. Optional: use pre-created Stripe Prices instead of dynamic `price_data`:

   ```dotenv
   STRIPE_PRICE_SINGLE_ID=price_...
   STRIPE_PRICE_MONTHLY_ID=price_...
   ```

5. Forward webhooks to the public endpoint:

   ```powershell
   stripe listen --forward-to localhost:3000/api/webhook
   ```

   Copy the printed signing secret into `STRIPE_WEBHOOK_SECRET`.

   The legacy alias `/api/billing/webhook` also works.

Supported webhook events:

- `checkout.session.completed` — grants access if the success redirect was missed.
- `checkout.session.async_payment_succeeded` — grants access for delayed payment methods.
- `invoice.paid` — extends a monthly entitlement.
- `customer.subscription.deleted` — revokes a cancelled subscription's entitlement.

Subscription cancellation through the Stripe billing portal is not included in this UI. Wire Stripe's customer portal or your own account page if you need self-serve cancellation. The monthly entitlement automatically expires after `SUBSCRIPTION_ACCESS_DAYS` (31 by default) if renewal webhooks are not received.

### Deployment (Render / Railway)

Production deployment files are included:

- `render.yaml` — Render Blueprint with build/start commands, `/health` checks, and production variables.
- `Procfile` — declares the web process for Railway/Procfile-compatible platforms.
- `.env.production.example` — complete production environment template.
- `DEPLOYMENT.md` — step-by-step guide to live Stripe keys, webhook setup, custom domains, verification, and rollback.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the full walkthrough.

Key production behavior:

- `NODE_ENV=production` defaults `HOST` to `0.0.0.0` so the platform can reach the process.
- `APP_URL` is the public HTTPS origin used for Stripe redirects. If unset, the app falls back to `RENDER_EXTERNAL_URL` or `RAILWAY_PUBLIC_DOMAIN` (then to `http://HOST:PORT` locally).
- CORS always allows the `APP_URL` origin. `CORS_ORIGIN` adds a comma-separated list of extra origins; wildcards are not used and credentials are enabled.
- `TRUST_PROXY=true` should be set on Render/Railway; it trusts exactly one reverse-proxy hop.
- Sandbox checkout is disabled by default in production. Keep `ENABLE_BILLING_SANDBOX=false` on public deployments.
- `DATABASE_URL` is required in production. `render.yaml` provisions a Render PostgreSQL instance and injects its internal connection string; on Railway, add the PostgreSQL plugin and reference `DATABASE_URL`.
- Entitlements, webhook deduplication, and uploaded/cleaned datasets are stored in PostgreSQL, so restarts, redeploys, and horizontal scaling no longer clear purchases or active sessions.
- Uploads are never written to local disk. Datasets are gzipped into the PostgreSQL `files` table and purged after `FILE_TTL_MINUTES`; expired rows are removed by a periodic sweep.
- Migrations run automatically at startup when `AUTO_MIGRATE=true` (the default). The included Render Blueprint also runs `npm run db:migrate` as a pre-deploy command; both paths use an advisory lock, so concurrent deploys are safe.
- `DATABASE_SSL=true` enables TLS for external/public database URLs. Internal Render/Railway connections normally stay on the private network.

### Health and monitoring

`GET /health` (also available at `GET /api/health`) is safe for platform health checks and uptime monitors. It returns HTTP `200` with `status: "ok"` when the stores are ready, or HTTP `503` with `status: "degraded"` otherwise. Responses are never cached.

```json
{
  "status": "ok",
  "service": "tidydata",
  "uptimeSeconds": 42,
  "memory": {
    "rss": { "bytes": 73400320, "megabytes": 70 },
    "heapUsedPercent": 31.4
  },
  "stores": {
    "ready": true,
    "persistence": "postgres",
    "fileStore": { "ready": true, "driver": "postgres" },
    "billingStore": { "ready": true, "driver": "postgres" },
    "database": {
      "configured": true,
      "required": true,
      "ready": true,
      "status": "ready",
      "driver": "postgres"
    }
  }
}
```

The response also includes the process ID, Node version, environment, timestamp, start time, formatted uptime, and external/array-buffer memory. The Render Blueprint uses `/health` as its deploy health check; set the same path in Railway's service settings.

## Cleaning rules

The default recipe enables all of the following, and each option can be toggled in the UI:

- Remove exact duplicate rows (all columns or a chosen column).
- Remove rows where every cell is empty.
- Drop columns that are completely empty.
- Normalize headers to snake_case.
- Trim leading/trailing whitespace from cells.
- Convert numeric-looking strings to numbers.
- Convert common boolean values to `true`/`false`.
- Normalize common date formats to ISO `YYYY-MM-DD`.
- Turn empty strings into `null` values.

Column headers and row values are kept consistent, and the API returns warnings when a cleanup changes the dataset shape unexpectedly.

## API reference

All API responses are JSON unless noted. Billing, upload, and health endpoints set `Cache-Control: no-store`.

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/health` | Process, memory, uptime, and store-readiness health check (`200`/`503`) |
| `GET` | `/api/health` | Alias of `/health` for clients that only call the API prefix |
| `GET` | `/api/sample` | Download the bundled messy CSV sample |
| `POST` | `/api/upload` | Upload a file as multipart field `file`; returns preview, `file.id`, and free-tier `access` |
| `POST` | `/api/clean` | Body `{ "fileId": "...", "options": { ... } }`; returns cleaned preview, stats, and `cleaned.id`; `402` above free limits |
| `POST` | `/api/clean/bulk` | Premium only. Body `{ "fileIds": ["...", "..."], "options": { ... } }`; cleans up to `BULK_MAX_FILES` files |
| `GET` | `/api/download/:id?format=csv\|json\|ndjson\|tsv` | Download a cleaned file. Returns `402` for premium formats or high-volume exports without an entitlement |
| `DELETE` | `/api/files/:id` | Delete a stored file early |
| `GET` | `/api/billing/status` | Billing configuration, prices, free-tier limits, premium formats, and current entitlement |
| `POST` | `/api/billing/checkout` | Body `{ "plan": "single\|monthly", "sandbox": true\|false }` |
| `GET` | `/api/billing/success` | Stripe success redirect target; reuses the webhook entitlement or verifies the session, then sets the cookie |
| `POST` | `/api/webhook` | Public Stripe webhook receiver (raw body, signature verified) |
| `POST` | `/api/billing/webhook` | Legacy alias of `/api/webhook` |

Example: upload and clean with PowerShell

```powershell
$upload = Invoke-RestMethod -Uri http://127.0.0.1:3000/api/upload -Method Post -Form @{ file = Get-Item .\sample.csv }
$clean = Invoke-RestMethod -Uri http://127.0.0.1:3000/api/clean -Method Post -ContentType 'application/json' -Body (@{
  fileId = $upload.file.id
  options = @{ removeDuplicates = $true; trimWhitespace = $true }
} | ConvertTo-Json)
Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/download/$($clean.cleaned.id)?format=csv" -OutFile cleaned.csv
```

A `402` response includes the billing state so a client can render the paywall:

```json
{
  "error": {
    "code": "PAYMENT_REQUIRED",
    "message": "This file has 12,000 rows. The free plan cleans up to 500 rows and 1 MB per file. Upgrade to clean large files, run bulk jobs, and unlock NDJSON/TSV exports.",
    "details": {
      "reason": "FREE_ROW_LIMIT",
      "fileId": "…",
      "rowCount": 12000,
      "limits": { "maxRows": 500, "maxFileSizeMb": 1 }
    }
  },
  "billing": {
    "highVolumeRowLimit": 5000,
    "freeTier": { "maxRows": 500, "maxFileSizeMb": 1 },
    "premiumExportFormats": ["ndjson", "tsv"],
    "prices": { "single": { "display": "$5" }, "monthly": { "display": "$19" } },
    "entitlement": null
  },
  "access": { "allowed": false, "premium": false, "reason": "FREE_ROW_LIMIT" }
}
```

## Project structure

```text
data-cleaner/
├─ server.js                     # Startup migrations, HTTP server, graceful shutdown
├─ package.json
├─ render.yaml                   # Render web service + PostgreSQL blueprint
├─ Procfile                      # Web process declaration
├─ .env.example                  # Local environment template
├─ .env.production.example       # Production environment template
├─ DEPLOYMENT.md                 # Deployment, Stripe, and domain guide
├─ db/
│  └─ migrations/
│     └─ 001_initial.sql         # Entitlements, webhook events, and files schema
├─ scripts/
│  └─ migrate.js                 # Manual `npm run db:migrate` runner
├─ src/
│  ├─ app.js                     # Express app, CORS, proxy, static views
│  ├─ config.js                  # Environment parsing and defaults
│  ├─ db/
│  │  ├─ database.js             # PostgreSQL pool, transactions, health
│  │  ├─ migrate.js              # Advisory-locked SQL migration runner
│  │  └─ initialize.js           # Startup migration and production fail-fast
│  ├─ routes/api.js              # API router
│  ├─ controllers/
│  │  ├─ dataController.js       # Upload, clean, download, delete
│  │  ├─ billingController.js    # Status, checkout, success, webhook
│  │  └─ healthController.js     # Memory, uptime, and store readiness
│  ├─ services/
│  │  ├─ parser.js               # CSV/TSV/JSON/NDJSON parsing
│  │  ├─ cleaner.js              # Cleaning engine
│  │  ├─ exporter.js             # CSV/JSON/NDJSON/TSV serialization
│  │  ├─ fileStore.js            # Memory/Postgres expiring file storage
│  │  ├─ billing.js              # Stripe, entitlement cookies, access checks
│  │  └─ billingStore.js         # Memory/Postgres entitlement ledger
│  ├─ middleware/                # Multer upload and error handling
│  ├─ utils/                     # Async handler, header helpers
│  ├─ fixtures/sample.csv
│  └─ styles/tailwind.css
├─ public/
│  ├─ views/index.html           # Main UI
│  ├─ js/app.js                  # Client interactions, preview, billing UI
│  ├─ js/theme.js                # Early dark-mode setup
│  ├─ css/styles.css             # Built Tailwind output
│  └─ favicon.svg
└─ test/
   ├─ api.test.js
   ├─ billing.test.js
   ├─ freemium.test.js
   ├─ webhook.test.js
   ├─ postgres.test.js
   ├─ cleaner.test.js
   └─ parser.test.js
```

## Testing

```powershell
npm test
```

The suite covers parsing, cleaning, exports, request validation, health/memory/store reporting, CORS allowlisting, free-tier row and file-size limits, premium format gating, bulk processing, billing status, single-pass credit consumption, monthly unlimited access, sandbox refusal, public webhook signature verification, event deduplication, and immediate post-payment access. Tests use Node's built-in test runner and an ephemeral port. The PostgreSQL adapters are additionally exercised against an embedded PostgreSQL (PGlite) using the real migration: entitlement lifecycle, credits, subscription renewal/revocation, webhook claims, gzipped file round-trips, and TTL expiry.

## Configuration reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` (`0.0.0.0` in production) | Bind address |
| `NODE_ENV` | `development` | Enables production behavior and disables sandbox by default |
| `APP_URL` | platform URL or `http://HOST:PORT` | Public base URL for Stripe redirects; its origin is always CORS-allowed |
| `CORS_ORIGIN` | empty | Extra comma-separated allowed origins for `/api` |
| `TRUST_PROXY` | `false` (`true` in production) | Trust one reverse-proxy hop so client IP/protocol are correct |
| `DATABASE_URL` | empty | PostgreSQL connection string; required in production for durable entitlements and files |
| `DATABASE_SSL` | `false` | Enable TLS for external/public PostgreSQL connections |
| `DATABASE_POOL_MAX` | `10` | Maximum PostgreSQL pool connections per process |
| `AUTO_MIGRATE` | `true` | Run pending SQL migrations when the server starts |
| `MAX_FILE_SIZE_MB` | `10` | Global upload size limit (free files can still be previewed above the free limit) |
| `MAX_ROWS` | `200000` | Maximum parsed rows |
| `MAX_COLUMNS` | `200` | Maximum parsed columns |
| `FILE_TTL_MINUTES` | `30` | Stored file lifetime before TTL cleanup |
| `FREE_TIER_MAX_ROWS` | `500` | Maximum rows a free user can clean/download |
| `FREE_TIER_MAX_FILE_MB` | `1` | Maximum source file size a free user can clean/download |
| `PREMIUM_EXPORT_FORMATS` | `ndjson,tsv` | Comma-separated premium formats; use `none` to disable format gating |
| `BULK_MAX_FILES` | `10` | Maximum files per premium bulk clean request |
| `STRIPE_SECRET_KEY` | empty | Enables real Stripe Checkout |
| `STRIPE_WEBHOOK_SECRET` | empty | Verifies webhook signatures |
| `STRIPE_PRICE_SINGLE_ID` | empty | Optional one-time Stripe Price ID |
| `STRIPE_PRICE_MONTHLY_ID` | empty | Optional recurring Stripe Price ID |
| `STRIPE_CURRENCY` | `usd` | Currency for dynamic prices |
| `SINGLE_EXPORT_PRICE_CENTS` | `500` | One-time pass price |
| `MONTHLY_PRICE_CENTS` | `1900` | Monthly price |
| `ENABLE_BILLING_SANDBOX` | `true` outside production | Allows simulated purchases |
| `BILLING_SECRET` | random per process | Signs entitlement cookies; set this in production |
| `HIGH_VOLUME_ROW_LIMIT` | `5000` | Export-side guard: rows above this require entitlement |
| `SINGLE_EXPORT_PASS_HOURS` | `24` | One-time pass lifetime |
| `SUBSCRIPTION_ACCESS_DAYS` | `31` | Monthly access lifetime before renewal webhook |

## Troubleshooting

- **“Checkout unavailable”** — no Stripe key is configured and sandbox is disabled. Add `STRIPE_SECRET_KEY` or enable `ENABLE_BILLING_SANDBOX`.
- **Checkout redirects fail** — `APP_URL` must match the URL you are actually using. For real Stripe, HTTPS is required outside localhost.
- **Browser CORS error** — add the request origin to `CORS_ORIGIN` (scheme + host + port). The `APP_URL` origin is allowed automatically.
- **Platform health check fails** — confirm `HOST=0.0.0.0`, the platform-injected `PORT` is used, and `GET /health` returns `200` locally.
- **Payment succeeded but access is missing** — confirm Stripe is posting `checkout.session.completed` (or `checkout.session.async_payment_succeeded`) to `https://yourdomain.com/api/webhook`, and that `STRIPE_WEBHOOK_SECRET` matches the endpoint. The success redirect also verifies the session directly, so check `/api/billing/success?session_id=...` in the Stripe dashboard if the webhook was missed.
- **Files or purchases disappear after restart** — production requires `DATABASE_URL`. If it is missing, the app refuses to start; local development without it intentionally uses memory. Confirm the database service is reachable and `/health` reports `stores.persistence: "postgres"`.
- **Port already in use** — change `PORT` in `.env` or stop the process using port 3000.
- **Styles look stale after edits** — run `npm run build:css` (or use `npm run dev`).

## License

MIT

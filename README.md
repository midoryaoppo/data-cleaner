# TidyData — Data Cleaner & Converter

TidyData is a full-stack CSV/JSON cleaner built with Node.js, Express, and Tailwind CSS. Upload a messy file, clean it up, preview every change, and download production-ready CSV or JSON. High-volume downloads are gated behind Stripe Checkout with a built-in sandbox mode for testing.

## Features

- **Upload CSV, TSV, JSON, or NDJSON** up to 10 MB by default.
- **Clean automatically**: remove duplicate rows, drop empty rows/columns, trim whitespace, normalize headers, fix null/empty cells, and normalize numbers, booleans, and dates.
- **Live before/after preview** of the first 50 rows, with full statistics for the whole file.
- **Convert formats**: export the cleaned dataset as CSV or JSON.
- **Spreadsheet-friendly CSV**: UTF-8 BOM and CRLF line endings for Excel compatibility.
- **Private by default**: files are parsed in memory and expire after 30 minutes. Nothing is written to disk.
- **Stripe Checkout**: $5 one-time export pass, or $19/month for unlimited high-volume exports.
- **Sandbox mode**: complete the whole purchase flow without a real card or charge.
- **Server-enforced download gating**: a high-volume export cannot be downloaded without a valid entitlement.
- **Production-ready deployment**: Render/Railway manifests, proxy-aware CORS, and a detailed `/health` endpoint for uptime and readiness monitoring.
- **Responsive UI** with dark mode, keyboard-accessible dialogs, toasts, and inline errors.

## Requirements

- Node.js **20 or newer**
- npm 9 or newer
- A modern browser

## Quick start

Run these commands from the project directory:

```powershell
cd C:\Users\midorya\Desktop\data-cleaner
npm install
Copy-Item .env.example .env
npm run build:css
npm start
```

Then open <http://127.0.0.1:3000>.

For development with automatic server restarts and Tailwind rebuilds:

```powershell
npm run dev
```

`npm run dev` runs the server with `node --watch` and Tailwind in watch mode. The prebuilt CSS is already included, so `npm run build:css` is only needed after editing HTML/JS classes or `src/styles/tailwind.css`.

## Pricing and billing

| Plan | Price | What you get |
| --- | --- | --- |
| Free | $0 | Clean unlimited files and download up to `HIGH_VOLUME_ROW_LIMIT` rows (5,000 by default) |
| Export pass | $5 one-time | One high-volume export download, valid for 24 hours |
| Monthly | $19/month | Unlimited high-volume exports while the subscription is active |

How gating works:

- Files at or below the free row limit can always be downloaded.
- Cleaned files above the limit return HTTP `402 Payment Required` until the browser has an active entitlement cookie.
- A single pass consumes one credit per successful download.
- A monthly entitlement is unlimited and does not consume credits.
- The threshold is configured with `HIGH_VOLUME_ROW_LIMIT`.

### Sandbox checkout (default in development)

No Stripe keys are required to try the payment UI:

- Sandbox mode is enabled by default outside production.
- Open the checkout modal from the Pricing section, the paywall, or the `Unlock` button.
- Leave **Sandbox mode** switched on and click **Complete sandbox purchase**.
- The server immediately issues a signed entitlement cookie. No real money moves.
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

5. For subscription renewals and cancellations, forward webhooks to the app:

   ```powershell
   stripe listen --forward-to localhost:3000/api/billing/webhook
   ```

   Copy the printed signing secret into `STRIPE_WEBHOOK_SECRET`.

Supported webhook events:

- `checkout.session.completed` — grants access if the success redirect was missed.
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
- Entitlements and uploaded files are stored **in memory**. A restart clears them, and the app is intended to run as a single instance. For multi-instance or durable billing, replace `src/services/billingStore.js` and `src/services/fileStore.js` with Redis/Postgres-backed implementations. The interfaces are intentionally small.
- The app does not write uploads to disk; if you add a database, treat data retention as a product decision.

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
    "persistence": "in-memory",
    "fileStore": { "ready": true, "driver": "memory" },
    "billingStore": { "ready": true, "driver": "memory" },
    "database": {
      "configured": false,
      "required": false,
      "ready": null,
      "status": "not_configured"
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
| `POST` | `/api/upload` | Upload a file as multipart field `file`; returns preview and `file.id` |
| `POST` | `/api/clean` | Body `{ "fileId": "...", "options": { ... } }`; returns cleaned preview, stats, and `cleaned.id` |
| `GET` | `/api/download/:id?format=csv\|json` | Download a cleaned file. Returns `402` when payment is required |
| `DELETE` | `/api/files/:id` | Delete a stored file early |
| `GET` | `/api/billing/status` | Billing configuration, prices, row limit, and current entitlement |
| `POST` | `/api/billing/checkout` | Body `{ "plan": "single\|monthly", "sandbox": true\|false }` |
| `GET` | `/api/billing/success` | Stripe success redirect target; verifies the session and sets the entitlement cookie |
| `POST` | `/api/billing/webhook` | Stripe webhook receiver (raw body, signature verified) |

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
    "message": "This export has 5,005 rows. Free downloads cover up to 5,000 rows — buy an export pass for $5 or subscribe for $19/month."
  },
  "billing": {
    "highVolumeRowLimit": 5000,
    "prices": { "single": { "display": "$5" }, "monthly": { "display": "$19" } },
    "entitlement": null
  }
}
```

## Project structure

```text
data-cleaner/
├─ server.js                     # HTTP server and graceful shutdown
├─ package.json
├─ render.yaml                   # Render Blueprint (build, health check, env)
├─ Procfile                      # Web process declaration
├─ .env.example                  # Local environment template
├─ .env.production.example       # Production environment template
├─ DEPLOYMENT.md                 # Deployment, Stripe, and domain guide
├─ src/
│  ├─ app.js                     # Express app, CORS, proxy, static views
│  ├─ config.js                  # Environment parsing and defaults
│  ├─ routes/api.js              # API router
│  ├─ controllers/
│  │  ├─ dataController.js       # Upload, clean, download, delete
│  │  ├─ billingController.js    # Status, checkout, success, webhook
│  │  └─ healthController.js     # Memory, uptime, and store readiness
│  ├─ services/
│  │  ├─ parser.js               # CSV/TSV/JSON/NDJSON parsing
│  │  ├─ cleaner.js              # Cleaning engine
│  │  ├─ exporter.js             # CSV/JSON serialization
│  │  ├─ fileStore.js            # Expiring in-memory file storage
│  │  ├─ billing.js              # Stripe, entitlement cookies, access checks
│  │  └─ billingStore.js         # In-memory entitlement ledger
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
   ├─ cleaner.test.js
   └─ parser.test.js
```

## Testing

```powershell
npm test
```

The suite covers parsing, cleaning, exports, request validation, health/memory/store reporting, CORS allowlisting, billing status, paywall enforcement, single-pass credit consumption, monthly unlimited access, and server-side sandbox refusal. Tests use Node's built-in test runner and an ephemeral port.

## Configuration reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` (`0.0.0.0` in production) | Bind address |
| `NODE_ENV` | `development` | Enables production behavior and disables sandbox by default |
| `APP_URL` | platform URL or `http://HOST:PORT` | Public base URL for Stripe redirects; its origin is always CORS-allowed |
| `CORS_ORIGIN` | empty | Extra comma-separated allowed origins for `/api` |
| `TRUST_PROXY` | `false` (`true` in production) | Trust one reverse-proxy hop so client IP/protocol are correct |
| `MAX_FILE_SIZE_MB` | `10` | Upload size limit |
| `MAX_ROWS` | `200000` | Maximum parsed rows |
| `MAX_COLUMNS` | `200` | Maximum parsed columns |
| `FILE_TTL_MINUTES` | `30` | In-memory file lifetime |
| `STRIPE_SECRET_KEY` | empty | Enables real Stripe Checkout |
| `STRIPE_WEBHOOK_SECRET` | empty | Verifies webhook signatures |
| `STRIPE_PRICE_SINGLE_ID` | empty | Optional one-time Stripe Price ID |
| `STRIPE_PRICE_MONTHLY_ID` | empty | Optional recurring Stripe Price ID |
| `STRIPE_CURRENCY` | `usd` | Currency for dynamic prices |
| `SINGLE_EXPORT_PRICE_CENTS` | `500` | One-time pass price |
| `MONTHLY_PRICE_CENTS` | `1900` | Monthly price |
| `ENABLE_BILLING_SANDBOX` | `true` outside production | Allows simulated purchases |
| `BILLING_SECRET` | random per process | Signs entitlement cookies; set this in production |
| `HIGH_VOLUME_ROW_LIMIT` | `5000` | Rows above this require entitlement |
| `SINGLE_EXPORT_PASS_HOURS` | `24` | One-time pass lifetime |
| `SUBSCRIPTION_ACCESS_DAYS` | `31` | Monthly access lifetime before renewal webhook |

## Troubleshooting

- **“Checkout unavailable”** — no Stripe key is configured and sandbox is disabled. Add `STRIPE_SECRET_KEY` or enable `ENABLE_BILLING_SANDBOX`.
- **Checkout redirects fail** — `APP_URL` must match the URL you are actually using. For real Stripe, HTTPS is required outside localhost.
- **Browser CORS error** — add the request origin to `CORS_ORIGIN` (scheme + host + port). The `APP_URL` origin is allowed automatically.
- **Platform health check fails** — confirm `HOST=0.0.0.0`, the platform-injected `PORT` is used, and `GET /health` returns `200` locally.
- **Payment succeeded but access is missing** — wait for the success redirect or configure `STRIPE_WEBHOOK_SECRET` and forward `checkout.session.completed`.
- **Files or purchases disappear after restart** — expected with the default in-memory stores. Configure `BILLING_SECRET` for cookie continuity and replace the stores for durable data.
- **Port already in use** — change `PORT` in `.env` or stop the process using port 3000.
- **Styles look stale after edits** — run `npm run build:css` (or use `npm run dev`).

## License

MIT

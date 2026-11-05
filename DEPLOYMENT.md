# Deploying TidyData to Production

This guide covers deploying TidyData to **Render** or **Railway**, connecting live Stripe credentials, adding a custom domain, and verifying the deployment.

The repository includes:

- `render.yaml` — Render Blueprint with health checks and production settings.
- `Procfile` — Railway/Heroku-compatible web process definition.
- `.env.production.example` — complete production environment template.
- `GET /health` — machine-readable process, memory, uptime, and store readiness endpoint.

> **Before taking real payments:** uploaded files and billing entitlements are currently stored in process memory. A restart or deploy clears them. The deployment is safe for testing and demos, but for a real paid launch replace `src/services/fileStore.js` and `src/services/billingStore.js` with Redis/Postgres-backed stores first. See [Store durability and zero-downtime](#10-store-durability-and-zero-downtime).

## 1. Prerequisites

- A GitHub/GitLab repository containing this project.
- A [Render](https://render.com) or [Railway](https://railway.app) account.
- A Stripe account with completed business/payout details.
- A custom domain (optional, but recommended for Stripe live mode).
- Node.js 20+ locally for generating secrets and testing.

Do not commit `.env`, `.env.production`, or any real key. The included `.gitignore` excludes `.env`, `.env.local`, and `.env.production`.

## 2. Generate production secrets

Generate a strong cookie-signing secret:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Copy the output into `BILLING_SECRET`. Keep it stable across deploys. Changing it invalidates every existing entitlement cookie.

## 3. Get live Stripe API keys

1. Sign in to the [Stripe Dashboard](https://dashboard.stripe.com).
2. Complete account activation and business verification.
3. Switch the Dashboard out of **Test mode** (toggle in the top-right).
4. Go to **Developers → API keys**.
5. Copy the **Secret key** (`sk_live_...`) into `STRIPE_SECRET_KEY`.
6. Never expose the secret key in client-side code or commit it to Git.

For the first rehearsal, deploy with test keys (`sk_test_...`), complete a purchase with Stripe test card `4242 4242 4242 4242`, then swap in live keys.

## 4. Configure Stripe products and prices (optional)

TidyData defaults to dynamic `price_data` using:

- `SINGLE_EXPORT_PRICE_CENTS=500` (`$5` one-time)
- `MONTHLY_PRICE_CENTS=1900` (`$19` every month)

To use pre-created Stripe Prices instead:

1. Go to **Product catalog → Add product**.
2. Create a **TidyData export pass** product with a one-time **$5** price.
3. Create a **TidyData Pro** product with a recurring **$19/month** price.
4. Copy each Price ID (`price_...`) into `STRIPE_PRICE_SINGLE_ID` and `STRIPE_PRICE_MONTHLY_ID`.
5. Leave either variable empty to keep dynamic pricing for that plan.

## 5. Deploy to Render

### Blueprint deployment

1. Push the repository to GitHub/GitLab.
2. In Render, choose **New → Blueprint** and connect the repository.
3. Render reads `render.yaml` and proposes the `tidydata` web service.
4. Set the required secret environment variables when prompted:
   - `APP_URL` — use the final HTTPS domain, or the service's `onrender.com` URL for the first deploy and update it after adding a custom domain
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
5. Apply the Blueprint. Add optional `STRIPE_PRICE_SINGLE_ID` / `STRIPE_PRICE_MONTHLY_ID` values under **Environment** afterward.

The Blueprint configures:

- Build: `npm ci --include=dev && npm run build:css`
- Start: `npm start`
- Health check: `/health`
- Auto-deploy on every push
- A 10-second graceful-shutdown window before the platform forcefully stops the old instance
- `HOST=0.0.0.0`, `NODE_ENV=production`, `TRUST_PROXY=true`
- `ENABLE_BILLING_SANDBOX=false`
- Auto-generated `BILLING_SECRET`

The `0.5c-512mb` paid instance type is used so Render can keep the service warm and perform health-checked rolling deploys. The free plan spins down after inactivity and is not suitable for production checkout. Upgrade the plan if you expect consistently large uploads; parsed files are held in memory.

### Render environment variables

After the first deploy, open **Service → Environment** and confirm:

```text
NODE_ENV=production
HOST=0.0.0.0
TRUST_PROXY=true
APP_URL=https://yourdomain.com
BILLING_SECRET=<generated long random secret>
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
ENABLE_BILLING_SANDBOX=false
FREE_TIER_MAX_ROWS=500
FREE_TIER_MAX_FILE_MB=1
PREMIUM_EXPORT_FORMATS=ndjson,tsv
BULK_MAX_FILES=10
```

Render injects `PORT` automatically. Do not hardcode it.

### Render health check

The service is only considered live when `GET /health` returns HTTP 200 (`/api/health` is an alias). The endpoint reports:

- process ID, Node version, environment, and uptime
- RSS, heap, external, and array-buffer memory
- file-store and billing-store readiness
- explicit `database.configured=false` and `database.status="not_configured"` while the in-memory stores are used

## 6. Deploy to Railway

1. Create a new Railway project from the repository.
2. Set the build command:

   ```bash
   npm ci --include=dev && npm run build:css
   ```

3. Set the start command:

   ```bash
   npm start
   ```

   The included `Procfile` also declares `web: node server.js`.

4. Add the variables from `.env.production.example` under **Variables**. At minimum:

   ```text
   NODE_ENV=production
   HOST=0.0.0.0
   TRUST_PROXY=true
   APP_URL=https://yourdomain.com
   BILLING_SECRET=<generated secret>
   STRIPE_SECRET_KEY=sk_live_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   ENABLE_BILLING_SANDBOX=false
   ```

5. Set the health check path to `/health`.
6. Deploy. Railway injects `PORT` and provides `RAILWAY_PUBLIC_DOMAIN`; TidyData uses it as an `APP_URL` fallback until you override it with your custom domain.

## 7. Connect a custom domain

Do this before configuring the Stripe webhook so the webhook uses the final hostname.

### Render

1. Open the service → **Settings → Custom Domains**.
2. Add `yourdomain.com` and, optionally, `www.yourdomain.com`.
3. Create the DNS records Render shows:
   - apex domain: `A`/`ALIAS` records as instructed
   - subdomain: `CNAME`
4. Wait for TLS/domain verification to complete.
5. Set `APP_URL=https://yourdomain.com`.
6. If you serve both apex and `www`, set:

   ```dotenv
   CORS_ORIGIN=https://yourdomain.com,https://www.yourdomain.com
   ```

7. Redeploy so Stripe redirects and CORS use the final URL.

### Railway

1. Open the service → **Settings → Networking → Public Networking**.
2. Click **Custom Domain**, enter the domain, and create the shown `CNAME`.
3. Wait for Railway-managed TLS to become active.
4. Set `APP_URL=https://yourdomain.com` and redeploy.
5. Add `CORS_ORIGIN` if you serve multiple hostnames.

TidyData automatically allows the `APP_URL` origin for `/api` CORS. `CORS_ORIGIN` adds extra origins and should be a comma-separated list of full origins (scheme + host + port).

## 8. Create the Stripe webhook endpoint

Use the final HTTPS domain, not a temporary platform preview URL.

1. Stripe Dashboard → **Developers → Webhooks → Add endpoint**.
2. Endpoint URL:

   ```text
   https://yourdomain.com/api/webhook
   ```

   `/api/billing/webhook` remains available as a compatibility alias for older endpoints. Use `/api/webhook` for new deployments.

3. Subscribe to these events:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `invoice.paid`
   - `customer.subscription.deleted`
4. Copy the **Signing secret** (`whsec_...`).
5. Add it as `STRIPE_WEBHOOK_SECRET` in Render/Railway.
6. Redeploy.

The server verifies the raw request body with the signing secret and deduplicates repeated Stripe event IDs. `checkout.session.completed` and `checkout.session.async_payment_succeeded` grant access immediately; `invoice.paid` extends monthly access; `customer.subscription.deleted` revokes it.

The `/api/billing/success` redirect also verifies the checkout session directly. If the webhook already created the entitlement, the redirect reuses it without a second Stripe API call, so a temporary Stripe outage cannot leave a paying customer locked out.

### Local webhook testing

```powershell
stripe login
stripe listen --forward-to localhost:3000/api/webhook
```

Use the printed `whsec_...` as `STRIPE_WEBHOOK_SECRET` in your local `.env`, then complete a test checkout with card `4242 4242 4242 4242`. The Stripe CLI prints each delivered event and the app logs rejected signatures or processing errors.

## 9. Post-deploy verification

Run these checks from your machine:

```powershell
# 1. Process, memory, uptime, and store readiness
Invoke-RestMethod https://yourdomain.com/health | ConvertTo-Json -Depth 6

# 2. Billing configuration (should report live mode and sandbox false)
Invoke-RestMethod https://yourdomain.com/api/billing/status | ConvertTo-Json -Depth 6

# 3. Checkout redirect URL (test with a test key first)
Invoke-RestMethod -Method Post `
  -Uri https://yourdomain.com/api/billing/checkout `
  -ContentType 'application/json' `
  -Body '{"plan":"single","sandbox":false}'
```

Expected production values:

- `/health` → HTTP 200, `"status": "ok"`, `stores.ready: true`, `stores.database.configured: false`
- `/api/billing/status` → `billing.stripeMode: "live"`, `billing.stripeConfigured: true`, `billing.sandboxEnabled: false`, `freeTier.maxRows: 500`, `freeTier.maxFileSizeMb: 1`, `premiumExportFormats: ["ndjson","tsv"]`
- Checkout response contains a `url` beginning with `https://checkout.stripe.com/`

### Free-tier and automatic-upgrade flow

1. Upload a small CSV (under 500 rows and 1 MB). Confirm it cleans and downloads as CSV or JSON without a payment.
2. Request an NDJSON or TSV download. Confirm HTTP `402` and that the checkout modal opens with the premium-format reason.
3. Upload a CSV with more than 500 rows (or a source file over 1 MB). Confirm the upload succeeds and the preview is visible, but the **Upgrade for $5** notice appears and **Clean data** returns `402`.
4. Buy the export pass with a real card (or test card in test mode).
5. Confirm Stripe delivers `checkout.session.completed` to `/api/webhook` with a 2xx response.
6. Return to the app. It restores the saved workspace and automatically retries the clean.
7. Confirm the header shows `1 export credit`, download the premium format successfully, and confirm the credit is consumed.
8. Request another premium export and confirm the paywall returns.

Test the monthly plan separately:

1. Subscribe with the monthly plan.
2. Confirm large-file cleaning stays unlocked and premium downloads are unlimited.
3. Confirm Stripe sends `invoice.paid` on renewal and the entitlement is extended.
4. Cancel the subscription in Stripe and confirm `customer.subscription.deleted` revokes access.

Test bulk processing with an active entitlement:

```powershell
Invoke-RestMethod -Method Post `
  -Uri https://yourdomain.com/api/clean/bulk `
  -ContentType 'application/json' `
  -Headers @{ Cookie = 'td_export_pass=<cookie-from-checkout>' } `
  -Body '{"fileIds":["<id-1>","<id-2>"],"options":{}}'
```

Without an entitlement the same request must return HTTP `402` with `error.details.reason: "BULK_PREMIUM"`.

## 10. Store durability and zero-downtime

The current stores are deliberately in-memory:

- `src/services/fileStore.js` — uploaded/cleaned datasets, 30-minute TTL
- `src/services/billingStore.js` — entitlements, credits, subscription indexes, webhook event deduplication

Implications:

- A restart or deploy clears files and purchases.
- Running more than one instance can route a returning user to an instance without their entitlement.
- `BILLING_SECRET` keeps cookies verifiable, but the entitlement ledger itself does not survive a restart.

The deployment is structured for health-checked rolling deploys:

- platform health checks use `/health`
- `SIGTERM`/`SIGINT` trigger graceful shutdown
- idle keep-alive sockets are closed during shutdown
- the process exits within 5 seconds if connections do not drain

For a real paid launch, migrate both stores to a shared durable backend (Redis or Postgres) before scaling horizontally. At minimum, keep the service at one instance. Once the stores are shared, multiple instances can provide true zero-downtime deploys.

## 11. Security checklist

- `NODE_ENV=production`
- `ENABLE_BILLING_SANDBOX=false`
- `BILLING_SECRET` is long, random, and stable
- `STRIPE_SECRET_KEY` is a live key and exists only in the platform secret store
- `STRIPE_WEBHOOK_SECRET` is configured
- `APP_URL` is the final HTTPS hostname
- `TRUST_PROXY=true` on Render/Railway
- `FREE_TIER_MAX_ROWS`, `FREE_TIER_MAX_FILE_MB`, `PREMIUM_EXPORT_FORMATS`, and `BULK_MAX_FILES` match your intended pricing
- custom domain has valid TLS
- no `.env` or `.env.production` file is committed
- Stripe webhook endpoint `/api/webhook` returns 2xx in the Stripe dashboard
- Stripe webhook subscribes to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`, and `customer.subscription.deleted`
- Stripe account is fully activated before accepting live payments

## 12. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Service fails health check | Confirm `HOST=0.0.0.0`, the platform-injected `PORT` is used, and `/health` responds locally |
| Stripe redirect goes to localhost or wrong host | Set `APP_URL` to the final `https://` domain and redeploy |
| Browser CORS error | Ensure the request Origin is either `APP_URL` or listed in `CORS_ORIGIN` |
| `Checkout unavailable` | Set `STRIPE_SECRET_KEY`; sandbox is intentionally disabled in production |
| Webhook returns 400 | Check `STRIPE_WEBHOOK_SECRET` and that `/api/webhook` receives the raw body (not JSON-parsed) |
| Webhook returns 404 | Point Stripe at `https://yourdomain.com/api/webhook`; `/api/billing/webhook` is only a compatibility alias |
| Payment works but access is missing | Confirm `/api/webhook` delivery in Stripe and that `/api/billing/success?session_id=...` is reachable; the redirect reuses a webhook-created entitlement |
| Large file uploads but cannot be cleaned | Expected on the free tier; confirm the checkout modal opens and that the saved workspace auto-retries after payment |
| Files/purchases vanish after deploy | Expected with in-memory stores; migrate to Redis/Postgres |
| Duplicate webhook delivery | Already handled by event-ID deduplication; verify the event ID is present |

## 13. Rollback

Render and Railway both retain previous deployments:

- **Render:** Service → Deploys → select the last known-good deploy → **Rollback**.
- **Railway:** Deployments → select the previous deployment → **Redeploy**.

Rollback does not restore in-memory files or entitlements. Restore Stripe webhook replay from the Stripe dashboard only if you have durable stores.

## 14. Useful commands

```powershell
npm ci --include=dev
npm run build:css
npm test
npm start
```

Local health check:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health | ConvertTo-Json -Depth 6
```

For local production-mode verification:

```powershell
$env:NODE_ENV = 'production'
$env:HOST = '0.0.0.0'
$env:APP_URL = 'http://127.0.0.1:3000'
$env:BILLING_SECRET = 'local-production-test-secret'
$env:ENABLE_BILLING_SANDBOX = 'true'
npm start
```

This is useful for verifying production process and health-check behavior. Entitlement cookies are marked `Secure` in production, so test checkout over HTTPS (or in development mode) rather than plain local HTTP.

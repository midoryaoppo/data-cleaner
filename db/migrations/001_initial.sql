-- Persistent entitlement ledger and temporary dataset storage for TidyData.

CREATE TABLE IF NOT EXISTS entitlements (
  id uuid PRIMARY KEY,
  plan text NOT NULL CHECK (plan IN ('single', 'monthly')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  remaining_exports integer,
  session_id text NOT NULL UNIQUE,
  subscription_id text,
  stripe_customer_id text,
  customer_email text,
  sandbox boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entitlements_remaining_exports_check CHECK (
    (plan = 'monthly' AND remaining_exports IS NULL) OR
    (plan = 'single' AND remaining_exports IS NOT NULL AND remaining_exports >= 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS entitlements_subscription_id_unique
  ON entitlements (subscription_id)
  WHERE subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS entitlements_customer_id_idx
  ON entitlements (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS entitlements_expires_at_idx
  ON entitlements (expires_at);

CREATE INDEX IF NOT EXISTS entitlements_status_idx
  ON entitlements (status);

CREATE TABLE IF NOT EXISTS processed_webhook_events (
  event_id text PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS processed_webhook_events_processed_at_idx
  ON processed_webhook_events (processed_at);

CREATE TABLE IF NOT EXISTS files (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('source', 'cleaned')),
  source_id uuid,
  name text NOT NULL,
  format text NOT NULL,
  size integer NOT NULL CHECK (size >= 0),
  -- Gzipped JSON containing { headers: string[], rows: unknown[][] }.
  payload bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS files_expires_at_idx
  ON files (expires_at);

CREATE INDEX IF NOT EXISTS files_created_at_idx
  ON files (created_at DESC);

CREATE INDEX IF NOT EXISTS files_source_id_idx
  ON files (source_id)
  WHERE source_id IS NOT NULL;

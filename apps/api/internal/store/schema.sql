-- Thin entitlement schema. NO payment data (Stripe holds cards/PII), NO asset data (assets never
-- leave the user's device — founding invariant). Just: which key exists, which devices hold a seat,
-- which Stripe events we already fulfilled (idempotency), and opt-in metric history.

CREATE TABLE IF NOT EXISTS licenses (
  key                   TEXT PRIMARY KEY,
  stripe_session        TEXT UNIQUE,           -- guards against double-mint for one checkout
  stripe_customer       TEXT,
  stripe_payment_intent TEXT,
  email                 TEXT,
  plan                  TEXT NOT NULL DEFAULT 'pro',
  seats                 INTEGER NOT NULL DEFAULT 3,
  status                TEXT NOT NULL DEFAULT 'active',  -- active | refunded | revoked
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_licenses_customer ON licenses(stripe_customer);
CREATE INDEX IF NOT EXISTS idx_licenses_pi ON licenses(stripe_payment_intent);

CREATE TABLE IF NOT EXISTS devices (
  license_key  TEXT NOT NULL REFERENCES licenses(key) ON DELETE CASCADE,
  device_hash  TEXT NOT NULL,
  label        TEXT,
  activated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at   INTEGER,                        -- NULL = holds a seat; non-NULL = released
  PRIMARY KEY (license_key, device_hash)
);

-- Idempotency ledger: one row per Stripe event we acted on. The PK makes re-delivery a no-op.
CREATE TABLE IF NOT EXISTS fulfillments (
  event_id    TEXT PRIMARY KEY,
  license_key TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Opt-in metric history (Phase-3 dogfood). Stores derived metrics only — never asset bytes.
CREATE TABLE IF NOT EXISTS metric_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  payload     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metric_license ON metric_history(license_key, ts);

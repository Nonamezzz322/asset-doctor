# `@asset-doctor/api` — thin billing & entitlement backend (Slice B)

The **only** server in Asset Doctor. It does license activation, Stripe webhook fulfillment, and
ed25519 entitlement signing — **nothing else**. It never sees a user's assets; all analysis and the
paid "fix" run in the browser (founding invariant: *assets never leave the device*). If this server is
down, the diagnosis side keeps working entirely offline; only new Pro activations pause.

```
Stripe Checkout ──webhook──▶ /v1/stripe/webhook ──mint──▶ licenses(key)        [SQLite]
buyer success page ──────────▶ GET /v1/key?session_id ──────────────▶ shows the key
app (paste key) ─────────────▶ POST /v1/activate ──sign──▶ entitlement token (ed25519)
app (offline) ───────────────▶ verify token with embedded PUBLIC key — no network needed
app (≤TTL) ──────────────────▶ POST /v1/refresh ──renew or decline (refund/seat-revoke = kill-switch)
```

## Two credentials

- **License key** (`AD-XXXX-XXXX-XXXX-XXXX`) — opaque, crypto-random, 80 bits. A lookup handle the
  buyer keeps; possession is checked server-side. Not a secret algorithm, so it can't be "cracked".
- **Entitlement token** — an ed25519-signed claim `{v,lic,dev,plan,iat,exp}` the client verifies
  **offline** with an embedded public key. Short-lived (default 7 days) so a refunded/revoked license
  stops refreshing and self-expires — that's the revocation mechanism, no online check on the hot path.

The **device id** (`dev`) is a random value the client generates and stores locally. It is **not** a
hardware fingerprint — it only lets us count/limit seats and let a user release one.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET  | `/healthz` | liveness |
| GET  | `/v1/pubkey` | the ed25519 public key (convenience/verification) |
| POST | `/v1/stripe/webhook` | Stripe → us; signature-verified, idempotent mint |
| GET  | `/v1/key?session_id=` | success-page key delivery (no email provider needed) |
| POST | `/v1/activate` | `{key,device,label}` → entitlement token (enforces seat cap) |
| POST | `/v1/refresh` | renew a token while active; declines on refund/seat-release |
| POST | `/v1/deactivate` | release a seat |
| POST | `/v1/history` | opt-in metric history (off unless `HISTORY_ENABLED=true`) |

## Run locally

```bash
cd apps/api
cp .env.example .env           # dev synthesizes an ephemeral signing key if none is set
go run ./cmd/api               # listens on :8080
curl localhost:8080/healthz
```

Tests (hermetic — fake clock, real Stripe-signature path, temp SQLite):

```bash
go test ./...
go vet ./...
```

## Generate the signing keypair

```bash
go run ./tools/keygen
# → LICENSE_SIGNING_SEED=...   (SERVER SECRET — fly secrets set, never commit)
# → VITE_LICENSE_PUBKEY=...    (embed in apps/web at build time)
```

Rotating the seed invalidates all outstanding tokens within one TTL; ship the new public key to the
web client in the same release.

## Stripe setup

1. **Product/Price** — one-time payment (this slice is one-time, not subscription).
2. **Checkout** — create a Payment Link or Checkout Session with
   `success_url = https://<app>/activate?session_id={CHECKOUT_SESSION_ID}`. The success page calls
   `GET /v1/key?session_id=…` (polls briefly until the webhook lands) and shows/auto-activates the key.
3. **Webhook** — point an endpoint at `POST https://<api>/v1/stripe/webhook`, subscribe to
   `checkout.session.completed` and `charge.refunded`. Copy the signing secret →
   `STRIPE_WEBHOOK_SECRET`. (The SDK pins an API version but we set `IgnoreAPIVersionMismatch` and read
   only stable fields, so the dashboard's API version doesn't have to match.)
4. Local: `stripe listen --forward-to localhost:8080/v1/stripe/webhook` and
   `stripe trigger checkout.session.completed`.

## Deploy (Fly.io)

```bash
fly launch --no-deploy            # uses fly.toml; creates the app + ad_data volume
fly secrets set \
  LICENSE_SIGNING_SEED="…seed…" \
  STRIPE_WEBHOOK_SECRET="whsec_..." \
  ALLOWED_ORIGINS="https://nonamezzz322.github.io"
fly deploy
```

`ENV=production` makes missing secrets a **hard startup failure** (fail-closed) and requires
`ALLOWED_ORIGINS` (no wildcard CORS in prod).

### Durability

SQLite lives on the Fly volume. For point-in-time recovery / a replica, add **Litestream** streaming to
object storage (S3/R2) — until then a license is recoverable only by re-running the buyer's checkout.
The data is intentionally tiny and re-mintable, so this is a launch-acceptable risk, not a permanent one.

## Security properties (and honest limits)

- Webhook signature verified before any DB write; body size-capped; idempotent via the `fulfillments`
  PK — Stripe's at-least-once retries can't double-mint. Refunds revoke **only on a full refund**
  (`charge.refunded` with `refunded:true`); partial/goodwill refunds leave a paid license active.
- Every client route (`/v1/activate|refresh|deactivate|key|history`) is per-IP rate-limited. The limiter
  keys on the **TCP peer** by default, or on `TRUSTED_IP_HEADER` when set — we do **not** use chi's
  deprecated `RealIP` (which trusts forgeable `X-Forwarded-For`). License keys are 80-bit random (brute
  force infeasible); error bodies are non-leaky machine codes.
- `/v1/history` (opt-in, off by default) accepts only a **fixed set of numeric fields** (decoder rejects
  any other key) — the privacy invariant ("derived numbers only, never asset bytes") is enforced by the
  type, not a comment.
- **Honest limit:** a determined user can extract the embedded public key and patch the client to skip
  verification — true of *every* client-side gated tool. We optimize for "easy to pay, hard to
  accidentally bypass", not DRM. The value is the tool, not the lock.
- No card data, no asset bytes, minimal PII (buyer email for support) — Stripe holds the rest.

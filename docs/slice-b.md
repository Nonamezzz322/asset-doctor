# Slice B — thin billing & entitlement backend (decision record)

**Status:** implemented (`apps/api`), not yet deployed (needs the owner's Stripe + Fly secrets).
Deploy/run mechanics live in [`apps/api/README.md`](../apps/api/README.md); this is the *why*.

## What it is

The first and only server in Asset Doctor. Per **invariants 1–2** it does auth-free license
activation, Stripe webhook fulfillment, and ed25519 entitlement signing — and **nothing touching a
user's assets**. All analysis and the paid "fix" stay in the browser. Backend down ⇒ diagnosis still
works fully offline; only *new* Pro activations pause.

## Decisions (and the forks behind them)

| Decision | Choice | Why |
|---|---|---|
| Stack | Go + chi | smallest honest surface; static distroless binary; signed off earlier |
| DB | SQLite (`modernc.org/sqlite`, pure-Go, `MaxOpenConns=1`) | tiny data, no cgo, atomic seat-checks without lock gymnastics |
| Monetization | one-time payment | not a subscription tool; simplest honest model |
| Revocation | short-lived ed25519 entitlement (TTL 7d) + `/v1/refresh` | offline hot path; refund/seat-release self-expires within a TTL — no online check per use |
| Key delivery | success page `GET /v1/key?session_id` | no email provider needed; session id is high-entropy + buyer-only |
| Gate default | **OFF** (`VITE_PRO_GATE`) | "build full functionality first, monetize later" — fix stays free until flipped |
| Idempotency | `fulfillments(event_id)` PK + `licenses.stripe_session` UNIQUE | Stripe's at-least-once retries can't double-mint |

## Two credentials (the crux)

- **License key** `AD-XXXX-…` — opaque, 80-bit crypto-random, a server-checked lookup handle (not a
  secret algorithm → nothing to "crack").
- **Entitlement token** — ed25519-signed `{v,lic,dev,plan,iat,exp}`, verified **offline** in the
  browser via WebCrypto with an embedded public key. Wire form `b64url(payloadJSON).b64url(sig)`; the
  signed message is the literal first segment, so there's no canonical-JSON requirement.

`dev` is a random client-generated id (NOT a fingerprint) — only used to count/limit/release seats.

## The cross-language contract

The byte format is shared by two languages, so it's pinned by a committed fixture
(`fixtures/license/entitlement-fixture.json`, from `apps/api` `go run ./tools/fixturegen`):
- Go side: `internal/license/fixture_test.go` re-verifies it; CI fails if regen isn't a no-op.
- Web side: `apps/web/src/lib/license.test.ts` verifies the **Go-signed** token with the real
  WebCrypto path. If either encoding drifts, this breaks — by design.

## Honest limits (stated, not hidden)

A determined user can extract the embedded public key and patch the client to skip verification —
true of *every* client-side gate. We optimize for "easy to pay, hard to *accidentally* bypass", not
DRM. The value is the tool, not the lock. No card data, no asset bytes, minimal PII (buyer email).

## To turn monetization on (later)

1. `apps/api`: `go run ./tools/keygen` → set `LICENSE_SIGNING_SEED` + `STRIPE_WEBHOOK_SECRET` +
   `ALLOWED_ORIGINS` as Fly secrets; `fly deploy`.
2. Stripe: product/price + Checkout `success_url=…/activate?session_id={CHECKOUT_SESSION_ID}` +
   webhook → `/v1/stripe/webhook` (`checkout.session.completed`, `charge.refunded`).
3. `apps/web`: set `VITE_PRO_GATE=true`, `VITE_LICENSE_PUBKEY=<public key>`, `VITE_API_BASE=<api>`,
   optional `VITE_CHECKOUT_URL`; rebuild + redeploy.
4. Optional hardening before real reliance: Litestream replica; email key delivery; subscriptions.

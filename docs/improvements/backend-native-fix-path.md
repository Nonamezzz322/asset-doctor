# Opt-In Backend Native-Fix Path — implementation-ready design

**Status:** design (implementation-ready) · **Owners (new):** `apps/encoder` (NEW sidecar) · `apps/api`
(auth/quota gateway) · `packages/fix` (pure protocol + GPU-format VRAM) · `apps/web/src/worker/fix.worker.ts`
(opt-in `encodeRemote` branch) · `apps/web/src/lib/*` (consent + token) · `packages/core` (compressed-texture
contract) · **Default:** OFF — when the backend is unconfigured/unreachable/consent-declined, the fix output is
**byte-identical to today** and the all-browser path is the only path.

> ⚠️ **This document AMENDS invariants 1 & 2.** Until now invariant 1 = "assets never leave the device" and
> invariant 2 = "thin backend, NO image processing." This design introduces an **opt-in** path where, with
> **explicit per-run consent**, the *minimal needed asset bytes* leave the device to a backend that performs
> heavy native encoding the browser literally cannot do. The amendment is **narrow and honest**:
> browser-first stays the default; the free diagnosis path (≤10s instant-wow) stays 100% local; the backend is
> a slower, paid, opt-in *fix* fallback only. Every other invariant (3 objectivity, 4 instant-wow, 5
> disk≠VRAM honesty) is preserved unchanged, and invariant 5 is *strengthened* by a new GPU-format-aware VRAM
> model.

---

## 0. The amended invariants, written honestly

Add this to `CLAUDE.md` (and surface the privacy boundary in the UI). The amendment must be stated as a
bounded carve-out, not a silent erosion:

> **Invariant 1 (amended).** Heavy processing runs in the browser; assets never leave the device — **except**
> for an explicit, opt-in, per-run "native fix" that the user consents to, which uploads only the specific
> asset bytes a native-only operation needs (GPU-texture compression, pngquant, native resample kernels),
> processes them ephemerally on the backend, returns the optimized bytes, and **persists nothing**. Default
> OFF. The free diagnosis path is always 100% local.
>
> **Invariant 2 (amended).** The billing/auth backend (`apps/api`, Go, distroless) stays thin and does **no**
> image processing. Heavy native encoding lives in a **separate, isolated sidecar** (`apps/encoder`) that
> `apps/api` gates (entitlement + quota) and proxies to. The trust root (Stripe/license/ed25519) keeps its
> no-shell, no-libc security posture.

---

## 1. Decision (a): WHERE the processing runs — **SIDECAR**, gated by `apps/api`

**Decision: a separate sidecar container `apps/encoder`, with `apps/api` as the auth/quota gateway that
proxies to it.** Not a fattened `apps/api` image; not a public direct-to-sidecar endpoint.

### Why not extend `apps/api`
`apps/api/Dockerfile` builds `CGO_ENABLED=0` static Go onto `gcr.io/distroless/static-debian12:nonroot` —
**no shell, no libc, cannot exec** `basisu`/`toktx`/`pngquant`/`vips`/`avifenc`. Adding native CLIs forces
abandoning distroless, which would drag the **billing trust root** (Stripe webhook, license mint, ed25519
seed) down to a fat image with a shell and a large CVE surface. That trade is unacceptable: the thin image is
the security posture for the money/secrets path. **Rejected.**

### Why a sidecar (chosen)
- Keeps `apps/api` distroless and thin (invariant 2 mostly intact — it gains only an entitlement-verify +
  quota + reverse-proxy hop, no image bytes touch its logic, no native code in its image).
- The heavy, CVE-prone, native-binary, untrusted-image-decoding work is **isolated** in its own container with
  its own resource limits, its own (non-distroless) base, and **no access to the SQLite DB or the signing
  seed**.
- `apps/api` is the single CORS origin + the single place that verifies the ed25519 token and enforces the
  per-license job quota **before** any CPU is spent (closes the "free CPU" hole — see §6).

### What the sidecar is built from
**Recommendation: a small Node/`sharp` service** (`apps/encoder`, TypeScript) on a `debian-slim` base, that
bundles the native CLIs and shells to them. Rationale:
- `sharp` (libvips) gives resample kernels (lanczos3/lanczos2/mitchell/cubic) + gaussian pre-blur + AVIF
  4:4:4/bitdepth + JPEG(mozjpeg) + lossless PNG in one well-maintained lib — covers v2 tiers B/C with zero
  extra binaries.
- For the v1 headline (KTX2), the service shells to **`basisu`** (BinomialLLC) and/or **`ktx`/`toktx`**
  (KTX-Software) — both are Debian-installable native CLIs. The Node service writes the input to a temp file,
  execs the CLI with **pinned flags**, reads the `.ktx2` back, deletes the temp.
- Node is chosen over "Go-with-CGO calling libvips" because the heavy lib (sharp) and the v2 features are
  TS-ergonomic, and the service is genuinely *not* the trust root — it can be any language. (A Go sidecar
  shelling to CLIs is a valid alternative; not chosen because sharp consolidates B/C.)

> **Honesty note on invariant 2:** this is a real erosion — we now run a fat, native-binary, image-decoding
> service. Mitigations make it *bounded*: it is isolated, gated, ephemeral, resource-capped, and the billing
> root is untouched. The user must weigh this (§9).

### Topology (on this PC, today)
```
browser ──(consent + token + asset bytes)──▶ apps/api (:8088, distroless, tailnet 100.114.253.114)
                                               │  verify ed25519 token (license.Verify) → 402 if invalid/expired
                                               │  enforce per-license in-flight + daily job quota → 429 if over
                                               │  size-cap the body (large reader, NOT decodeJSON)
                                               ▼  reverse-proxy (internal docker network only)
                                            apps/encoder (:9090, debian-slim, NOT on tailnet, NOT public)
                                               │  exec basisu/toktx | sharp  (pinned versions)
                                               │  temp-file in, temp-file out, unlink both (no persistence)
                                               ▼
                                            returns optimized bytes ──▶ apps/api ──▶ browser
```
`apps/encoder` is **only** reachable from `apps/api` over the internal docker-compose network — never bound to
the host/tailnet. One public origin (`apps/api`) keeps CORS simple and the gate unbypassable.

---

## 2. Decision (b): v1 FEATURE SET — **KTX2 only** (one tight, defensible feature)

**v1 = Basis Universal / KTX2 GPU-compressed textures, nothing else.** This is the *only* feature that
justifies a backend on value grounds alone:
- **Browser literally cannot produce the output** (no WASM basis/ktx encoder; OffscreenCanvas emits only
  png/webp/avif — never a GPU block format).
- **It is the only fix that lowers actual GPU VRAM** (4×–8×), not just disk. Every other native feature
  (pngquant, kernels, advanced AVIF, JPEG) is a disk/quality win the product can survive without, and is a
  weaker "first time we break invariant 1" story.
- It forces us to build the **GPU-format-aware VRAM model** (§7) once, correctly — the riskiest honesty piece
  — for the highest-value feature, instead of shipping disk-only features first and bolting VRAM honesty on
  later.

### v1 KTX2 sub-scope (tight)
- Encode **atlas page images and oversized loose images** to `.ktx2`.
- **One encoding profile, pinned:** UASTC (high quality) → Zstd supercompression, **with baked mip levels**
  (clean levels via the encoder's own filter). UASTC, not ETC1S, for v1 — higher quality, and the VRAM story
  is BC7/ASTC-class (~1 B/px) which is the headline. (ETC1S/lower-bpp is a v2 quality/size knob.)
- Emit an additive **compressed-texture variant** alongside the existing output: the game gets `page.ktx2`
  **plus** the normal `page.webp`/`.png`, wired through the round8 Pixi manifest so Pixi auto-picks `.ktx2` on
  capable GPUs and falls back to the raster format elsewhere (§5).
- **Honest, conditional VRAM accounting** (§7): the receipt charges `.ktx2` at `bpp·w·h` (+ measured baked-mip
  overhead), never `w·h·4`, and states the win is **"only on GPUs that support BC7/ASTC/ETC2; RGBA fallback
  elsewhere."**

### Explicit v1 OUT-OF-SCOPE
- **pngquant, native resample kernels + pre-blur, advanced AVIF (4:4:4/bitdepth), JPEG(mozjpeg), sharp
  lossless-PNG** — all deferred to **v2** (they ride the *same* sidecar + protocol; the protocol is designed
  additive so they slot in as new `NativeOpKind`s without a contract break). Their i18n "unavailable
  in-browser" disclosures (`en.json` `whyNoKernel`/`whyNoPreBlur`/`whyNoPngquant`/`whyNoChroma`) flip to
  "available via opt-in backend" only when their op ships.
- **ETC1S / per-folder KTX2 profiles / KTX2 for every loose image** — v2 knobs.
- **Async job queue / poll** — v1 is synchronous request/response with a generous per-route timeout (KTX2 of a
  2048² UASTC page is seconds, acceptable for an opt-in Pro step). A job+poll model is a v3 scale concern.
- **Public/Fly deployment of the sidecar** — v1 targets the existing on-PC docker-compose + tailnet; public
  rollout needs deploy creds + the binaries in the deploy image (noted, non-blocking for design).
- **Diagnosis-path changes** — diagnosis stays 100% local and generates nothing (invariant 3 + 4 untouched).

---

## 3. Decision (c): DATA FLOW

The single merge seam is the worker's `out: {path, bytes}[]` array (declared `fix.worker.ts:604`; deduped
`:2223`; `makeZip :2246`). A backend result joins `out` **identically** to a local encode — the zip assembly,
path-dedup, Pixi-manifest emit, and receipt math are downstream and format-agnostic. The per-op seam is a new
sibling to `encodeCanvas` (`:2389`) / `transcode` (`:2466`): **`encodeRemote()`**, called only when (1) the
user consented to the backend path AND (2) the requested op is native-only.

KTX2 is **not** an `ImageMime`, so it is a **new op kind**, not a swap-in for `encodeCanvas`. The natural
injection points are the factored `composePageEncode` (`:877`, the single compose+encode path repack/pack
share) and the loose-transcode branch (`:1494`–`:1523`): compose the page locally → `getImageData` → send RGBA
(or the already-encoded PNG) to the backend → receive `.ktx2` bytes → `out.push({ path: name.ktx2, bytes })`.

```
DETECT (browser, free):  diagnosis already flags oversize / heavy-VRAM atlases.  The fix planner
                          (plan.ts) marks pages eligible for a native KTX2 variant → planNativeOps[].
                          NOTHING uploaded yet.  ≤10s instant-wow path is unaffected.

OFFER  (browser):         If (backend configured) AND (Pro unlocked) AND (≥1 native op eligible):
                          show the consent gate (§4).  Default OFF.

CONSENT (browser):        User ticks "send these images to the server to compress them."
                          buildOptions() (App.tsx:1149) sets backend.enabled + backend.ops:['ktx2']
                          + attaches the entitlement token (loadStoredEntitlement().token).

EXECUTE (worker):         The compose loop runs locally as today.  For each eligible page, AFTER the
                          local raster encode (the fallback), encodeRemote(rgbaOrPng, 'ktx2', opts):
                            POST {API_BASE}/v1/process   (multipart/octet-stream)
                              headers: Authorization: Bearer <token>, X-AD-Op: ktx2
                              body:    the page bytes (PNG) + a tiny JSON sidecar {w,h,op,profile}
                          On 2xx → out.push({path:'<name>.ktx2', bytes})  (ADDITIVE — the .webp/.png
                                   page is STILL emitted; ktx2 is an extra candidate).
                          On any failure / timeout / offline → log an honest skipped[] note, DO NOT
                                   upload-retry, keep the local raster output (graceful degrade to
                                   browser-only).  The zip is still valid and drop-in.

MERGE  (worker):          ktx2 entries flow into `out` like any file → dedup → zip.  The round8 Pixi
                          manifest (emitPixiManifest) lists {alias → src:[page.ktx2, page.webp]} so the
                          game auto-resolves the GPU format (§5).  Receipt VRAM uses the GPU-format model
                          (§7): vramBytesAfter charges ktx2 at bpp·w·h, raster fallback at w·h·4, and
                          reports both honestly.

RESULT (browser):         "Download optimized folder" → one zip with .ktx2 + raster + manifest.  Receipt
                          states the conditional GPU-VRAM win.  Server kept nothing.
```

**Key honesty rule on the wire:** the backend path is **additive** — it never *replaces* the local raster
output for a page; it *adds* a `.ktx2` candidate. So even if the device's GPU can't transcode KTX2, the game
still loads the raster fallback. This is what makes "VRAM win only on capable GPUs" true *and* safe.

---

## 4. Decision (d): CONSENT + privacy UX

**Default OFF. The backend path is invisible unless ALL of: backend configured (`API_BASE` set) AND backend
reachable (a cheap `GET /healthz` probe) AND Pro unlocked AND ≥1 native op is eligible for this folder.**

When offered, the consent surface (a new section in the fix settings panel, near the existing Pro toggle that
`App.tsx:1137` already gates with `isProUnlocked()`):

- A clearly-labeled, **default-unchecked** switch:
  > **"Compress textures on the server (sends images off your device)"**
  > These N images will be uploaded to *{backend host}*, compressed to GPU-native KTX2, and the result sent
  > back. **Images are processed in memory and deleted immediately — nothing is stored.** Everything else in
  > this fix still runs entirely in your browser. Leave this off to keep all processing local.
- A list/count of **exactly which files** would be uploaded (the eligible pages), so consent is informed and
  scoped — never "upload my whole folder."
- The destination host shown verbatim (so a self-hoster sees their own tailnet box, not a mystery cloud).
- A persistent, honest reminder in the receipt when the path was used: *"N textures were compressed on the
  server ({host}) and then deleted there."*
- **No dark patterns:** the switch is off by default, requires an explicit click per run (not a sticky
  "remember me" that silently re-uploads later), and declining loses nothing except the GPU-VRAM extra.

i18n: new keys `fix.backend.consentTitle/consentBody/uploadList/processedDeleted/disabledWhyOffline` in all 9
locales. The existing `whyNoPngquant`/`whyNoKernel`/`whyNoChroma` stay "unavailable" until their op ships in
v2, then flip to "available via opt-in backend."

---

## 5. Decision (f) + manifest: the shared contract (additive)

All additions are **additive** so the all-browser path is byte-identical when the backend is off.

### `packages/core/src/index.ts` (single source of truth)
```ts
// GPU-native compressed-texture container formats (NOT ImageMime — they don't decode to RGBA on disk).
export type CompressedTextureFormat = 'ktx2-uastc' | 'ktx2-etc1s'; // v1 ships only 'ktx2-uastc'

// Per-format GPU residency cost in BYTES PER PIXEL, the SINGLE source of the VRAM math (invariant 5).
// BC7/ASTC-4x4 ≈ 1 B/px; ETC1S/BC1/ETC1 ≈ 0.5 B/px; raw RGBA8888 = 4 B/px. Mip overhead applies the
// SAME MIP_OVERHEAD (4/3) factor already in core — CONDITIONALLY, only when mips are baked.
export const GPU_BYTES_PER_PX: Record<CompressedTextureFormat, number> = {
  'ktx2-uastc': 1,    // BC7/ASTC-class block, ~8 bpp = 1 byte/px
  'ktx2-etc1s': 0.5,  // ETC1S transcodes to BC1/ETC1-class, ~4 bpp = 0.5 byte/px (v2)
};
```
- Extend the existing `vramBytes`/residency path so a texture carries a **GPU-residency-bytes** distinct from
  disk bytes AND from the raster `w·h·4`. The receipt's `vramBytesAfter` MUST consult the format: a `.ktx2`
  page contributes `GPU_BYTES_PER_PX[fmt] · w · h · (mipsBaked ? MIP_OVERHEAD : 1)`, NOT `w·h·4`.

### `apps/web/src/worker/fix-protocol.ts` — `FixOptions` (additive bag)
```ts
/** Opt-in backend native-fix path (AMENDED invariant 1). Absent/undefined ⇒ 100% browser, zip byte-identical
 *  to today. Only honored when the user consented this run AND the backend is configured+reachable AND Pro is
 *  unlocked. The worker attaches `token` to the POST; never uploads without it. */
backend?: {
  enabled: boolean;            // the per-run consent (default false; never sticky)
  ops: NativeOpKind[];         // v1: ['ktx2']
  token: string;               // ed25519 entitlement token (loadStoredEntitlement().token)
  apiBase: string;             // = lib/license.ts API_BASE (the only network origin)
};
export type NativeOpKind = 'ktx2'; // v2 adds 'pngquant' | 'kernel-resize' | 'avif444' | 'jpeg' | ...
```
- `FixReceipt` additions (additive, honest):
  ```ts
  /** Native backend path summary. Absent ⇒ path not used (browser-only run). */
  backendNative?: {
    op: NativeOpKind;
    uploaded: number;          // files actually sent (consented + eligible)
    produced: number;          // compressed variants returned + zipped
    failed: number;            // graceful-degrade count (kept raster fallback) — honest, never silent
    host: string;              // destination shown to the user (privacy receipt)
  };
  /** GPU-residency VRAM of the COMPRESSED variants, charged at bpp·w·h (NEVER w·h·4). Reported SEPARATELY
   *  from vramBytesAfter's raster accounting and labeled "GPUs that support BC7/ASTC/ETC2 only." */
  ktx2VramBytes?: number;
  ktx2VramConditional: true;   // the win is conditional on GPU support + the game shipping the transcoder
  ```

### Pixi manifest (reuse round8, `packages/fix/src/pixi-manifest.ts`)
Add `.ktx2` as a **candidate in the same asset entry's `src[]`** ahead of the raster format, so Pixi v8's
loader resolves the best supported GPU format per device and falls back to `.webp`/`.png`:
```
{ alias: ['hud','ui/hud'], src: ['ui/hud.ktx2', 'ui/hud.webp'] }
```
This requires the game to register Pixi's basis/ktx2 transcoder; the receipt's loader-migration note states
that explicitly (honesty: "KTX2 needs `@pixi/basis`/ktx loader + a GPU that supports a target block format").

### Backend wire contract (`POST /v1/process`)
- Request: `Authorization: Bearer <token>`, `X-AD-Op: ktx2`, body = the page PNG bytes; a small JSON header
  part carries `{w,h,op:'ktx2',profile:'uastc-zstd-mip'}`.
- Response: `200` + `Content-Type: application/octet-stream` + body = the `.ktx2` bytes; `402` invalid/expired
  token; `429` over quota; `413` too large; `415` unknown op; `503` encoder unavailable. Errors return the
  small `{error,code}` shape `respond.go` already uses so the client maps to localized copy.

---

## 6. Decision (e): SECURITY

The CPU-burning endpoint MUST close the "free CPU" hole the offline-only gate leaves. **`apps/api` is the
gate; the sidecar trusts only `apps/api`.**

1. **Server-side entitlement verification (NEW).** Today no endpoint verifies the token server-side (it is
   browser-offline-only). `/v1/process` adds a middleware that pulls the `Bearer` token, calls the EXISTING
   `license.Verify(cfg.PublicKey(), token)` (`internal/license/token.go`) + `Claims.Expired(now)`, and returns
   `402`/`403` on fail/expired **before any work**. This reuses the exact verifier the browser uses → one
   contract.
2. **Per-license quota, not per-IP.** The existing `newIPLimiter(10, time.Minute)` is for billing clicks. The
   native path gates by **(a)** an in-flight **concurrency semaphore** (CPU-bound; e.g. ≤2 concurrent encodes
   on the PC) and **(b)** a per-license **daily job/byte quota** (keyed on `Claims.Lic`, stored in a tiny
   in-memory or separate counter — NOT on the single-conn billing SQLite path). Over → `429`.
3. **Own large-body reader + size caps.** NOT `respond.go decodeJSON` (16 KiB, DisallowUnknownFields — wrong
   for MB image bytes). A dedicated `http.MaxBytesReader` with a per-page cap (e.g. 32 MB) + a total-request
   cap. Reject `413` over cap.
4. **Own timeouts.** The server-wide 30s `WriteTimeout` is too short for UASTC. Use a **separate route timeout
   override** (or a dedicated `http.Server` for this group) sized for the synchronous encode (e.g. 120s),
   while keeping the billing routes at 30s.
5. **Keep the heavy path OFF the single SQLite connection** (`MaxOpenConns=1`). The native handler must not
   touch the billing DB on its request path (quota counter is separate/in-memory). This protects the billing
   serialization point from the slow encodes.
6. **No persistence / ephemeral (the privacy promise, enforced).** The sidecar writes input to a temp file in
   a tmpfs/scratch dir, execs the pinned CLI, reads the output, and **`unlink`s both** in a `finally`. No
   logging of image bytes. A periodic sweeper deletes orphaned temps. The receipt's "deleted there" claim must
   be *true*.
7. **Sidecar isolation.** `apps/encoder` is on the internal docker network only, never host/tailnet-bound;
   runs non-root; read-only root FS except the scratch tmpfs; pinned CLI versions (determinism + known CVE
   surface); resource limits (CPU/mem) in compose. It has **no** DB access and **no** signing seed.
8. **CORS unchanged.** `/v1/process` rides the existing `s.cors` + `ALLOWED_ORIGINS` allowlist (one origin =
   `apps/api`). The sidecar has no CORS (not browser-reachable).
9. **Untrusted-input hardening.** Image decoding on the server is a CVE surface (libpng/libvips/basisu). Cap
   dimensions + pixel count (reject absurd `w·h` before decode); run the encoder under the resource limits;
   pin + track tool versions for CVE patching.

---

## 7. Decision (g): HONESTY — GPU-texture footprint, never faked

This is the load-bearing honesty piece and the reason v1 is KTX2 (build it once, right):

- **A `.ktx2` page's resident VRAM is `GPU_BYTES_PER_PX[fmt] · w · h`, NOT `w·h·4`.** Applying the raster
  formula to a compressed output would *fake* the saving — and a faked GPU saving breaks invariant 5
  (precisely the trap the research flags). The VRAM model becomes **format-aware**: `vramBytesAfter` sums each
  surviving page at its real residency (raster pages `w·h·4`; ktx2 pages `bpp·w·h`).
- **Mip overhead stays conditional.** The repo already established (`mipmap-vram-accounting.md`) that the
  `MIP_OVERHEAD = 4/3` factor is charged **only where mips actually exist** — never assumed universal. A `.ktx2`
  with *baked* mip levels makes the +33% a **measured fact** for that texture (the levels are in the file), so
  it is charged; a raster page without mips is not. One constant, applied conditionally on both paths.
- **The win is explicitly conditional on the device.** KTX2 → a GPU block format requires (a) the game to ship
  Pixi's basis/ktx transcoder AND (b) a GPU supporting a target format (BC7/ASTC/ETC2). On unsupported
  devices Pixi falls back to RGBA = `w·h·4` again. The receipt MUST say so: *"GPU-VRAM win only on devices
  that support BC7/ASTC/ETC2; other devices load the raster fallback at full RGBA."* Reporting `ktx2VramBytes`
  separately + `ktx2VramConditional: true` keeps it from being folded into an unconditional hard claim.
- **Lossy labeling.** UASTC is high-quality but lossy; the fix must label the `.ktx2` output **lossy** (like
  the existing lossy-format honesty), and the diagnosis path still generates nothing (invariant 3) — only the
  opt-in fix applies it.
- **Determinism / reproducibility.** Native encoders vary by version/flags → **pin the `basisu`/`toktx`
  version and the exact flag set**; record the profile id (`uastc-zstd-mip`) in the receipt. Mirrors the
  repo's deterministic-manifest discipline. Backend OFF ⇒ zip byte-identical to today (the additive proof).

---

## 8. ORDERED TASK BREAKDOWN (small commits, one meaning each)

Grouped by phase; each row is a candidate commit. `[BE]`=Go gateway, `[SC]`=sidecar, `[WEB]`=client,
`[CORE]`=contract, `[FIX]`=pure fix, `[DOC]`.

### Phase 0 — contract + honesty foundation (no behavior change; everything additive)
| # | tag | task | acceptance |
|---|-----|------|-----------|
| T1 | `[DOC]` | Amend invariants 1 & 2 in `CLAUDE.md` (the bounded carve-out wording from §0). | reviewer agrees wording is honest + bounded |
| T2 | `[CORE]` | Add `CompressedTextureFormat`, `GPU_BYTES_PER_PX`, and a GPU-residency-bytes field distinct from disk + `w·h·4`. Reuse the existing `MIP_OVERHEAD`. | typecheck; constants exported; comments state bpp·w·h, conditional mips |
| T3 | `[FIX]` | GPU-format-aware VRAM helper in `packages/fix` (`vramOfPage(fmt,w,h,mips)`), pure + tested: raster=`w·h·4`, ktx2-uastc=`1·w·h`, mips→×4/3 only when baked. | unit tests for each format + mip on/off |

### Phase 1 — sidecar (heavy work, isolated)
| # | tag | task | acceptance |
|---|-----|------|-----------|
| T4 | `[SC]` | Scaffold `apps/encoder` (Node/TS, debian-slim Dockerfile with pinned `basisu`/`toktx` + sharp). `GET /healthz`. Non-root, read-only FS + scratch tmpfs. | container builds; healthz 200; CLIs present + version-pinned |
| T5 | `[SC]` | `POST /process` (internal): read PNG + `{w,h,op,profile}`, exec pinned KTX2 profile (`uastc-zstd-mip`), return `.ktx2`. Temp-in/temp-out + `unlink` in finally; dimension/pixel caps; size cap. | given a PNG, returns a valid `.ktx2` loadable by Pixi; temps cleaned; oversize→413 |
| T6 | `[SC]` | Resource limits + concurrency cap inside the sidecar; structured errors (`415/413/503`); NO image-byte logging. | over-cap/over-concurrency behave; logs carry no pixels |

### Phase 2 — Go gateway (auth + quota + proxy; keep distroless thin)
| # | tag | task | acceptance |
|---|-----|------|-----------|
| T7 | `[BE]` | New chi group (separate from the 10/min `limitMW`) with its own large-body reader, own timeout override, NOT touching SQLite. | route exists; big bodies accepted; billing routes unaffected |
| T8 | `[BE]` | Entitlement middleware: `Bearer` → `license.Verify(cfg.PublicKey(), token)` + `Claims.Expired` → `402/403` before work. | invalid/expired token rejected pre-proxy; valid passes; unit tests |
| T9 | `[BE]` | Per-license concurrency semaphore + daily quota (keyed on `Claims.Lic`, off the SQLite path). `429` over. | quota enforced; concurrent floods bounded; billing DB untouched |
| T10 | `[BE]` | Reverse-proxy verified requests to the sidecar (internal network); map sidecar errors to the `{error,code}` shape; config: `ENCODER_URL`, caps, timeout (fail-closed if unset in prod when native enabled). | end-to-end: browser→api→sidecar→.ktx2 back; sidecar unreachable→503 honest |
| T11 | `[BE]` | Tests (mirror the existing ~30 Go tests): token-gate, quota, size-cap, proxy-error mapping. | `go test ./...` green |

### Phase 3 — client opt-in path (additive; OFF ⇒ byte-identical)
| # | tag | task | acceptance |
|---|-----|------|-----------|
| T12 | `[WEB]` | `FixOptions.backend` bag + `NativeOpKind` + `FixReceipt.backendNative`/`ktx2VramBytes`/`ktx2VramConditional` (fix-protocol.ts). | typecheck; absent ⇒ no behavior change |
| T13 | `[WEB]` | `lib/fix-client` / `lib/license`: a `backendReachable()` healthz probe + thread `API_BASE` + `loadStoredEntitlement().token` into `buildOptions()` (App.tsx:1149) — single source for plan+execute. | token + apiBase reach the worker only when consented |
| T14 | `[WEB]` | `fix.worker.ts`: `encodeRemote(pngBytes,'ktx2',opts)` sibling to `encodeCanvas`; new ktx2 op at `composePageEncode`/loose-transcode seams; `out.push({path:'<name>.ktx2',bytes})` ADDITIVE (raster page still emitted). Failure ⇒ honest `skipped[]`, keep fallback, NO retry-storm. | with backend on: zip has .ktx2 + raster; with backend off/unreachable: zip byte-identical to today |
| T15 | `[FIX]` | `pixi-manifest.ts`: add `.ktx2` as the lead candidate in the asset entry `src[]` (raster fallback after). Loader-migration note: "needs ktx/basis transcoder + capable GPU." | manifest lists ktx2-then-raster; note emitted |
| T16 | `[WEB]` | Receipt VRAM uses the §7 model: raster pages `w·h·4`, ktx2 pages `bpp·w·h`; `ktx2VramBytes` reported SEPARATELY + conditional label. NEVER `w·h·4` on a ktx2 page. | receipt math matches T3 helper; conditional copy shown |

### Phase 4 — consent UX + privacy (the amended-invariant surface)
| # | tag | task | acceptance |
|---|-----|------|-----------|
| T17 | `[WEB]` | Consent gate in the fix panel: default-OFF switch, file list/count, destination host, "deleted there" promise; only shown when configured+reachable+Pro+≥1 eligible op. | hidden unless all conditions; off by default; per-run (not sticky) |
| T18 | `[WEB]` | i18n `fix.backend.*` consent/receipt keys in all 9 locales; en byte-matches baked. | catalog parity tests green |
| T19 | `[WEB]` | Receipt privacy line ("N textures compressed on {host}, then deleted") + the conditional GPU-VRAM caveat copy. | copy present + honest |

### Phase 5 — deploy + verify (on-PC compose; public deferred)
| # | tag | task | acceptance |
|---|-----|------|-----------|
| T20 | `[DOC]`/deploy | docker-compose: `apps/api` (host :8088, tailnet) + `apps/encoder` (internal only); env (`ENCODER_URL`, caps, quota). Update `local-backend-deploy` memory. | both up; sidecar not host-bound; api proxies |
| T21 | verify | End-to-end on a real atlas: KTX2 round-trips, loads in Pixi on a capable GPU, falls back on an incapable one; receipt VRAM honest; temps cleaned; backend-off ⇒ byte-identical zip. | manual verify pass; determinism (pinned flags → stable bytes) |

**Suggested commit grouping:** T1 · T2+T3 · T4 · T5 · T6 · T7+T8 · T9 · T10+T11 · T12 · T13 · T14 · T15+T16 ·
T17 · T18+T19 · T20 · T21.

---

## 9. HONEST cost / infra / privacy trade-offs (the user must weigh)

1. **Privacy: this relaxes the moat.** "Assets never leave the device" is the product's headline trust claim
   and the basis of "zero server cost." Even opt-in + ephemeral, *some* users will not want any upload, and a
   poorly-worded consent erodes trust for everyone. **Mitigation:** default OFF, scoped to named files,
   per-run consent, no persistence, browser-first stays the only default path. **Weigh:** is the GPU-VRAM win
   worth being the kind of tool that *can* upload at all? (You can ship v1 disabled and gauge demand first.)

2. **Infra cost + ops: the sidecar is real money + real attack surface.** It is a fat, native-binary,
   CPU-heavy, image-decoding service — the opposite of the current zero-cost thin Go box. KTX2/UASTC is
   seconds of CPU per large page; concurrent users need real CPU. **Cost shifts from ~$0 to a sized compute
   bill**, plus the operational burden of patching native-decoder CVEs (libvips/libpng/basisu) and running an
   isolated container. On-PC it's "free" but ties the feature to your home box's uptime/CPU.

3. **Latency vs instant-wow.** Network round-trip + seconds of encode means the native fix is *slow*. **Kept
   strictly off the ≤10s free path** — it's a deliberate, slower, paid step. But users may perceive "the fix
   is slow" if the gating/messaging isn't clear that it's the opt-in extra.

4. **The VRAM win is conditional, and that's a marketing tension.** The 4×–8× number is real but only on GPUs
   supporting BC7/ASTC/ETC2 with the transcoder shipped. Honesty *requires* hedging the headline number; an
   over-claimed "4× less VRAM!" would be false on fallback devices. **Weigh:** the honest caveat is less
   punchy than competitors who fake it — but honesty is your differentiator.

5. **Quality: lossy.** UASTC is high-quality but lossy; some art (crisp UI, gradients) may show block
   artifacts. The fix must label it lossy and keep the raster fallback, which means **larger zips** (you ship
   both `.ktx2` AND raster). Disk goes *up* even as VRAM goes down — another honest-but-counterintuitive thing
   to explain.

6. **Determinism risk.** External toolchains drift by version. Pinning fixes it but adds maintenance (track +
   bump `basisu`/`toktx` deliberately). The repo's byte-identical-when-off discipline must hold: a backend op
   must never change the output when the path is off.

7. **Public rollout is a separate lift.** v1 runs on the existing on-PC + tailnet. A real Pro launch needs:
   deploy creds (absent today), the native binaries in a deploy image, a sized compute plan, and a clear
   privacy policy for the upload. **Weigh:** ship v1 self/dev-only, validate the VRAM win on real games, then
   decide on public infra.

**Bottom line recommendation:** build v1 = **KTX2-only, sidecar-gated-by-`apps/api`, default OFF, on-PC
compose**. It is the single feature that (a) can't be done in-browser and (b) actually lowers GPU VRAM, it
forces the honest GPU-VRAM model to be built correctly once, and it keeps every relaxation bounded and
reversible. Defer all disk-only native features (pngquant/kernels/AVIF/JPEG) to v2 on the same rails. Do not
ship the backend path enabled-by-default, and do not fatten the billing image.

I now have complete ground-truth verification. Let me write the final revised design.

# Disk-Only Native Ops on the round12 Sidecar — Adversarial Review + Revised Design

## Verdict

The draft is **largely code-grounded and correct on its two load-bearing claims** (gateway is op-agnostic; AVIF-4:4:4 already runs locally). It picks the right v1 op (pngquant) and the right honesty pivot (disk-only, no VRAM field). But the **adversarial pass found four real defects** that must be fixed before it is implementation-ready, plus three rebuttals where the draft is right.

### Confirmed against actual code (PASS)
- **Gateway truly op-agnostic.** `apps/api/internal/httpapi/encode.go:198` `handleEncode` reads the body, never inspects `op`/`profile`, and proxies verbatim (`:238`). Its test sends `{...,"op":"ktx2",...}` and asserts the body is forwarded EXACTLY and the fake sidecar's bytes stream straight back (`encode_test.go:122,209`). New op ⇒ **zero gateway changes**. CONFIRMED.
- **Sidecar seam is exactly three spots.** `encode.go:25` (`Op` union), `:53` (`SupportedProfiles`), `toktx.go:29` (`flagsFor`), `server.go:91-98` (two 415 checks). The `Encoder` interface (`encode.go:47`) is the mock seam; tests inject fakes and never exec a binary (`encode_test.go`, `server_test.go`). CONFIRMED.
- **AVIF-4:4:4 already runs in-browser.** The fonts→444 override sets `avifSubsample: 3` (`App.tsx:1267`), threaded through `formatEncode` global (`settings.ts:179`) → `fix.worker.ts:2549` → `@jsquash/avif encode({subsample})`. Routing it to the backend would be a pure regression. CONFIRMED — **prompt item #3 is correctly killed.**
- **pngquant is genuinely native-only.** The honest skip note already says so: `en.json:264` "Lossy PNG quantization is unavailable in-browser." Canvas/`@jsquash` have no median-cut indexed-PNG path. CONFIRMED.
- **In-place replace is free.** The pre-zip dedup (`fix.worker.ts:2362-2363`) is `Map`-keyed last-write-wins, so pushing pngquant'd bytes at the same path after the original page is exactly the supported idiom. CONFIRMED.

---

### BLOCKERS (must fix)

**B1 — `whyNoChroma` is NOT simply "stale, delete it."** The note (`en.json:265`) reads *"AVIF chroma subsampling **toggle** is held until its mapping is verified."* That is **accurate**: the `avifSubsample` field is wired (`fix-protocol.ts:36-37`, `fix.worker.ts:2508-2509` "no UI toggle ships — kept hidden") but **no general subsample UI toggle exists** — only the fonts444 preset hard-codes `3`. Deleting the note silently would leave the hidden-toggle situation undocumented. **Fix:** the note is about the *toggle*, not the capability; keep it OR (better) the prompt's `[1m]` context is irrelevant here — simply **retarget** it to the truth ("the general AVIF subsample toggle stays hidden; the fonts→4:4:4 preset already ships it"). Do NOT delete it as part of a pngquant change — that conflates two features. **This is the single biggest correction to the draft.**

**B2 — `FormatTarget.pngLossy` collides with the dup-target key.** `validateFormatList` (`scale.ts:134`) keys every PNG target as the literal string `'image/png'` (`key = 'image/png'`). So `{format:'image/png'}` and `{format:'image/png', pngLossy:true}` both produce key `'image/png'` ⇒ the validator flags `dupTarget` and **fails the whole profile closed**, or (if only one is present) silently can't distinguish them. The draft's §6 never addresses this. **Fix:** the dup key for PNG must become `key = pngLossy ? 'image/png|lossy' : 'image/png'`. Without this the profile path is broken.

**B3 — Receipt-field collision: do NOT add a parallel `pngquantNative` field.** The draft proposes a new `FixReceipt.pngquantNative`. But `backendNative` (`fix-protocol.ts:329`) is **already keyed by `op: NativeOpKind`** and the App receipt block (`App.tsx:1648-1665`) renders exactly one `backendNative` object. A second parallel field means a second render block, a second i18n receipt string family, and a structure where two ops can't both report. **Fix:** generalize `backendNative` to an **array** (or keep single-op-per-run for v1 and discriminate on `op`). The disk-only honesty is still preserved structurally because `ktx2VramBytesWorstCase` is a **separate sibling field** — pngquant simply never sets it, and adds `bytesBefore/bytesAfter` (disk-only). No `pngquant…Vram…` field, ever.

**B4 — The "either/or" routing the prompt demands (item #5) is under-specified for the AVIF/PNG path.** The draft says `formatEncode` emits a `nativePng` marker and the worker routes it, "else local lossless." But the worker's PNG emit must be a **clean, deterministic either/or**: a `pngLossy` target with backend-on ⇒ compose lossless PNG locally, then route THAT page through pngquant in-place (it already needs a lossless source — same as KTX2's re-decode at `fix.worker.ts:2306-2316`); backend-off/declined/floor ⇒ keep the local lossless PNG + honest skip. It must **never** double-emit or race the export-profile fan-out. Pin this: pngquant is a **post-pass that replaces an already-composed PNG page**, identical in shape to the KTX2 post-pass (`:2300`) but in-place instead of additive. This makes the collision with the browser export-profile path impossible by construction (the profile produces the PNG; pngquant only re-compresses its bytes).

### MAJORS

**M1 — Quality-floor outcome must be a distinct, non-error code end-to-end.** The draft's `--quality=45-85` makes pngquant exit 99 when it can't hit the floor. Good — but the sidecar currently maps every exec failure to `ErrEncodeFailed → 502` (`toktx.go:86-92`, `server.go:164`). A 502 would make the client log it as a backend *failure*. **Fix:** add `ErrQualityFloor`, detect exit-99 specifically in `PngQuantEncoder`, map it to a **distinct 200-with-marker or a 422/`quality_floor` code** the client treats as "kept original, not a failure" — so the receipt's `failed` count isn't polluted by an honest decline.

**M2 — `Op != KTX2` hard-check inside `ToktxEncoder.Encode` (`toktx.go:44`).** Even with a `Dispatcher`, the dispatcher routes `PngQuant→PngQuantEncoder`, so `ToktxEncoder` never sees pngquant — fine. But `server.go:136-141` hard-codes `Op: encode.KTX2` when building the `Request`. **Fix:** pass `Op: encode.Op(req.Op)` through (it's already validated against `SupportedOps`), else the dispatcher can never see pngquant.

**M3 — pngquant determinism caveat is real and must be pinned harder than the draft implies.** Debian's `pngquant` is built against `libimagequant`; a point-release can change dithering bytes. The draft pins the apt version — good — but should add a **golden-bytes determinism test gated behind the real binary** (deploy-time, like round12 T21), not a unit test, since the mock seam can't verify byte output.

### Rebuttals (draft is right, keep as-is)
- **Gateway zero-change** — correct, proven by `encode_test.go`.
- **pngquant-only v1, mozjpeg/sharp/kernel deferred** — correct and honest. mozjpeg loses alpha and AVIF/WebP beat it; sharp kernels move *geometry* not an encode. Cut both.
- **stdin/stdout for pngquant** — correct; it's cleaner than toktx's temp-out (toktx can't read stdin; pngquant can). One fewer attacker-influenced path.
- **Image-size accounting** — correct; `pngquant` on bookworm-slim pulls `libpng16`/`libimagequant0`, single-digit MB, one binary, no new network cap, posture unchanged.

---

## FINAL REVISED DESIGN — pngquant disk-only op on the round12 sidecar

### 0. Scope
**v1 adds exactly one op: `pngquant` lossy-indexed PNG.** Native-only (no in-browser equivalent), disk-only (decodes to full RGBA8888 on GPU ⇒ VRAM unchanged), in-place (replaces PNG bytes at the same path — not additive like KTX2). Default OFF; backend/op absent ⇒ byte-identical zip.

**Scope of the in-place post-pass (finding [0]):** pngquant is a *page re-compressor*, so v1 applies it ONLY to **single-tier loose PNG pages** — the page composed once at scale 1 by `emitLooseProfileFanout` (`fix.worker.ts` recordPngquantCandidate site). It is deliberately OUT of scope for (a) the **multi-tier** path (a profile carrying a lower-resolution tier) and (b) **atlas / Spine sheets**, both of which flow through the multi-tier loop. A `nativePng`-marked PNG that reaches that loop ships as a normal lossless PNG; per invariant 3 (never a silent skip) the worker emits **one honest `skipped[]` note per ref** at the tier PNG-emit site ("pngquant skipped: lossy PNG applies only to single-tier loose pages — emitted lossless"), gated on `pngquantOn` so backend-off stays byte-identical. This mirrors the tier loop's other v1-scope notes (Spine-stays-PNG, `tierTransformed` repacked-sheet). Re-compressing per-tier downscales / large atlas sheets is a candidate for v2.

**Out of scope:** sharp/libvips kernels & pre-blur (v2; move geometry not an encode), mozjpeg (loses alpha; AVIF/WebP win), AVIF-4:4:4-on-backend (already local — regression), any gateway envelope/quota change, async jobs, public deploy.

### 1. Honesty (structurally enforced)
- A pngquant PNG decodes to RGBA8888 ⇒ `vramCeilingOfPage('raster', w, h, mips)` = `w·h·4`, identical to original. **There is no pngquant VRAM field and never will be.** `CompressedTextureFormat`/`COMPRESSED_BYTES_PER_PX_CEILING` (`core/index.ts:280-292`) stay KTX2-only.
- Receipt copy says **"smaller download / cache,"** never GPU/VRAM. Contrast `fix.backend.receiptVram` (`en.json:363`) which legitimately claims GPU memory for KTX2.
- `bytesBefore`/`bytesAfter` are **real measured** PNG byte sums (original page bytes vs pngquant'd bytes). Honesty by omission of any VRAM field — can't drift.

### 2. Sidecar (`apps/encoder`)

**`internal/encode/encode.go`** — grow the allowlist:
```go
const PngQuant Op = "pngquant"
const ProfilePngQuant256 Profile = "pngquant-256-fs"   // 256 colors, Floyd–Steinberg
var SupportedOps = map[Op]bool{KTX2: true, PngQuant: true}            // NEW closed set
var SupportedProfiles = map[Profile]bool{ProfileUASTCZstdMip: true, ProfilePngQuant256: true}
var opProfiles = map[Op]Profile{KTX2: ProfileUASTCZstdMip, PngQuant: ProfilePngQuant256} // op×profile compat
var ErrQualityFloor = errors.New("quality floor not met")             // M1
```

**`internal/encode/pngquant.go`** (new) + a `Dispatcher`:
```go
type PngQuantEncoder struct{ Bin, TmpDir string; Timeout time.Duration }
func pngQuantFlags(p Profile) ([]string, error) {
    switch p {
    case ProfilePngQuant256:
        // stdin→stdout: no output-path guessing, one fewer attacker path. Quality floor → exit 99.
        return []string{"--quality=45-85", "--speed", "1", "--strip", "--force", "256", "--output", "-", "-"}, nil
    }
    return nil, ErrUnsupported
}
// Encode: write PNG to stdin, read stdout. Detect exit-99 → ErrQualityFloor (NOT ErrEncodeFailed).
// Same posture as ToktxEncoder: minimal env (PATH only), never log bytes, timeout, temp-finally if any.

type Dispatcher struct{ Toktx, PngQuant Encoder }
func (d *Dispatcher) Encode(ctx context.Context, req Request) ([]byte, error) {
    switch req.Op {
    case KTX2:     return d.Toktx.Encode(ctx, req)
    case PngQuant: return d.PngQuant.Encode(ctx, req)
    default:       return nil, ErrUnsupported
    }
}
```

**`internal/httpapi/server.go`** — generalize the op check (`:91`) + add op×profile compat + propagate op (M2):
```go
if !encode.SupportedOps[encode.Op(req.Op)] { /* 415 unsupported_op */ }
if encode.RequiredProfile(encode.Op(req.Op)) != encode.Profile(req.Profile) { /* 415 unsupported_profile */ }
// ... caps unchanged (:100-119) ...
out, err := s.enc.Encode(r.Context(), encode.Request{PNG: png, W: req.W, H: req.H,
    Op: encode.Op(req.Op), Profile: encode.Profile(req.Profile)})   // M2: was hard-coded KTX2
```
`mapEncodeError` (`:160`) gains an `ErrQualityFloor` arm → a **distinct 422/`quality_floor`** (NOT 502). Caps, sweeper, concurrency cap are op-agnostic and cover pngquant free (pngquant is far lighter than UASTC RDO, so `MaxConcurrent=2` is conservative).

**`internal/config/config.go`** — add `PngQuantPath` (mirror `ToktxPath` `:19,51`), default `pngquant`.

**`cmd/encoder/main.go`** — wire the dispatcher:
```go
enc := &encode.Dispatcher{
  Toktx:    encode.NewToktxEncoder(cfg.ToktxPath, cfg.TmpDir, cfg.ExecTimeout),
  PngQuant: encode.NewPngQuantEncoder(cfg.PngQuantPath, cfg.TmpDir, cfg.ExecTimeout),
}
```

**`Dockerfile`** — one pinned apt package in the existing `RUN` layer (after `:38`):
```dockerfile
 && apt-get install -y --no-install-recommends pngquant=<pinned-bookworm-ver> \
 && pngquant --version \   # build-log proof; pin discipline = re-verify determinism golden on bump
```
Add `PNGQUANT_PATH=/usr/bin/pngquant` to the `ENV` block (`:57`). Honest note: pulls `libpng16`+`libimagequant0` (mostly already present), single-digit MB, non-root + RO-FS + tmpfs unchanged.

### 3. Gateway (`apps/api`) — NO code change
`handleEncode` proxies verbatim; entitlement, `licenseQuota`, `EncodeMaxBodyBytes`, `EncodeTimeout`, healthz all apply unchanged. The single `EncodeTimeout` (sized for slow UASTC) safely covers fast pngquant. v1 keeps one quota knob (a pngquant encode counts like a KTX2 encode). **Add one parametrized test** proving `op:pngquant` proxies through entitlement+quota identically.

### 4. Client (`apps/web` + `packages/fix`)

**`fix-protocol.ts`**:
```ts
export type NativeOpKind = 'ktx2' | 'pngquant';   // :146 additive
// B3: generalize backendNative to an array (or keep one-op-per-run + discriminate on op). Add disk-only fields:
backendNative?: { op: NativeOpKind; uploaded: number; produced: number; failed: number; host: string;
                  bytesBefore?: number; bytesAfter?: number }[];   // bytes* set for pngquant only; NO Vram field
```
`BackendOptions.ops` (`:161`) already accepts `NativeOpKind[]` ⇒ `ops:['ktx2','pngquant']` needs no shape change.

**`backend-client.ts`** — fix the hard-coded profile (`:93`):
```ts
export const PNGQUANT_PROFILE = 'pngquant-256-fs';   // beside KTX2_PROFILE (:24)
const profile = op === 'pngquant' ? PNGQUANT_PROFILE : KTX2_PROFILE;   // in encodeRemote body
```
Everything else (base64 envelope, Bearer, never-throws, error mapping) reused.

**`fix.worker.ts`** — a pngquant post-pass mirroring KTX2 (`:2300`) but **in-place** (B4):
- Gate `pngquantOn = backend present && consent && ops.includes('pngquant') && apiBase && token` (mirror `backendOn` `:722`).
- A `recordPngquantCandidate` collector at PNG-emit sites only (the `enc.mime==='image/png'` page-encode sites + the `out.push` at `:1109`); no-op when off ⇒ byte-identical (the `:2277` additivity proof).
- Post-pass: re-decode the page to lossless PNG (reuse the `:2306-2316` idiom), `encodeRemote(png,'pngquant',w,h,…)`. On `ok`: **push pngquant'd bytes at the same path** (last-write-wins dedup `:2362` handles it), `bytesBefore+=orig.length; bytesAfter+=res.bytes.length`. On `!ok` OR `quality_floor`: keep original PNG, push honest `skipped[]` note. **No `referencesChanged`, no manifest variant, no sidecar, no VRAM field, no `vramCeilingOfPage('ktx2-…')` call.**

**`App.tsx`**:
- `buildBackendOptions()` (`:1389`) adds `'pngquant'` to `ops` when the new toggle is opted in. **Reuse the exact same gate** (`backendConfigured` `:1240`, `backendReachable` `:1311`, per-run `backendConsent`) — same host, same consent ⇒ **no new privacy surface**.
- **B1 fix:** do NOT delete `whyNoChroma`. Retarget `whyNoPngquant` (`:604,1137`) to a backend-available toggle when configured+reachable+Pro (mirror the KTX2 toggle `:777`), honest "unavailable in-browser" otherwise. `whyNoKernel`/`whyNoPreBlur` stay (v2). `whyNoChroma` stays accurate (the general subsample toggle is still hidden).

### 5. Profile integration — one config surface (§6 of the draft, corrected)
- **`core/index.ts:131` `FormatTarget`** — add `pngLossy?: boolean` (explicit, validateProfile-checkable; clearer than overloading `quality`). No VRAM/footprint change.
- **`settings.ts:143 formatEncode`** — when `format==='image/png' && pngLossy`, return a `nativePng: true` marker instead of `lossless: true`. **`formatEncode` stays PURE — it only decides**, never uploads.
- **B2 fix — `scale.ts:134 validateFormatList`** — the PNG dup-key MUST split: `key = f.pngLossy ? 'image/png|lossy' : 'image/png'` so a lossless+lossy PNG pair doesn't false-positive `dupTarget`. Add a rule: `pngLossy` only on `image/png` (fail-closed otherwise).
- **Override path** — `resolveProfileForRef` (`:248`) + `overlayFormat` (`:222`) already fold per-folder format replacements; `overlayFormat` returns PNG unchanged, so a `pngLossy` PNG target rides through untouched. A folder rule `{match:'ui', formats:[{format:'image/png', pngLossy:true}]}` routes that folder's PNGs to pngquant — symmetric with fonts→4:4:4 (`App.tsx:1267`).
- **B4 — clean either/or:** the worker reads `nativePng` at the PNG-emit site; if `nativePng && pngquantOn` ⇒ the page is composed lossless locally then re-compressed by the post-pass; else lossless PNG + honest `skipped[]` ("lossy PNG needs the opt-in backend — emitted lossless instead"). The export-profile produces the PNG; pngquant only re-encodes its bytes ⇒ no double-emit, no race, deterministic.

### 6. Security
Unchanged round12 posture: non-root (uid 10001), RO root FS, tmpfs `/tmp`, no DB/secret, internal-net-only, entitlement-gated upstream. One new binary = one narrow, widely-fuzzed PNG CVE surface, covered by existing dimension/pixel/size caps **before decode** (`server.go:100-119`), exec timeout, concurrency cap, minimal env, temp-finally. stdin/stdout (no temp-out) shrinks pngquant's surface vs toktx. No flag injection: request carries only `op`+`profile` (closed sets); flags from the closed `pngQuantFlags` map; PNG rides as base64 stdin, never a shell arg.

### 7. Test plan
**Go (mock seam, no binary):** `pngQuantFlags` pins the deterministic flag set + `ErrUnsupported` on unknown; `SupportedOps`/`SupportedProfiles` membership + closed-set negatives; **op×profile incompatibility** (`{pngquant, uastc-zstd-mip}`→415); `Dispatcher` routes `KTX2→Toktx`, `PngQuant→PngQuant`, unknown→`ErrUnsupported`; `PngQuantEncoder` missing-binary→`ErrEncodeFailed`+no-temp-leak (mirror `encode_test.go:57`); **exit-99→`ErrQualityFloor`** distinct from `ErrEncodeFailed`; `server_test.go` `{op:pngquant}` with fake→200, bad profile→415, oversize→413, over-dim→415, busy→503, **quality_floor→422** (not 502). Gateway: one parametrized proxy test.
**TS (Vitest):** `settings.test.ts` `formatEncode({png,pngLossy})`→`nativePng` (not `lossless`); plain png still `lossless` (byte-identical); `validateFormatList` lossless+lossy PNG pair NOT flagged `dupTarget` (B2); `pngLossy` rejected on non-png; `resolveProfileForRef` folds a `pngLossy` override. `backend-client.test.ts` `encodeRemote(…, 'pngquant', …)` sends `profile:'pngquant-256-fs'`. Worker: ops absent/not-opted ⇒ collector no-op ⇒ zip byte-identical; mocked ok ⇒ page bytes replaced at same path, `bytesBefore/After` accumulated, **no** `referencesChanged`/VRAM field; `quality_floor`⇒original kept + honest skip. i18n drift: new `fix.backend.pngquant*` keys consistent across 9 locales; **`whyNoChroma` retained** (B1); en matches baked.
**Real-tool e2e (deploy step, mirror T21):** real folder → PNGs shrink 60–80%, pixel-within-dither, `bytesBefore/After` real, temps cleaned, backend-off⇒byte-identical zip, floor-decline keeps original, latency <1s/page (confirms shared timeout fine), **golden-bytes determinism check vs the pinned pngquant version** (M3).

### 8. Ordered task breakdown (small commits)

**Phase 0 — protocol + honesty**
- **T1 `[DOC]`** New `docs/improvements/round13-disk-native-ops.md`: v1 scope, AVIF-444-is-local rationale (keep `whyNoChroma`, retarget `whyNoPngquant`), pngquant disk-only.
- **T2 `[PROTO]`** `fix-protocol.ts`: `NativeOpKind|='pngquant'`; generalize `backendNative` to an array + add `bytesBefore/After` (B3, **no VRAM field**).
- **T3 `[CORE]`** `FormatTarget.pngLossy?: boolean` (no VRAM/footprint change).

**Phase 1 — sidecar**
- **T4 `[SC]`** `encode.go`: `PngQuant`, `ProfilePngQuant256`, `SupportedOps`, `opProfiles`/`RequiredProfile`, `SupportedProfiles` entry, `ErrQualityFloor`.
- **T5 `[SC]`** `pngquant.go`: `PngQuantEncoder` (stdin→stdout, pinned flags, exit-99→`ErrQualityFloor`, minimal env, never-log-bytes) + `Dispatcher`; wire in `main.go`.
- **T6 `[SC]`** `server.go`: `SupportedOps` check + op×profile compat (415) + **propagate `Op` (M2)** + `ErrQualityFloor`→422; `config.go`: `PngQuantPath`. Go tests (§7).
- **T7 `[SC]`** `Dockerfile`: pinned `pngquant` apt pkg + `--version` proof + `PNGQUANT_PATH`. Honest image-size note.

**Phase 2 — gateway**
- **T8 `[BE]`** Verify-only + one parametrized `op:pngquant` proxy/quota test. No code change expected.

**Phase 3 — client + profile**
- **T9 `[FIX]`** `settings.ts formatEncode`: `nativePng` marker for `pngLossy`; `scale.ts validateFormatList`: **PNG dup-key split (B2)** + `pngLossy`-only-on-png rule. Pure tests.
- **T10 `[WEB]`** `backend-client.ts`: `PNGQUANT_PROFILE` + op-keyed `profile` (fixes the `:93` hard-code). Test.
- **T11 `[WEB]`** `fix.worker.ts`: `recordPngquantCandidate` (gated like `backendOn`) + in-place post-pass (`bytesBefore/After`, honest skip on fail/floor, **no** `referencesChanged`/VRAM); clean either/or with `nativePng` (B4). Additivity test.
- **T12 `[WEB]`** `App.tsx buildBackendOptions`: add `'pngquant'` when opted; reuse existing consent/reachable/Pro gate; route `nativePng` targets to backend or honest lossless fallback.

**Phase 4 — UX + i18n**
- **T13 `[WEB]`** Retarget `whyNoPngquant` to a backend toggle when available; **keep `whyNoChroma` (B1)**; add the lossy-PNG profile toggle beside AVIF-444.
- **T14 `[I18N]`** `fix.backend.pngquant*` keys (toggle/hint/consent-reuse/receipt="smaller download"/fallback) across 9 locales; **`whyNoChroma` retained**; en matches baked. Drift test.

**Phase 5 — deploy + verify**
- **T15 `[DOC]`/deploy** Update `docker-compose.example.yml` + `local-backend-deploy` memory (image now carries pngquant).
- **T16 `[E2E]`** Real-tool verification per §7 incl. determinism golden (M3).

**Commit grouping:** T1 · T2+T3 · T4 · T5 · T6 · T7 · T8 · T9 · T10 · T11 · T12 · T13 · T14 · T15 · T16.

### 9. Key files (absolute)
- Sidecar: `/home/nonamezzz/Рабочий стол/projects/apps/encoder/internal/encode/encode.go` (`:25,47,53`), `.../encode/toktx.go:29` (flag pattern), `.../encode/pngquant.go` (new), `.../httpapi/server.go:91-119,136-141,160` (op check + **propagate Op M2** + error map), `.../config/config.go:19,51`, `.../cmd/encoder/main.go:30` (dispatcher), `.../Dockerfile:33-48,57`, `.../encode/encode_test.go` (mock pattern)
- Gateway (no change): `/home/nonamezzz/Рабочий стол/projects/apps/api/internal/httpapi/encode.go:198,238`
- Client: `/home/nonamezzz/Рабочий стол/projects/apps/web/src/lib/backend-client.ts:24,75,93`, `.../src/worker/fix-protocol.ts:146,329`, `.../src/worker/fix.worker.ts:722,1109,2300,2362`, `.../src/App.tsx:604-605,1267,1389,1648`
- Profile/core: `/home/nonamezzz/Рабочий стол/projects/packages/fix/src/settings.ts:143,179,222,248`, `.../packages/fix/src/scale.ts:134` (**dup-key split B2**), `/home/nonamezzz/Рабочий стол/projects/packages/core/src/index.ts:131` (FormatTarget; leave `280-292` VRAM types untouched)
- i18n: `/home/nonamezzz/Рабочий стол/projects/packages/i18n/src/catalogs/en.json:262-265,350-364` (retarget `whyNoPngquant`, **keep `whyNoChroma`**, add `fix.backend.pngquant*`)

### 10. Bottom line
Build **v1 = pngquant-only**, one pinned Debian binary, dispatcher seam on the existing op-agnostic sidecar, gateway untouched, default OFF, disk-only with **no VRAM field** (honest by omission). The draft's architecture is sound; the must-fixes are **B1** (don't delete `whyNoChroma` — it's accurate), **B2** (split the PNG dup-target key or the profile path breaks closed), **B3** (generalize `backendNative`, don't add a parallel field), **B4** (pngquant is an in-place post-pass on the composed PNG — clean either/or vs the export profile), plus **M1** (quality-floor is a distinct non-error code) and **M2** (propagate `Op` past `server.go:136`). Cut mozjpeg and sharp/kernels honestly. Determinism is real only with a pinned pngquant version + a deploy-time golden (M3).
Confirmed: no existing resample/vips/lanczos op. All grep hits are incidental comments. The feature is genuinely not-yet-built. No false-premise of re-proposing shipped work.

I now have everything needed. Let me write the final revised mini-design.

---

# ADVERSARIAL REVIEW — libvips lanczos3 resample op (sidecar) + measured-quality receipt

## Verdict: SALVAGEABLE with two BLOCKERS fixed + scope tightened. Premise is TRUE.

All cited code verified against `feat/asset-pipeline` (current branch, 47 commits). The four `imageSmoothingQuality='high'` sites match exactly (worker lines 1306/2178/2249/3149). `en.json:331 whyNoKernel` exists verbatim. `NativeOpKind` is at fix-protocol.ts:210, `backendNative` at 470, the encoder allowlist + pngquant stdin/stdout + Dispatcher + op-agnostic gateway (`handleEncode`) + Dockerfile pin discipline are all as described. The feature is genuinely not-yet-built (no resample/vips/lanczos op anywhere — grep hits are incidental). This is a real, code-grounded, honest unit.

But the draft has **two blockers** and **two majors** the author must fix; below is the revised design.

### BLOCKER 1 — Cache-busting hash/content mismatch (the draft's central false claim)
The draft asserts the resample post-pass is "in-place replace at the SAME path … NO referencesChanged since the tier path/format/dims are unchanged." **This is false when `hashFilenames=true`.** Verified: the tier loop computes `emittedImage = hashEmit(tierImagePath, enc.bytes)` (worker:3206) where the filename embeds `shortHash(enc.bytes)` of the **browser-downscaled bytes** (hashEmit, 981–1009), and the per-tier manifest's `meta.image` is repointed to that hashed name (3190 `scaled.imageRef`). Replacing the bytes in-place leaves the filename's hash describing the *old* (browser) bytes while the file *content* is the vips bytes — a content/hash integrity violation, and the manifest `src[]` points at a name whose hash no longer matches its content. This defeats the entire purpose of round9 cache-busting.

Note this is a **pre-existing latent issue in shipped pngquant** (pngquant records `emittedPath` then replaces at `c.path` without re-hashing, 1631/3640), but pngquant is single-tier-loose-only and far less coupled; the tier loop is where cache-busting is the documented motivation, so resample *amplifies* it. The draft must not silently inherit it.
**Fix (required):** when `hashOn`, the post-pass must NOT replace in place. It must (a) re-hash the vips bytes → a new hashed name, (b) emit at the new name, (c) drop the old browser-tile entry from `out`, and (d) repoint the per-tier manifest `meta.image` / Pixi `recordVariant` src + emit a loader-migration row (`referencesChanged=true`). When `hashOff`, the path is byte-stable and a true in-place replace is sound (pngquant-identical). Simpler, defensible alternative for v1: **gate resample OFF when `hashFilenames` is on** and emit an honest skip ("resample skipped: not yet supported with content-hash cache-busting") — this keeps v1 small and avoids re-threading the cache-bust chain through a post-pass. Either is acceptable; the draft's stated approach (unconditional in-place) is NOT.

### BLOCKER 2 — `whyNoKernel` is used at 3 sites; retargeting it lies at 2 of them
The draft says "retarget the note." Verified: `whyNoKernel` renders at App.tsx **686, 1022, 1275** — three places, two of which are the non-tier downscale paths (resize / compose) where resample is explicitly NOT routed in v1. Retargeting the copy to "enable the lanczos3 resample backend op for cleaner tier downscales" makes it **false at those two sites** (the kernel is not lifted there). 
**Fix (required):** do NOT retarget the existing key. Keep `whyNoKernel` truthful as-is for the un-routed sites and add a SEPARATE new key (e.g. `fix.backend.resampleHint` / `fix.skipped.tierKernelLifted`) shown only on the tier path when resample is available. This avoids a cross-site honesty regression and keeps the drift test honest.

### MAJOR 1 — The measurement directionally true but the receipt copy overclaims
The draft correctly *abandons* SSIM-vs-ground-truth (there is no in-browser Lanczos reference — the self-correction is sound and honest) and lands on a Laplacian/high-frequency-energy retention delta. That is a real, deterministic, device-independent measured number, consistent with the existing pure pixel-math precedent (`perceptual.ts`: luma, box-average, deterministic region extraction). **But** lanczos3's extra high-frequency energy includes *ringing/overshoot*, which is an artifact, not "detail." So "N% more edge detail = sharper, cleaner tiers" overclaims. Invariant 3 (measure, don't editorialize a verdict).
**Fix (required):** name the field and copy for what is measured: `qualityHfEnergyDelta` (or keep `qualitySharpnessDelta` but) with receipt copy "lanczos3 retained N% more high-frequency content at the same file size" — a measured fact, no "cleaner/better" verdict. Display clamp ≥0; on ≤0 keep the browser tile and count delta 0 (not failed), as the draft already says.

### MAJOR 2 — Upload is the FULL-RES source, not a downscaled tile (cost + format)
Unlike KTX2/pngquant (which upload the already-downscaled composed page), resample must upload the **full-res top tier**. Verified the bytes exist (`bytes = bytesByRef.get(ref)` at 3087 = original on-disk source), but (a) the source may be lossy JPEG/WebP, while the sidecar `processRequest.png` expects PNG base64 — so the worker must PNG-encode the full-res `srcBmp` first (the KTX2 path already does exactly this re-encode-to-PNG-for-upload at 3507–3518, so it's precedented but the draft glosses it); (b) a full-res PNG is materially larger than a tile and pushes against the 32 MiB body / 64 Mpx caps. The draft's edge-case handling (oversized → 413 → honest fallback) is correct, but the design body must state the full-res PNG re-encode step + its memory cost explicitly, and reuse the KTX2 `createImageBitmap → drawImage → convertToBlob('image/png')` idiom.

### Rebutted / confirmed-fine (no change needed)
- **Gateway zero-changes:** CONFIRMED. `handleEncode` (apps/api encode.go:199) reads the body and proxies verbatim to the sidecar `/process` without inspecting op/profile. The draft's "encode.go:198/:238" point at this function. No gateway change needed.
- **Sidecar op-agnostic propagation:** CONFIRMED. `httpapi/server.go` already propagates `encode.Op(req.Op)` (line 150, "do NOT hard-code KTX2"). Adding the op needs only the allowlist + encoder + dispatcher arm.
- **Temp-file fallback feasibility:** the read-only-root + `/tmp`-tmpfs + non-root posture means a vips temp-file fallback MUST use `TmpDir`/`/tmp` (toktx already does). Acceptable; the draft's fallback note stands but must say "via TmpDir."
- **`fix.worker.ts` has no Node runtime:** CONFIRMED the load-bearing tests must be the Go gate + the pure TS helpers (perceptual/ktx2-probe-collect precedent). The draft's test split is right.
- **The one external API to confirm (vips CLI flags):** legitimately flagged. This is the single unverifiable-without-the-binary surface. Keep it as a pre-merge confirmation gate, not a guess.

---

## REVISED MINI-DESIGN

### Scope (v1)
New sidecar op `resample` (profile `vips-lanczos3`): `ResampleEncoder` shells to a **pinned `vips`**, target `w`/`h` from the request, PNG stdin→stdout, no temp files (mirror pngquant; temp-file fallback via `TmpDir` only if the pinned vips can't stream both ways). Closed allowlist + dispatcher arm + pinned `libvips-tools` in the Dockerfile.
Client: `'resample'` in `NativeOpKind` + `profileForOp`. Worker: a GATED post-pass at the **tier loop only** (3149), strictly gated on `opts.backend` + `consent` + `ops.includes('resample')` + non-empty apiBase/token. Uploads the **full-res source, PNG-re-encoded** + target tier dims; on success decodes the vips tile, **re-encodes it to every tier format** for that ref, measures `qualityHfEnergyDelta`, and:
  - **`hashFilenames` OFF:** replaces the tier page bytes in place (pngquant-identical, byte-stable path).
  - **`hashFilenames` ON:** EITHER re-hash + repoint manifest/variant/loader-row (`referencesChanged=true`) OR (v1-simplest) **skip resample with an honest note**. (Pick one in task 7; do not ship unconditional in-place.)
Off/declined/failed/oversized ⇒ existing OffscreenCanvas tier runs ⇒ byte-identical fallback.
Receipt: a `backendNative` `op:'resample'` entry with **NO VRAM and NO disk field**, carrying only `qualityHfEnergyDelta`.

### Out of scope
mozjpeg, mitchell/other kernels, the three non-tier downscale sites (1306/2178/2249 keep the browser resampler — and keep the *unchanged* `whyNoKernel` note), any gateway/quota change, live deploy (creds-blocked — ship behind a mock `Encoder` like toktx/pngquant).

### Honesty / invariants (structurally enforced)
- **Inv 5:** resample changes neither disk nor VRAM; the entry has NO disk/VRAM field, ever. Only number carried = `qualityHfEnergyDelta`.
- **Inv 3:** the delta is MEASURED in-worker (deterministic Laplacian/HF-energy of vips tile minus browser tile, device-independent), surfaced as "retained N% more high-frequency content at the same file size" — measured fact, no verdict.
- **Inv 1 & 2:** identical opt-in gate to KTX2/pngquant; absent/declined ⇒ path dead, output byte-identical. Sidecar holds no secrets, stdin/stdout, never logs bytes.
- **`whyNoKernel`:** UNCHANGED (still true on the un-routed sites). A new tier-only key carries the resample hint.

### Determinism
Pinned vips + CLOSED `vipsFlags` (request supplies no flags) ⇒ same bytes; re-verify the pin on bump with a deploy-time golden (toktx/pngquant precedent). Worker: HF-energy is pure integer/float pixel math; candidates in push order; fallback path byte-identical (the local tile already ran).

### Type changes (`fix-protocol.ts`)
- `NativeOpKind` (210): `'ktx2' | 'pngquant' | 'resample'`.
- `backendNative[]` (470): add `qualityHfEnergyDelta?: number` (resample ONLY; NO disk/VRAM field for resample, doc it). `ops` doc (225) notes `'resample'`. No new wire fields.

### Sidecar (`apps/encoder`)
- `encode.go`: `Resample Op = "resample"`, `ProfileVipsLanczos3 = "vips-lanczos3"`, + `SupportedOps`/`opProfiles`/`SupportedProfiles` entries. `Request` unchanged (W/H = **output** target, `req.PNG` = **input** source — document the asymmetry; for ktx2/pngquant W/H describe the input, for resample they're the output).
- `resample.go` (new): `ResampleEncoder{Bin,Timeout}`, `NewResampleEncoder`, `vipsFlags(Profile)` (CLOSED), `Encode`. stdin→stdout, minimal env, `Op!=Resample`/wrong-profile → `ErrUnsupported` pre-exec, timeout/non-zero/empty → `ErrEncodeFailed`, never logs bytes. No `ErrQualityFloor` analogue. **CONFIRM the real vips/vipsthumbnail stdin→stdout forced-w+h lanczos3 flags against the pinned binary; temp-file fallback via `TmpDir` only if streaming unavailable.**
- `pngquant.go` Dispatcher: add `Resample Encoder` field + `case Resample` arm.
- `config.go`: `VipsPath` (`VIPS_PATH`, default `"vips"`). `main.go`: wire `Resample: NewResampleEncoder(cfg.VipsPath, cfg.ExecTimeout)` + log line.
- `Dockerfile`: pinned `libvips-tools` apt (`ARG VIPS_VERSION`), `vips --version` in build log, stable `/usr/local/bin/vips` symlink + `test -x`, `ENV VIPS_PATH`.
- **Gateway: ZERO changes** (verified op-agnostic).

### Client (`apps/web/src/lib`)
- `backend-client.ts`: `RESAMPLE_PROFILE='vips-lanczos3'`; `profileForOp` adds the resample arm. `encodeRemote` unchanged (already takes op+w/h; for resample `pngBytes`=full-res source PNG, w/h=target tier dims).
- `resample-quality.ts` (new, pure, Node-tested): `hfEnergy(rgba,w,h)` (mean |Laplacian| over luma, deterministic) + `qualityHfEnergyDelta(vipsTile, browserTile, w, h)`. NO ground-truth/SSIM claim.
- `resample-collect.ts` (new, pure, Node-tested): gated predicate + candidate builder (full-res source bytes+mime, target dims, browser-tile ref), mirroring `ktx2-probe-collect.ts` so the gate can't regress.

### Worker (`fix.worker.ts`)
`resampleOn` gate (mirror `pngquantOn` 1064). At the tier downscale (3142–3206): compose the local tile as today (byte-identical fallback). When `resampleOn` AND `tier.scale<1`, collect a candidate `{ref, fullResSourceBytes, sourceMime, targetW:dst.w, targetH:dst.h, browserTileImageData, hashOn}`. A post-pass after the tier loop (mirror pngquant 3582) iterates candidates: PNG-re-encode the full-res source (KTX2 idiom 3507–3518), `encodeRemote(srcPNG,'resample',dst.w,dst.h,…)`; on success decode the vips tile, measure the delta, **re-encode the vips bitmap to each tier format for that ref**, then emit per the `hashOn` branch (in-place when off; re-hash+repoint OR skip when on — task 7 decides). On failure/oversized/≤0-delta: keep browser tile, honest `skipped[]` note, increment `failed` only on real failure. Build the `op:'resample'` entry when `produced>0||failed>0` (mirror the all-decline suppression 3714). `cancelled` checked before each candidate (3610).

### Edge cases
Full-res > caps → 413/415 → keep browser tile + honest skip (document: resample uploads the FULL-RES page, larger than ktx2/pngquant — the 32 MiB/8192/64 Mpx caps apply). Tier scale 1 → skip. vips same-dims-diff-bytes → valid; ≤0 delta → keep browser, produced-as-keep, delta 0, not failed. vips PNG decode fail → keep browser, failed++. Older sidecar (op not deployed) → 415 `unsupported_op` → honest fallback (makes ship-before-deploy safe). Spine PNG tiers → applies. `hashFilenames` ON → per the task-7 decision (re-hash+repoint or skip), never silent in-place.

### Tests
**Go (load-bearing gate):** `resample_test.go` — `vipsFlags` returns pinned closed set / foreign→`ErrUnsupported`; wrong-op/profile reject pre-exec; missing-binary→`ErrEncodeFailed` no-byte-leak; `/bin/cat` stdout-passthrough proves stdin→stdout no-temp; Dispatcher routes `Resample`; allowlist assertions. `server_test.go` — `validResampleBody`, `TestProcessResampleSuccess` (op propagated, `fe.lastReq.Op==Resample`), op×profile 415, caps 413/415 through the real HTTP path, no-byte-logging.
**TS (Vitest, Node-importable):** `resample-quality.test.ts` — sharp tile vs box-blurred → positive delta; identical → 0; determinism. `resample-collect.test.ts` — no-op when gate false. i18n drift + app-keys: new resample receipt key + new tier-hint key in all 9 catalogs; **`whyNoKernel` stays unchanged** (assert it is NOT mutated).
**Live (deploy-gated, deferred):** real-vips golden-bytes determinism + real lanczos-vs-canvas HF-energy run after the sidecar is redeployed with libvips (toktx/pngquant deploy-time posture).

### ORDERED TASK BREAKDOWN (small commits)
1. **`feat(encoder): resample Op + vips-lanczos3 profile in the allowlist`** — encode.go entries + encode_test.go/pngquant_test.go allowlist assertions.
2. **`feat(encoder): ResampleEncoder (stdin→stdout vips, no temp files) + Dispatcher arm`** — resample.go + Dispatcher field/case + config.go `VipsPath` + main.go wiring + resample_test.go. **CONFIRM the real vips CLI flags against the pinned binary here** (temp-file fallback via TmpDir if streaming unavailable).
3. **`feat(encoder): HTTP resample path (op-propagated) + caps tests`** — server_test.go only (server.go already op-agnostic; gateway untouched).
4. **`chore(encoder): Dockerfile pins libvips-tools + VIPS_PATH symlink`** — pinned apt, version-in-log, symlink + test -x, ENV.
5. **`feat(web): resample in NativeOpKind + profileForOp + RESAMPLE_PROFILE`** — fix-protocol.ts union+doc (incl. `qualityHfEnergyDelta` field); backend-client.ts.
6. **`feat(web): pure HF-energy measurement + gated collector helpers`** — resample-quality.ts + resample-collect.ts + .test.ts.
7. **`feat(web): worker resample tier post-pass (gated, honest fallback, hash-safe)`** — `resampleOn` gate, tier candidate collection, full-res PNG re-encode upload, per-format re-encode, measure, emit. **Decide + implement the `hashFilenames` branch (re-hash+repoint OR honest skip) — never unconditional in-place** (fixes BLOCKER 1).
8. **`feat(web): resample receipt block + NEW tier-kernel hint key`** — App.tsx `op:'resample'` arm (HF-energy delta, no disk/VRAM); resample backend toggle/hint; **new** tier-only hint key. **Do NOT retarget `whyNoKernel`** (fixes BLOCKER 2).
9. **`i18n: resample backend keys + new tier-hint key across 9 catalogs`** — ru/de/es/pt/fr/it/zh/hi; satisfies drift + app-keys; `whyNoKernel` untouched.
10. **`docs: round24-libvips-lanczos3-resample.md + CHANGELOG/FEATURES`** — record the design + the deploy-deferred live verification + the hash-interaction decision.

**Pre-merge confirmation (unchanged from draft):** the exact `vips`/`vipsthumbnail` stdin→stdout forced-w+h lanczos3 flag syntax for the pinned libvips-tools — the single external surface to verify against the real binary; temp-file fallback via `TmpDir` if streaming isn't available (no flag guessing).

**Key load-bearing files (absolute):** `/home/nonamezzz/Рабочий стол/projects/apps/encoder/internal/encode/{encode.go,pngquant.go,resample.go(new),config.go}`, `/home/nonamezzz/Рабочий стол/projects/apps/encoder/cmd/encoder/main.go`, `/home/nonamezzz/Рабочий стол/projects/apps/encoder/Dockerfile`, `/home/nonamezzz/Рабочий стол/projects/apps/encoder/internal/httpapi/server_test.go`, `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/{fix-protocol.ts,fix.worker.ts}`, `/home/nonamezzz/Рабочий стол/projects/apps/web/src/lib/{backend-client.ts,resample-quality.ts(new),resample-collect.ts(new)}`, `/home/nonamezzz/Рабочий стол/projects/apps/web/src/App.tsx` (whyNoKernel at 686/1022/1275, backendNative.map at 2010), `/home/nonamezzz/Рабочий стол/projects/packages/i18n/src/catalogs/*.json` (whyNoKernel at en.json:331).
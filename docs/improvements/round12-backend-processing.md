I now have everything needed. All the draft's code references are accurate, but I've found one design-breaking error (atlas KTX2 manifest), one VRAM-honesty nuance (UASTC is the worst-case 8 bpp = 1 B/px only on ASTC/BC7; transcode to BC1/ETC1 = 0.5 B/px), and one unaddressed shipping requirement (the transcoder bundle the game must add). I have enough to deliver the adversarial verdict and revised design. The draft is genuinely strong and well-grounded — my output will surface the fixes and tighten v1.

I'll write the final review and revised design directly as my response (per instructions, not as a file).

---

# Adversarial Review + Revised Design — Backend Native-Fix Path

## Verdict

**The draft is strong, honest, and correctly grounded in the actual code.** I verified every load-bearing reference against the real tree and they all check out:

- `apps/api/Dockerfile` *is* `CGO_ENABLED=0` on `gcr.io/distroless/static-debian12:nonroot` — confirmed, so "cannot exec native CLIs" and "don't fatten the billing image" is **correct**.
- `server.go` `newIPLimiter(10, time.Minute)` is billing-click rate limiting; `decodeJSON` (respond.go) is a 16 KiB `MaxBytesReader` + `DisallowUnknownFields` — confirmed wrong for image bytes, so a separate large-body reader is **correctly required**.
- `license.Verify(pub, token)` + `Claims.Expired(now)` exist exactly as cited in `token.go`; **no endpoint verifies the token server-side today** — the "free CPU hole" is real and the server-side-verify fix is correct.
- The worker merge seam `out: {path,bytes}[]` is at `fix.worker.ts:604`; `composePageEncode` at `:892`, `encodeCanvas` at `:2389`, `transcode` at `:2466`, `makeZip` at `:2246` — all **accurate**.
- The VRAM model the draft claims to reuse exists: `MIP_OVERHEAD = 4/3` in `packages/core/src/index.ts:266`, `vramBytes`/`vramBytesMipmapped` in `analysis/src/rules.ts:11,16`. So the "one constant, conditional mips" honesty story is **real, not aspirational**.
- The `whyNoKernel/whyNoPngquant/whyNoChroma/whyNoPreBlur` i18n keys exist in all locales (`fix.skipped.*`) — the "flip to available via backend" plan is grounded.

**But I found one design-breaking technical error, one VRAM-honesty inaccuracy, and one omitted shipping cost.** All three are fixable and the fixes actually make v1 *tighter*. Details below, then the revised design.

---

## Blocking findings (must fix before implementation)

### B1 — The atlas KTX2 manifest as drafted DOES NOT LOAD. (design-breaking)

The draft says (§5, line 267):
```
{ alias: ['hud','ui/hud'], src: ['ui/hud.ktx2', 'ui/hud.webp'] }
```
and claims "Pixi auto-picks `.ktx2` on capable GPUs." **This is false for atlases.** Your own round8 design doc (`round8-pixi-manifest.md`) and `pixi-manifest.ts:12-15` already established that for a sheet the `src` candidate is the **`.json`/`.atlas` sidecar** (Pixi reads `meta.image`), never the image file. And the PixiJS maintainer is explicit ([discussion #10193](https://github.com/pixijs/pixijs/discussions/10193)):

> "the JSON format doesn't support [multiple image formats], so you should save multiple JSON files, one for each format variant."

The format-preference `src` array works for **loose textures** ([Pixi compressed-textures guide](https://pixijs.com/8.x/guides/components/assets/compressed-textures): "try `bg.ktx2` first… fall back to `bg.png`"), but a spritesheet `.json` hardcodes one `meta.image`. You cannot list `[page.ktx2, page.webp]` in an atlas entry's `src`. You must emit **two sidecars** (`hud.ktx2.json` with `meta.image: hud.ktx2`, and `hud.webp.json` with `meta.image: hud.webp`) and put **those two JSONs** in the entry's `src`.

This directly contradicts the round8 finding (B2) that you already accepted: "No auto-resolution of tiers via `src` arrays… both loose AND atlas emit one alias-suffixed entry per tier." KTX2 collides with the same constraint. **Fix in revised design §5.**

### B2 — The VRAM bytes-per-pixel table is honest only at the worst case; it under-counts the *typical* win and the const naming is misleading.

The draft's `GPU_BYTES_PER_PX = { 'ktx2-uastc': 1 }` charges UASTC at **8 bpp = 1 B/px**. That is correct **only** if the device transcodes to ASTC-4x4 or BC7 (both 8 bpp). But UASTC commonly transcodes down to **BC1/ETC1 = 4 bpp = 0.5 B/px** on lower-end GPUs ([Basis UASTC transcode targets](https://github.com/BinomialLLC/basis_universal/wiki/Transcoder-Texture-Format-Support-for-ETC1S-and-UASTC-LDR-4x4)). **The resident VRAM depends on the runtime transcode target, which the encoder cannot know.** So a single fixed `bpp` *is itself a small honesty violation* — it's a per-device runtime value the build pins to a guess.

This is actually *more* honest to fix, not less: charge the **worst case (1 B/px)** as the headline (you never over-promise), and label it "≤ this; less on GPUs that transcode to BC1/ETC1." Don't name the constant as if it's exact. **Fix in §7.**

### B3 — Omitted real cost: the game must ship the Pixi KTX2 transcoder (~hundreds of KB WASM), which can erase the disk story and adds an integration burden the receipt must disclose.

The draft mentions "the game must register Pixi's basis/ktx2 transcoder" but treats it as a one-line note. In practice ([pixi-basis-ktx2](https://github.com/Sparcks/pixi-basis-ktx2) ships the transcoder; Pixi's own `pixi.js/ktx2` pulls a WASM transcoder) this is a **non-trivial bundle the game did not have before**, plus a code change (`import 'pixi.js/ktx2'` before `Assets.load`). Combined with finding B4 below (you ship BOTH ktx2 + raster, so **disk goes up**), the honest receipt must say: disk increases, you add a transcoder dependency, and the VRAM win is conditional. That's three caveats on one feature. It's still worth it — but the consent/receipt copy must carry all three or it's a faked-simplicity claim. **Fix in §4/§7.**

---

## Non-blocking but important

- **B4 (already in the draft, keep it loud):** you ship `.ktx2` **and** raster → **disk size goes up** even as VRAM goes down. The draft acknowledges this (§9.5). Good — but it must be in the *receipt*, not just the design doc, because it's counterintuitive and a user comparing zip sizes will think the tool made things worse.
- **Encode time:** UASTC→KTX2 of a 2048² page is plausibly seconds, and UASTC→BC7/ASTC transcode is "particularly fast" ([richg42](http://richg42.blogspot.com/2020/01/universal-astc-uastc-tech-details.html)), but **UASTC *encoding* (RDO) at high quality can be tens of seconds for large pages.** The 120s route timeout (§6.4) is right; the concurrency semaphore (≤2) is right; but **measure it in T21 and surface a progress/cancel affordance** — an opt-in step that silently hangs 40s feels broken.
- **toktx vs basisu:** pick **one** for v1 (don't ship both binaries — CVE surface, determinism). `toktx` (KTX-Software) produces standard `.ktx2`; `basisu` produces `.basis` or `.ktx2`. Since the output is `.ktx2`, **use `toktx`** (it's the reference KTX2 writer) OR `basisu -ktx2`. Pin exactly one. The draft lists both as options — **tighten to one** in §1.
- **Sidecar language:** the draft picks Node/sharp "because sharp consolidates v2 B/C." But **v1 is KTX2-only and KTX2 doesn't use sharp at all** — it shells to a CLI. So for v1 the sharp justification is v2 speculation. A Go sidecar shelling to `toktx` would be smaller and language-consistent with `apps/api`. **Recommend: keep it minimal for v1** (either is fine, but don't pull in sharp until v2 actually needs it — YAGNI). Surfaced as a trade in §1.
- **`ktx2VramConditional: true` as a literal type** is odd (a field that's always `true` carries no info). Make it a boolean that's genuinely conditional, or drop it and let the *presence* of `ktx2VramBytes` + a fixed caveat string convey it. Minor. §5.
- **Healthz probe leaks backend existence to non-Pro users / pre-consent.** The draft gates the probe behind "configured AND Pro." Good — but ensure the probe fires **only after Pro unlock**, never on page load, so a non-paying visitor's browser never even pings the encoder host. §4.

---

## Is the whole direction worth it? — Honest answer: **yes, but barely, and only for KTX2.**

KTX2 is the one feature that's (a) impossible in-browser and (b) a *real GPU-VRAM* win, which is literally your moat's headline ("disk ≠ VRAM"). Every deferred feature (pngquant/kernels/AVIF-444/JPEG) is a **disk-only** win the browser path mostly already covers with WebP/AVIF/oxipng — those do **not** justify breaking invariant 1 on their own. The draft's instinct to ship **KTX2-only and defer the rest** is correct and should be held firmly. If KTX2 adoption is weak in real games (transcoder burden + conditional win), **the entire backend path should be reconsidered rather than expanded** — ship v1 behind a flag and measure before building v2.

---

# FINAL REVISED DESIGN (implementation-ready)

## 0. Amended invariants (unchanged from draft — wording is honest and bounded)
Keep the draft's §0 wording verbatim. It correctly frames a bounded carve-out, default-OFF, free diagnosis stays 100% local.

## 1. WHERE — sidecar gated by `apps/api` (unchanged) + tightened tool choice
- Sidecar `apps/encoder`, internal docker network only, never host/tailnet-bound; `apps/api` is the auth/quota/proxy gateway. (Draft is correct; distroless billing image stays untouched — verified.)
- **v1 tool: pin exactly ONE KTX2 writer — `toktx` (KTX-Software) — not both `basisu` and `toktx`.** One binary = smaller CVE surface + deterministic bytes.
- **v1 sidecar language: minimal Go shelling to `toktx`** (consistent with `apps/api`, no sharp). **Do NOT pull in Node/sharp until v2** actually ships a sharp-backed op (YAGNI; the draft's sharp justification is entirely v2). Revisit at v2 — if v2 lands, a Node/sharp sidecar is the right consolidation then.

## 2. v1 FEATURE SET — KTX2 only (unchanged, correct)
- One pinned profile: **UASTC → Zstd supercompression, baked mips.**
- Encode atlas pages + oversized loose images to `.ktx2`.
- Everything else (pngquant, kernels, AVIF-444, JPEG, ETC1S, per-folder KTX2 profiles, async job queue, public deploy) → **v2+ on the same additive rails.** Held firmly.

## 3. DATA FLOW (unchanged) — detect-local → offer-if-eligible → per-run consent → `encodeRemote()` → additive `out.push` → graceful skip on failure. The seam math in the draft is accurate.

## 4. CONSENT + privacy (draft + one addition)
- Default OFF, per-run, invisible unless **(Pro unlocked) AND (backend configured) AND (healthz reachable — probed ONLY after Pro unlock, never on page load) AND (≥1 eligible op).**
- Consent surface shows: exact file list + count, destination host verbatim, "processed in memory, deleted immediately."
- **NEW (B3/B4): consent + receipt must disclose all three real costs:** "(1) Your zip will be **larger** (ships both KTX2 and the normal image). (2) The VRAM win applies **only** on GPUs that support BC7/ASTC/ETC2. (3) Your game must add the Pixi KTX2 loader (`import 'pixi.js/ktx2'`) — a one-time code + bundle change." Anything less is a faked-simplicity claim.

## 5. CONTRACT (additive) — with the B1 manifest fix
- `packages/core`: add `CompressedTextureFormat = 'ktx2-uastc'` and the GPU residency model from §7. Reuse existing `MIP_OVERHEAD`.
- `fix-protocol.ts`: `FixOptions.backend?{enabled,ops,token,apiBase}`; `NativeOpKind='ktx2'`; `FixReceipt.backendNative?{op,uploaded,produced,failed,host}` + `ktx2VramBytesWorstCase?: number`.
- **Drop `ktx2VramConditional: true`** (an always-true field carries no info). Convey conditionality via the receipt caveat string + presence of `ktx2VramBytesWorstCase`.
- **Pixi manifest (CORRECTED):** A `.ktx2` atlas page requires its **own sidecar JSON** with `meta.image: page.ktx2`. The manifest entry's `src` lists the **two JSON sidecars**, ktx2-first:
  ```
  { alias:['hud','ui/hud'], src:['ui/hud.ktx2.json','ui/hud.webp.json'] }
  ```
  The zip therefore contains: `hud.ktx2`, `hud.ktx2.json`, `hud.webp`, `hud.webp.json`. For **loose** (non-atlas) images, the draft's direct-format `src:['x.ktx2','x.webp']` is correct and needs no sidecar. This matches the round8 "one resolvable target per src candidate" rule.

## 6. SECURITY (unchanged — all correct and grounded)
Server-side `license.Verify` + `Claims.Expired` before any work (closes the verified free-CPU hole); per-license concurrency semaphore (≤2) + daily quota keyed on `Claims.Lic`, off the single-conn SQLite path; dedicated `MaxBytesReader` (not the 16 KiB `decodeJSON`) with per-page (32 MB) + total caps → 413; separate 120s route timeout; ephemeral temp-in/temp-out + `unlink` in finally + orphan sweeper; sidecar non-root, read-only FS + scratch tmpfs, no DB, no signing seed; dimension/pixel caps before decode; existing CORS allowlist.

## 7. HONESTY — corrected VRAM model (B2)
- `.ktx2` resident VRAM = **worst-case 1 B/px (ASTC/BC7)** charged as the headline; **never `w·h·4`.**
- **Rename/relabel: it is a CEILING, not an exact value.** Runtime may transcode to BC1/ETC1 (0.5 B/px), so the real residency is **≤** the charged number. Receipt copy: *"GPU VRAM ≤ {bpp·w·h}; less on GPUs that transcode to BC1/ETC1; raster fallback (`w·h·4`) on GPUs without block-compression support."*
- Mip overhead: reuse `MIP_OVERHEAD = 4/3`, charged **only** when mips are baked (they are, in the profile) — consistent with `mipmap-vram-accounting.md`.
- Lossy-labeled. Deterministic via pinned `toktx` version + exact flags + profile id `uastc-zstd-mip` in the receipt. Backend OFF ⇒ zip byte-identical (the additive proof).

## 8. ORDERED TASK BREAKDOWN (small commits)

**Phase 0 — contract + honesty (additive, no behavior change)**
- T1 `[DOC]` Amend invariants 1 & 2 in `CLAUDE.md` (bounded carve-out).
- T2 `[CORE]` `CompressedTextureFormat` + GPU-residency-ceiling model (worst-case 1 B/px), reuse `MIP_OVERHEAD`.
- T3 `[FIX]` Pure `vramCeilingOfPage(fmt,w,h,mips)` helper + tests: raster=`w·h·4`, ktx2=`1·w·h`, mips ×4/3 only when baked.

**Phase 1 — sidecar (Go, one binary)**
- T4 `[SC]` Scaffold `apps/encoder` (minimal Go, debian-slim, pinned **`toktx`** only). `GET /healthz`. Non-root, RO FS + scratch tmpfs.
- T5 `[SC]` `POST /process` (internal): PNG + `{w,h,op,profile}` → exec pinned `toktx uastc-zstd-mip` → `.ktx2`. Temp-in/out + `unlink` finally; dimension/pixel caps; size cap → 413.
- T6 `[SC]` Resource + concurrency caps; structured `413/415/503`; no image-byte logging; orphan-temp sweeper.

**Phase 2 — Go gateway (keep distroless thin)**
- T7 `[BE]` New chi group, own `MaxBytesReader`, own 120s timeout, NOT touching SQLite.
- T8 `[BE]` Entitlement middleware: `Bearer` → `license.Verify` + `Claims.Expired` → `402/403` before work + tests.
- T9 `[BE]` Per-license concurrency semaphore + daily quota (keyed `Claims.Lic`, off SQLite) → 429.
- T10 `[BE]` Reverse-proxy verified → sidecar (internal net); map errors to `{error,code}`; config `ENCODER_URL`/caps/timeout, fail-closed if unset when native enabled.
- T11 `[BE]` Go tests mirroring the existing ~30: token-gate, quota, size-cap, proxy-error mapping.

**Phase 3 — client opt-in (additive; OFF ⇒ byte-identical)**
- T12 `[WEB]` `FixOptions.backend` + `NativeOpKind` + `FixReceipt.backendNative`/`ktx2VramBytesWorstCase`.
- T13 `[WEB]` `backendReachable()` healthz probe **fired only after Pro unlock**; thread `API_BASE` + `loadStoredEntitlement().token` into `buildOptions()` (App.tsx:1149).
- T14 `[WEB]` `encodeRemote(pngBytes,'ktx2',opts)` in `fix.worker.ts`, ktx2 op at `composePageEncode`/loose-transcode seams; `out.push({path:'<name>.ktx2',bytes})` ADDITIVE. Failure ⇒ honest `skipped[]`, keep raster, NO retry-storm. Off/unreachable ⇒ byte-identical zip.
- T15 `[FIX]` **(B1 fix)** `pixi-manifest.ts`: for atlas, emit a **second `.ktx2.json` sidecar** (`meta.image: page.ktx2`) and list **both JSON sidecars** in `src` (ktx2-first); for loose, list `[x.ktx2, x.webp]` directly. Loader note: "needs `import 'pixi.js/ktx2'` + capable GPU."
- T16 `[WEB]` Receipt VRAM uses §7 ceiling model; `ktx2VramBytesWorstCase` separate + "≤ / fallback" caveat; NEVER `w·h·4` on a ktx2 page.

**Phase 4 — consent UX + privacy**
- T17 `[WEB]` Consent gate: default-OFF switch, exact file list/count, destination host, "deleted there" + **the three cost disclosures (bigger zip, conditional VRAM, transcoder dependency)**. Shown only when Pro+configured+reachable+≥1 eligible.
- T18 `[WEB]` i18n `fix.backend.*` (consent + the 3 caveats + receipt) in all 9 locales; en byte-matches baked.
- T19 `[WEB]` Receipt privacy line + conditional-VRAM caveat + disk-went-up note.

**Phase 5 — deploy + verify**
- T20 `[DOC]`/deploy docker-compose: `apps/api` (host :8088, tailnet) + `apps/encoder` (internal only); env. Update `local-backend-deploy` memory.
- T21 verify E2E on a real atlas: KTX2 round-trips, **loads in Pixi via the two-sidecar manifest on a capable GPU and falls back on an incapable one**, receipt VRAM honest, **measured encode time + a cancel/progress affordance if >~10s**, temps cleaned, backend-off ⇒ byte-identical zip.

Commit grouping: T1 · T2+T3 · T4 · T5 · T6 · T7+T8 · T9 · T10+T11 · T12 · T13 · T14 · T15 · T16 · T17 · T18+T19 · T20 · T21.

## 9. Trade-offs (draft's are all valid; add three)
Keep the draft's 7 honest trade-offs. **Add:** (8) the **two-sidecar atlas manifest** roughly doubles emitted JSON files per atlas tier — verify your zip dedup handles it; (9) the **game must add a transcoder bundle + import** — real integration friction that may suppress adoption; (10) **measure encode latency before promising "seconds"** — high-quality UASTC RDO on large pages can be tens of seconds, hence the 120s timeout and a cancel affordance.

**Bottom line:** Build v1 = **KTX2-only, single-binary (`toktx`) Go sidecar gated by `apps/api`, default OFF, on-PC compose.** The draft's architecture, security model, and code grounding are sound. The only must-fix is **B1 (atlas needs two JSON sidecars, not a multi-format `src` array — your own round8 doc already proves this)**; **B2 (VRAM is a worst-case ceiling, not an exact 1 B/px)** and **B3 (disclose the transcoder bundle + bigger zip in the receipt)** are honesty corrections that make the feature *more* trustworthy. Ship behind a flag and measure KTX2 adoption before building any v2 disk-only native op.

Sources: [PixiJS multi-format spritesheet discussion #10193](https://github.com/pixijs/pixijs/discussions/10193) · [PixiJS v8 compressed textures guide](https://pixijs.com/8.x/guides/components/assets/compressed-textures) · [Basis UASTC transcode targets](https://github.com/BinomialLLC/basis_universal/wiki/Transcoder-Texture-Format-Support-for-ETC1S-and-UASTC-LDR-4x4) · [pixi-basis-ktx2 (transcoder bundle)](https://github.com/Sparcks/pixi-basis-ktx2)
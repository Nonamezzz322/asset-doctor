# Asset Doctor — changelog (per round)

Living log of the autonomous improvement loop. One entry per round; each round = a
design→skeptic→impl→adversarial-review→fix cycle, independently verified green and committed
small on branch `feat/asset-pipeline` (= local `main`). Newest first.
**Each new round MUST append its entry here.** `origin/main` is at `54c1a3a` (deploy blocked: no
GitHub creds — user pushes); commit hashes below are over that base.

> Convention: `commit` · what shipped · review verdict · gate. Designs live in `docs/improvements/round*.md`.

---

## Round 19 — selection only (design pending; session-limit) — 2026-06-29
Selection chose 3, but the design phase hit the session limit (resets ~01:20 Kyiv) → designs not produced.
Picks to design+build on resume: **(a) frame-redundancy FIX** (alias N byte-identical frames to ONE packed
region in the repack — turns the r18 detector into a Pro fix; exact VRAM via repack, drop-in via the manifest);
**(b) fix-worker memory bounds** (LRU-evict + `close()` decoded ImageBitmaps with a byte budget; free on
finish/cancel); **(c) trim-margin detector** (transparent padding baked inside packed rects → exact recoverable VRAM).
Status: re-run the design, then impl each.

## Round 18 — robustness + moat + analysis depth — 2026-06-29
- `4870cc1` **Abortable workers** — `AbortSignal` seam through analyze + fix workers + clients; cooperative cancel flag; a superseded drop aborts the prior run. Additive (no signal ⇒ byte-identical). Review SHIP.
- `1c6902d` **correlateFix(receipt)** — measured before→after fix probe → one localized doctor verdict (reuses `CorrelatedFinding` + variant-suffixed i18n; measured-only, honest). Review SHIP.
- `c3950ae` **Frame-redundancy detector** — duplicate frames within an atlas (per-region SHA, instant-wow caps + flat-guard; exact VRAM-area waste). Review FIX_THEN_SHIP — both MAJORs fixed (fixture now reproduces the defect through the real flat-guarded path; worker decode path tested).

## Round 17 — moat / parity / honesty — 2026-06-28
- `3be0d6a` **Render-probe the produced fix** — measured before→after draw calls + decoded VRAM per sheet (3rd probe sibling); honest badge kept separate from static numbers. Review SHIP.
- `01e5950` **Per-image measured best-format pick** — carry the diagnosis's measured smallest-encode winner into the fix plan (default OFF; precedence profile>override>bestMime>global). Review FIX_THEN_SHIP — MAJOR fixed (dedup owner-name prediction honors the per-op mime).
- `bb2fd38` **Opaque fan-out size-loss guard** — never ship a larger same-format opaque page. Review SHIP (zero findings).

## Round 16 — consolidation (round-15 MINORs) — 2026-06-28
- `2fe9828` — honesty double-count de-overlap (`potentialDiskSaved` MAX not SUM for format+wasted-alpha refs); keep-original-on-size-loss guard for opaque transcode; `ktx2-probe-collect` extracted+tested; gl-instrument 9-arg form; loader copy softened ×9. Review SHIP.

## Round 15 — selection (3 picks) — 2026-06-28
- `b297290` **Measure REAL KTX2 GPU VRAM on-device** — `compressedTexImage2D` instrument + `probeKtx2` + self-hosted transcoder (no CDN); shown beside the worst-case ceiling, device-local. Review FIX_THEN_SHIP.
- `84b8ea7` **KTX2 loader-migration snippet** — emit `import 'pixi.js/ktx2'` when a fix produced `.ktx2` (fixes the manifest-refs-`.ktx2`-but-loader-can't-decode bug; Phaser honest NOTE). Review SHIP.
- `21710a0` **Wasted-alpha detector + opaque-encode fix** — full-frame opaque pass (short-circuit/size-capped/worker = instant-wow safe); disk-only saving, never VRAM. Review SHIP.

## Round 14 — consolidation (round-11→13 MINORs) — 2026-06-28
- `b5c1405` — i18n-app-keys guard extended to the new components; highlightId debounced; shared `defaultSelectOpts`; `countCandidates` (no per-keystroke re-sort); consent upload count/preview; auto-pair the Pixi manifest when a backend op is on; gateway one-fewer body copy; suppress empty all-quality-floor entry. Review SHIP.

## Round 13 — native→backend #2 — 2026-06-28
- `a872dd0` **pngquant lossy-PNG** disk-only op on the sidecar (browser-impossible); zero VRAM field (decodes to RGBA); quality-floor decline kept-not-failed; Op propagated; `backendNative` array; PNG dup-key split. Review FIX_THEN_SHIP (MAJOR fixed: honest skip on tiered path).

## Round 12 — native→backend #1 (invariant 1/2 amendment) — 2026-06-28
- `25f7af0` **KTX2 GPU-texture sidecar** (`apps/encoder`, Go toktx) via `apps/api` entitlement-gated reverse proxy; opt-in, default OFF, explicit upload consent; honest VRAM ceiling; two-json-sidecar manifest; CLAUDE.md invariants 1&2 amended. Review FIX_THEN_SHIP (2 MAJORs fixed: manifest order + worker/client test coverage). Go: apps/api + apps/encoder build/vet/test green.

## Round 11 — UI/UX — 2026-06-28
- `6c17ffd` **Triage-first scalable results view** — pure `triage.ts` (O(assets+findings) index, kills the per-render O(N×F) scan) + zero-dep virtualization; VerdictBar + virtualized TriageLedger (search/sort/filter/group, honest rollups) replacing the chip wall; sticky film detail w/ debounced decode; collapsed the double ArrayBuffer copy. Fixes the many-images chaos. Review FIX_THEN_SHIP (MAJOR fixed: show-clean emits real clean rows).

## Round 10 — asset-builder parity — 2026-06-28
- `8af0247` **Per-folder/prefix export overrides** — `ExportProfile.overrides[]` (exact-or-prefix match) overlays formats/quality/lossless/AVIF-4:4:4 (fonts→4:4:4); pure `resolveProfileForRef`; default OFF ⇒ byte-identical. Review SHIP.

## Round 9 — AssetPack arc — 2026-06-28
- `8c478d4` **Content-hash cache-busting** (`hashFilenames`) — 8-hex content hash chained through atlas `meta.image`, Spine `.atlas` line, Pixi manifest, dedup consumer images, loader rows. Skeptic caught 3 blockers + 4 majors pre-code; reviewer caught 1 more (dedup→loose-owner 404) — all fixed.

## Round 8 — AssetPack arc — 2026-06-28
- `0727449` **PixiJS manifest.json emitter** — real v8 `{bundles}` (one alias-suffixed entry per tier; sheets→sidecar; no fabricated `data.resolution`); makes the variant fan-out loadable with one `Assets.init`. Review SHIP.

## Round 7 — asset-builder parity / AssetPack arc — 2026-06-28
- `f3b3cc9` **Config-driven export profile** — arbitrary resolutions × formats × per-format compression, replacing the fixed 3-tier ladder; first-class format fan-out; lossless genuinely threaded. Skeptic caught 3 real defects pre-code. Review FIX_THEN_SHIP.

## Backend ↔ frontend connection — 2026-06-28
- `e59916d` — wired the React app to the Go license backend (`:8088`): `.env.local` (gitignored) + `apps/api/tools/devmint` (dev-license) + `tools/verify/license-connect-run.mjs` (proves activate→sign→offline-verify vs the live backend). LICENSE_CONNECT PASS.

## Round 6 + fss fix — 2026-06-28
- `7eca731` **Round 6** — F1 before/after FilmViewer sheet-diff (visual proof), F2 solid-fill detector, F3 surface-unparsed-files + parser hardening.
- `7499fb7` **fss bug** — pack ALL spine regions (don't drop large ones via the static `maxSpriteEdgePx` filter).

## Earlier rounds (rounds 2–5, same branch) — 2026-06-26/27
- `e09c539` engine-aware loader-migration guide · `bd3d8e0` zip UTF-8 flag + occupancy clamp · `fb7fbc7` content-class format-suitability · `411b9de` per-texture VRAM/probe breakdown · `8074226` polygon-pack content-extent trim (no empty bottom) · `9411b44` probe-into-verdict (measured GPU footprint) · `a5f7864` selective fix · `ae51c15` atlas fragmentation score · `e9d18ca` dry-run plan preview · `416828f` edge-extrude (bleed).
- (Pre-branch foundations — Phase 1 diagnosis, render-probe, runtime profiler, MV3 extension, correlate, CLI + budget-gate, i18n, Phase-2 browser fix, polygon packer, Part B dedup, scale-tiers, Slice B Go billing — see `docs/` + git history.)

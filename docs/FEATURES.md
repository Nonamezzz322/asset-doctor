# Asset Doctor — feature catalog

Browser-side asset audit for HTML5 games (PixiJS/Phaser) + a Pro fix engine, with an opt-in
native backend. Free diagnosis runs 100% in the browser (assets never leave the device);
the Pro fix generates optimized output; native-only ops run on an opt-in backend (with consent).

---

## 1. Diagnosis — the free audit (in-browser, objective, ≤10s)

- **Whole-folder import** — File System Access API + `webkitdirectory` fallback + drag-drop; dir-aware grouping (manifest/spine + image) into a normalized `Asset` model.
- **Parsers** — TexturePacker JSON (Hash + Array), PixiJS atlas, single PNG/WebP/JPG/AVIF (header-based dims), Spine/libGDX `.atlas` (legacy + modern, multi-page, rotation/trim), and BMFont `.fnt` in **all three serializations — TEXT, XML, and binary** (byte-identical `FntPage[]`; binary is the BMFont.exe/libGDX default). Pure & worker-safe.
- **Occupancy + wasted-region map** — grid coverage map per atlas; highlights empty space (the film-viewer overlay).
- **Dimensions audit** — NPOT (gated on real POT-padding-waste) + oversize (calibrated edge threshold).
- **Format audit** — tries a real AVIF/WebP encode and only reports a saving it actually measured.
- **Content-class** — flat/alpha-art images get a lossless verdict (Invariant-4-safe, reuses a cheap sample).
- **VRAM honesty** — disk ≠ VRAM: PNG 2048² = 16 MB GPU (w·h·4), +33% with mipmaps; shown explicitly.
- **Mipmap-cost VRAM** — base + ceiling accounting (`vramBytesMipmapped`).
- **Folder rules** — duplicate-exact (SHA-256), duplicate-similar (dHash, flat-guarded), should-atlas, atlas-merge, integrity (missing image), format-aggregate.
- **Shared-page merge** — atlases resolving to the same image are unioned + counted once (kills phantom VRAM double-count).
- **Variant-aware VRAM** — clusters `name_res[_fmt]` variants; one logical asset loads once → `loadedVramBytes` (worst-case tier).
- **Atlas fragmentation** — dispersion score of used vs free space.
- **Solid-fill detector** — single-color images pinning VRAM for one color (reuses the decoded 9×8 sample).
- **Wasted-alpha detector** — fully-opaque images carrying an alpha channel (full-frame opaque pass, short-circuit, instant-wow safe); disk-only saving.
- **Frame-redundancy detector** — byte-identical duplicate frames *within* an atlas (per-region SHA, flat-guarded, instant-wow caps); exact wasted atlas-area/VRAM.
- **Strippable-metadata detector** — pure header-only byte-walk (no decode) summing EXACT strippable ancillary bytes (PNG `iCCP/eXIf/tEXt/iTXt/zTXt/tIME`, JPEG `APP1..15`+`COM`, WebP `EXIF/XMP/ICCP`; render-affecting chunks excluded); **disk-only** saving (the GPU decodes to RGBA8888 regardless), MAX-de-overlapped vs the format/wasted-alpha findings, names the existing oxipng/re-encode fix. Conservative true lower bound (never over-claims).
- **Texture-bleeding detector** — pure integer frame-adjacency (no decode): flags atlas frame pairs packed with a 0px gutter (shared edge + perpendicular overlap; corner-touches & rotated/aliased frames excluded) that can bleed 1px seams under linear/mipmap sampling. A **correctness** finding carrying NO saving (edge-extrude can grow the sheet — invariant 5), with a conditional honest hedge; lights the teal `bleeding` film overlay and points at the existing edge-extrude fix.
- **Declared-vs-real dimension-mismatch detector** — the always-on static sibling of the render-probe label: compares the manifest's declared `meta.size` (Spine page `size:`) against the REAL decoded pixel header (zero decode), beyond a small absolute tolerance. Direction-aware (real<declared with a frame off the real edge = crit; in-bounds = warn; real>declared = info). A **correctness** finding carrying NO estimate — states two measurements (declared vs real), and discloses that the static VRAM estimate is charged on the declared size (never a fix-saving claim).
- **Unparsed-file surfacing** — files that look like a manifest but can't be parsed are shown honestly (never silently dropped) + hardened frame/Spine parsers (reject neg/zero/OOB rects; Spine `numsRaw` per-region recovery).

## 2. Render-probe & runtime profiler (the moat)

- **Render-probe** — loads an atlas into offscreen PixiJS v8 WebGL, instruments the GL context, and reads **measured** draw calls + VRAM (Σ baseTexture w·h·4).
- **Runtime profiler SDK** — patches `getContext` + wraps RAF; per-frame draw calls, redundant binds, uploads/shader-compiles (hitches), live textures, VRAM, fps.
- **MV3 Chrome extension** — injects the profiler into a live game (MAIN world) + on-page HUD + "load folder & correlate" in the overlay.
- **Correlate layer** — `correlate(static, runtime)` → one verdict (static fragmentation × live draw calls/binds, VRAM residency, upload/shader hitches, redundant state).
- **Probe-into-verdict** — the diagnosis can show the measured GPU footprint (declared vs measured).
- **Per-texture VRAM/probe breakdown** card.

## 3. Pro fix engine (browser — generates optimized output)

- **Atlas repack** — roll-our-own MaxRects/BSSF, smallest-area POT bin, rotation/padding/spill; tighter sheet, re-emitted manifest (drop-in).
- **Binary polygon packer** — bitmap-mask occupancy nesting (trace alpha → conservative RDP → ear-clip → bitmap nesting + mesh-clip compose); TexturePacker-compatible mesh manifest (`vertices/verticesUV/triangles`); honest VRAM gate, rect fallback; content-extent trim (no empty bottom).
- **Resize** — downscale oversized loose images + atlases (frames clamped); drop-in.
- **Transcode** — WebP/PNG (native `convertToBlob`) + AVIF + lossless-WebP + oxipng (via `@jsquash`, honest fallback).
- **Spine repack** — tighter single-page Spine sheet + re-emitted `.atlas`.
- **Aggressive dedup** — owner/consumer model (pools/skin, lazy-aware), drop exact + near dupes, reference repointing.
- **Edge-extrude (bleed)** — symmetric gutter to kill bilinear seams.
- **Per-image measured best-format pick** — carries the diagnosis's measured smallest-encode winner into the fix.
- **Opaque-encode** — re-encode wasted-alpha images without alpha (disk-only; keep-original-on-size-loss guard).
- **Selective fix** — choose which findings to fix (masked preview).
- **Dry-run plan preview** — see the plan before downloading.
- **Receipt + per-file change manifest** — disk/VRAM before→after, op trail, honest "references changed" warnings.
- **Engine-aware loader-migration guide** — copy-paste Pixi/Phaser snippets when a fix rewrites loader calls (incl. the KTX2 `import 'pixi.js/ktx2'` snippet).
- **Before/after FilmViewer sheet-diff** — two side-by-side x-ray films per repacked sheet + empty-space overlay (visual proof, not a saving).
- **Render-probe the produced fix** — measured before→after draw calls + decoded VRAM per sheet (3rd probe sibling).
- **correlateFix** — turns the measured fix probe into a localized doctor's verdict.
- **Own zero-dep store-only ZIP** (CRC32, UTF-8 flag, overflow guards). Output downloaded as `optimized-folder.zip`.

## 4. AssetPack arc — config-driven export pipeline

- **Config-driven export profile** — arbitrary resolutions × formats (png/webp/avif, lossless+lossy) × per-format compression (quality/near/effort); replaces the fixed 3-tier ladder. Additive (off ⇒ byte-identical).
- **Per-folder/prefix overrides** — match an asset by path and override formats/quality/lossless/AVIF-4:4:4 (e.g. `fonts → 4:4:4`); asset-builder parity in the honest browser subset.
- **Multi-resolution scale tiers** — `_1080p/_720p/_540p` (now config-driven) with honest disk-only fan-out.
- **PixiJS manifest.json emitter** — a real Pixi v8 `AssetsManifest` so the whole optimized output loads with one `Assets.init({ manifest })` (one alias-suffixed entry per resolution tier; sheets point at the `.json`/`.atlas` sidecar).
- **Content-hash cache-busting** — append a content hash to emitted filenames, chained through atlas `meta.image`, the Spine `.atlas` line, the Pixi manifest, dedup consumer images, and loader-migration rows.
- **Pack loose assets into spritesheets** — from scratch: static TexturePacker JSON + correct Spine `.atlas` composition, multi-page spill.
- **Multipack round-trip safety** — TexturePacker `meta.related_multi_packs` (the sibling-`.json` linkage Pixi v8 auto-loads) is carried verbatim through the byte-stable passthrough/resize re-emit, and honestly stripped (with a skip note) on every path that renames siblings (tier suffixes, KTX2, content-hashed filenames) — so a multipack page-0 keeps loading pages 1+ instead of silently dropping them.

## 5. UI — the x-ray cabinet

- **Film-viewer** — the hero: atlas snapshot with highlighted anomalies (empty = red, transparent = yellow, bleeding = teal, duplicate-frame = per-cluster hue), 4-cell VRAM/DISK/SIZE/OCC readout.
- **Triage-first scalable results view** — summary VerdictBar (severity tally) + a **virtualized** TriageLedger (search / sort by severity·wasted-disk·VRAM·occupancy / problems-only / show-clean / group-by-folder with honest declared-only rollups), replacing the flat chip wall. Stays responsive at 1000+ assets; sticky film detail with debounced decode.
- **Brand system** — Space Grotesk / IBM Plex Sans / IBM Plex Mono; severity palette; reduced-motion aware.
- **i18n** — 9 languages (en/ru/de/es/pt/fr/it/zh/hi); findings localized via `messageKey`+params without breaking objectivity; byte-exact drift guard + 9-locale parity tests.

## 6. Native → backend (opt-in, default OFF, consent, entitlement-gated)

- **KTX2 GPU-compressed textures** — a Go `toktx` sidecar (`apps/encoder`) encodes `.ktx2` (UASTC + zstd + mips); the only fix that cuts real **GPU VRAM 4–8×** (browser-impossible). Reached through `apps/api` as an entitlement-gated reverse proxy (keeps the billing backend thin). Hardened sidecar (non-root, RO-FS, caps, no persistence, no image-byte logging).
- **Measured KTX2 VRAM probe** — transcodes the produced `.ktx2` on the probing GPU and reads real compressed residency (`compressedTexImage2D` instrument); shown beside the worst-case ceiling, device-local. Transcoder is self-hosted (no CDN fetch).
- **pngquant lossy-PNG** — a 2nd sidecar op (256-color quantization, browser-impossible); disk-only (never a VRAM claim); quality-floor decline kept-not-failed.
- **libvips lanczos3 resample** — a 3rd sidecar op that downscales a scale-tier with a high-quality kernel the browser canvas can't be steered to, replacing the browser tile at the SAME dims/format; carries ONLY a MEASURED high-frequency-energy retention delta (a fact, never a "sharper" verdict — invariant 3) and NO VRAM/disk claim (invariant 5). Fires on **every genuinely downscaled tier including the oversize-clamped TOP tier** (`dst < src`, not just `tier.scale < 1`), with an honest skip note when suppressed by content-hash filenames.
- **Privacy model** — assets leave the device ONLY on explicit per-run opt-in + consent (with an upload count/preview); default OFF ⇒ everything stays local and byte-identical.

## 7. Backend — Slice B (thin Go billing/license)

- **apps/api** — Go (chi · pure-Go SQLite · stripe-go · ed25519). Stripe webhook → mint, `/v1/{activate,refresh,deactivate}` (seat limits, refund kill-switch), `/v1/key`.
- **License = opaque key; entitlement = ed25519 token** verified **offline** in the browser (WebCrypto); device-bound. Cross-language byte-contract fixture (Go ↔ WebCrypto).
- **Pro gate OFF by default** (`VITE_PRO_GATE`) — fix is free in beta.
- **Local deploy** — runs in Docker on this PC (`:8088`), reachable on Tailscale; wired into the web app (verified live: activate → sign → offline-verify). Dev-license tool (`devmint`) + connection verifier.

## 8. CLI + CI

- **`asset-doctor` CLI** — `audit | budget | init` reuses the core in Node (assets never leave the machine); exact-dup via `node:crypto`; VRAM = Σ w·h·4.
- **GitHub Action budget-gate** — composite `action.yml` with before/after via git worktree; fail-closed JSON config on browser-only metrics; SARIF/markdown/summary output.

## 9. Robustness

- **Abortable workers** — an `AbortSignal` seam through the analyze + fix workers so a superseded drop stops competing (additive, default-off).
- **Honest skips everywhere** — unparseable inputs, encode failures, quality-floor declines, GPU-format unavailability all surfaced (never silent), never shipping a larger "optimized" file.
- **De-overlapped headline savings** — the `potentialDiskSaved` headline never double-counts: format ∩ wasted-alpha ∩ strippable-metadata collapse to a per-ref MAX, and exact-duplicate dropped copies don't also charge their own format/alpha/strippable saving (phantom bytes for files that vanish on dedup). Always ≤ the achievable total — the product under-promises rather than over-claims.
- **Partitioned duplicate reclaim** — within-atlas frame-redundancy and cross-atlas redundancy count DISJOINT pixel sets: an atlas's own intra-atlas dupes are reclaimed once (per-rect), and cross-atlas only counts the (distinct-sheets − 1) freed copies, so the two readouts are honestly additive (each reported count equals what the corresponding fix actually delivers).
- **Robust multi-page Spine parsing** — the `.atlas` page-boundary lookahead tolerates modern Spine 4.x indented page headers, so a second/Nth texture page is never silently dropped (no phantom full-page sprite, no false-orphan image).

---

*Updated 2026-06-29 (through round 28). Branch `feat/asset-pipeline` (= local `main`), ~61 commits over `origin/main`, all green. Deploy (GH Pages) awaits the user's `git push origin main`; live backend ops need the toktx/pngquant/vips binaries in the deployed sidecar.*

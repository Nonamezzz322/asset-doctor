# Threshold calibration

Thresholds in `packages/analysis/src/config.ts` were calibrated against a **real production slot
game** (~225 MB, 3000+ files: TexturePacker/Pixi atlases, Spine sheets, raw sprites in png/webp/avif
× 540p/720p/1080p variants). The assets are proprietary and gitignored; the harness is
`apps/web/test/calibrate.test.ts` (run `CALIBRATE=1 pnpm --filter @asset-doctor/web exec vitest run
test/calibrate.test.ts`). A multi-agent audit verified each decision against the measured
distributions.

## Measured distributions (real data)

- **occupancy** (153 packed atlases): median **0.92**, p10 0.87, min 0.78. Real packers are tight.
- **longest edge**: median 998px, p90 2418px, max 3980px. 45 > 2048, **0 > 4096**.
- **NPOT**: **99%** of textures (327/329, 1938/1948) are non-power-of-two — the normal state of a
  trimmed export.
- **duplicate-exact**: 196 real groups (3.1 MB) in the raw sprite dump.
- **VRAM**: 1.31 GB (packed). The killer metric lands.

## Decisions

| Threshold | Before | After | Why |
| --- | --- | --- | --- |
| `dimensions-npot` severity | `warn`, fires on every NPOT | **`info`, gated on POT-padding waste > 25%** | NPOT is fine on WebGL2/PixiJS (clamp+linear, native upload). At `warn` it fired on 99% of textures and buried the actionable warns. Now de-prioritized; detail states the padded-VRAM cost *if* the build pads to POT. |
| `oversizePx.crit` | 4096 | **2730** | 4096 was dead (0 textures). Target is budget Android (GL_MAX often 2048). 2730 escalates the genuinely dangerous 3000–3980px textures to crit; intentional 2444px HD backgrounds stay `warn`. |
| `occupancy.warn` | 0.85 | **0.80** | 0.85 flagged 15/153 well-packed atlases (0.78–0.85 is the MaxRects noise floor). 0.80 → 3 findings. crit 0.60 kept as the real safety net. |
| `npotPadding.warn` | — | **0.25** (new) | Gates the NPOT info finding on measured padding waste. |

Also fixed while here: **`group.ts` matched manifest↔image by *global* basename** → mis-pairs in
nested projects with repeated names; now resolved within the manifest's own directory (path-aware),
basename fallback for flat uploads. And **loose AVIF images were silently dropped** (missing from the
image regex) — now picked up.

## Follow-ups (logged, not done)

- **Spine `.atlas` parser** (P1): ~261 Spine sheets + ~261 Spine skeleton `.json` are unparsed — a big
  chunk of a real game. The `.atlas` text format maps cleanly onto the existing `Atlas` model (reset
  coverage per page; resolve `../` image refs via the path-aware matching above). Pull ahead of Phase 4.
- **NPOT as a single folder aggregate** instead of per-asset info (UX refinement).
- **Atlas size cross-check** in `parseAtlas`: if `meta.size` disagrees with the paired image's real
  pixel dims, treat as a mis-pair (defensive, after the path-aware fix).
- **`formatSaving.minBytes` (4096, CALIBRATE)**: absolute floor on the MEASURED format saving —
  suppresses per-file warns whose byte win is noise (30% of a 2 KB icon ≈ 700 bytes). Verify on the
  real corpus that no meaningful transcode win falls under 4 KB; adjust only from measured deltas.
- **`duplicates.maxMeanColorDelta` (24, CALIBRATE)**: mean-color guard splitting hue-swapped symbol
  sets out of duplicate-similar (dHash is luma-sign-only ⇒ color-blind). Run before/after
  duplicate-similar counts on the real slot corpus: genuine re-export clusters must survive
  (re-export shifts channel means ≲8), recolored symbol sets must split (a saturated hue swap moves
  a channel ≳60). Adjust 24 only from those measured deltas.

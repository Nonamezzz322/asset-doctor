# N4 design — `loose-in-atlas` (a loose sprite shipped ALSO inside an atlas)

Status: **SHIPPED 2026-07-18** (`01b10ea`). Skeptic-vetted + implemented per the plan below. Exact-match
rule (proof-based, no fuzzy threshold to corpus-calibrate — same class as `duplicate-exact` /
`frame-redundancy`). Gate green + all 5 e2e PASS; 5 analysis unit tests, i18n ×10 drift-guarded.

## The gap (confirmed against the real rule set)

The analysis has 30 rules but **none** compares a LOOSE image's pixels to an ATLAS FRAME's pixels:
- `duplicate-exact` clusters loose images by `contentHash` = SHA of the **file bytes** (encoded PNG/WebP).
  Loose-vs-loose only.
- `cross-atlas-redundancy` clusters **atlas frames** by region hash = SHA of the **decoded RGBA** region.
  Atlas-frame-vs-atlas-frame only.
- `frame-redundancy` is within one atlas.

So a sprite that ships **both** as a loose file AND as a frame inside an atlas is invisible today — a real,
common build-pipeline mistake (leftover loose export, or a sprite used both standalone and packed). One copy
is redundant: its disk bytes + its `w·h·4` VRAM (it loads as its own texture) are wasted regardless of which
copy the game actually references.

## The honest claim

A loose image whose **decoded RGBA** is byte-identical to an atlas frame's **decoded RGBA region** is a PROOF
(SHA-256; collision negligible) that the same pixels ship twice. The finding states exactly that and no more:
"`sprite.png` (loose) is byte-identical to frame `X` in atlas `Y` — it ships twice; drop the loose copy if the
atlas is the one you load." Severity `warn` (a real, measurable waste, but which copy is redundant depends on
the game's references — hedge like `duplicate-exact`'s "copies the game actually loads"). Estimate: the loose
file's disk bytes (exact) + its `w·h·4` VRAM (exact, invariant-5 separate from disk). NEVER claim which copy
is used; NEVER sum the two atlas/loose sides.

## Narrowing caveats (kept honest, not hidden)

1. **Untrimmed frames only.** An atlas frame's region is the *placed* pixels; for a TRIMMED sprite that is the
   trimmed content, which will NOT match the full untrimmed loose PNG. So the match only fires for untrimmed
   atlas frames (or a loose file that was itself pre-trimmed to the same bounds). This narrows hit rate but
   never produces a false positive — a non-match simply doesn't fire. Acceptable (a proof that under-claims).
2. **Flat-guard.** Exclude flat/near-uniform loose images and frames (a transparent 16×16 loose matching a
   transparent frame region is a degenerate coincidence, not a shipped-twice sprite). `extractFrameRegions`
   already flat-guards its frames (`isFlat` → null); apply the same guard to the loose pixel hash so only
   featureful sprites are compared. This is the ONLY calibration knob and it reuses the existing dHash flat
   threshold — no new corpus-tuned number.
3. **Deps-gated ⇒ CLI/headless byte-identical.** The loose pixel hash needs a full-res decode, which only the
   browser worker does; the Node CLI injects no pixel hashes ⇒ the rule never fires there ⇒ goldens unchanged
   (same pattern as `frame-redundancy` / `premultiplied-alpha`).

## Implementation plan (slices)

1. **Worker + pixel layer:** in `@asset-doctor/pixel` `decodeImageFeatures`, SHA-256 the full-res decoded RGBA
   of each LOOSE alpha-bearing image (the buffer it already reads for the opaque/premult scans — zero extra
   decode), flat-guarded (null when `isFlat` over the 9×8 sample). Attach as `ImageFeatures.pixelHash?`
   (additive, omit-when-absent). `apps/web` worker already has `frameHashes` (SHA of decoded frame regions) —
   the two hashes are now on the SAME basis (decoded RGBA) and directly comparable.
2. **Core contract:** additive `ImageFeatures.pixelHash?: string`. No new deps object needed — the rule reads
   `deps.features[].pixelHash` (loose) vs `deps.frameHashes[].frameHashes` (atlas frames), both already passed.
3. **Rule (`packages/analysis/src/folder.ts` `looseInAtlasFindings`):** build a map `frameHash → {atlasRef,
   frameName}` from `frameHashes`; for each loose feature with a non-null `pixelHash` that hits the map, emit a
   finding (assetRef = loose ref, relatedRefs = [atlas frame ref]). One finding per redundant loose copy, or a
   folder-aggregate à la `format-aggregate` if the corpus shows many. Estimate diskBytesSaved = loose
   `byteSize`, vramBytesSaved = loose `w·h·4`. `messageKey: 'loose-in-atlas'`.
4. **Config:** `looseInAtlas: { minSprites: 1 }` (exact match ⇒ even one is real; keep a knob for aggregation).
   Browser-only via `resolveThresholds` omission (like the other pixel rules) so CLI byte-identical.
5. **i18n ×10** (title/detail/fix), drift-guarded EN.
6. **Tests:** analysis unit (a loose feature whose pixelHash matches a frameHash → finding; trimmed/flat →
   none; deps-absent → none). Pin the rule-count bumps (ALL_RULES, view-prefs group, RULE_SUFFIXES, render
   key-set) — see the `add-analysis-rule` skill.
7. **Overlay:** none (a loose↔atlas relationship has no single film to highlight); surfaces as a folder finding
   with the per-sprite drill-down (CabinetIssueDetail) listing the atlas frame it duplicates.
8. **Docs:** CHANGELOG + FEATURES + calibration note.

## Rejected alternatives (skeptic ABORTs — do NOT build)

- **Rotation-packing opportunity** — advice-without-remedy: the fix packs UNrotated (repack.ts v1), so flagging
  a rotation win our own fix cannot take breaks the repack-opportunity "exact packing the fix performs"
  contract. Revisit only if the fix gains rotation (v2).
- **POT-rounding VRAM waste** ("1030² forces a 2048² texture") — FALSE PREMISE on WebGL2/Pixi v8: NPOT
  textures are uploaded at their real size, not rounded up to POT (that is exactly why `dimensions-npot` is
  gated to POT-padding-waste and demoted to info). A POT-rounding VRAM claim would fabricate a cost that does
  not exist (invariant 3). ABORT.
- **Trim-margin-across-sheet aggregate** — overlaps `trim-margin` (per-sprite) + `repack-opportunity` (the
  measured achievable sheet shrink already subsumes the trim benefit). No new information.

## Note on the analysis-detection vein

With 30 rules the honest-static-detection space is near-exhausted; `loose-in-atlas` is a genuine remaining gap,
but future rounds should weigh a fresh-brainstorm (N3) non-detection improvement against yet another narrow
rule. Record any new candidate here before building (CLAUDE.md: new analysis rules need sign-off).

# Preserve Pixi/TexturePacker spritesheet `animations` map verbatim on byte-stable re-emit (PROCEED)

## Premise verification (all load-bearing claims checked against real code)

VERDICT: PROCEED. Premise TRUE, not already handled. Citations:

1. Core `Atlas` has `frames`(via sprites)/`relatedMultiPacks` but NO `animations` — packages/core/src/index.ts:67-83 (relatedMultiPacks at :80, no animations).
2. `parseAtlasManifest` reads frames + meta.{size,format,scale,image,related_multi_packs} only, never top-level `animations` — packages/parsers/src/atlas.ts:137-236 (the only meta reads are :223-234).
3. `emitTexturePackerJson` re-emits `{frames, meta}` only — packages/fix/src/manifest.ts:7-43.
4. `grep -rn animations packages/{core,parsers,fix}/src` → exit 1, ZERO matches. CONFIRMED.
5. Frequency: 18 (not 15) true spritesheet manifests in the repo's untracked sample data carry the `{frames, animations, meta}` shape with frame-name `animations` arrays, all with 0 dangling refs — raw/raw/coin-emitter/{blue,coin,green,red,white}/*_{540,720,1080}p.json (15) + raw/raw/main_game/trail/trail_{540,720,1080}p.json (3). trail carries TWO groups: `trail`=20 frames, `trail_outro`=5. Premise (slightly understated) holds.
6. CRITICAL DISAMBIGUATION I verified: 29 OTHER sample JSONs also contain `animations` but are SPINE SKELETON JSON (top keys skeleton/bones/slots/skins/animations, NO `frames`) — a different concept (animation timelines, not a frame-name map). parseAtlasManifest line 149 returns `{ok:false,'manifest has no frames'}` for any frame-less JSON, so skeletons NEVER become an Atlas and we only ever read `j.animations` after `frames` is confirmed present. No cross-contamination risk.
7. Net defect CONFIRMED: every Pro re-emit strips animations. The passthrough comment at fix.worker.ts:2496 falsely claims "frames/trim/pivot/mesh carried verbatim" (and repointAtlasImage's doc at atlas-transcode.ts:18 says the same) while animations is silently dropped → runtime Spritesheet.animations empty → every AnimatedSprite built from it breaks.
8. Round28 `relatedMultiPacks` is a complete copy-paste template: parser read at atlas.ts:231-234, emit at manifest.ts:34-40, repointAtlasImage spread at atlas-transcode.ts:19-21, strip-with-skip at fix.worker.ts:2279-2285 / 2502-2508 / 3707, tests at packages/fix/test/atlas-transcode.test.ts:86-130 + packages/parsers/test/parsers.test.ts:85-124.

### Refinement folded in (correction to the pick's strip lumping)
The pick says "STRIP on aggressive dedup". I verified dedup has TWO sub-paths with DIFFERENT correct behavior:
- **dedup-REPOINT** (fix.worker.ts:3048-3052 atlas-consumer, 3086-3090 loose-consumer): KEEPS the consumer manifest, only repoints meta.image via `{...consumerAtlas, imageRef}`. Frame KEYS unchanged → animations stays valid → SHOULD carry (and does, free, via the spread). NOT a strip path.
- **frame-redundancy aliasing / cross-atlas merge dedup**: routes through `repackAtlases`, which BUILDS FRESH atlases at packages/fix/src/repack.ts:300 (`{name, imageRef, size, sprites, source, ...format}`) carrying NO relatedMultiPacks and NO animations. So animations is absent BY CONSTRUCTION on every repack/merge/pack path (2039/2094/2830) — correctly stripped with zero new code, exactly as relatedMultiPacks is today.

Second correction: animations references frame KEYS, not file names. So unlike relatedMultiPacks, it stays valid under hashOn/cache-bust (renames FILES, not frame keys) AND under the KTX2 second-sidecar (renames the sidecar FILE, not frame keys). Therefore animations is carried even on those paths where relatedMultiPacks must be stripped. This is the load-bearing reason the two fields diverge.

---

## Problem (verified)
Every Pro fix re-emit (passthrough transcode, atlas resize, KTX2 sidecar, dedup-repoint — all frame-name-stable) silently drops the user-authored top-level `animations` map, breaking runtime `Spritesheet.animations` / every `AnimatedSprite`, while the code comment claims verbatim fidelity. 18 real sheets in the user's own data are affected.

## v1 scope
Carry the user-authored `animations` map through parse → Atlas → emit, VERBATIM (no sort, array order = play order, key order preserved), on FRAME-NAME-STABLE re-emit paths ONLY. Absent ⇒ field omitted ⇒ Atlas + emitted JSON byte-identical to today.

## Out of scope / deferral
- Spine `.atlas` (no animations concept) — `emitSpineAtlasText` UNCHANGED; never emits animations.
- Array-layout TP exports without top-level animations — untouched.
- Regenerating/repairing animations on rename/merge/alias paths — NOT done; animations is naturally absent there (fresh atlas from repackAtlases). No skip-note needed for those because nothing is being dropped that was present on THAT atlas object (the fresh atlas never had it). [Adversarial note: if a future change ever spreads a source atlas INTO a repack result, a strip+note would be required; v1 does not, so no note.]
- Spine SKELETON JSON animations (different concept) — never reaches the read.
- No new finding, no UI surface, no analysis change.

## Additive contract/type changes (absent ⇒ byte-identical)
packages/core/src/index.ts, in `Atlas` (after relatedMultiPacks:80), add:
```ts
/** TexturePacker/Pixi frame-animation map (top-level `animations`): named ordered lists of FRAME
 *  names = play order. Carried VERBATIM from parse, re-emitted by emitTexturePackerJson ONLY on a
 *  frame-NAME-stable re-emit (passthrough transcode, resize, dedup-repoint, KTX2 sidecar, cache-bust
 *  — these rename FILES not frame keys, so refs stay valid). Repack/merge/aggressive-dedup-alias build
 *  a fresh Atlas (repack.ts) ⇒ field naturally absent. Array order + key order are load-bearing (play
 *  order) ⇒ NEVER sorted. Spine has no equivalent ⇒ never emitted to .atlas. Absent ⇒ NO key written
 *  ⇒ JSON byte-identical to today (single-/non-animated case is common). */
animations?: Record<string, string[]>;
```
Type is `Record<string,string[]>` (not a flat array) — do NOT reuse readStringArray.

## Pure modules + signatures
1. **packages/parsers/src/atlas.ts** — new pure helper near readStringArray (atlas.ts:61):
```ts
// Read a verbatim, order-preserving frame-animation map. Each value must be a non-empty array of
// non-empty strings; coerce nothing, drop a whole group only if its value is not such an array.
// Returns undefined when no usable group (⇒ field omitted ⇒ Atlas byte-identical). Insertion order
// of valid keys preserved (Object.entries order = JSON source order); arrays copied verbatim, NO sort.
function readAnimations(v: unknown): Record<string, string[]> | undefined
```
Wire into parseAtlasManifest right after the relatedMultiPacks block (atlas.ts:234), reading from the TOP-LEVEL `j.animations` (NOT meta): `const animations = readAnimations(j.animations); if (animations) atlas.animations = animations;`. [Note: top-level, mirroring the real-file shape — verified animations sits beside frames/meta, not inside meta.]

2. **packages/fix/src/manifest.ts** — in `emitTexturePackerJson`, emit a TOP-LEVEL `animations` key between `frames` and `meta` (TexturePacker/Pixi order is frames, animations, meta — verified in trail_540p.json top-keys `['frames','animations','meta']`), ONLY when present and non-empty:
```ts
const out: Record<string, unknown> = { frames };
if (atlas.animations && Object.keys(atlas.animations).length)
  out.animations = atlas.animations; // VERBATIM, no sort — array order = play order
out.meta = meta;
return JSON.stringify(out, null, 2);
```
Verbatim object/array reference is fine: JSON.stringify preserves insertion order; integers/strings only ⇒ deterministic. Absent ⇒ key omitted ⇒ byte-identical.

## Worker/UI/backend changes
**No code change required on any path** — every carry happens automatically via existing `{...atlas}` spreads:
- Passthrough transcode: repointAtlasImage (atlas-transcode.ts:19, `{...atlas, imageRef}`) → repointedA (fix.worker.ts:2497) → emit :2511. Carries. Update the FALSE comments: atlas-transcode.ts:18 and fix.worker.ts:2496 to add "animations" to the verbatim list.
- Resize: scaleAtlas (repack.ts:70, `{...atlas, size, sprites}`) → scaled → emit :2287 / :3396. Carries. (Update scaleAtlas doc-comment :48-49 "same region names" → also "+ animations map".)
- KTX2 sidecar: `{...c.atlasSidecar.atlas, imageRef}` (fix.worker.ts:3698) → emit :3709. Carries (frame keys valid under KTX2 rename). Add a one-line comment near :3707 noting WHY animations is NOT stripped here even though relatedMultiPacks IS (frame-key ref vs file-name ref).
- Dedup-repoint: `{...consumerAtlas/...referencingAtlas, imageRef}` (fix.worker.ts:3048 / 3086) → emit :3052 / :3090. Carries.
- Repack/merge/pack (2039/2094/2830): fresh atlas (repack.ts:300) — animations absent by construction. No change.
- Backend (apps/api, apps/encoder): NONE — animations never crosses the network (the sidecar JSON is emitted client-side; KTX2 encoder receives only page bytes). Invariants 1/2 untouched.

## Honesty + invariant compliance
- inv3 (objective, generate nothing): we carry user-authored bytes verbatim. No estimate, no synthesis, no finding. The ONE thing to verify: we never FABRICATE an animations map — readAnimations returns undefined when absent, and we never construct one on repack.
- inv5 (disk≠VRAM): zero saving/VRAM claim involved. Pure round-trip fidelity. No metric touched.
- inv1/2 (browser-first, thin backend): client-only, no network.
- Honesty: the carry FIXES a false-verbatim comment rather than adding a claim. On strip-by-construction paths nothing is silently lost that was on that atlas object.

## Determinism
JSON.stringify preserves insertion order; readAnimations preserves Object.entries order and copies arrays without sorting; no timestamps. Same input ⇒ byte-identical output across runs and re-parses (animations round-trips to the same map). The existing manifest determinism contract (manifest.ts:1-3) is preserved — frames still sorted; animations carried in source order (which IS deterministic for a given input).

## Edge cases
- Absent / not-an-object animations ⇒ undefined ⇒ no field ⇒ byte-identical.
- A group whose value is not an array of non-empty strings ⇒ that group dropped (defensive); an all-bad map ⇒ undefined. [Decision: drop-the-bad-group, mirroring readStringArray's per-element filter, but at GROUP granularity so a valid neighbor group survives. Document this — it is the only non-verbatim case and it only triggers on malformed input.]
- Empty animations `{}` ⇒ Object.keys length 0 ⇒ omitted (no `"animations":{}` written).
- A frame name in an animations array that does NOT exist in frames (dangling in the SOURCE): carried verbatim — we do not validate against frames (inv3, we measure/carry, not repair); the source already shipped it. v1 does not warn (out of scope; could be a future analysis finding, deferred).
- 20-frame trail group + multi-group (trail + trail_outro): round-trips with NO reordering — covered by the golden test below.
- Array-LAYOUT manifest (frames is an array) WITH top-level animations: readAnimations still reads j.animations (independent of frames layout). Verbatim carry works. (None in sample data, but supported.)
- Rotated/trimmed frames, mesh, multipack all orthogonal — animations sits beside them.

## Test plan (real harness)
A) packages/parsers/test/parsers.test.ts — new describe 'parseAtlasManifest — top-level animations (round-trip)', mirroring the R28 multipack block (:85-124):
  - parses a single-group map into `atlas.animations` verbatim;
  - MULTI-group order preserved (trail-shaped: {trail:[20 names], trail_outro:[5 names]}) — assert deep-equal AND `Object.keys(animations)` order unchanged;
  - WITHIN-group array order preserved (assert exact array, not a set);
  - absent ⇒ `animations` undefined (field omitted);
  - non-object / array / null animations ⇒ undefined;
  - empty {} ⇒ undefined;
  - a group with a non-string element ⇒ that group filtered, valid neighbor survives;
  - Spine-skeleton-shaped JSON (animations present, NO frames) ⇒ {ok:false} (the read is never reached) — guards the disambiguation.

B) packages/fix/test/atlas-transcode.test.ts — extend the multipack round-trip describe (:86) with an animations group:
  - emit writes top-level `animations` (assert it sits between frames and meta — substring index check) and re-parses intact, order preserved (use a ≥20-element array + ≥2 groups, e.g. derive from a trail-like fixture, to catch any accidental sort);
  - absent ⇒ NO `animations` key in output (`expect(text).not.toContain('"animations"')`);
  - repointAtlasImage preserves animations through its shallow clone, surviving emit→reparse (the passthrough path);
  - scaleAtlas preserves animations (resize path) — add to packages/fix/test/scale.test.ts;
  - a FRESH repack result has NO animations (assert repackAtlases output atlas.animations === undefined) — locks the strip-by-construction behavior.

C) Golden reconciliation: if a sample fixture with animations is added under fixtures/ (mirroring make-fixture), run the fix worker's transcode path and diff the emitted sidecar's animations against the source — but this requires the worker (can't run headless). Instead assert at the PURE seam: parseAtlasManifest(srcJson) → emitTexturePackerJson(atlas) → re-parse → animations deep-equals the source map (full pure round-trip, Node-runnable, covers the real defect without a browser).

D) i18n / 9-locale drift: NONE required. No finding, no messageKey, no UI string introduced. The strip paths reuse no new skip note (animations is never stripped on a present-and-frame-stable path; absent-by-construction paths emit nothing). Confirm `pnpm test` i18n drift suite is unaffected (it will be — no catalog touch). [If a reviewer insists on a skip note for a future generated-multipack regen path, that is deferred, not v1.]

E) Full suite: `pnpm typecheck && pnpm test` — must stay green; existing single-page manifest tests already assert byte-stability and will catch any accidental always-write regression.

## Ordered small-commit task breakdown
1. core: add `animations?: Record<string,string[]>` to Atlas + doc-comment (packages/core/src/index.ts). typecheck.
2. parsers: add readAnimations helper + wire into parseAtlasManifest after the relatedMultiPacks block (read TOP-LEVEL j.animations); add parsers.test.ts cases (A). Commit "feat(parsers): read top-level spritesheet animations map verbatim".
3. fix/manifest: emit top-level animations between frames and meta when present; extend atlas-transcode.test.ts + scale.test.ts (B). Commit "feat(fix): re-emit animations map verbatim on byte-stable manifest emit".
4. fix/comments: correct the false-verbatim comments (atlas-transcode.ts:18, fix.worker.ts:2496, scaleAtlas doc) to include animations; add the KTX2 "why-not-stripped" note (fix.worker.ts near :3707). Commit "docs(fix): animations now carried — correct verbatim comments + KTX2 frame-key rationale".
5. fix: add the fresh-repack-has-no-animations assertion + the pure end-to-end round-trip reconciliation test (C). Commit "test(fix): lock animations strip-by-construction on repack + round-trip golden".

## Threshold values
None introduced. No new threshold; the only gate is presence (Object.keys length) — same posture as relatedMultiPacks at manifest.ts:38. The group-validity filter (non-empty array of non-empty strings) mirrors readStringArray's element filter (atlas.ts:61-66) at group granularity, chosen so a single malformed group cannot poison a valid neighbor while still refusing to invent data.
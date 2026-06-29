This confirms the E6 edge case is reachable: `frames: {}` or `frames: []` passes `looksLikeManifest` (an empty object/array is still an object/array), and if it has `meta.image` it reaches `parseAtlas`. So the draft's E6 concern is real and its `malformedFrames.length > 0` gating fix is necessary and correct. Today, empty-frames → `{ok:true, sprites:[]}`; the naive zero-survivor guard would have flipped that to `{ok:false}`. The draft caught this.

I have everything needed. The premise is TRUE, the mechanism is sound, and the draft caught the subtle edge cases. I found minor overstatements to correct (the pipeline.test.ts "already replicates fan-out" claim, and the noimage.json reasoning) and one structural clarification (the Spine vs atlas asymmetry is inherent, not a stylistic choice). Here is the final revised design.

---

# Mini-Design: Per-Frame Recovery for TexturePacker/Pixi Atlases (REVISED)

## 0. Adversarial verdict

**Premise TRUE, verified end-to-end.** `parseAtlasManifest` (`packages/parsers/src/atlas.ts:140,143,145,150,152,165`) bails `{ok:false}` on the first unusable frame; Spine recovers per-region; the worker fans only Spine. The defect fires unconditionally on the target case and a fixture reproduces it through the real path. Draft accepted with the corrections below — all are clarifications/honesty fixes, **no blocker invalidates the feature**.

**Corrections folded in:**
- **C1 (honesty, was overstated):** The draft's §8b said `pipeline.test.ts` "already replicates the worker's malformedFrames fan-out." It does NOT. Verified at `apps/web/test/pipeline.test.ts:36-45`: it does group→parse→`analyze(assets)` with **no `unparsed` arg at all** and discards every `!r.ok` (lines 38,42). Threading `unparsed` is genuinely NEW test scaffolding, not an extension of existing fan-out. Re-scoped in §8b.
- **C2 (test-break, must-do not optional):** The existing `it` asserts `report.assets).toHaveLength(5)` and exact per-asset verdict arrays (`pipeline.test.ts:49-54`). Adding the new fixture dir to that SAME `it` **breaks those counts**. The new case MUST be a **separate `it`** — the draft's "or add a sibling `it`" is the only safe option, now mandatory.
- **C3 (mechanism justification, strengthened):** The atlas `malformedFrames` rides on the **parse RESULT** (not on `a.manifest` like Spine) because the asymmetry is **inherent**, not stylistic: Spine's `parseSpineAtlasText` runs at INGEST (`ingest/src/index.ts:102`), baking `malformedRegions` onto the `SpinePage` that becomes `a.manifest` (line 114). TexturePacker/Pixi ingest only does `JSON.parse`+`looksLikeManifest`+`meta.image` (lines 123-140); the per-frame parse happens LATER in the worker via `parseAtlas`. So result-carried is the ONLY correct option for atlas. Option B confirmed.
- **C4 (E5 false-reassurance corrected):** The draft said the `noimage.json` fixture "still holds." TRUE, but the draft implied the parser's line-170 check protects it. Verified: `noimage.json` is intercepted at INGEST (`ingest/src/index.ts:131`, reason `"manifest has frames but no meta.image"`) and **never reaches `parseAtlasManifest`**. So the parser change provably cannot affect it. The `unparsed-corrupt/expected.json` golden is untouched.
- **C5 (no-dangling-ref confirmed):** All `parseAtlas` callers destructure `{ok, asset}` and ignore extra props: `cli/src/pipeline.ts:53`, `extension/src/inject.ts:144`, `fix.worker.ts:311`, `fix/src/dedup-repoint.ts` (comment-only ref). The additive optional `malformedFrames` is invisible to them; `pnpm typecheck` confirms.

## 1. Problem (verified TRUE on the real path)

`parseAtlasManifest` bails on the **first** unusable frame: array layout (atlas.ts:140 non-object, 143 missing filename, 145 `bodyToSprite`→null), hash layout (150 non-object, 152 →null), OOB pass (164-165, any over-edge frame). A 500-sprite sheet with one corrupt frame yields **zero diagnosis** — the most common atlas format is the all-or-nothing outlier. Spine recovers per-region (`spine-atlas.ts:113,124`→`malformedRegions`) and the worker fans those into `unparsed[]` (`analyze.worker.ts:72-76`).

**Anti-"never-fires" confirmation:** `bodyToSprite` returns null for a frame whose rect is missing/0×0/negative (`readRect`, atlas.ts:22,25 — `w<=0||h<=0||x<0||y<0`); the OOB pass triggers on any over-edge frame. The fixture (§8c) places exactly ONE such frame among N good. Today → `{ok:false}` (whole sheet dropped). After → N-1 sprites + 1 `malformedFrames`. The e2e test fails on current code, passes after. Real coverage.

## 2. V1 Scope

**In:** (1) array/hash loops collect `{name,reason}` into `malformedFrames[]`, keep good sprites; (2) OOB pass partitions; (3) `{ok:false}` ONLY when survivors=0 **AND** ≥1 frame was malformed (E6); (4) additive optional `malformedFrames` on `AtlasParseResult` ok-branch (mirrors `SpinePage.malformedRegions?`); (5) worker fans `res.malformedFrames` into `unparsed[]` with ref `` `${a.name}#${frameName}` `` (Spine pattern); (6) golden fixture + parser tests + e2e test through the real path.

**Out:** no change to `bodyToSprite`/`readRect` thresholds; no mesh sub-tlety (a bad mesh already degrades to rect-only inside `bodyToSprite` via `readMesh`→undefined, atlas.ts:88 — NOT a frame drop); no new finding rule; no UI strings (`unparsed[]`→UI already wired); no core change; no backend; no parser-side sorting (worker owns the global sort, analyze.worker.ts:93).

## 3. Contract changes (additive only)

`packages/parsers/src/atlas.ts:10`:
```ts
export type AtlasParseResult =
  | { ok: true; atlas: Atlas; malformedFrames?: { name: string; reason: string }[] }
  | { ok: false; error: string };
```
`malformedFrames` present ONLY when ≥1 frame was dropped. Absent ⇒ byte-identical to today. Lives on `ok:true` only; a zero-survivor-with-malformed manifest is still `{ok:false}`. **No change to `@asset-doctor/core`** — the `unparsed` `{ref,reason}[]` surface (`core/src/index.ts:623`, `analysis/src/analyze.ts:76,269`) already exists and is plumbed; `malformedFrames` is a parser-internal carrier fanned into it by the worker, exactly as `SpinePage.malformedRegions` is (also not in core). **No change to `ParseResult`** (`types.ts:4`) — see §4b.

## 4. Pure module changes

### 4a. `parseAtlasManifest` (atlas.ts:116-178)

Collect instead of bail. **Keep reason strings byte-identical** to today (pinned by F3 tests, parsers.test.ts:187,196). Array (keep `for...of`, add an index counter for synthesized names so `forEach` isn't forced):
```ts
const sprites: Sprite[] = [];
const malformedFrames: { name: string; reason: string }[] = [];

if (layout === 'array') {
  let i = -1;
  for (const entry of rawFrames as unknown[]) {
    i++;
    if (typeof entry !== 'object' || entry === null) {
      malformedFrames.push({ name: `#${i}`, reason: 'array frame is not an object' }); continue;
    }
    const e = entry as Record<string, unknown>;
    const name = typeof e.filename === 'string' ? e.filename : undefined;
    if (!name) { malformedFrames.push({ name: `#${i}`, reason: 'array frame missing filename' }); continue; }
    const sp = bodyToSprite(name, e);
    if (!sp) { malformedFrames.push({ name, reason: `invalid frame "${name}"` }); continue; }
    sprites.push(sp);
  }
} else {
  for (const [name, body] of Object.entries(rawFrames as Record<string, unknown>)) {
    if (typeof body !== 'object' || body === null) {
      malformedFrames.push({ name, reason: `frame "${name}" is not an object` }); continue;
    }
    const sp = bodyToSprite(name, body as Record<string, unknown>);
    if (!sp) { malformedFrames.push({ name, reason: `invalid frame "${name}"` }); continue; }
    sprites.push(sp);
  }
}
```

**Keep manifest-level checks in place, in order:** `size` check (158) stays BEFORE the OOB pass (OOB needs `size`); `imageRef` check (170) stays where it is. These are manifest-level failures — still `{ok:false}` for the whole sheet. They are unchanged.

**OOB pass (163-167) → partition:**
```ts
const placed: Sprite[] = [];
for (const s of sprites) {
  if (s.frame.x + s.frame.w > size.w || s.frame.y + s.frame.h > size.h) {
    malformedFrames.push({ name: s.name, reason: `frame "${s.name}" extends past atlas ${size.w}×${size.h}` });
  } else placed.push(s);
}
```

**Zero-survivor guard (gated on malformed>0, per E6) — placed AFTER the OOB partition, BEFORE atlas build:**
```ts
if (placed.length === 0 && malformedFrames.length > 0) {
  return { ok: false, error: malformedFrames[0]!.reason };
}
```
Empty `frames` (`malformedFrames.length===0`, `placed.length===0`) falls through to `{ok:true, sprites:[]}` — byte-identical to today (E6).

**Build atlas from `placed` (not `sprites`); final return:**
```ts
const atlas: Atlas = { name: opts.name ?? imageRef, imageRef, size, sprites: placed, source: { kind } };
// ...format/scale as today...
return malformedFrames.length ? { ok: true, atlas, malformedFrames } : { ok: true, atlas };
```

### 4b. `parseAtlas` (atlas.ts:181-202) — Option B (local return widen)

`ParseResult` has no `malformedFrames` slot. Widen `parseAtlas`'s return locally (not core's `ParseResult`):
```ts
export function parseAtlas(
  manifestJson: unknown,
  image: { ref: string; bytes: Uint8Array },
  opts: { name?: string } = {},
): ParseResult & { malformedFrames?: { name: string; reason: string }[] } {
  const info = readImageInfo(image.bytes);
  if (!info) return { ok: false, error: `atlas image unrecognized: ${image.ref}` };
  const res = parseAtlasManifest(manifestJson, { imageRef: image.ref, imageSize: info.size, ...(opts.name !== undefined ? { name: opts.name } : {}) });
  if (!res.ok) return res;
  const imageAsset: ImageAsset = { name: res.atlas.imageRef, imageRef: image.ref, size: info.size, mime: info.mime, byteSize: image.bytes.byteLength };
  return res.malformedFrames
    ? { ok: true, asset: { kind: 'atlas', atlas: res.atlas, image: imageAsset }, malformedFrames: res.malformedFrames }
    : { ok: true, asset: { kind: 'atlas', atlas: res.atlas, image: imageAsset } };
}
```
Additive intersection on success; all other callers (C5) destructure `{ok,asset}` and ignore it. **A (widen core `ParseResult`) rejected** — over-broad, touches every parser caller.

## 5. Worker / UI / backend

`apps/web/src/worker/analyze.worker.ts:65-70` — fan-out symmetric to Spine (72-76), inside the atlas branch:
```ts
if (res.ok && res.asset.kind === 'atlas') {
  assets.push(res.asset);
  imageBytes.set(res.asset.atlas.name, a.image.bytes);
  // Per-frame TexturePacker/Pixi recovery: the sheet kept its good sprites; surface bad frames individually.
  for (const mf of res.malformedFrames ?? []) {
    unparsed.push({ ref: `${a.name}#${mf.name}`, reason: mf.reason });
  }
} else if (!res.ok) {
  unparsed.push({ ref: a.name, reason: res.error });
}
```
`res.malformedFrames` is only on the non-spine branch (parseSpinePage's `ParseResult` has no such field → `?? []` empty). The Spine block (72-76) is untouched. Global `unparsed.sort` (93) keeps order deterministic. **Ref note:** an object-shaped nameless array frame → ref `` `${a.name}##${i}` `` (double-hash) — honest + unique. **UI/backend: none.**

## 6. Honesty / invariants / determinism

- **Inv 3 (objectivity):** never fabricate a placement; OOB frames dropped+surfaced, not clamped — same discipline as Spine (`spine-atlas.ts:31-33`).
- **Inv 4 (instant-wow/FREE):** strictly more diagnosis from the same input; no new network/decode; pure parser + 4-line worker fan-out.
- **Determinism:** array preserves source order (index counter); hash preserves `Object.entries` insertion order; OOB partition preserves order; worker's global sort (93) stabilizes the final surface. No `Date.now`/`Math.random`.
- **Backwards-compat:** clean sheet → field absent → byte-identical; empty-frames → `{ok:true,sprites:[]}` (E6); all-bad → `{ok:false, error: firstReason}`.

## 7. Edge cases

- **E1 one-bad-among-many (target):** N-1 survive + 1 entry. Fires (fixture).
- **E2 single-frame-sheet-bad (existing F3, parsers.test.ts:180-198):** survivors=0, malformed=1 → `{ok:false, error: malformedFrames[0].reason}` = `invalid frame "bad.png"` / `extends past atlas 1024×1024` — both `.toMatch()` assertions pass. **Critical compat gate; commit 2 verifies green.**
- **E3 array missing filename:** synthesized `#i`, reason unchanged; survives if others do.
- **E4 ALL frames bad:** `{ok:false}`, reason=first malformed. Honest.
- **E5 manifest-level (no `meta.image`/no size/not object/no frames):** unchanged. `noimage.json` intercepted at INGEST (`ingest:131`), never reaches parser (C4); `unparsed-corrupt/expected.json` golden untouched.
- **E6 empty `frames`:** reachable (passes `looksLikeManifest`, verified `ingest:63-67`). Guard gated on `malformedFrames.length>0` keeps it `{ok:true,sprites:[]}` — byte-identical. **Caught; mandatory.**

## 8. Test plan

### 8a. Parser unit — `packages/parsers/test/parsers.test.ts` (new `describe`, alongside F3; helpers `json`/`bytes` at lines 8-9)
```ts
describe('per-frame recovery — one bad frame no longer nukes the sheet', () => {
  it('Hash: keeps N-1 sprites + surfaces the 1 malformed frame', () => {
    const res = parseAtlas(json('atlas-frame-recovery/hash.json'),
      { ref: 'sheet.png', bytes: bytes('atlas-frame-recovery/sheet.png') });
    expect(res.ok).toBe(true);
    if (!res.ok || res.asset.kind !== 'atlas') throw new Error('expected atlas');
    expect(res.asset.atlas.sprites.map(s => s.name).sort()).toEqual(['a.png','b.png']);
    expect(res.malformedFrames).toEqual([{ name: 'bad.png', reason: 'invalid frame "bad.png"' }]);
  });
  it('Array: keeps N-1 + surfaces the OOB frame', () => { /* array.json, OOB frame */ });
  it('zero survivors still returns {ok:false} (preserves today)', () => { /* all-bad manifest */ });
  it('empty frames stays {ok:true} with zero sprites (E6 byte-identity)', () => {
    const res = parseAtlas({ frames: {}, meta: { image: 'sheet.png', size: { w: 128, h: 128 } } },
      { ref: 'sheet.png', bytes: bytes('atlas-frame-recovery/sheet.png') });
    expect(res.ok && res.asset.kind === 'atlas' && res.asset.atlas.sprites).toHaveLength(0);
    expect(res.ok && res.malformedFrames).toBeUndefined();
  });
  it('clean sheet has no malformedFrames field (byte-identical)', () => {
    const res = parseAtlas(json('tp-hash-symbols/symbols.json'),
      { ref: 'symbols.png', bytes: bytes('tp-hash-symbols/symbols.png') });
    expect(res.ok && res.malformedFrames).toBeUndefined();
  });
});
```

### 8b. End-to-end worker-path — `apps/web/test/pipeline.test.ts` (NEW SEPARATE `it`, C2)
The existing `it` (24-55) cannot host this — its `toHaveLength(5)` + exact verdicts would break. Add a sibling `it` that walks ONLY `atlas-frame-recovery`, and — since `pipeline.test.ts` does NOT thread `unparsed` today (C1) — replicate the worker's fan-out explicitly:
```ts
it('per-frame recovery: one bad frame surfaces via unparsed, good frames still diagnosed', async () => {
  const files: RawFile[] = [];
  walk(join(ROOT, 'atlas-frame-recovery'), 'atlas-frame-recovery', files);
  const grouped = groupFiles(files);
  const assets: Asset[] = [];
  const unparsed = [...grouped.unparsed];
  for (const a of grouped.atlases) {
    const r = parseAtlas(a.manifest, { ref: a.name, bytes: new Uint8Array(a.image.bytes) });
    if (r.ok && r.asset.kind === 'atlas') {
      assets.push(r.asset);
      for (const mf of r.malformedFrames ?? []) unparsed.push({ ref: `${a.name}#${mf.name}`, reason: mf.reason });
    } else if (!r.ok) unparsed.push({ ref: a.name, reason: r.error });
  }
  unparsed.sort((x, y) => x.ref.localeCompare(y.ref));
  const report = await analyze(assets, undefined, { unparsed });
  expect(report.unparsed).toContainEqual({ ref: 'sheet.png#bad.png', reason: 'invalid frame "bad.png"' });
  expect(report.assets.find(a => a.assetRef === 'sheet.png')).toBeDefined(); // good frames diagnosed
});
```
On today's code `parseAtlas` returns `{ok:false}` → `sheet.png` produces zero assets, only an atlas-level `unparsed` entry → this `it` fails. After the change it passes. **Defect reproduced through the real group→parse→fan-out→analyze path.** (Note: `analyze`'s 3rd-arg `deps.unparsed` pass-through is verified at `analysis/src/analyze.ts:269`.)

### 8c. Fixture — `fixtures/sample-projects/atlas-frame-recovery/` (via `make-fixture` skill)
- `sheet.png` — small valid page (128×128).
- `hash.json` — TexturePacker Hash (`meta.app:"TexturePacker"`, `meta.image:"sheet.png"`, `meta.size:{w:128,h:128}`): `a.png`,`b.png` valid in-bounds + `bad.png` with `frame:{x:0,y:0,w:0,h:32}` → `invalid frame "bad.png"`. 2 survive.
- `array.json` — TexturePacker Array, two valid + one OOB (`frame.x+w > 128`) → `extends past atlas 128×128`.
- `expected.json` — golden mirroring `unparsed-corrupt/expected.json` schema: surviving sprite names + `unparsed` refs (`sheet.png#bad.png`) + `note`.
- `README.md` — documents the defect (1 corrupt frame, N-1 recoverable) + the recovery contract.

## 9. Ordered task breakdown (small commits)

1. **`feat(parsers): AtlasParseResult carries optional malformedFrames`** — widen type (atlas.ts:10); field unused, compiles. Tiny isolated contract commit.
2. **`feat(parsers): per-frame recovery in parseAtlasManifest (collect, don't bail)`** — array loop, hash loop, OOB partition, zero-survivor guard (gated `malformedFrames.length>0`, E6), build from `placed`, return optional field; `parseAtlas` forwards it (§4b). **Run `pnpm --filter @asset-doctor/parsers test` — the two F3 tests (E2) MUST stay green. This is the compat gate.**
3. **`test(parsers): per-frame recovery golden tests + fixture`** — `make-fixture` `atlas-frame-recovery/`; new `describe` (§8a) incl. the E6 empty-frames + clean-sheet byte-identity assertions.
4. **`feat(web): analyze worker fans atlas malformedFrames into unparsed[]`** — the block in analyze.worker.ts:65-70 (§5), symmetric with Spine.
5. **`test(web): end-to-end per-frame recovery through the worker path`** — NEW SEPARATE `it` in pipeline.test.ts (§8b), threading `unparsed` (which the file does not do today). Asserts `sheet.png#bad.png` in `report.unparsed` AND surviving-frame diagnosis.
6. **`pnpm typecheck && pnpm test`** — full suite green; confirms CLI/extension/fix.worker callers (C5) unaffected.

## 10. Files touched (absolute)

- `/home/nonamezzz/Рабочий стол/projects/packages/parsers/src/atlas.ts` — type (10) + `parseAtlasManifest` loops/OOB/guard/return (137-178) + `parseAtlas` forward (181-202).
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/analyze.worker.ts` — fan-out (65-70).
- `/home/nonamezzz/Рабочий стол/projects/packages/parsers/test/parsers.test.ts` — new `describe`.
- `/home/nonamezzz/Рабочий стол/projects/apps/web/test/pipeline.test.ts` — NEW separate `it` (not editing the existing one — C2).
- `/home/nonamezzz/Рабочий стол/projects/fixtures/sample-projects/atlas-frame-recovery/` — sheet.png, hash.json, array.json, expected.json, README.md.

**No changes:** `packages/core/src/index.ts` (surface at 623 exists, plumbed), `packages/analysis` (pass-through analyze.ts:269), `packages/ingest`, `apps/cli`, `apps/extension`, `apps/web/.../fix.worker.ts`, `packages/fix`, backend, UI.

## 11. Key risks & mitigations

- **R1 — break the two F3 single-frame tests (E2).** Guard returns `malformedFrames[0].reason` = today's exact string for both. Commit 2 gates on green. Verified against parsers.test.ts:187,196.
- **R2 — empty-`frames` drift (E6).** Guard gated on `malformedFrames.length>0` → empty manifest stays `{ok:true,sprites:[]}`. New test in §8a pins it.
- **R3 — does the op fire?** Confirmed: fixture has exactly one `bodyToSprite`/OOB-rejected frame; today `{ok:false}` (zero diagnosis), after N-1+1. The §8b `it` fails on current code, passes after — genuine coverage.
- **R4 (NEW) — pipeline.test.ts overstatement (C1/C2).** The file does NOT thread `unparsed` today and the existing `it` has exact-count assertions; the test is a NEW separate `it` with explicit fan-out replication, not an edit to the existing one. Reflected in §8b + task 5 + §10.
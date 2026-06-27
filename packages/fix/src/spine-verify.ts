// Feature 4 (pack loose assets) — PURE Spine skeleton verifier. The worker (fix.worker.ts) parses the
// loose region PNGs into a packed `.atlas`; this module reads the UNTOUCHED skeleton `.json` and asserts
// every attachment that NEEDS a region resolves to a region the new atlas actually ships — so a packed
// Spine atlas is never silently broken (an attachment pointing at a region we didn't emit).
//
// Verified against 290 real production skeletons (docs/spritesheet-packing-design.md § 5):
//   • `skins` is an ARRAY of {name, attachments} in modern (3.8+) exports — the real production form —
//     AND a legacy OBJECT {skinName: {slot: {att: {...}}}} in older ones. BOTH are handled; an
//     unrecognized shape returns `unverified` (honest "paths not verified"), NEVER a false 0-of-0.
//   • Resolution is PER ATTACHMENT TYPE:
//       region / mesh         → REQUIRE a region named `att.path ?? attachmentName` (path override read).
//       linkedmesh            → has no path of its own; inherits its region from its PARENT mesh
//                               (`att.parent` in skin `att.skin ?? currentSkin`), resolved via the
//                               parent's `path ?? parentName`.
//       clipping/point/boundingbox/path → need NO region; IGNORED (never flagged).
//     Default type (absent `type`) is "region" (Spine convention).
//
// Pure, zero-dependency, worker-safe: NO DOM/canvas/Node-FS, no Date.now/Math.random. The worker hands
// the already-parsed JSON (it owns the bytes) + the set of region names the packed atlas exposes.

/** One attachment that REQUIRES a region in the packed atlas. `attachment` = the skin attachment name
 *  (for the human-readable skipped[] message); `region` = the resolved region name the atlas must ship
 *  (= `path ?? name`, parent-inherited for linkedmesh). Clipping/point/boundingbox/path never appear. */
export interface RequiredRegion {
  slot: string;
  attachment: string;
  region: string;
}

/** Result of reading a skeleton's attachments. `required` = every attachment that needs a region.
 *  `unverified` = the skeleton shape could not be understood (legacy-and-modern both failed, or a
 *  `.skel` binary the worker handed as null) — surface an honest "paths not verified", never claim 0. */
export interface SkeletonScan {
  required: RequiredRegion[];
  unverified: boolean;
}

/** Outcome of matching a skeleton's required regions against the packed atlas's emitted region names. */
export interface SpineVerifyResult {
  /** Required attachments whose region IS present in the packed atlas. */
  verified: number;
  /** Required attachments with NO matching packed region (do not ship that region — surfaced). */
  unmatched: RequiredRegion[];
  /** True when the skeleton shape was unrecognized (honest "paths not verified"). */
  unverified: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Attachment types that need NO region (never flagged). Everything else (incl. absent type ⇒ region)
 *  requires a region. linkedmesh is required but resolves via its PARENT (handled separately). */
const NO_REGION_TYPES = new Set(['clipping', 'point', 'boundingbox', 'path']);

/** One slot's attachment map: { attachmentName: attachmentDef }. Modern skins nest this under
 *  `skin.attachments[slot]`; legacy skins nest it directly under `skin[slot]`. */
type SlotAtts = Record<string, unknown>;
/** A normalized skin: name + its slot→attachments map. The two wire shapes collapse to this. */
interface NormSkin {
  name: string;
  slots: Record<string, SlotAtts>;
}

/** Normalize the `skins` field from EITHER wire shape into NormSkin[]. Returns null when neither shape
 *  parses (⇒ caller marks the scan unverified). */
function normalizeSkins(skins: unknown): NormSkin[] | null {
  // Modern (3.8+): an ARRAY of { name, attachments: { slot: { att: {...} } } }.
  if (Array.isArray(skins)) {
    const out: NormSkin[] = [];
    for (const s of skins) {
      if (!isObj(s)) return null;
      const name = str(s.name) ?? '';
      const atts = isObj(s.attachments) ? s.attachments : {};
      const slots: Record<string, SlotAtts> = {};
      for (const [slot, m] of Object.entries(atts)) if (isObj(m)) slots[slot] = m as SlotAtts;
      out.push({ name, slots });
    }
    return out;
  }
  // Legacy (≤3.7): an OBJECT { skinName: { slot: { att: {...} } } }.
  if (isObj(skins)) {
    const out: NormSkin[] = [];
    for (const [name, slotMap] of Object.entries(skins)) {
      if (!isObj(slotMap)) return null;
      const slots: Record<string, SlotAtts> = {};
      for (const [slot, m] of Object.entries(slotMap)) if (isObj(m)) slots[slot] = m as SlotAtts;
      out.push({ name, slots });
    }
    return out;
  }
  return null;
}

/**
 * Read a parsed skeleton `.json` and return every attachment that REQUIRES a region in the packed atlas,
 * resolving each per its type (region/mesh → `path ?? name`; linkedmesh → parent's `path ?? parentName`;
 * clipping/point/boundingbox/path ignored). `json === null` (a `.skel` binary the worker can't cheaply
 * decode) or an unrecognized `skins` shape ⇒ `{ required: [], unverified: true }` — never a false 0-of-0.
 * Pure; no IO.
 */
export function scanSkeleton(json: unknown): SkeletonScan {
  if (!isObj(json)) return { required: [], unverified: true };
  // Not a skeleton at all (no `skins`) — treat as unverifiable rather than claim a hollow 0-of-0.
  if (!('skins' in json)) return { required: [], unverified: true };
  const skins = normalizeSkins(json.skins);
  if (!skins) return { required: [], unverified: true };

  const byName = new Map<string, NormSkin>();
  for (const s of skins) byName.set(s.name, s);

  /** Resolve a parent mesh's region name for a linkedmesh: look up `att.parent` in skin `att.skin ??
   *  current`, read its `path ?? parentName`. Returns undefined when the parent can't be located (the
   *  linkedmesh then has no derivable region and is dropped from `required` — it can't be matched). */
  const resolveParentRegion = (def: Obj, currentSkin: string): string | undefined => {
    const parentName = str(def.parent);
    if (!parentName) return undefined;
    const skinName = str(def.skin) ?? currentSkin;
    const skin = byName.get(skinName) ?? byName.get(currentSkin);
    if (!skin) return undefined;
    for (const slotAtts of Object.values(skin.slots)) {
      const pdef = slotAtts[parentName];
      if (isObj(pdef)) return str(pdef.path) ?? parentName;
    }
    return undefined;
  };

  const required: RequiredRegion[] = [];
  for (const skin of skins) {
    for (const [slot, slotAtts] of Object.entries(skin.slots)) {
      for (const [attName, rawDef] of Object.entries(slotAtts)) {
        const def = isObj(rawDef) ? rawDef : {};
        const type = str(def.type) ?? 'region';
        if (NO_REGION_TYPES.has(type)) continue;
        if (type === 'linkedmesh' || type === 'weightedlinkedmesh') {
          const region = resolveParentRegion(def, skin.name);
          if (region !== undefined) required.push({ slot, attachment: attName, region });
          continue;
        }
        // region / mesh (and any other region-backed type): need a region named `path ?? attName`.
        required.push({ slot, attachment: attName, region: str(def.path) ?? attName });
      }
    }
  }
  return { required, unverified: false };
}

/**
 * Match a skeleton's required regions against the region names the packed atlas actually exposes.
 * `regionNames` = the emitted atlas's region/frame names (e.g. `items/sword`). Unrecognized skeleton ⇒
 * `{ verified: 0, unmatched: [], unverified: true }` (honest). Determinism: `unmatched` preserves the
 * scan's deterministic attachment order. Pure.
 */
export function verifySpineSkeleton(json: unknown, regionNames: Iterable<string>): SpineVerifyResult {
  const scan = scanSkeleton(json);
  if (scan.unverified) return { verified: 0, unmatched: [], unverified: true };
  const have = regionNames instanceof Set ? regionNames : new Set(regionNames);
  let verified = 0;
  const unmatched: RequiredRegion[] = [];
  for (const r of scan.required) {
    if (have.has(r.region)) verified++;
    else unmatched.push(r);
  }
  return { verified, unmatched, unverified: false };
}

// Conservative, skins-only reader of a Spine skeleton .json — the attachment-reference surface the
// `spine-unreferenced-regions` disclosure needs, and NOTHING more. Grounded against the vendored
// spine-core 4.3.9 SkeletonJson: an animation's attachment timelines name skin PLACEHOLDERS resolved via
// the skeleton's skins, so the union over ALL skins is the complete statically-reachable region set —
// animations deliberately NOT parsed. The atlas is looked up by `path ?? name ?? placeholderKey`
// (AtlasAttachmentLoader.findRegion uses the attachment's `path`), so that chain IS the match key.
//
// HONESTY (invariant 3): CONSERVATIVE by construction — any unrecognized shape returns null and the rule
// never fires (a wrong parse must never fabricate a "dead region" verdict). Non-visual attachment types
// (boundingbox / path / point / clipping) reference NO atlas region and collect nothing; an UNKNOWN type
// string DOES collect (over-collection only SHRINKS the dead set — an under-claim, never an over-claim).
// Spine 4.1+ `sequence` attachments resolve to path + zero-padded index at load time, so their base path
// goes into `prefixes` (the consumer matches name === prefix + digits). Pure, total, never throws.

/** The attachment-reference surface of one parsed skeleton: exact region names + sequence base paths. */
export interface SkeletonAttachmentRefs {
  names: string[];
  prefixes: string[];
}

/** Attachment types that reference NO atlas region (vertices/geometry only) — they collect nothing. */
const NON_VISUAL = new Set(['boundingbox', 'path', 'point', 'clipping']);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Collect one attachment entry (placeholderKey → data map). Returns false on an unrecognized shape
 *  (⇒ the whole read aborts to null — conservative). */
function collectEntry(
  placeholderKey: string,
  data: unknown,
  names: Set<string>,
  prefixes: Set<string>,
): boolean {
  if (!isRecord(data)) return false;
  const type = typeof data.type === 'string' ? data.type : 'region';
  if (NON_VISUAL.has(type)) return true; // geometry-only — references no region, honestly skipped
  const name = typeof data.name === 'string' ? data.name : placeholderKey;
  const path = typeof data.path === 'string' ? data.path : name;
  if (isRecord(data.sequence)) {
    // Spine 4.1+ sequence: the real regions are `path` + a zero-padded frame index — prefix match.
    prefixes.add(path);
    return true;
  }
  names.add(path);
  return true;
}

/** Collect one skin's slot→placeholder map ({ slotName: { placeholderKey: data } }). */
function collectSlots(slots: unknown, names: Set<string>, prefixes: Set<string>): boolean {
  if (!isRecord(slots)) return false;
  for (const slot of Object.values(slots)) {
    if (!isRecord(slot)) return false;
    for (const [placeholderKey, data] of Object.entries(slot)) {
      if (!collectEntry(placeholderKey, data, names, prefixes)) return false;
    }
  }
  return true;
}

/** Read the attachment-reference surface of a PARSED skeleton json. Handles BOTH schema generations:
 *  skins as an ARRAY of { name, attachments: {...} } (Spine 3.8+/4.x) and the legacy OBJECT form
 *  { skinName: { slot: {...} } } (≤3.7). Returns null on ANY unrecognized shape — the consumer's rule
 *  then never fires (conservative; a wrong parse must never fabricate a verdict). */
export function readSkeletonAttachmentRefs(json: unknown): SkeletonAttachmentRefs | null {
  if (!isRecord(json)) return null;
  const skins = json.skins;
  const names = new Set<string>();
  const prefixes = new Set<string>();
  if (Array.isArray(skins)) {
    // 3.8+/4.x: [{ name, attachments?: { slot: { placeholder: data } } }]
    for (const skin of skins) {
      if (!isRecord(skin)) return null;
      if (skin.attachments === undefined) continue; // a skin with no attachments is valid (e.g. "default")
      if (!collectSlots(skin.attachments, names, prefixes)) return null;
    }
  } else if (isRecord(skins)) {
    // legacy ≤3.7: { skinName: { slot: { placeholder: data } } }
    for (const skinSlots of Object.values(skins)) {
      if (!collectSlots(skinSlots, names, prefixes)) return null;
    }
  } else {
    return null; // skins absent / wrong shape — cannot reason about references
  }
  return { names: [...names].sort(), prefixes: [...prefixes].sort() };
}

// Pure parser/grouper for the worker's free-text FixReceipt.operations[] strings (fix.worker.ts).
// Web-app-local (it parses a web-worker string format → does NOT belong in a shared package). No DOM,
// no I/O, no Date.now/Math.random — same input ⇒ deep-equal output. Presents the EXISTING audit trail;
// generates nothing and synthesizes no numbers (op strings carry dims/format, never per-file bytes).

/** Op verbs — the closed set emitted by the 11 operations.push sites (8 distinct verbs) in fix.worker.ts. */
export type OpKind = 'repack' | 'merge' | 'resize' | 'transcode' | 'drop' | 'pack' | 'dedup' | 'tier';

/** Verbs whose op rewrites/changes asset references (NOT a drop-in) → rendered with the warn token. */
export const REFERENCE_CHANGING: ReadonlySet<OpKind> = new Set<OpKind>(['merge', 'dedup', 'pack', 'tier']);

/** Deterministic group display order: drop-in ops first, reference-changing next, tier last. */
export const OP_KIND_ORDER: readonly OpKind[] = ['repack', 'resize', 'transcode', 'drop', 'merge', 'pack', 'dedup', 'tier'];

const KNOWN: ReadonlySet<string> = new Set<string>(OP_KIND_ORDER);

export interface OpRow {
  kind: OpKind | null;
  text: string;
}

export interface OpGroup {
  /** null ⇒ unknown/future verb, bucketed into the trailing neutral "other" group (never dropped). */
  kind: OpKind | null;
  refChanging: boolean;
  rows: OpRow[];
}

/** Classify one operations[] string by its leading whitespace-delimited token. Unknown/empty leading
 *  token → null (caller buckets under a neutral "other" group — never mislabeled, never silently
 *  dropped). Pure. No multi-word special case needed: 'drop duplicate …' leads with 'drop'. */
export function classifyOp(op: string): OpKind | null {
  const head = op.trimStart().split(/\s+/, 1)[0] ?? '';
  return KNOWN.has(head) ? (head as OpKind) : null;
}

/** Group operations[] into ordered, verb-bucketed groups. Known verbs emitted in OP_KIND_ORDER; null-verb
 *  rows collected into a single trailing group (kind:null). Within-group order = input order. Empty groups
 *  omitted. Pure: same input ⇒ deep-equal output. */
export function groupOps(operations: readonly string[]): OpGroup[] {
  const rows: OpRow[] = operations.map((text) => ({ kind: classifyOp(text), text }));
  const groups: OpGroup[] = [];
  for (const kind of OP_KIND_ORDER) {
    const r = rows.filter((row) => row.kind === kind);
    if (r.length > 0) groups.push({ kind, refChanging: REFERENCE_CHANGING.has(kind), rows: r });
  }
  const other = rows.filter((row) => row.kind === null);
  if (other.length > 0) groups.push({ kind: null, refChanging: false, rows: other });
  return groups;
}

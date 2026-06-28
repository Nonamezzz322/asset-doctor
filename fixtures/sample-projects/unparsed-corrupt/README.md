# unparsed-corrupt

A folder that mixes one **good** loose image with the two deterministic **ingest skip-points**, to prove the
diagnosis surfaces unparseable would-be assets HONESTLY instead of silently dropping them
(`docs/improvements/round6-f3-unparsed-surface.md`) — symmetric with the fix engine's `skipped[]`.

- **`good.png`** — a valid 64×64 loose image → a real asset survives (the notice never replaces the report).
- **`broken.json`** — truncated/invalid JSON → `JSON.parse` throws → surfaced
  `manifest JSON parse failed: …`.
- **`noimage.json`** — valid JSON with `frames` (so it *looks* like a manifest) but no `meta.image` →
  surfaced `manifest has frames but no meta.image`.
- **`config.json`** (no `frames`) and **`notes.txt`** — legitimately **not** assets → stay **silent**
  (flagging a benign non-asset file would be its own dishonesty, Invariant 3).

`expected.json` pins the good asset, the sorted `unparsed` surface (reasons stay English — parser strings,
same precedent as `fix.skipped`), and the files that must NOT be surfaced.

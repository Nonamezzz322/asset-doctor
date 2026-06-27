# raw-multifolder-dupes

A multi-folder **raw upload** (loose images + one pre-built atlas pair) where the same bytes recur
across folders. Drives Part B **owner/consumer dedup** (Feature 1) and **lazy-aware owner selection**
(Feature 3). `bundle(ref)` = first path segment; the golden uses marking
`{ main_game: eager, fs_game: eager, bonus: lazy, bonus_b: lazy }` (every other root is **isolated**,
the unmarked default), and SkinGuard `{ skin_red: skin_blue }` (matched on the **file** basename).

Owner rule (codepoint `cmp`, **not** localeCompare): with any eager member, owner = the cmp-first
eager copy and everyone else consumes it (one safe cross-bundle edge, `LAZY_MAY_CONSUME_EAGER`); with
no eager member, dedup only **within** a bundle (cmp-first local owner) — zero cross-bundle edges.

### Cases (see `expected.json` for the authored golden)
- **(a)** `main_game/logo.png` == `fs_game/logo.png` — cross-bundle, both eager → owner `fs_game/logo.png` (cmp-first), `main_game` consumes (`eager-owner-cross-bundle`).
- **(b)** `main_game/general/icon.png` == `main_game/ui/icon.png` — same eager bundle → owner `general` (cmp-first), `ui` consumes (`same-eager-bundle`).
- **(c)** `main_game/spark.png` (eager) == `bonus/spark.png` == `bonus_b/spark.png` (two lazy) → both lazy consume the eager owner (`eager-owner-cross-bundle`).
- **(d)** `theme_default/skin_red.png` == `theme_dark/skin_blue.png` (byte-identical) → **NOT collapsed**: `skin_red`∈keys, `skin_blue`∈values (different skin partitions).
- **(e)** `skin_red/tile.png` == `skin_blue/tile.png` — folders look like skin key/value, but the **file** basename `tile` is neither → both `general`. No eager, distinct isolated bundles → each its own owner, no drop. Pins AD's file-basename rule (vs the builder's folder-basename).
- **(f)** `animations/a/frame.png` == `animations/b/frame.png`, both with a `.atlas` → **spine** pool, same bundle → owner `a` (cmp-first), `b` consumes (`same-isolated-bundle`).
- **(g)** `props/frame.png` is byte-identical to the spine frame but is a **pixi** sprite → pool separation keeps it apart; alone in the pixi pool for this hash → **no group**.
- **(h)** `extra/sheet.{png,json}` is fully identical to `main_game/sheet.{png,json}` → owner `main_game` (eager), the consumer's **image is dropped and its manifest `meta.image` is repointed** at the owner image (round-trips through `parseAtlas`).
- **(i)** `loose/orphan.png` == `loose/orphan_copy.png` — same isolated bundle, so a drop is planned, but no AD-emitted manifest references them → the worker **KEEPS** the copy and surfaces `looseRepathSkipped`.

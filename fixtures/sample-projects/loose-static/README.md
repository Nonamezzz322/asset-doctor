# loose-static

RAW **loose PNGs** (no manifest) for Feature 4 part A — packing loose assets into a static
spritesheet + TexturePacker JSON. Eight images sit directly under the folder (≥ `minLooseImages`
= 8), most with a fully-transparent **margin** the worker's `alphaBBox` trims; `gem.png` /
`scroll.png` are fully opaque (`trimmed:false` even with trim on); `blank.png` is fully
**transparent** → a **1×1 sentinel** (the frame stays resolvable, never zero-size). A nested
`icons/` subfolder exercises folder-**relative** frame keys (`icons/star`).

### Intended outcome (`expected.json` is the authored golden)
Default grouping is **per-leaf-folder**: the 9 root candidates pack into **one** sheet + TP JSON
(frames keyed by the folder-relative stem); `icons/` (2 candidates < 8) is **skipped** unless
forced or under one-sheet-for-all. Sprite/frame order is `localeCompare` (== the emitted manifest).
Packing is **reference-changing** — the game must load the sheet JSON, not the loose files — so
`FixReceipt.referencesChanged` is set and `fix.packWarn` fires. `allowRotation` is always false.

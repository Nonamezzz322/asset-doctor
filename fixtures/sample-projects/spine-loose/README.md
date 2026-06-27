# spine-loose

Loose **Spine region PNGs** + a **modern `skins`-ARRAY** skeleton (`skeleton.json`) for Feature 4
part B — packing a Spine animation's loose regions into page image(s) + a correct libGDX `.atlas`.
Each region's folder-relative stem **equals** the skeleton attachment's resolved `path` (incl. the
nested `items/sword`).

### Verifier matrix (mirrors `packages/fix/test/spine-verify.ts` `modern`)
- `head` — region, no path override → region `head`.
- `sword` — region **with a `path` override** `items/sword` (attachment name ≠ region) → `items/sword`.
- `shield` — one region **shared across two slots** (`shieldA`, `shieldB`) — legitimate, **never** a collision.
- `cape` — a **mesh** attachment → needs region `cape`.
- `capeLink` — a **linkedmesh** (parent `cape`) → inherits region `cape` (no path of its own).
- `mask` — a **clipping** attachment → needs **no** region; **ignored**.

### Intended outcome (`expected.json` is the authored golden)
The folder holding the skeleton is the **spine root**; all loose regions pack into **one** `.atlas`
(`verified = 6`, no unmatched). `cape.png` carries an **asymmetric transparent margin** so the
**bottom-left** Spine `offset` (the only Y-flip, in `trim.ts`) is exercised — the emitter writes it
verbatim and a re-parse recovers it. Spine sheets default to **PNG**; `allowRotation` is always false;
the skeleton `.json` is **passed through untouched**. Reference-changing (`fix.packWarn`).

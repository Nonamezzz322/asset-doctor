# Render-probe spike — GO / NO-GO

_Decided 2026-06-25 (Milestone 1). Status: **GO (conditional)** — approach verified; one
browser run remains to confirm the live read._

## Question

Can we load an atlas into offscreen PixiJS v8 (WebGL) and **reliably** read:

1. **Draw calls** — via a GL-context wrapper (`drawElements` / `drawArrays`)?
2. **VRAM** — Σ over live base textures of `w × h × 4`?

If both read cleanly, the differentiator static analyzers cannot replicate is real → **GO**.

## Method

Split into two pieces so the hard, device-independent part is verifiable without a browser:

1. **GL instrument** ([`packages/probe/src/gl-instrument.ts`](../packages/probe/src/gl-instrument.ts))
   — Spector.js-style. Monkeypatches a GL context in place and counts `drawElements` /
   `drawArrays` / `texImage2D` / `useProgram` / `compileShader` / `linkProgram`, and tracks
   live textures (sizes captured from both `texImage2D` overloads) for a VRAM estimate
   (`Σ w×h×4`, +33% when `generateMipmap` is seen). All accounting is pure.
2. **Pixi probe** ([`packages/probe/src/probe.ts`](../packages/probe/src/probe.ts)) — inits an
   offscreen `Application` with `preference: 'webgl'`, grabs `renderer.gl`, instruments it,
   builds a `Sprite` per frame, renders once, reads the stats.

## Findings

**Verified headless (no browser):**
- The instrument's accounting is correct — unit-tested in
  [`packages/probe/test/instrument.test.ts`](../packages/probe/test/instrument.test.ts)
  against a mock GL context: draw-call counts, both `texImage2D` forms (explicit `w/h` and
  DOM-source), VRAM `Σ w×h×4`, mipmap +33%, texture create/delete lifecycle, and reset/restore.
- These are **structural / GPU-workload** metrics → device-independent. Valid from headless
  or a browser extension. (Timing metrics — FPS, frame time — are deliberately NOT read here;
  they are only trustworthy on the real target device and must never be sold as "what the
  player sees".)
- The Pixi v8 probe **typechecks against the real Pixi API and builds**.

**Pending (needs one browser run):**
- The live numbers from an actual Pixi render — draw calls produced for N sprites and the VRAM
  of the live texture set — have not yet been read in a real WebGL context (this sandbox has no
  GPU/WebGL). Risk is low: the instrument is proven and the Pixi API typechecks; what remains is
  confirming `renderer.gl` is exposed as assumed and that uploads/draws route through the
  instance methods we patch.

## Decision

**GO (conditional).** The moat's core — trustworthy, device-independent measurement of draw
calls and VRAM — is real and its accounting is proven. We proceed to build on it. One browser
confirmation closes the remaining risk; a false GO is avoided because the unverified part is
explicitly fenced off, not assumed.

## To confirm the live read

In a browser (e.g. a temporary route in `apps/web`, or the planned extension):

```ts
import { probeAtlas } from '@asset-doctor/probe';
const bmp = await createImageBitmap(atlasBlob);
const reading = await probeAtlas(bmp, frames); // frames = atlas.sprites.map(s => s.frame)
console.log(reading); // { drawCalls, vramBytes, liveTextures, textureUploads, shaderCompiles }
```

Expected: `drawCalls` small (sprites sharing one base texture should batch); `vramBytes`
≈ atlas `w×h×4`. Record the actual numbers here and flip status to **GO (confirmed)**.

# Render-probe spike — GO / NO-GO

_Decided 2026-06-25 (Milestone 1). Status: **GO (confirmed)** — verified live in a real
(headless, SwiftShader) WebGL context._

## Question

Can we load an atlas into offscreen PixiJS v8 (WebGL) and **reliably** read:

1. **Draw calls** — via a GL-context wrapper (`drawElements` / `drawArrays`)?
2. **VRAM** — Σ over live base textures of `w × h × 4`?

If both read cleanly, the differentiator static analyzers cannot replicate is real → **GO**.

## Method

Split so the device-independent core is verifiable both headless-as-unit and live-in-browser:

1. **GL instrument** ([`packages/probe/src/gl-instrument.ts`](../packages/probe/src/gl-instrument.ts))
   — Spector.js-style. Monkeypatches a GL context in place and counts `drawElements` /
   `drawArrays` / `texImage2D` / `useProgram` / `compileShader` / `linkProgram`, and tracks
   live textures (sizes from both `texImage2D` overloads) for VRAM (`Σ w×h×4`, +33% with
   `generateMipmap`). Unit-tested against a mock GL context.
2. **Pixi probe** ([`packages/probe/src/probe.ts`](../packages/probe/src/probe.ts)) — inits an
   offscreen `Application` (`preference: 'webgl'`), instruments `renderer.gl`, draws a `Sprite`
   per frame, renders once, reads the stats.
3. **Live harness** ([`apps/web/probe.html`](../apps/web/probe.html) +
   [`src/probe-harness.ts`](../apps/web/src/probe-harness.ts)) driven headless by
   [`tools/verify/probe-run.mjs`](../tools/verify/probe-run.mjs).

## Findings

**Confirmed live** — system Chromium 149 headless, renderer `ANGLE (… SwiftShader …)`, WebGL2,
PixiJS v8, atlas = the tp-hash-symbols layout (512×512, 5 frames sharing one base texture):

```json
{ "drawCalls": 1, "vramBytes": 1048576, "liveTextures": 1, "textureUploads": 1, "shaderCompiles": 2 }
```

- **`drawCalls: 1`** — 5 sprites sharing one base texture batch into a single draw call.
  The instrument reads it cleanly from the live `drawElements` calls.
- **`vramBytes: 1048576` = 512×512×4** — exactly one RGBA8888 base texture. This is the
  product thesis made literal: 5 sprites cost **one** 1 MB texture, independent of sprite
  count and of the PNG's on-disk size (1.7 KB here). Disk weight ≠ GPU footprint.
- `textureUploads: 1`, `shaderCompiles: 2` (Pixi's batch vertex+fragment program).

These are **structural / GPU-workload** metrics → device-independent (valid headless or from a
browser extension). Timing metrics (FPS, frame time) are deliberately NOT read here — on a
software (SwiftShader) renderer they would be meaningless, and even on real hardware they are
only trustworthy on the target device. We never sell them as "what the player sees".

**Also verified headless (no browser):** the instrument's accounting — draw-call counts, both
`texImage2D` forms, VRAM `Σ w×h×4`, mipmap +33%, texture lifecycle, reset/restore — in
[`packages/probe/test/instrument.test.ts`](../packages/probe/test/instrument.test.ts).

## Decision

**GO (confirmed).** The moat's core — trustworthy, device-independent measurement of draw calls
and VRAM from a real render — works and reads cleanly. Build on it: the structural runtime
profiler (extension / SDK) and the correlation layer that stitches static findings to live
GPU-workload numbers.

## Reproduce

```bash
pnpm dev &  # serves /probe.html
CHROME=/snap/chromium/current/usr/lib/chromium-browser/chrome \
  node tools/verify/probe-run.mjs
# → PROBE_RESULT {"probe":{"drawCalls":1,"vramBytes":1048576,...}}
```

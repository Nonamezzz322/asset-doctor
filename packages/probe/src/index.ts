// @asset-doctor/probe — render-probe. Loads an asset into offscreen PixiJS v8 (WebGL) and
// measures its ACTUAL footprint via a GL-context wrapper: draw calls + VRAM
// (Σ baseTexture w×h×4). The go/no-go spike writes docs/render-probe-decision.md.

import type { Size } from '@asset-doctor/core';

export interface ProbeResult {
  drawCalls: number;
  /** Σ w×h×4 over live base textures. Device-independent (structural) metric. */
  vramBytes: number;
  textures: Size[];
}

// The POC lands during the render-probe spike (see the probe-engineer agent).

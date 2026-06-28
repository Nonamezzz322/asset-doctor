// Spector.js-style WebGL instrument. Monkeypatches a GL context in place to count draw calls,
// texture binds/uploads, shader compiles and program binds (incl. REDUNDANT binds — re-binding the
// already-bound texture/program, a classic wasted state change), and to track live textures for a
// VRAM estimate (Σ w×h×4, +33% with mipmaps). These are STRUCTURAL / GPU-workload metrics —
// device-independent, valid from headless, the runtime profiler, or an extension. The accounting is
// pure and unit-tested against a mock GL context; no real WebGL is required to verify correctness.

import { MIP_OVERHEAD } from '@asset-doctor/core';

export interface GlStats {
  drawCalls: number;
  drawElementsCalls: number;
  drawArraysCalls: number;
  textureBinds: number;
  /** bindTexture calls that re-bind the already-bound texture for that target (wasted). */
  redundantTexBinds: number;
  textureUploads: number;
  shaderCompiles: number;
  programLinks: number;
  programBinds: number;
  /** useProgram calls that re-select the already-active program (wasted). */
  redundantProgBinds: number;
  liveTextures: number;
  /** Σ w×h×4 over live base textures (+33% where mipmaps were generated). */
  vramBytes: number;
  /** Σ compressedTexImage2D/compressedTexSubImage2D data byteLengths over live textures — the REAL resident
   *  compressed (block-compression) footprint incl. all baked mip levels (each its own call, so the sum IS
   *  the exact residency). 0 unless a compressed upload was observed. DEVICE-MEASURED (the GPU's chosen
   *  transcode target), NEVER w·h·4 and NEVER charged a synthetic MIP_OVERHEAD (the mips are real, already
   *  summed). A compressed texture contributes THIS (not w·h·4) to `vramBytes`. */
  compressedBytes: number;
}

export interface InstrumentHandle {
  /** Snapshot: per-frame call counters (since last reset) + live VRAM / texture count. */
  stats(): GlStats;
  /** Zero the per-frame call counters (draws, binds, uploads, programs). Keeps texture + binding state. */
  reset(): void;
  /** Restore the original GL methods. */
  restore(): void;
}

type Fn = (...args: unknown[]) => unknown;
type GlLike = WebGLRenderingContext | WebGL2RenderingContext;

interface TexRecord {
  w: number;
  h: number;
  mip: boolean;
  /** Σ compressed-upload data byteLengths charged to this texture (all mip levels). 0 for raster. When
   *  >0 the texture contributes THIS to VRAM (measured residency), NOT w·h·4 — see `vram()`. */
  compressed: number;
}

/** Real resident byte length of a compressed upload's data argument. PURE — a deterministic arg reader,
 *  headless-verifiable independent of GL (mirrors `recordTexImage`). The data arg is an ArrayBufferView
 *  whose `.byteLength` IS the resident size of that mip level; the PBO form passes the size as a number.
 *    compressedTexImage2D(target, level, internalformat, w, h, border, data)           ⇒ view at index 6
 *    compressedTexImage2D(target, level, internalformat, w, h, border, imageSize, off) ⇒ number at index 6 (PBO)
 *    compressedTexSubImage2D(target, level, x, y, w, h, format, data)                  ⇒ view at index 7
 *    compressedTexSubImage2D(target, level, x, y, w, h, format, imageSize, off)        ⇒ number at index 7 (PBO)
 *  Returns the view's byteLength (or the explicit imageSize for the PBO form), else 0. */
export function compressedDataByteLength(name: string, a: unknown[]): number {
  const idx = name === 'compressedTexSubImage2D' ? 7 : 6;
  const data = a[idx];
  if (typeof data === 'number') return data >= 0 ? data : 0; // PBO form: explicit imageSize
  const view = data as { byteLength?: unknown } | null | undefined;
  if (view && typeof view.byteLength === 'number') return view.byteLength;
  return 0;
}

export function instrument(gl: GlLike): InstrumentHandle {
  const target = gl as unknown as Record<string, unknown>;
  const originals = new Map<string, Fn>();

  const counters = {
    drawElementsCalls: 0,
    drawArraysCalls: 0,
    textureBinds: 0,
    redundantTexBinds: 0,
    textureUploads: 0,
    shaderCompiles: 0,
    programLinks: 0,
    programBinds: 0,
    redundantProgBinds: 0,
  };
  const textures = new Map<unknown, TexRecord>();
  const boundByTarget = new Map<unknown, unknown>(); // GL state: persists across frames (not reset)
  let currentProgram: unknown;
  let bound: unknown = null;

  const patch = (name: string, make: (orig: Fn) => Fn): void => {
    const orig = target[name];
    if (typeof orig !== 'function') return;
    const origFn = orig as Fn;
    originals.set(name, origFn);
    const bound2 = ((...args: unknown[]) => origFn.apply(gl, args)) as Fn;
    target[name] = make(bound2);
  };

  patch('drawElements', (orig) => (...a) => ((counters.drawElementsCalls++), orig(...a)));
  patch('drawArrays', (orig) => (...a) => ((counters.drawArraysCalls++), orig(...a)));
  patch('drawElementsInstanced', (orig) => (...a) => ((counters.drawElementsCalls++), orig(...a)));
  patch('drawArraysInstanced', (orig) => (...a) => ((counters.drawArraysCalls++), orig(...a)));
  patch('compileShader', (orig) => (...a) => ((counters.shaderCompiles++), orig(...a)));
  patch('linkProgram', (orig) => (...a) => ((counters.programLinks++), orig(...a)));
  patch('texSubImage2D', (orig) => (...a) => ((counters.textureUploads++), orig(...a)));

  patch('useProgram', (orig) => (...a) => {
    counters.programBinds++;
    if (currentProgram === a[0]) counters.redundantProgBinds++;
    else currentProgram = a[0];
    return orig(...a);
  });

  patch('createTexture', (orig) => (...a) => {
    const tex = orig(...a);
    textures.set(tex, { w: 0, h: 0, mip: false, compressed: 0 });
    return tex;
  });
  patch('deleteTexture', (orig) => (...a) => {
    textures.delete(a[0]);
    return orig(...a);
  });
  patch('bindTexture', (orig) => (...a) => {
    counters.textureBinds++;
    const tgt = a[0];
    const tex = a[1] ?? null;
    if (boundByTarget.get(tgt) === tex) counters.redundantTexBinds++;
    else boundByTarget.set(tgt, tex);
    bound = tex;
    return orig(...a);
  });
  patch('texImage2D', (orig) => (...a) => {
    counters.textureUploads++;
    recordTexImage(a);
    return orig(...a);
  });
  patch('compressedTexImage2D', (orig) => (...a) => {
    counters.textureUploads++;
    recordCompressed('compressedTexImage2D', a); // level-0 records w/h (like recordTexImage) + adds byteLength
    return orig(...a);
  });
  patch('compressedTexSubImage2D', (orig) => (...a) => {
    counters.textureUploads++;
    recordCompressed('compressedTexSubImage2D', a); // adds byteLength; does NOT reset w/h (a sub-upload)
    return orig(...a);
  });
  patch('generateMipmap', (orig) => (...a) => {
    const t = textures.get(bound);
    if (t) t.mip = true;
    return orig(...a);
  });

  function recordTexImage(a: unknown[]): void {
    if ((typeof a[1] === 'number' ? a[1] : 0) !== 0) return; // base level defines footprint
    let w = 0;
    let h = 0;
    if (a.length >= 9 && typeof a[3] === 'number' && typeof a[4] === 'number') {
      w = a[3];
      h = a[4]; // texImage2D(target, level, internalformat, w, h, border, format, type, pixels)
    } else {
      const src = a[a.length - 1] as { width?: unknown; height?: unknown } | null;
      if (src && typeof src.width === 'number' && typeof src.height === 'number') {
        w = src.width;
        h = src.height; // texImage2D(target, level, internalformat, format, type, source)
      }
    }
    const t = textures.get(bound);
    if (t && w > 0 && h > 0) {
      t.w = w;
      t.h = h;
    }
  }

  function recordCompressed(name: string, a: unknown[]): void {
    const t = textures.get(bound);
    if (!t) return;
    // MEASURED residency: the data arg's real byteLength (each mip level is its own call ⇒ summed).
    t.compressed += compressedDataByteLength(name, a);
    // compressedTexImage2D level 0 defines the footprint (w/h). The sub variant never resets dims.
    if (
      name === 'compressedTexImage2D' &&
      (typeof a[1] === 'number' ? a[1] : 0) === 0 &&
      typeof a[3] === 'number' &&
      typeof a[4] === 'number' &&
      a[3] > 0 &&
      a[4] > 0
    ) {
      t.w = a[3];
      t.h = a[4]; // compressedTexImage2D(target, level, internalformat, w, h, border, ...)
    }
  }

  function vram(): number {
    let total = 0;
    for (const t of textures.values()) {
      // A texture that received a compressed upload contributes its MEASURED compressed total (real
      // resident bytes, all mips already summed) — NOT w·h·4 and NO synthetic MIP_OVERHEAD on it.
      if (t.compressed > 0) {
        total += t.compressed;
        continue;
      }
      // Raster: CONDITIONAL +33% chain charged only for textures we actually saw mipmapped — the same
      // factor (MIP_OVERHEAD, shared with static analysis) applied per measured generateMipmap call.
      if (t.w > 0 && t.h > 0) total += t.w * t.h * 4 * (t.mip ? MIP_OVERHEAD : 1);
    }
    return Math.round(total);
  }

  function compressedTotal(): number {
    let total = 0;
    for (const t of textures.values()) total += t.compressed;
    return total;
  }

  return {
    stats: () => ({
      drawCalls: counters.drawElementsCalls + counters.drawArraysCalls,
      drawElementsCalls: counters.drawElementsCalls,
      drawArraysCalls: counters.drawArraysCalls,
      textureBinds: counters.textureBinds,
      redundantTexBinds: counters.redundantTexBinds,
      textureUploads: counters.textureUploads,
      shaderCompiles: counters.shaderCompiles,
      programLinks: counters.programLinks,
      programBinds: counters.programBinds,
      redundantProgBinds: counters.redundantProgBinds,
      liveTextures: textures.size,
      vramBytes: vram(),
      compressedBytes: compressedTotal(),
    }),
    reset: () => {
      counters.drawElementsCalls = 0;
      counters.drawArraysCalls = 0;
      counters.textureBinds = 0;
      counters.redundantTexBinds = 0;
      counters.textureUploads = 0;
      counters.shaderCompiles = 0;
      counters.programLinks = 0;
      counters.programBinds = 0;
      counters.redundantProgBinds = 0;
    },
    restore: () => {
      for (const [name, orig] of originals) target[name] = orig;
      originals.clear();
    },
  };
}

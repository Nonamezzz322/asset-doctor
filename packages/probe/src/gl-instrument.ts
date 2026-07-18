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
  /** OBSERVED alpha-blend configuration of the running renderer (P8 — the V3-reopen precondition for a
   *  premultiplied-alpha × runtime correlation). Blend state is set PER-DRAW and can vary across passes,
   *  so we record what was EVER seen, never a single "mode" (mixed ⇒ both true):
   *   • `blendPremultiplied` — a premultiplied-style blend was observed: srcRGB factor === ONE (the
   *     shader expects pre-multiplied texture colour);
   *   • `blendStraight` — a straight-alpha blend was observed: srcRGB factor === SRC_ALPHA (expects
   *     un-premultiplied colour, multiplied by alpha at blend time);
   *   • `unpackPremultiply` — pixelStorei(UNPACK_PREMULTIPLY_ALPHA_WEBGL, true) was ever set (WebGL
   *     premultiplies texture RGB by alpha at UPLOAD).
   *  These are MEASURED facts of the app's own GL calls (no interpretation here); the honest premultiplied
   *  verdict that consumes them lives above and is intentionally cautious about the intricate interaction. */
  blendPremultiplied: boolean;
  blendStraight: boolean;
  unpackPremultiply: boolean;
}

// WebGL blend-factor + pixelStore enum values (stable across contexts; hard-coded so the instrument needs
// no live GL to read them). ONE=1, SRC_ALPHA=0x0302, UNPACK_PREMULTIPLY_ALPHA_WEBGL=0x9241, TRUE flags are
// truthy. blendFunc's FIRST arg (srcRGB) is the premultiply-discriminating factor.
const GL_ONE = 1;
const GL_SRC_ALPHA = 0x0302;
const GL_UNPACK_PREMULTIPLY_ALPHA_WEBGL = 0x9241;

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
  /** Compressed-upload resident bytes PER LEVEL (level → byteLength). A `compressedTexImage2D(level)`
   *  DEFINES / reallocates that level, so it REPLACES the level's byte total (a re-upload of the same
   *  texture must not stack — mirrors raster `texImage2D` overwriting w/h); a level-0 (re)definition
   *  starts a fresh mip chain (clear). `compressedTexSubImage2D` rewrites bytes already resident ⇒ NO
   *  new residency (like raster `texSubImage2D`). Σ over levels = the real compressed footprint (all mips
   *  summed once). Empty for raster; when non-empty the texture contributes that Σ to VRAM, NOT w·h·4. */
  compressed: Map<number, number>;
}

/** Σ of a texture's per-level compressed residency (0 for a raster texture — an empty map). */
function compressedOf(t: TexRecord): number {
  let s = 0;
  for (const v of t.compressed.values()) s += v;
  return s;
}

/** Real resident byte length of a compressed upload's data argument. PURE — a deterministic arg reader,
 *  headless-verifiable independent of GL (mirrors `recordTexImage`). The data arg is an ArrayBufferView
 *  whose `.byteLength` IS the resident size of that mip level; the PBO form passes the size as a number.
 *  WebGL2 adds a 9/10-arg view form with `srcOffset` (+ optional `srcLengthOverride`) — when the override is
 *  present (>0) it is the EXACT uploaded byte count; otherwise the upload is `byteLength − srcOffset`.
 *    WebGL1 view form:
 *      compressedTexImage2D(target, level, internalformat, w, h, border, data)                          ⇒ view @6
 *      compressedTexSubImage2D(target, level, x, y, w, h, format, data)                                 ⇒ view @7
 *    WebGL2 PBO form (data passed as a number = imageSize):
 *      compressedTexImage2D(target, level, internalformat, w, h, border, imageSize, offset)             ⇒ num  @6
 *      compressedTexSubImage2D(target, level, x, y, w, h, format, imageSize, offset)                    ⇒ num  @7
 *    WebGL2 view form with srcOffset (+ optional srcLengthOverride):
 *      compressedTexImage2D(target, level, internalformat, w, h, border, srcData, srcOffset, srcLenOverride)   ⇒ view @6, off @7, len @8
 *      compressedTexSubImage2D(target, level, x, y, w, h, format, srcData, srcOffset, srcLenOverride)          ⇒ view @7, off @8, len @9
 *  Returns the EXACT uploaded byte count (override when present, else view.byteLength − srcOffset, clamped
 *  to the view), or the explicit imageSize for the PBO form, else 0. */
export function compressedDataByteLength(name: string, a: unknown[]): number {
  const idx = name === 'compressedTexSubImage2D' ? 7 : 6;
  const data = a[idx];
  if (typeof data === 'number') return data >= 0 ? data : 0; // PBO form: explicit imageSize
  const view = data as { byteLength?: unknown } | null | undefined;
  if (!view || typeof view.byteLength !== 'number' || view.byteLength < 0) return 0;
  const byteLength = view.byteLength;
  // WebGL2 view form: srcOffset @idx+1, optional srcLengthOverride @idx+2. The override (when >0) is the
  // EXACT uploaded byte count and takes precedence; element units are 1 for the BYTE views the codecs hand
  // to compressed uploads (Uint8Array), so no BYTES_PER_ELEMENT scaling is applied.
  const lenOverride = a[idx + 2];
  if (typeof lenOverride === 'number' && lenOverride > 0) return Math.min(lenOverride, byteLength);
  const srcOffset = a[idx + 1];
  if (typeof srcOffset === 'number' && srcOffset > 0) return Math.max(0, byteLength - srcOffset);
  return byteLength;
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
  // Unique sentinel so the FIRST useProgram (with any real program / null / even undefined) is never
  // mis-counted as a redundant re-bind — `undefined === undefined` would otherwise flag useProgram(undefined).
  const NO_PROGRAM = Symbol('gl-no-program');
  let currentProgram: unknown = NO_PROGRAM;
  let bound: unknown = null;
  // Observed blend config (P8). Session-sticky (never reset per-frame — it is a config fact, not a
  // per-frame counter): once a mode is seen it stays recorded.
  const blend = { premultiplied: false, straight: false, unpackPremultiply: false };
  const recordBlendSrc = (srcRGB: unknown): void => {
    if (srcRGB === GL_ONE) blend.premultiplied = true;
    else if (srcRGB === GL_SRC_ALPHA) blend.straight = true;
  };

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
    textures.set(tex, { w: 0, h: 0, mip: false, compressed: new Map() });
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

  // Blend config capture (P8). blendFunc(srcRGB, dstRGB) + blendFuncSeparate(srcRGB, dstRGB, srcA, dstA):
  // the FIRST arg (srcRGB) discriminates premultiplied (ONE) vs straight (SRC_ALPHA). pixelStorei records
  // the upload-premultiply flag. Pure observation — the real call always runs.
  patch('blendFunc', (orig) => (...a) => (recordBlendSrc(a[0]), orig(...a)));
  patch('blendFuncSeparate', (orig) => (...a) => (recordBlendSrc(a[0]), orig(...a)));
  patch('pixelStorei', (orig) => (...a) => {
    if (a[0] === GL_UNPACK_PREMULTIPLY_ALPHA_WEBGL && a[1]) blend.unpackPremultiply = true;
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
    // A sub-image REWRITES bytes already resident (the level was allocated by its defining
    // compressedTexImage2D) ⇒ adds NO new residency (mirrors raster texSubImage2D, which adds 0 VRAM).
    // Streaming N sub-updates to the same region must not inflate the footprint N×.
    if (name === 'compressedTexSubImage2D') return;
    // compressedTexImage2D DEFINES (reallocates) this mip level ⇒ REPLACE the level's byte total, so a
    // re-upload of the same texture replaces rather than stacks. A level-0 (re)definition begins a fresh
    // mip chain, so clear the prior chain first; Σ over the surviving levels = the real residency.
    const level = typeof a[1] === 'number' ? a[1] : 0;
    if (level === 0) t.compressed.clear();
    t.compressed.set(level, compressedDataByteLength(name, a));
    // Level 0 defines the footprint (w/h).
    if (level === 0 && typeof a[3] === 'number' && typeof a[4] === 'number' && a[3] > 0 && a[4] > 0) {
      t.w = a[3];
      t.h = a[4]; // compressedTexImage2D(target, level, internalformat, w, h, border, ...)
    }
  }

  function vram(): number {
    let total = 0;
    for (const t of textures.values()) {
      // A texture that received a compressed upload contributes its MEASURED compressed total (real
      // resident bytes, all mips already summed once) — NOT w·h·4 and NO synthetic MIP_OVERHEAD on it.
      const c = compressedOf(t);
      if (c > 0) {
        total += c;
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
    for (const t of textures.values()) total += compressedOf(t);
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
      blendPremultiplied: blend.premultiplied,
      blendStraight: blend.straight,
      unpackPremultiply: blend.unpackPremultiply,
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

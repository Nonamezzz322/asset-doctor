// Spector.js-style WebGL instrument. Monkeypatches a GL context in place to count draw calls,
// texture uploads, shader compiles and program binds, and to track live textures for a VRAM
// estimate (Σ w×h×4, +33% with mipmaps). These are STRUCTURAL / GPU-workload metrics —
// device-independent, valid from headless or an extension. The accounting here is pure and
// is unit-tested against a mock GL context; no real WebGL is required to verify correctness.

export interface GlStats {
  drawCalls: number;
  drawElementsCalls: number;
  drawArraysCalls: number;
  textureUploads: number;
  shaderCompiles: number;
  programLinks: number;
  programBinds: number;
  liveTextures: number;
  /** Σ w×h×4 over live base textures (+33% where mipmaps were generated). */
  vramBytes: number;
}

export interface InstrumentHandle {
  /** Snapshot: per-frame call counters (since last reset) + live VRAM / texture count. */
  stats(): GlStats;
  /** Zero the per-frame call counters (draws, uploads, programs). Keeps texture tracking. */
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
}

export function instrument(gl: GlLike): InstrumentHandle {
  const target = gl as unknown as Record<string, unknown>;
  const originals = new Map<string, Fn>();

  const counters = {
    drawElementsCalls: 0,
    drawArraysCalls: 0,
    textureUploads: 0,
    shaderCompiles: 0,
    programLinks: 0,
    programBinds: 0,
  };
  const textures = new Map<unknown, TexRecord>();
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
  patch('useProgram', (orig) => (...a) => ((counters.programBinds++), orig(...a)));
  patch('compileShader', (orig) => (...a) => ((counters.shaderCompiles++), orig(...a)));
  patch('linkProgram', (orig) => (...a) => ((counters.programLinks++), orig(...a)));
  patch('texSubImage2D', (orig) => (...a) => ((counters.textureUploads++), orig(...a)));

  patch('createTexture', (orig) => (...a) => {
    const tex = orig(...a);
    textures.set(tex, { w: 0, h: 0, mip: false });
    return tex;
  });
  patch('deleteTexture', (orig) => (...a) => {
    textures.delete(a[0]);
    return orig(...a);
  });
  patch('bindTexture', (orig) => (...a) => {
    bound = a[1] ?? null;
    return orig(...a);
  });
  patch('texImage2D', (orig) => (...a) => {
    counters.textureUploads++;
    recordTexImage(a);
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

  function vram(): number {
    let total = 0;
    for (const t of textures.values()) {
      if (t.w > 0 && t.h > 0) total += t.w * t.h * 4 * (t.mip ? 4 / 3 : 1);
    }
    return Math.round(total);
  }

  return {
    stats: () => ({
      drawCalls: counters.drawElementsCalls + counters.drawArraysCalls,
      drawElementsCalls: counters.drawElementsCalls,
      drawArraysCalls: counters.drawArraysCalls,
      textureUploads: counters.textureUploads,
      shaderCompiles: counters.shaderCompiles,
      programLinks: counters.programLinks,
      programBinds: counters.programBinds,
      liveTextures: textures.size,
      vramBytes: vram(),
    }),
    reset: () => {
      counters.drawElementsCalls = 0;
      counters.drawArraysCalls = 0;
      counters.textureUploads = 0;
      counters.shaderCompiles = 0;
      counters.programLinks = 0;
      counters.programBinds = 0;
    },
    restore: () => {
      for (const [name, orig] of originals) target[name] = orig;
      originals.clear();
    },
  };
}

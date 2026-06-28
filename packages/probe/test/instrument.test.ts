import { describe, it, expect } from 'vitest';
import { instrument, compressedDataByteLength } from '../src/gl-instrument';

// Minimal mock GL context: just the methods the instrument patches. No real WebGL needed —
// this proves the accounting (counters + VRAM) is correct, which is the device-independent core.
function fakeGl() {
  let id = 0;
  return {
    TEXTURE_2D: 0x0de1,
    createTexture: () => ({ id: ++id }),
    deleteTexture: () => {},
    bindTexture: () => {},
    texImage2D: () => {},
    texSubImage2D: () => {},
    compressedTexImage2D: () => {},
    compressedTexSubImage2D: () => {},
    generateMipmap: () => {},
    drawElements: () => {},
    drawArrays: () => {},
    useProgram: () => {},
    compileShader: () => {},
    linkProgram: () => {},
  };
}

describe('GL instrument', () => {
  it('counts draws / uploads / programs and tracks VRAM (both texImage2D forms)', () => {
    const gl = fakeGl();
    const probe = instrument(gl as unknown as WebGL2RenderingContext);

    const a = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, a);
    gl.texImage2D(gl.TEXTURE_2D, 0, 0x1908, 512, 512, 0, 0x1908, 0x1401, null); // 9-arg form

    const b = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, b);
    gl.texImage2D(gl.TEXTURE_2D, 0, 0x1908, 0x1908, 0x1401, { width: 256, height: 128 }); // source form

    gl.useProgram({});
    gl.compileShader({});
    gl.compileShader({});
    gl.drawElements(4, 6, 0x1403, 0);
    gl.drawArrays(4, 0, 3);

    const s = probe.stats();
    expect(s.drawCalls).toBe(2);
    expect(s.drawElementsCalls).toBe(1);
    expect(s.drawArraysCalls).toBe(1);
    expect(s.textureUploads).toBe(2);
    expect(s.programBinds).toBe(1);
    expect(s.shaderCompiles).toBe(2);
    expect(s.liveTextures).toBe(2);
    expect(s.vramBytes).toBe(512 * 512 * 4 + 256 * 128 * 4); // 1,179,648
  });

  it('adds mipmap overhead, frees deleted textures, and reset() clears counters', () => {
    const gl = fakeGl();
    const probe = instrument(gl as unknown as WebGL2RenderingContext);

    const a = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, a);
    gl.texImage2D(gl.TEXTURE_2D, 0, 0x1908, 300, 300, 0, 0x1908, 0x1401, null);
    gl.generateMipmap(gl.TEXTURE_2D);
    expect(probe.stats().vramBytes).toBe(Math.round(300 * 300 * 4 * (4 / 3)));

    gl.deleteTexture(a);
    expect(probe.stats().liveTextures).toBe(0);
    expect(probe.stats().vramBytes).toBe(0);

    gl.drawArrays(4, 0, 3);
    expect(probe.stats().drawCalls).toBe(1);
    probe.reset();
    expect(probe.stats().drawCalls).toBe(0);
  });

  it('counts redundant texture and program binds (wasted state changes)', () => {
    const gl = fakeGl();
    const probe = instrument(gl as unknown as WebGL2RenderingContext);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.bindTexture(gl.TEXTURE_2D, tex); // redundant — already bound
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture()); // a real change

    const prog = { id: 'p' };
    gl.useProgram(prog);
    gl.useProgram(prog); // redundant — already active
    gl.useProgram({ id: 'q' }); // a real change

    const s = probe.stats();
    expect(s.textureBinds).toBe(3);
    expect(s.redundantTexBinds).toBe(1);
    expect(s.programBinds).toBe(3);
    expect(s.redundantProgBinds).toBe(1);
  });

  it('restore() unpatches the context', () => {
    const gl = fakeGl();
    const probe = instrument(gl as unknown as WebGL2RenderingContext);
    probe.restore();
    gl.drawArrays(4, 0, 3);
    expect(probe.stats().drawCalls).toBe(0);
  });

  // ── Compressed (block-compression / KTX2) residency: MEASURED byteLength, not w·h·4 ──────────────
  const COMPRESSED_RGBA_S3TC_DXT5 = 0x83f3; // an arbitrary internalformat — accounting is format-agnostic

  it('charges a compressed texture its MEASURED data byteLength (incl. baked mips), not w·h·4', () => {
    const gl = fakeGl();
    const probe = instrument(gl as unknown as WebGL2RenderingContext);

    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    // level 0 (256×256) + 3 shrinking mip levels, each its own compressedTexImage2D call (real KTX2 shape).
    const lvl0 = 65536;
    const lvl1 = 16384;
    const lvl2 = 4096;
    const lvl3 = 1024;
    gl.compressedTexImage2D(gl.TEXTURE_2D, 0, COMPRESSED_RGBA_S3TC_DXT5, 256, 256, 0, new Uint8Array(lvl0));
    gl.compressedTexImage2D(gl.TEXTURE_2D, 1, COMPRESSED_RGBA_S3TC_DXT5, 128, 128, 0, new Uint8Array(lvl1));
    gl.compressedTexImage2D(gl.TEXTURE_2D, 2, COMPRESSED_RGBA_S3TC_DXT5, 64, 64, 0, new Uint8Array(lvl2));
    gl.compressedTexImage2D(gl.TEXTURE_2D, 3, COMPRESSED_RGBA_S3TC_DXT5, 32, 32, 0, new Uint8Array(lvl3));

    const sum = lvl0 + lvl1 + lvl2 + lvl3;
    const s = probe.stats();
    expect(s.compressedBytes).toBe(sum);
    // VRAM = the measured compressed total, NOT 256·256·4 (262144) and NOT ×MIP_OVERHEAD.
    expect(s.vramBytes).toBe(sum);
    expect(s.vramBytes).not.toBe(256 * 256 * 4);
    expect(s.textureUploads).toBe(4);
  });

  it('mixes a compressed and a raster texture in one context (each charged its own model)', () => {
    const gl = fakeGl();
    const probe = instrument(gl as unknown as WebGL2RenderingContext);

    const cx = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, cx);
    gl.compressedTexImage2D(gl.TEXTURE_2D, 0, COMPRESSED_RGBA_S3TC_DXT5, 128, 128, 0, new Uint8Array(8192));

    const rx = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, rx);
    gl.texImage2D(gl.TEXTURE_2D, 0, 0x1908, 64, 64, 0, 0x1908, 0x1401, null);

    const s = probe.stats();
    expect(s.compressedBytes).toBe(8192); // only the compressed tex
    expect(s.vramBytes).toBe(8192 + 64 * 64 * 4); // compressed measured + raster w·h·4
    expect(s.liveTextures).toBe(2);
  });

  it('PBO 8-arg compressedTexImage2D uses the explicit imageSize; sub-image adds without resetting dims', () => {
    const gl = fakeGl();
    const probe = instrument(gl as unknown as WebGL2RenderingContext);

    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    // PBO form: (target, level, internalformat, w, h, border, imageSize, offset) — no view, explicit size.
    gl.compressedTexImage2D(gl.TEXTURE_2D, 0, COMPRESSED_RGBA_S3TC_DXT5, 64, 64, 0, 2048, 0);
    expect(probe.stats().compressedBytes).toBe(2048);

    // compressedTexSubImage2D(target, level, x, y, w, h, format, data) — adds byteLength, no dim reset.
    gl.compressedTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 64, 64, COMPRESSED_RGBA_S3TC_DXT5, new Uint8Array(512));
    expect(probe.stats().compressedBytes).toBe(2048 + 512);
    expect(probe.stats().vramBytes).toBe(2048 + 512); // still measured-compressed, not w·h·4
  });

  it('reset() keeps compressedBytes (residency state); restore() unpatches the compressed methods', () => {
    const gl = fakeGl();
    const probe = instrument(gl as unknown as WebGL2RenderingContext);

    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.compressedTexImage2D(gl.TEXTURE_2D, 0, COMPRESSED_RGBA_S3TC_DXT5, 64, 64, 0, new Uint8Array(4096));
    expect(probe.stats().compressedBytes).toBe(4096);

    probe.reset(); // clears per-frame counters only — residency persists like w/h/mip
    expect(probe.stats().compressedBytes).toBe(4096);
    expect(probe.stats().vramBytes).toBe(4096);
    expect(probe.stats().textureUploads).toBe(0); // counter was reset

    probe.restore();
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.compressedTexImage2D(gl.TEXTURE_2D, 0, COMPRESSED_RGBA_S3TC_DXT5, 64, 64, 0, new Uint8Array(4096));
    expect(probe.stats().compressedBytes).toBe(4096); // unchanged — the patch is gone
  });

  it('compressedDataByteLength reads each arg shape (the pure extractor)', () => {
    // compressedTexImage2D view form: data at index 6.
    expect(
      compressedDataByteLength('compressedTexImage2D', [0, 0, 0, 64, 64, 0, new Uint8Array(4096)]),
    ).toBe(4096);
    // compressedTexImage2D PBO form: explicit imageSize number at index 6.
    expect(compressedDataByteLength('compressedTexImage2D', [0, 0, 0, 64, 64, 0, 2048, 0])).toBe(2048);
    // compressedTexSubImage2D view form: data at index 7.
    expect(
      compressedDataByteLength('compressedTexSubImage2D', [0, 0, 0, 0, 64, 64, 0, new Uint8Array(512)]),
    ).toBe(512);
    // compressedTexSubImage2D PBO form: imageSize number at index 7.
    expect(compressedDataByteLength('compressedTexSubImage2D', [0, 0, 0, 0, 64, 64, 0, 256, 0])).toBe(256);
    // A non-Uint8Array typed view still reports its byteLength.
    expect(
      compressedDataByteLength('compressedTexImage2D', [0, 0, 0, 4, 4, 0, new Float32Array(8)]),
    ).toBe(32);
    // Missing / null / non-numeric data ⇒ 0 (never throws).
    expect(compressedDataByteLength('compressedTexImage2D', [0, 0, 0, 64, 64, 0])).toBe(0);
    expect(compressedDataByteLength('compressedTexImage2D', [0, 0, 0, 64, 64, 0, null])).toBe(0);
  });
});

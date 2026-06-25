import { describe, it, expect } from 'vitest';
import { instrument } from '../src/gl-instrument';

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
});

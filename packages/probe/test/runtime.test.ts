import { describe, it, expect } from 'vitest';
import { buildReport, type FrameRec } from '../src/runtime';

// FrameRec factory: dt 16ms, `uploads` gameplay uploads on this frame (drives uploadsDuringGameplay).
const rec = (over: Partial<FrameRec> = {}): FrameRec => ({ dt: 16, draws: 1, binds: 0, redundant: 0, uploads: 0, compiles: 0, ...over });

describe('buildReport — warmup is anchored to session start, not the rolling window', () => {
  it('skips exactly `warmup` frames early in the session (window == whole session)', () => {
    // 5 warmup frames each with an upload (load-phase), then 3 gameplay frames each with an upload.
    const recs = [...Array(5)].map(() => rec({ uploads: 1 })).concat([...Array(3)].map(() => rec({ uploads: 1 })));
    const r = buildReport(recs, 5, [], 8); // totalFrames == recs.length ⇒ nothing shifted out
    expect(r.uploadsDuringGameplay).toBe(3); // only the 3 post-warmup gameplay uploads
  });

  it('does NOT re-skip gameplay frames once the warmup phase has scrolled out of the window', () => {
    // A long session: the load phase is long gone. The window holds 100 steady-state gameplay frames,
    // each issuing an upload. totalFrames is far past warmup, so the WHOLE window is gameplay.
    const recs = [...Array(100)].map(() => rec({ uploads: 1 }));
    const warmup = 30;
    const totalFrames = 5000; // shiftedOut = 5000 - 100 = 4900 >> warmup ⇒ effWarmup 0
    const r = buildReport(recs, warmup, [], totalFrames);
    expect(r.uploadsDuringGameplay).toBe(100); // NOT 70 — no phantom warmup skip on real gameplay
  });

  it('transition: only the warmup frames still present in the window are skipped', () => {
    // warmup 30, window holds 100 frames, but only 10 warmup frames have scrolled out so 20 remain at the
    // front of the window (shiftedOut = 10). effWarmup = 30 - 10 = 20 ⇒ skip 20, keep 80.
    const recs = [...Array(100)].map(() => rec({ uploads: 1 }));
    const r = buildReport(recs, 30, [], 110); // shiftedOut = 110 - 100 = 10
    expect(r.uploadsDuringGameplay).toBe(80);
  });

  it('frames==0 window is safe (no NaN, all zeros)', () => {
    const r = buildReport([], 30, [], 0);
    expect(r.frames).toBe(0);
    expect(r.uploadsDuringGameplay).toBe(0);
    expect(r.timing.fps).toBe(0);
    expect(Number.isNaN(r.drawCalls.avg)).toBe(false);
  });
});

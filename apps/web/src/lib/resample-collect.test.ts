// Unit test for the EXTRACTED resample gate predicate (round24). The worker can't run in Node, so the
// load-bearing control flow — the opt-in/consent gate AND the B1 hashFilenames interaction (gate OFF rather
// than an in-place tile replace that would break round9 content-hash names) — is exercised here directly.

import { describe, it, expect } from 'vitest';
import { resampleOn, resampleSkippedByHashFilenames, type ResampleGateOptions } from './resample-collect';

const liveBackend = {
  apiBase: 'https://api.example.test',
  token: 'tok-123',
  ops: ['resample'] as const,
  consent: true,
};

describe('resampleOn — the opt-in gate (mirrors ktx2/pngquant)', () => {
  it('is true with a configured + consented backend that opted resample in (hashFilenames off)', () => {
    expect(resampleOn({ backend: { ...liveBackend } })).toBe(true);
  });

  it('is false when no backend is configured (default path — byte-identical)', () => {
    expect(resampleOn({})).toBe(false);
  });

  it('is false without per-run consent', () => {
    expect(resampleOn({ backend: { ...liveBackend, consent: false } })).toBe(false);
  });

  it('is false when resample was not opted in (e.g. only ktx2/pngquant chosen)', () => {
    expect(resampleOn({ backend: { ...liveBackend, ops: ['ktx2', 'pngquant'] } })).toBe(false);
  });

  it('is false with an empty apiBase or token', () => {
    expect(resampleOn({ backend: { ...liveBackend, apiBase: '   ' } })).toBe(false);
    expect(resampleOn({ backend: { ...liveBackend, token: '' } })).toBe(false);
  });
});

describe('B1 — content-hash cache-busting interaction (gate OFF, never in-place under hashed names)', () => {
  it('is FALSE when hashFilenames is on, even with a fully live backend', () => {
    expect(resampleOn({ backend: { ...liveBackend }, hashFilenames: true })).toBe(false);
  });

  it('stays TRUE when hashFilenames is explicitly off / absent', () => {
    expect(resampleOn({ backend: { ...liveBackend }, hashFilenames: false })).toBe(true);
    expect(resampleOn({ backend: { ...liveBackend } })).toBe(true);
  });

  it('resampleSkippedByHashFilenames flags the honest-skip case (eligible BUT suppressed by hashFilenames)', () => {
    const opts: ResampleGateOptions = { backend: { ...liveBackend }, hashFilenames: true };
    expect(resampleSkippedByHashFilenames(opts)).toBe(true);
    // The worker surfaces a note ONLY in this case (eligible-but-suppressed) — never when resample wasn't
    // opted in (no false note) and never when hashFilenames is off (no suppression).
  });

  it('resampleSkippedByHashFilenames is FALSE when resample was never eligible (no false note)', () => {
    expect(resampleSkippedByHashFilenames({ hashFilenames: true })).toBe(false);
    expect(
      resampleSkippedByHashFilenames({ backend: { ...liveBackend, ops: ['ktx2'] }, hashFilenames: true }),
    ).toBe(false);
    expect(resampleSkippedByHashFilenames({ backend: { ...liveBackend, consent: false }, hashFilenames: true })).toBe(
      false,
    );
  });

  it('resampleSkippedByHashFilenames is FALSE when hashFilenames is off (no suppression to disclose)', () => {
    expect(resampleSkippedByHashFilenames({ backend: { ...liveBackend } })).toBe(false);
  });
});

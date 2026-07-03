// The scroll-reveal decision is the one branchable bit of the landing's motion story (apps/web has no
// React/CSS harness). Pin the honesty rule: ONLY (no-reduce AND IntersectionObserver present) attaches the
// hide-then-reveal path; reduced-motion always wins (never attached), and a missing IO degrades to
// visible-by-default — so no-JS / old-browser / reduce users always see everything.

import { describe, it, expect } from 'vitest';
import { revealMode } from './landing-reveal';

describe('revealMode — when to attach the scroll reveal', () => {
  it('only (no reduce, has IntersectionObserver) ⇒ observe', () => {
    expect(revealMode(false, true)).toBe('observe');
  });

  it('reduced-motion wins even when IntersectionObserver is present ⇒ static', () => {
    expect(revealMode(true, true)).toBe('static');
  });

  it('no IntersectionObserver ⇒ static (visible by default), regardless of reduce', () => {
    expect(revealMode(false, false)).toBe('static');
    expect(revealMode(true, false)).toBe('static');
  });

  it('is a pure function (repeat calls agree)', () => {
    for (const reduce of [true, false]) {
      for (const io of [true, false]) {
        expect(revealMode(reduce, io)).toBe(revealMode(reduce, io));
      }
    }
  });
});

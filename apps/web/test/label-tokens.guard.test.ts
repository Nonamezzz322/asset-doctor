// Drift-guard for the .ad-label / .ad-label-sm micro-label tokens (UX-5). Pure source-grep, no DOM/React
// harness — mirrors i18n-app-keys.test.ts / contrast.test.ts which also read app source. Locks the
// drift-ban invariant: once the 8–10px / 0.06–0.08em uppercase-mono label stacks were centralized into the
// two tokens, no migrated file may reintroduce a raw stack or a 9.5/8.5px micro-label size.
//
// HONEST MANUAL PIXEL-GATE (unavoidable — there is no pixel harness here): the byte-identity of the 21
// centralized sites is *reasoned* (identical computed font-family/size/letter-spacing/text-transform, no
// line-height introduced), NOT pixel-diffed by this test. Two behavioral deltas still need a one-time human
// visual check, which this test canNOT perform: (1) ReadCell/dt 9.5px→9px shrink; (2) the ReadCell
// break-words wrap. Gate: `pnpm --filter web build && typecheck` green, then load a probed atlas, switch
// locale to de (longest: "VRAM (DEKLARIERT)"), then it/es/pt/zh, and shrink to the lg breakpoint (~1024px)
// so the film column sits at its 320px min — confirm the declared cell WRAPS inside its cell with no clip
// and no overlap of DISK, value legible, and the honest "(declared)" qualifier stays fully visible
// (invariant 5 — no truncation of the declared-vs-measured qualifier).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)); // apps/web/
const read = (p: string) => readFileSync(root + p, 'utf8');

const css = read('src/index.css');
const SRC = [
  'src/App.tsx',
  'src/components/FilmViewer.tsx',
  'src/components/Findings.tsx',
  'src/components/SettingsPage.tsx',
];

describe('micro-label tokens', () => {
  it('defines both canonical tokens', () => {
    expect(css).toMatch(/\.ad-label\s*\{[^}]*font-size:\s*10px[^}]*letter-spacing:\s*0\.06em/s);
    expect(css).toMatch(/\.ad-label-sm\s*\{[^}]*font-size:\s*9px[^}]*letter-spacing:\s*0\.08em/s);
  });

  it('no 9.5px / 8.5px micro-label sizes survive anywhere in web src', () => {
    for (const f of [
      'src/components/FilmViewer.tsx',
      'src/App.tsx',
      'src/components/SettingsPage.tsx',
      'src/components/Findings.tsx',
    ]) {
      expect(read(f)).not.toMatch(/text-\[(?:9\.5|8\.5)px\]/);
    }
  });

  it('no raw uppercase-label utility stacks remain in the migrated files', () => {
    const banned = [
      /font-mono text-\[10px\] uppercase tracking-\[0\.06em\]/,
      /font-mono text-\[9px\] uppercase tracking-\[0\.08em\]/,
    ];
    for (const f of SRC) for (const re of banned) expect(read(f)).not.toMatch(re);
  });

  // STRONG, order- and tracking-value-INSENSITIVE guard (closes the completeness gap of the exact-stack
  // regexes above): a raw micro-label stack is ANY className co-locating a micro `text-[8..10px]` with BOTH
  // `uppercase` and a `tracking-[…]` — regardless of class order or the exact tracking value. This catches a
  // reintroduced `text-[9px] … tracking-[0.06em]` drift (the pre-migration off-stack) or a reordered
  // `text-[10px] font-mono uppercase tracking-[0.06em]`, which the exact-stack regexes miss. Scanned per line
  // (classNames are single-line in these files); all such stacks must go through .ad-label / .ad-label-sm.
  it('no raw micro-label stack (micro size + uppercase + tracking, any order/value) remains', () => {
    const microSize = /text-\[(?:8|8\.5|9|9\.5|10)px\]/;
    for (const f of SRC) {
      read(f).split('\n').forEach((line, i) => {
        if (microSize.test(line) && /\buppercase\b/.test(line) && /tracking-\[/.test(line)) {
          throw new Error(`raw micro-label stack must use .ad-label/.ad-label-sm — ${f}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  });
});

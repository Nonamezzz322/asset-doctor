import { describe, expect, it } from 'vitest';
import type { AnalysisReport, Finding } from '@asset-doctor/core';
import { fmtBytes } from '@asset-doctor/analysis';
import { toJSON } from '../src/index';
import {
  reportToJSON,
  reportToMarkdown,
  reportToCSV,
  reportToHTML,
  reportContent,
  reportFilename,
  sortFindings,
  escapeHtml,
  REPORT_MIME,
} from '../src/index';

// Minimal AnalysisReport literal — ONLY the fields the serializers read (cast to the real type). Totals
// use values chosen so no field collides with a would-be SUMMED savings figure (1000+2000=3000), so the
// invariant-5 "never summed" assertions can't false-pass on a coincidental match.
function makeReport(overrides: Partial<AnalysisReport> = {}): AnalysisReport {
  const totals = {
    diskBytes: 5_000_000,
    vramBytes: 64_000_000,
    vramBytesMipmapped: 85_000_000,
    loadedVramBytes: 32_000_000,
    loadedVramBytesMipmapped: 42_000_000,
    loadedTextures: 7,
    potentialDiskSaved: 900_000,
  };
  return {
    // assets in DELIBERATELY non-sorted order → toJSON must sort by assetRef.
    assets: [{ assetRef: 'z-atlas.png' }, { assetRef: 'a-atlas.png' }],
    findings: [],
    totals,
    thresholds: { occupancy: { warn: 0.5, crit: 0.3 } },
    ...overrides,
  } as unknown as AnalysisReport;
}

function finding(f: Partial<Finding>): Finding {
  return {
    id: f.id ?? `${f.assetRef ?? 'x'}:${f.rule ?? 'occupancy'}`,
    rule: f.rule ?? 'occupancy',
    severity: f.severity ?? 'info',
    assetRef: f.assetRef ?? 'x.png',
    title: f.title ?? 'Title',
    detail: f.detail ?? 'Detail',
    ...f,
  } as Finding;
}

describe('reportToJSON — budget serializer verbatim (zero drift)', () => {
  it('parses byte-for-byte to budget toJSON(report) with no gate', () => {
    const r = makeReport({ findings: [finding({ assetRef: 'a.png', rule: 'format' })] });
    const parsed = JSON.parse(reportToJSON(r));
    expect(parsed).toEqual(toJSON(r));
    expect(parsed.version).toBe(1);
    expect(parsed.totals).toBeDefined();
    expect(parsed.assets).toBeDefined();
    expect(parsed.findings).toBeDefined();
    expect(parsed.thresholds).toBeDefined();
    // no gate ⇒ no gate/capabilities keys leaked
    expect(parsed.gate).toBeUndefined();
    expect(parsed.capabilities).toBeUndefined();
  });

  it('is deterministic and sorts assets by assetRef (budget sortedAssets)', () => {
    const r = makeReport();
    expect(reportToJSON(r)).toBe(reportToJSON(makeReport()));
    const parsed = JSON.parse(reportToJSON(r));
    expect(parsed.assets.map((a: { assetRef: string }) => a.assetRef)).toEqual(['a-atlas.png', 'z-atlas.png']);
  });
});

describe('reportToMarkdown — header + honest totals', () => {
  it('includes the subject when given and omits it when absent', () => {
    expect(reportToMarkdown(makeReport(), { subject: 'My Game' })).toContain('# Asset Doctor — audit: My Game');
    const noSubject = reportToMarkdown(makeReport());
    expect(noSubject).toContain('# Asset Doctor — audit\n');
    expect(noSubject).not.toContain('audit:');
  });

  it('totals line carries disk AND VRAM(loaded) as SEPARATE fmtBytes tokens + the honest draw-call floor', () => {
    const r = makeReport();
    const md = reportToMarkdown(r);
    expect(md).toContain(`disk ${fmtBytes(r.totals.diskBytes)}`);
    expect(md).toContain(`VRAM(loaded) ${fmtBytes(r.totals.loadedVramBytes)}`);
    // honest floor is totals.loadedTextures (7), NOT assets.length (2)
    expect(md).toContain('draw-call floor ≥ 7');
    expect(md).not.toContain('draw-call floor ≥ 2');
  });

  it('falls back to assets.length for the draw-call floor when loadedTextures is absent', () => {
    const r = makeReport({ totals: { ...makeReport().totals, loadedTextures: undefined } as AnalysisReport['totals'] });
    expect(reportToMarkdown(r)).toContain('draw-call floor ≥ 2'); // assets.length
  });

  it('carries the disk≠VRAM note with {naive} → fmtBytes(vramBytes)', () => {
    const r = makeReport();
    const md = reportToMarkdown(r);
    expect(md).toContain('Disk bytes and VRAM (w×h×4) are separate quantities — never summed.');
    expect(md).toContain(`the full naive Σ w×h×4 is ${fmtBytes(r.totals.vramBytes)}`);
    expect(md).not.toContain('{naive}');
  });
});

describe('reportToMarkdown — findings table', () => {
  it('sorts crit→warn→info→ok, tie-breaks by assetRef, one row per finding', () => {
    const r = makeReport({
      findings: [
        finding({ severity: 'ok', assetRef: 'ok.png' }),
        finding({ severity: 'info', assetRef: 'b.png' }),
        finding({ severity: 'info', assetRef: 'a.png' }),
        finding({ severity: 'crit', assetRef: 'c.png' }),
        finding({ severity: 'warn', assetRef: 'w.png' }),
      ],
    });
    const md = reportToMarkdown(r);
    const order = ['c.png', 'w.png', 'a.png', 'b.png', 'ok.png'].map((n) => md.indexOf(n));
    expect(order).toEqual([...order].sort((x, y) => x - y));
    // one data row per finding (header + separator + 5 rows)
    const dataRows = md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| ---') && !l.startsWith('| Severity'));
    expect(dataRows).toHaveLength(5);
  });

  it('shows disk-only saving in the Disk column and BLANK VRAM column (no invented VRAM saving)', () => {
    const r = makeReport({
      findings: [finding({ assetRef: 'meta.png', rule: 'strippable-metadata', estimate: { diskBytesSaved: 4096 } })],
    });
    const row = reportToMarkdown(r).split('\n').find((l) => l.includes('meta.png'))!;
    expect(row).toContain(`| ${fmtBytes(4096)} |  |`); // disk filled, vram blank
  });

  it('shows vram-only saving in the VRAM column and BLANK Disk column (symmetric)', () => {
    const r = makeReport({
      findings: [finding({ assetRef: 'dup.png', rule: 'duplicate-exact', estimate: { vramBytesSaved: 16 * 1048576 } })],
    });
    const row = reportToMarkdown(r).split('\n').find((l) => l.includes('dup.png'))!;
    expect(row).toContain(`|  | ${fmtBytes(16 * 1048576)} |`); // disk blank, vram filled
  });

  it('escapes pipes and flattens newlines so a nasty title/detail cannot break the row', () => {
    const r = makeReport({
      findings: [finding({ assetRef: 'a|b.png', title: 'has | pipe', detail: 'line1\nline2' })],
    });
    const md = reportToMarkdown(r);
    const row = md.split('\n').find((l) => l.includes('a\\|b.png'))!;
    expect(row).toContain('has \\| pipe');
    expect(row).toContain('line1 line2'); // newline flattened to a space
    expect(row).not.toContain('line1\nline2');
    // the row is a single physical line ⇒ exactly 8 unescaped pipe separators (7 cols)
    expect(row.match(/(?<!\\)\|/g)).toHaveLength(8);
  });

  it('renders _No findings._ (no empty table, no crash) on a clean report', () => {
    const md = reportToMarkdown(makeReport());
    expect(md).toContain('_No findings._');
    expect(md).not.toContain('| Severity |');
    expect(md).toContain('0 findings.');
  });

  it('pluralizes the trailing finding count', () => {
    expect(reportToMarkdown(makeReport({ findings: [finding({})] }))).toContain('1 finding.');
    expect(reportToMarkdown(makeReport({ findings: [finding({ id: '1' }), finding({ id: '2' })] }))).toContain(
      '2 findings.',
    );
  });
});

describe('reportToCSV — RFC4180 machine rows', () => {
  it('emits the exact header and one row per finding with RAW integer byte columns', () => {
    const r = makeReport({
      findings: [
        finding({ assetRef: 'a.png', rule: 'format', estimate: { diskBytesSaved: 4096 } }),
        finding({ assetRef: 'b.png', rule: 'duplicate-exact', estimate: { vramBytesSaved: 2048 } }),
      ],
    });
    const lines = reportToCSV(r).trimEnd().split('\r\n');
    expect(lines[0]).toBe(
      'severity,scope,asset,relatedRefs,title,detail,fix,diskSavedBytes,vramSavedBytes,occupancyPct',
    );
    expect(lines).toHaveLength(3); // header + 2 rows
    // disk & vram are SEPARATE columns, RAW integers, blank when absent
    expect(lines[1]).toContain(',4096,,'); // a.png: disk=4096, vram blank
    expect(lines[2]).toContain(',,2048,'); // b.png: disk blank, vram=2048
  });

  it('quotes fields with comma/quote/newline and doubles internal quotes', () => {
    const r = makeReport({ findings: [finding({ assetRef: 'a,b"c', title: 'x\ny', detail: 'plain' })] });
    const csv = reportToCSV(r);
    expect(csv).toContain('"a,b""c"'); // comma + doubled quote
    expect(csv).toContain('"x\ny"'); // newline preserved inside a quoted field
  });
});

describe('deterministic ordering shared by MD and CSV', () => {
  it('MD and CSV enumerate findings in the SAME sorted order', () => {
    const findings = [
      finding({ severity: 'info', assetRef: 'b.png' }),
      finding({ severity: 'crit', assetRef: 'a.png' }),
      finding({ severity: 'warn', assetRef: 'z.png' }),
    ];
    const r = makeReport({ findings });
    const sorted = sortFindings(findings).map((f) => f.assetRef);
    const csvOrder = reportToCSV(r)
      .trimEnd()
      .split('\r\n')
      .slice(1)
      .map((l) => l.split(',')[2]);
    expect(csvOrder).toEqual(sorted);
    const mdOrder = sorted.map((n) => reportToMarkdown(r).indexOf(n));
    expect(mdOrder).toEqual([...mdOrder].sort((x, y) => x - y));
  });
});

describe('reportFilename', () => {
  it('slugifies a path-like subject', () => {
    expect(reportFilename('My Game/UI', 'json')).toBe('my-game-ui-audit.json');
  });
  it('falls back to "asset" for empty / unicode-only / undefined subjects', () => {
    expect(reportFilename('', 'json')).toBe('asset-audit.json');
    expect(reportFilename('日本語', 'md')).toBe('asset-audit.md');
    expect(reportFilename(undefined, 'csv')).toBe('asset-audit.csv');
  });
  it('caps the slug length', () => {
    const long = 'a'.repeat(200);
    const name = reportFilename(long, 'json');
    expect(name).toBe(`${'a'.repeat(60)}-audit.json`);
  });
});

describe('reportContent + REPORT_MIME dispatch', () => {
  it('routes each format to its serializer', () => {
    const r = makeReport({ findings: [finding({ assetRef: 'a.png' })] });
    expect(reportContent(r, 'json', 'S')).toBe(reportToJSON(r));
    expect(reportContent(r, 'md', 'S')).toBe(reportToMarkdown(r, { subject: 'S' }));
    expect(reportContent(r, 'csv', 'S')).toBe(reportToCSV(r));
  });
  it('maps every format to a correct MIME type', () => {
    expect(REPORT_MIME).toEqual({
      json: 'application/json',
      md: 'text/markdown',
      csv: 'text/csv',
      html: 'text/html',
    });
  });
});

describe('honesty — invariant 3 (measure, never fabricate)', () => {
  it('every numeric token in MD traces to a measured input field; no invented aggregate appears', () => {
    const r = makeReport({
      findings: [finding({ assetRef: 'a.png', rule: 'format', estimate: { diskBytesSaved: 4096 } })],
    });
    const md = reportToMarkdown(r);
    // measured totals are FORMATTED, not recomputed
    expect(md).toContain(fmtBytes(r.totals.diskBytes));
    expect(md).toContain(fmtBytes(r.totals.loadedVramBytes));
    expect(md).toContain(fmtBytes(r.totals.vramBytes));
    expect(md).toContain(fmtBytes(4096)); // the finding's own measured saving
    // the "(est.)" honesty qualifier rides in the column headers
    expect(md).toContain('Disk saved (est.)');
    expect(md).toContain('VRAM saved (est.)');
    // NO potentialDiskSaved-style rollup or any total-savings aggregate is emitted in the human view
    expect(md).not.toContain(fmtBytes(r.totals.potentialDiskSaved));
  });
});

describe('honesty — invariant 5 (disk ≠ VRAM, never summed)', () => {
  it('a finding with disk=1000 AND vram=2000 never yields the summed 3000 in any format', () => {
    const r = makeReport({
      findings: [finding({ assetRef: 'both.png', estimate: { diskBytesSaved: 1000, vramBytesSaved: 2000 } })],
    });
    const json = reportToJSON(r);
    const md = reportToMarkdown(r);
    const csv = reportToCSV(r);
    for (const out of [json, md, csv]) {
      expect(out).not.toContain('3000'); // the raw sum
      expect(out).not.toContain(fmtBytes(3000)); // the formatted sum ("2.9 KB")
    }
    // both quantities DO appear, separately
    expect(md).toContain(fmtBytes(1000));
    expect(md).toContain(fmtBytes(2000));
    expect(csv).toContain(',1000,2000,'); // adjacent but distinct columns
    // JSON keeps them as the two estimate fields; no combined key exists
    const est = JSON.parse(json).findings[0].estimate;
    expect(est).toEqual({ diskBytesSaved: 1000, vramBytesSaved: 2000 });
    expect(json).not.toContain('totalSaved');
    expect(json).not.toContain('totalBytes');
  });
});

describe('escapeHtml — exhaustive metacharacter coverage (the #1 review focus)', () => {
  it('escapes each of the five HTML metacharacters', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('escapes ampersand FIRST and never double-escapes an inserted entity', () => {
    expect(escapeHtml('<&>')).toBe('&lt;&amp;&gt;');
    // a literal "&amp;" in the input becomes "&amp;amp;" — the '&' is escaped, the rest is literal text
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });

  it('neutralizes an attribute-context breakout value (quote escaped, no raw quote survives)', () => {
    const out = escapeHtml('" onmouseover="x');
    expect(out).toContain('&quot;');
    expect(out).not.toContain('"'); // no raw double-quote can close an attribute
  });

  it('coerces a number without throwing', () => {
    expect(escapeHtml(4096)).toBe('4096');
  });
});

describe('reportToHTML — self-contained document shape (invariant 1: zero network)', () => {
  it('is a complete standalone document with an inline <style> and correct terminators', () => {
    const html = reportToHTML(makeReport());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.endsWith('</html>\n')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<style>');
    expect(html).toContain('</style>');
  });

  it('embeds ZERO remote/fetchable references (no script/link/img/src/href/url/@import/http)', () => {
    // A CLEAN report (no findings) so no escaped-"src=" text from finding data can false-fail these checks.
    const html = reportToHTML(makeReport());
    for (const forbidden of ['<script', '<link', '<img', 'src=', 'href=', 'url(', '@import', 'http']) {
      expect(html).not.toContain(forbidden);
    }
  });
});

describe('reportToHTML — injection safety (ADVERSARIAL, the #1 review focus)', () => {
  it('neutralizes a <script> asset name (escaped, no live tag)', () => {
    const r = makeReport({ findings: [finding({ assetRef: '<script>alert(1)</script>.png' })] });
    const html = reportToHTML(r);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script'); // no live script tag anywhere in the document
  });

  it('neutralizes an attribute-breakout asset name ("><img …>) — no tag or attr escapes text context', () => {
    const r = makeReport({ findings: [finding({ assetRef: '"><img src=x onerror=alert(1)>.png' })] });
    const html = reportToHTML(r);
    expect(html).toContain('&quot;&gt;&lt;img');
    expect(html).not.toContain('<img'); // the injected image tag never materializes
    expect(html).not.toContain('"><img'); // and the quote/bracket breakout is fully neutralized
  });

  it('escapes HTML metacharacters in title and detail (raw <b> never appears)', () => {
    const r = makeReport({ findings: [finding({ assetRef: 'a.png', title: '<b>&"', detail: '<b>&"' })] });
    const html = reportToHTML(r);
    expect(html).toContain('&lt;b&gt;&amp;&quot;');
    expect(html).not.toContain('<b>');
  });
});

describe('reportToHTML — subject in <title> and <h1>', () => {
  it('escapes a nasty subject in BOTH the title and the heading', () => {
    const html = reportToHTML(makeReport(), { subject: 'A<b>&"C' });
    // both the <title> and the <h1> carry the escaped subject
    expect(html).toContain('<title>Asset Doctor — audit: A&lt;b&gt;&amp;&quot;C</title>');
    expect(html).toContain('<h1>Asset Doctor — audit: A&lt;b&gt;&amp;&quot;C</h1>');
    expect(html).not.toContain('<b>');
  });

  it('omits the subject suffix entirely when no subject is given', () => {
    const html = reportToHTML(makeReport());
    expect(html).toContain('<title>Asset Doctor — audit</title>');
    expect(html).not.toContain('audit:');
  });
});

describe('reportToHTML — summary header (invariant 3: measured-only)', () => {
  it('carries assets count, disk, VRAM(loaded) and the honest draw-call floor', () => {
    const r = makeReport();
    const html = reportToHTML(r);
    expect(html).toContain('2 assets');
    expect(html).toContain(`disk ${fmtBytes(r.totals.diskBytes)}`);
    expect(html).toContain(`VRAM(loaded) ${fmtBytes(r.totals.loadedVramBytes)}`);
    expect(html).toContain('draw-call floor ≥ 7'); // loadedTextures, not assets.length
  });

  it('falls back to assets.length for the floor when loadedTextures is absent', () => {
    const r = makeReport({ totals: { ...makeReport().totals, loadedTextures: undefined } as AnalysisReport['totals'] });
    expect(reportToHTML(r)).toContain('draw-call floor ≥ 2');
  });

  it('reuses the disk≠VRAM note with {naive}→fmtBytes(vramBytes) and no rollup total', () => {
    const r = makeReport();
    const html = reportToHTML(r);
    expect(html).toContain(fmtBytes(r.totals.vramBytes));
    expect(html).not.toContain('{naive}');
    expect(html).not.toContain(fmtBytes(r.totals.potentialDiskSaved)); // no total-savings rollup
  });

  it('carries the "(est.)" honesty qualifier in BOTH savings column headers', () => {
    // a finding is present so the findings table (and its headers) is rendered
    const html = reportToHTML(makeReport({ findings: [finding({ assetRef: 'a.png' })] }));
    expect(html).toContain('Disk saved (est.)');
    expect(html).toContain('VRAM saved (est.)');
  });
});

describe('reportToHTML — determinism & sorted order', () => {
  it('is byte-identical across calls (no Date.now / random — not a timestamp)', () => {
    const r = makeReport({ findings: [finding({ assetRef: 'a.png' })] });
    expect(reportToHTML(r)).toBe(reportToHTML(r));
  });

  it('emits one severity row per finding in sortFindings() order', () => {
    const findings = [
      finding({ severity: 'ok', assetRef: 'ok.png' }),
      finding({ severity: 'info', assetRef: 'b.png' }),
      finding({ severity: 'info', assetRef: 'a.png' }),
      finding({ severity: 'crit', assetRef: 'c.png' }),
      finding({ severity: 'warn', assetRef: 'w.png' }),
    ];
    const r = makeReport({ findings });
    const html = reportToHTML(r);
    const sorted = sortFindings(findings).map((f) => f.assetRef);
    const order = sorted.map((n) => html.indexOf(n));
    expect(order).toEqual([...order].sort((x, y) => x - y)); // ascending ⇒ same order as sortFindings
    // exactly one data row (severity <span>) per finding
    expect((html.match(/class="sev /g) || []).length).toBe(findings.length);
  });
});

describe('reportToHTML — SEPARATE disk/VRAM columns, blank-not-zero (invariants 3 & 5)', () => {
  it('has two distinct estimate header cells', () => {
    const html = reportToHTML(makeReport({ findings: [finding({})] }));
    expect(html).toContain('<th class="num">Disk saved (est.)</th>');
    expect(html).toContain('<th class="num">VRAM saved (est.)</th>');
  });

  it('renders a disk-only saving with an EMPTY vram cell (no fabricated 0)', () => {
    const r = makeReport({ findings: [finding({ assetRef: 'meta.png', estimate: { diskBytesSaved: 4096 } })] });
    const html = reportToHTML(r);
    expect(html).toContain(`<td class="num">${fmtBytes(4096)}</td><td class="num"></td>`);
  });

  it('renders a vram-only saving with an EMPTY disk cell (symmetric)', () => {
    const r = makeReport({ findings: [finding({ assetRef: 'dup.png', estimate: { vramBytesSaved: 16 * 1048576 } })] });
    const html = reportToHTML(r);
    expect(html).toContain(`<td class="num"></td><td class="num">${fmtBytes(16 * 1048576)}</td>`);
  });

  it('never sums disk+vram into a single figure (1000 & 2000 present, 3000 absent)', () => {
    const r = makeReport({
      findings: [finding({ assetRef: 'both.png', estimate: { diskBytesSaved: 1000, vramBytesSaved: 2000 } })],
    });
    const html = reportToHTML(r);
    expect(html).toContain(fmtBytes(1000));
    expect(html).toContain(fmtBytes(2000));
    expect(html).not.toContain('3000');
    expect(html).not.toContain(fmtBytes(3000));
    expect(html).toContain('never summed'); // the note is present
  });
});

describe('reportToHTML — empty findings', () => {
  it('shows the empty-state paragraph and no table on a clean report', () => {
    const html = reportToHTML(makeReport());
    expect(html).toContain('<p class="empty">No findings.</p>');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('class="sev');
    expect(html).toContain('0 findings.');
  });
});

describe('reportToHTML — dispatch, filename, MIME', () => {
  it('reportContent routes html to reportToHTML with the subject', () => {
    const r = makeReport({ findings: [finding({ assetRef: 'a.png' })] });
    expect(reportContent(r, 'html', 'S')).toBe(reportToHTML(r, { subject: 'S' }));
  });

  it('maps html to text/html and produces a .html filename', () => {
    expect(REPORT_MIME.html).toBe('text/html');
    expect(reportFilename('My Game', 'html')).toBe('my-game-audit.html');
  });
});

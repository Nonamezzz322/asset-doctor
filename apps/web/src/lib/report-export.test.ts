import { describe, expect, it } from 'vitest';
import type { AnalysisReport, Finding } from '@asset-doctor/core';
import { fmtBytes } from '@asset-doctor/analysis';
import { toJSON } from '@asset-doctor/budget';
import {
  reportToJSON,
  reportToMarkdown,
  reportToCSV,
  reportContent,
  reportFilename,
  sortFindings,
  REPORT_MIME,
} from './report-export';

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
    expect(REPORT_MIME).toEqual({ json: 'application/json', md: 'text/markdown', csv: 'text/csv' });
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

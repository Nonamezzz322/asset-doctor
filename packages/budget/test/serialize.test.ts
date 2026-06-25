import { describe, expect, it } from 'vitest';
import { CLI_CAPABILITIES, evaluateGate, parseBudgetConfig, renderGate, sortedAssets, toAnnotations, toJSON, toSARIF, toSummaryMarkdown } from '../src/index';
import type { GateEntry, GateResult } from '../src/index';
import { REPORT } from './fixture';

const entry = (over: Partial<GateEntry>): GateEntry => ({ key: 'k', scope: 'global', unit: 'count', level: 'error', check: 'max', budget: 0, value: 1, status: 'error', message: 'm', ...over });
const gateOf = (entries: GateEntry[], worst: GateResult['worst'] = 'error'): GateResult => ({ entries, capabilities: CLI_CAPABILITIES, errorCount: entries.filter((e) => e.status === 'error').length, warnCount: entries.filter((e) => e.status === 'warn').length, worst });

const failingGate = () =>
  evaluateGate(
    REPORT,
    parseBudgetConfig({ version: 1, budgets: { 'totals.diskBytes': { error: { max: '100B' } }, 'findings.warn': { warn: { max: 0 } } } }),
  );

describe('serialize', () => {
  it('sorts assets by ref for deterministic JSON', () => {
    expect(sortedAssets(REPORT).map((a) => a.assetRef)).toEqual(['a.png', 'b.png', 'sheet.json']);
    // toJSON does not mutate the input report
    toJSON(REPORT);
    expect(REPORT.assets[0]!.assetRef).toBe('b.png');
  });

  it('embeds capabilities + drawCallsLowerBound in JSON', () => {
    const j = toJSON(REPORT, failingGate()) as {
      capabilities: { vram: boolean; formatAudit: boolean };
      drawCallsLowerBound: number;
      gate: { worst: string };
    };
    expect(j.capabilities.vram).toBe(true);
    expect(j.capabilities.formatAudit).toBe(false);
    expect(j.drawCallsLowerBound).toBe(3);
    expect(j.gate.worst).toBe('error');
  });

  it('SARIF emits one result per breach with mapped levels', () => {
    const s = toSARIF(failingGate()) as {
      version: string;
      runs: { results: { ruleId: string; level: string }[] }[] };
    expect(s.version).toBe('2.1.0');
    const results = s.runs[0]!.results;
    expect(results.length).toBe(2); // disk error + warn breach
    expect(results.find((r) => r.ruleId === 'totals.diskBytes')!.level).toBe('error');
    expect(results.find((r) => r.ruleId === 'findings.warn')!.level).toBe('warning');
  });

  it('annotations are worst-first, capped, and well-formed', () => {
    const lines = toAnnotations(failingGate(), 1);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^::error::asset-doctor: /); // no file= for a global metric, no stray space
  });

  it('summary markdown shows the verdict and rows', () => {
    const md = toSummaryMarkdown(REPORT, failingGate(), { dir: 'x' });
    expect(md).toMatch(/budget failed/);
    expect(md).toMatch(/`totals.diskBytes`/);
  });

  it('human gate render is plain when color is off, ANSI when on', () => {
    expect(renderGate(REPORT, failingGate(), { color: false })).not.toContain('\x1b[');
    expect(renderGate(REPORT, failingGate(), { color: true })).toContain('\x1b['); // ESC byte present
  });

  it('escapes annotation file= and message per the workflow-command spec', () => {
    const [line] = toAnnotations(gateOf([entry({ scope: 'asset', assetRef: 'ui:icons,1.png', message: 'bad\nname' })]));
    expect(line).toContain('file=ui%3Aicons%2C1.png');
    expect(line).toContain('%0A'); // newline encoded, not a literal break that would split the command
    expect(line!.split('\n')).toHaveLength(1);
  });

  it('escapes pipe characters in summary table cells', () => {
    const md = toSummaryMarkdown(REPORT, gateOf([entry({ scope: 'asset', assetRef: 'a|b.png' })]), {});
    expect(md).toContain('a\\|b.png');
  });

  it('sorts gate.entries deterministically in JSON (scope, ref, key)', () => {
    const g = gateOf([entry({ key: 'z', status: 'pass' }), entry({ key: 'a', status: 'pass' }), entry({ scope: 'asset', assetRef: 'm.png', key: 'b', status: 'pass' })], 'pass');
    const j = toJSON(REPORT, g) as { gate: { entries: { key: string }[] } };
    expect(j.gate.entries.map((e) => e.key)).toEqual(['b', 'a', 'z']); // asset scope sorts before global, then by key
  });

  it('SARIF rules carry a name + shortDescription', () => {
    const s = toSARIF(failingGate()) as { runs: { tool: { driver: { rules: { id: string; name: string; shortDescription: { text: string } }[] } } }[] };
    const rule = s.runs[0]!.tool.driver.rules[0]!;
    expect(rule.name).toBe(rule.id);
    expect(rule.shortDescription.text).toMatch(/Asset budget:/);
  });
});

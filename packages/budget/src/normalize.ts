// Coerce human-friendly budget values into raw numbers, with unit-aware validation. Byte metrics
// REQUIRE a unit suffix ("8MB") — a bare number is rejected so nobody accidentally writes 8 (bytes)
// meaning 8 MB (the classic size-budget footgun). Counts/px are bare integers; ratios are 0..1.

import { ConfigError } from './errors';
import type { LevelSpec, MetricUnit } from './types';

const BYTE_UNIT: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

export function parseBytes(v: unknown, where: string): number {
  if (typeof v === 'number')
    throw new ConfigError(`byte budget must carry a unit (e.g. "8MB"), got bare number ${v}`, where);
  if (typeof v !== 'string') throw new ConfigError(`expected a byte string like "8MB"`, where);
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB)\s*$/i.exec(v);
  if (!m) throw new ConfigError(`invalid byte value "${v}" (use B/KB/MB/GB, e.g. "8MB")`, where);
  return Math.round(parseFloat(m[1]!) * BYTE_UNIT[m[2]!.toUpperCase()]!);
}

function parseNumber(v: unknown, where: string): number {
  const n = typeof v === 'string' ? Number(v.trim().replace(/%$/, '')) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ConfigError(`expected a number, got ${JSON.stringify(v)}`, where);
  return n;
}

export function parseCount(v: unknown, where: string): number {
  const n = parseNumber(v, where);
  if (n < 0 || !Number.isInteger(n)) throw new ConfigError(`count budget must be a non-negative integer, got ${n}`, where);
  return n;
}

export function parseRatio(v: unknown, where: string): number {
  const n = parseNumber(v, where);
  if (n < 0 || n > 1) throw new ConfigError(`ratio budget must be within 0..1, got ${n}`, where);
  return n;
}

export function parsePx(v: unknown, where: string): number {
  const n = parseNumber(v, where);
  if (n < 0) throw new ConfigError(`px budget must be >= 0, got ${n}`, where);
  return n;
}

function parseByUnit(v: unknown, unit: MetricUnit, where: string): number {
  switch (unit) {
    case 'bytes': return parseBytes(v, where);
    case 'count': return parseCount(v, where);
    case 'ratio': return parseRatio(v, where);
    case 'px': return parsePx(v, where);
  }
}

function parsePct(v: unknown, where: string): number {
  const n = parseNumber(v, where);
  if (n < 0) throw new ConfigError(`maxDeltaPct must be >= 0, got ${n}`, where);
  return n;
}

/** Validate + normalize one {max?,min?,maxDeltaPct?} spec for a metric of the given unit. */
export function coerceLevel(raw: unknown, unit: MetricUnit, where: string): LevelSpec {
  if (typeof raw !== 'object' || raw === null) throw new ConfigError(`expected an object with max/min/maxDeltaPct`, where);
  const o = raw as Record<string, unknown>;
  const known = ['max', 'min', 'maxDeltaPct'];
  for (const k of Object.keys(o)) if (!known.includes(k)) throw new ConfigError(`unknown key "${k}" (allowed: ${known.join(', ')})`, where);
  const out: LevelSpec = {};
  if (o.max !== undefined) out.max = parseByUnit(o.max, unit, `${where}.max`);
  if (o.min !== undefined) out.min = parseByUnit(o.min, unit, `${where}.min`);
  if (o.maxDeltaPct !== undefined) out.maxDeltaPct = parsePct(o.maxDeltaPct, `${where}.maxDeltaPct`);
  if (out.max === undefined && out.min === undefined && out.maxDeltaPct === undefined)
    throw new ConfigError(`a budget level needs at least one of max/min/maxDeltaPct`, where);
  return out;
}

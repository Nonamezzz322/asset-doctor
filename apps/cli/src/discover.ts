// Locate the budget config: explicit --config first, else walk up from the working dir looking for
// asset-doctor.budget.json, else a package.json "assetDoctor" field. Returns the parsed raw object
// (still un-validated). Malformed JSON / a missing --config path is a ConfigError (→ exit 2).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ConfigError } from '@asset-doctor/budget';

export interface Discovery {
  path: string;
  raw: unknown;
  source: 'flag' | 'file' | 'package.json';
}

const CONFIG_NAME = 'asset-doctor.budget.json';

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read config: ${(e as Error).message}`, path);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`invalid JSON in ${path}: ${(e as Error).message}`, path);
  }
}

export function discoverConfig(opts: { configFlag?: string; cwd: string }): Discovery | null {
  if (opts.configFlag) {
    const path = resolve(opts.cwd, opts.configFlag);
    if (!existsSync(path)) throw new ConfigError(`config not found: ${opts.configFlag}`, path);
    return { path, raw: readJson(path), source: 'flag' };
  }
  let dir = resolve(opts.cwd);
  for (;;) {
    const file = join(dir, CONFIG_NAME);
    if (existsSync(file)) return { path: file, raw: readJson(file), source: 'file' };
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      const json = readJson(pkg);
      if (typeof json === 'object' && json !== null && 'assetDoctor' in json) {
        return { path: pkg, raw: (json as { assetDoctor: unknown }).assetDoctor, source: 'package.json' };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

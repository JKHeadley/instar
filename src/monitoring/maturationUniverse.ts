/**
 * maturationUniverse — every switched-off feature, derived from code only, so
 * the coverage test cannot be satisfied by leaving a flag out of a list.
 * Spec: docs/specs/feature-maturation-ladder.md §2.
 */

import { getMigrationDefaults } from '../config/ConfigDefaults.js';
import { DARK_GATE_EXCLUSIONS, DEV_GATED_FEATURES } from '../core/devGatedFeatures.js';
import { GUARD_MANIFEST } from './guardManifest.js';

export interface UniverseMember {
  /** The flag path, without a trailing `.enabled`. */
  path: string;
  sources: Array<'dev-gated' | 'manifest' | 'default-off' | 'default-dry-run' | 'exclusion'>;
  /** Always sensitive: dark for everyone until an operator says otherwise, or load-bearing. */
  mustBeSensitive: boolean;
}

function strip(p: string): string {
  return p.replace(/\.(enabled|dryRun)$/, '');
}

export function maturationUniverse(): UniverseMember[] {
  const out = new Map<string, UniverseMember>();
  const add = (raw: string, source: UniverseMember['sources'][number], mustBeSensitive = false) => {
    const p = strip(raw);
    const m = out.get(p) ?? { path: p, sources: [], mustBeSensitive: false };
    if (!m.sources.includes(source)) m.sources.push(source);
    if (mustBeSensitive) m.mustBeSensitive = true;
    out.set(p, m);
  };
  for (const f of DEV_GATED_FEATURES) add(f.configPath, 'dev-gated');
  for (const g of GUARD_MANIFEST) {
    if (g.kind !== 'config' || !g.configPath) continue;
    if (g.defaultEnabled === false) add(g.configPath, 'manifest', g.loadBearing === true);
    else if (g.dryRunConfigPath) add(g.configPath, 'manifest', g.loadBearing === true);
  }
  const walk = (o: unknown, prefix: string): void => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const q = prefix ? `${prefix}.${k}` : k;
      if (k === 'enabled' && v === false) add(q, 'default-off');
      else if (k === 'dryRun' && v === true) add(q, 'default-dry-run');
      else walk(v, q);
    }
  };
  walk(getMigrationDefaults('standalone'), '');
  for (const e of DARK_GATE_EXCLUSIONS as ReadonlyArray<{ configPath?: string; path?: string }>) {
    const p = e.configPath ?? e.path;
    if (p) add(p, 'exclusion', true);
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

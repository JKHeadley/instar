/**
 * Test inventory for local-verify (spec local-verify-merge-authority.md §2 step 5).
 *
 * Pure: given every file path in the merge tree, compute which test files must
 * appear in a lane report and which lane each belongs to. The trusted side
 * computes this itself; it never reads the inventory from the PR.
 */

import { matchesAny, normalizePath } from './glob.js';

export type LaneName = 'unit' | 'integration' | 'e2e';

export interface LaneDefinition {
  name: LaneName;
  /** The vitest config the orchestrator runs this lane with. */
  config: string;
  /** Repo-relative include globs; lanes are disjoint. */
  include: readonly string[];
  /**
   * Only gating lanes count toward success (the §3 predicate's
   * `failed == 0 && tests > 0` and the inventory rule apply to gating lanes).
   * v1 ships every lane gating and NO advisory (`known-flaky`) lane.
   */
  gating: boolean;
}

export const LANES: readonly LaneDefinition[] = Object.freeze([
  { name: 'unit', config: 'vitest.config.ts', include: ['tests/unit/**', 'tests/real-world-state/**'], gating: true },
  { name: 'integration', config: 'vitest.integration.config.ts', include: ['tests/integration/**'], gating: true },
  { name: 'e2e', config: 'vitest.e2e.config.ts', include: ['tests/e2e/**'], gating: true },
] as LaneDefinition[]);

/** Test-file roots that make up the inventory. */
export const INVENTORY_INCLUDE: readonly string[] = Object.freeze(['tests/**/*.test.ts', 'src/**/*.test.ts']);

/**
 * Explicit exclusions: `tests/contract/**` needs a live key; `tests/fixtures/**`
 * holds test files used as data by other tests; the adapter template's example.
 * Changing this list is harness-changing (it lives under src/localVerify/**).
 */
export const INVENTORY_EXCLUDE: readonly string[] = Object.freeze([
  'tests/contract/**',
  'tests/fixtures/**',
  'src/providers/adapters/example/**',
]);

export type TestPathClass =
  | { kind: 'not-test' }
  | { kind: 'excluded' }
  | { kind: 'laned'; lane: LaneName }
  | { kind: 'unlaned' };

/** Classify one path against the inventory rules and lane include sets. */
export function classifyTestPath(path: string, lanes: readonly LaneDefinition[] = LANES): TestPathClass {
  const p = normalizePath(path);
  if (!matchesAny(p, INVENTORY_INCLUDE)) return { kind: 'not-test' };
  if (matchesAny(p, INVENTORY_EXCLUDE)) return { kind: 'excluded' };
  const hits = lanes.filter((l) => matchesAny(p, l.include));
  if (hits.length === 1) return { kind: 'laned', lane: hits[0].name };
  // Zero lanes (e.g. a stray src/**/*.test.ts) or an overlap (lanes must be
  // disjoint) are both "no single lane" and fail the run.
  return { kind: 'unlaned' };
}

/**
 * The vitest config that collects this test file: its lane's config, or the
 * unit config for anything outside a lane. `npm test` (vitest.config.ts) is the
 * unit lane only, so a caller that names an integration or e2e file without
 * this config runs nothing ("No test files found").
 */
export function vitestConfigForTestPath(path: string, lanes: readonly LaneDefinition[] = LANES): string {
  const p = normalizePath(path).replace(/^\.\//, '');
  const hit = lanes.find((l) => matchesAny(p, l.include));
  return hit ? hit.config : 'vitest.config.ts';
}

/** Files grouped by the config that collects them, in lane order (unit, integration, e2e). */
export function groupTestFilesByConfig(files: readonly string[], lanes: readonly LaneDefinition[] = LANES): Array<{ config: string; files: string[] }> {
  const order = [...lanes.map((l) => l.config), 'vitest.config.ts'];
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const c = vitestConfigForTestPath(f, lanes);
    groups.set(c, [...(groups.get(c) ?? []), f]);
  }
  return [...groups.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([config, fs]) => ({ config, files: fs }));
}

/** True when the file is part of the inventory (a test file not excluded), laned or not. */
export function isInventoried(path: string, lanes: readonly LaneDefinition[] = LANES): boolean {
  const c = classifyTestPath(path, lanes);
  return c.kind === 'laned' || c.kind === 'unlaned';
}

export interface InventoryEntry {
  path: string;
  lane: LaneName;
}

export interface InventoryError {
  path: string;
  reason: 'no-lane';
}

export interface Inventory {
  files: InventoryEntry[];
  errors: InventoryError[];
  byLane: Record<LaneName, string[]>;
}

export function computeInventory(treePaths: readonly string[], lanes: readonly LaneDefinition[] = LANES): Inventory {
  const seen = new Set<string>();
  const files: InventoryEntry[] = [];
  const errors: InventoryError[] = [];
  const byLane = Object.fromEntries(lanes.map((l) => [l.name, [] as string[]])) as Record<LaneName, string[]>;
  for (const raw of treePaths) {
    const p = normalizePath(raw);
    if (seen.has(p)) continue;
    seen.add(p);
    const c = classifyTestPath(p, lanes);
    if (c.kind === 'laned') {
      files.push({ path: p, lane: c.lane });
      byLane[c.lane].push(p);
    } else if (c.kind === 'unlaned') {
      errors.push({ path: p, reason: 'no-lane' });
    }
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  files.sort((a, b) => cmp(a.path, b.path));
  errors.sort((a, b) => cmp(a.path, b.path));
  for (const l of Object.keys(byLane) as LaneName[]) byLane[l].sort(cmp);
  return { files, errors, byLane };
}

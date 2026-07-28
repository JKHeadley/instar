/**
 * Write-domain conformance ratchet (standby-write-reconciliation §3.5).
 *
 * The Phase-1 write-surface inventory made structural: every mutating route
 * registration (`router.post|patch|put|delete`) in src/server/routes.ts must be
 * exactly ONE of:
 *   1. CLASSIFIED — matched by a wave-1 registry route entry
 *      (buildWriteDomainRegistry — the SAME map the server wires);
 *   2. ANNOTATED — `@write-domain:none` within the 3 lines above the
 *      registration (read-only actions, pure-compute triggers);
 *   3. TODO-CLASSIFY — listed in tests/fixtures/write-surface-inventory.json,
 *      the recorded baseline (keeps today's exact behavior, I8).
 *
 * THE RATCHET: the baseline may only SHRINK. A NEW mutating route absent from
 * all three fails this test — coverage ratchets instead of rotting (§3.5).
 * A baseline entry that no longer resolves (route deleted or since classified)
 * must LEAVE the baseline, so the list can never overstate the debt.
 *
 * Wave 2 drains the baseline to zero and flips WRITE_SURFACE_INVENTORY_COMPLETE
 * (§9.14 — the dryRun:false ladder gate refuses refusal authority until then).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildWriteDomainRegistry } from '../../src/core/WriteDomainRegistry.js';

const ROOT = path.resolve(__dirname, '..', '..');
const ROUTES_PATH = path.join(ROOT, 'src', 'server', 'routes.ts');
const INVENTORY_PATH = path.join(ROOT, 'tests', 'fixtures', 'write-surface-inventory.json');

interface ScannedRoute {
  method: string;
  routePath: string;
  /** `METHOD /path` — the inventory key. */
  key: string;
  line: number;
  annotatedNone: boolean;
}

/** Scan a routes source text for mutating route registrations. Handles both
 *  the single-line `router.post('/x', …)` and the multi-line
 *  `router.post(\n  '/x',` shapes. Exported-in-spirit: the self-test below
 *  pins the scanner against fixture text so a silent regex regression cannot
 *  quietly empty the ratchet. */
function scanMutatingRoutes(src: string): ScannedRoute[] {
  const out: ScannedRoute[] = [];
  const lines = src.split('\n');
  const re = /router\.(post|patch|put|delete)\(\s*\n?\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const upTo = src.slice(0, m.index);
    const line = (upTo.match(/\n/g) ?? []).length + 1; // 1-based
    // @write-domain:none annotation: same line or within the 3 lines above.
    let annotatedNone = false;
    for (let l = line; l >= Math.max(1, line - 3); l--) {
      if (lines[l - 1]?.includes('@write-domain:none')) {
        annotatedNone = true;
        break;
      }
    }
    out.push({
      method: m[1].toUpperCase(),
      routePath: m[2],
      key: `${m[1].toUpperCase()} ${m[2]}`,
      line,
      annotatedNone,
    });
  }
  return out;
}

function loadInventory(): { todoClassifyRoutes: string[] } {
  return JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf-8')) as { todoClassifyRoutes: string[] };
}

describe('write-domain conformance ratchet (§3.5)', () => {
  const src = fs.readFileSync(ROUTES_PATH, 'utf-8');
  const scanned = scanMutatingRoutes(src);
  const registry = buildWriteDomainRegistry({ machineId: 'ratchet-test' });
  const inventory = loadInventory();
  const baseline = new Set(inventory.todoClassifyRoutes);

  const classified = (r: ScannedRoute): boolean => registry.entryForRoute(r.method, r.routePath) !== null;

  it('the scanner finds the full mutating surface (drift canary: a regex regression cannot quietly empty the ratchet)', () => {
    // routes.ts carries hundreds of mutating registrations; a scan suddenly
    // finding far fewer means the scanner broke, not that the surface shrank.
    expect(scanned.length).toBeGreaterThan(300);
    // The P2-6 anchors are present and CLASSIFIED by the wave-1 registry.
    const anchors = ['POST /evolution/actions', 'POST /attention'];
    for (const a of anchors) {
      const hit = scanned.find((r) => r.key === a);
      expect(hit, `${a} not found in routes.ts scan`).toBeDefined();
      expect(classified(hit!), `${a} must be classified by the wave-1 registry`).toBe(true);
    }
  });

  it('RATCHET: every mutating route is classified, @write-domain:none-annotated, or in the TODO-classify baseline — a NEW undeclared route fails', () => {
    const undeclared = scanned.filter((r) => !classified(r) && !r.annotatedNone && !baseline.has(r.key));
    expect(
      undeclared.map((r) => `${r.key} (routes.ts:${r.line})`),
      [
        'New mutating route(s) with NO write-domain declaration (standby-write-reconciliation §3.5).',
        'Every mutating route must be one of:',
        '  1. classified in buildWriteDomainRegistry (src/core/WriteDomainRegistry.ts) with a',
        '     domain + convergence story (I9 — machine-local needs BOTH axes),',
        '  2. annotated `// @write-domain:none` within 3 lines above the registration',
        '     (read-only action / pure-compute trigger), or',
        '  3. (wave-2 drain ONLY) present in tests/fixtures/write-surface-inventory.json.',
        'The baseline may only SHRINK — do NOT add new routes to it.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('RATCHET (down-only): every baseline entry still resolves to a live, unclassified, unannotated route', () => {
    const liveKeys = new Set(scanned.filter((r) => !classified(r) && !r.annotatedNone).map((r) => r.key));
    const stale = inventory.todoClassifyRoutes.filter((k) => !liveKeys.has(k));
    expect(
      stale,
      'Baseline entries that no longer resolve to an undeclared mutating route — the route was deleted, classified, or annotated. Remove them from tests/fixtures/write-surface-inventory.json (the ratchet only goes DOWN).',
    ).toEqual([]);
  });

  it('the baseline carries no duplicates and every key is well-formed `METHOD /path`', () => {
    expect(new Set(inventory.todoClassifyRoutes).size).toBe(inventory.todoClassifyRoutes.length);
    for (const k of inventory.todoClassifyRoutes) {
      expect(k).toMatch(/^(POST|PATCH|PUT|DELETE) \//);
    }
  });
});

describe('scanner self-test (the lexical heuristic)', () => {
  it('finds single-line and multi-line registrations, with correct methods and paths', () => {
    const fixture = [
      "  router.post('/one', handler);",
      '  router.patch(',
      "    '/two/:id',",
      '    handler,',
      '  );',
      "  router.get('/read-only', handler); // never scanned",
      "  router.delete('/three', handler);",
    ].join('\n');
    const got = scanMutatingRoutes(fixture).map((r) => r.key);
    expect(got).toEqual(['POST /one', 'PATCH /two/:id', 'DELETE /three']);
  });

  it('honors @write-domain:none on the same line and within 3 lines above — but not further', () => {
    const fixture = [
      '  // @write-domain:none — pure-compute trigger',
      "  router.post('/annotated-above', handler);",
      '',
      "  router.post('/annotated-inline', handler); // @write-domain:none",
      '',
      '  // @write-domain:none — too far away',
      '  //',
      '  //',
      '  //',
      "  router.post('/not-annotated', handler);",
    ].join('\n');
    const got = scanMutatingRoutes(fixture);
    expect(got.find((r) => r.routePath === '/annotated-above')!.annotatedNone).toBe(true);
    expect(got.find((r) => r.routePath === '/annotated-inline')!.annotatedNone).toBe(true);
    expect(got.find((r) => r.routePath === '/not-annotated')!.annotatedNone).toBe(false);
  });
});

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { boundDirectSmokeCases, selectDirectSmokeFiles } from '../../../scripts/lib/pre-push-direct.mjs';
import { directSmokeCheckoutClean, directSmokeReportMatches, supportsDirectSmoke } from '../../../scripts/lib/pre-push-scope.mjs';

const root = path.resolve('direct-smoke-fixture');
const source = 'src/localVerify/worker.ts';
const logic = 'tests/unit/worker.test.ts';
const routes = 'tests/integration/local-verify-routes.test.ts';
const peer = 'tests/integration/local-verify-peer-routes.test.ts';
const ladder = 'tests/unit/feature-ladders-coverage.test.ts';
const changedTest = 'tests/unit/localVerify/worker.test.ts';
const absolute = (file: string) => path.join(root, file);

function select(changed: string[], files: Record<string, string>) {
  return selectDirectSmokeFiles(changed, Object.keys(files).map(absolute), root, new Set(Object.keys(files)), (file: string) => files[path.relative(root, file)]);
}

describe('direct Local Verify smoke', () => {
  const tests = {
    [logic]: "import { run } from '../../src/localVerify/worker.js';",
    [routes]: "import { route } from '../../src/server/routes.js';",
    [peer]: "import { route } from '../../src/server/routes.js';",
    'tests/unit/unrelated.test.ts': "import { route } from '../../src/server/routes.js';",
  };

  it('selects direct logic and both shared route checks without following the whole route fan-out', () => {
    expect(select([source], tests)).toEqual([peer, routes, logic].map(absolute).sort());
  });

  it('does not use ignored inventory files to establish direct coverage', () => {
    const inventory = Object.keys(tests).map(absolute);
    expect(selectDirectSmokeFiles([source], inventory, root, new Set([routes, peer]),
      (file: string) => tests[path.relative(root, file) as keyof typeof tests])).toBeNull();
  });

  it('requires exactly the planned files and case counts on execution and retry', () => {
    const planned = new Map([[absolute(logic), { cases: 1, mustExecute: true }]]);
    const report = (file: string, assertions: unknown[]) => JSON.stringify({
      testResults: [{ name: file, assertionResults: assertions }],
    });
    expect(directSmokeReportMatches(report(absolute(logic), [{ status: 'passed' }]), planned)).toBe(true);
    expect(directSmokeReportMatches(report(absolute(logic), []), planned)).toBe(false);
    expect(directSmokeReportMatches(report(absolute(logic), [{ status: 'skipped' }]), planned)).toBe(false);
    expect(directSmokeReportMatches(report(absolute(routes), [{ status: 'passed' }]), planned)).toBe(false);
  });

  it('rejects opposite case-count changes even when the total is unchanged', () => {
    const planned = new Map([
      [absolute(logic), { cases: 1, mustExecute: true }],
      [absolute(routes), { cases: 2, mustExecute: true }],
    ]);
    const passed = { status: 'passed' };
    const output = JSON.stringify({ testResults: [
      { name: absolute(logic), assertionResults: [passed, passed] },
      { name: absolute(routes), assertionResults: [passed] },
    ] });
    expect(directSmokeReportMatches(output, planned)).toBe(false);
  });

  it('keeps changed tests and the ladder audit in the smoke set', () => {
    const changed = [source, changedTest, 'src/data/feature-ladders.json'];
    expect(select(changed, { ...tests, [changedTest]: '', [ladder]: '' }))
      .toEqual([peer, routes, logic, changedTest, ladder].map(absolute).sort());
  });

  it('keeps the wiring checks while adding whole direct files up to the case cap', () => {
    const casesByFile = { [absolute(routes)]: 2, [absolute(peer)]: 3, [absolute(logic)]: 10 };
    expect(boundDirectSmokeCases([source], casesByFile, root, 15)).toMatchObject({ cases: 15 });
    expect(boundDirectSmokeCases([source], casesByFile, root, 7))
      .toEqual({ files: [peer, routes].map(absolute).sort(), cases: 5 });
    expect(boundDirectSmokeCases([source], casesByFile, root, 4)).toBeNull();
  });

  it('uses the exact selection only when its inputs match the checked-out commit', () => {
    expect(directSmokeCheckoutClean({ git: () => '' })).toBe(true);
    expect(directSmokeCheckoutClean({ git: () => '?? tests/unit/new.test.ts' })).toBe(false);
    expect(directSmokeCheckoutClean({ git: () => { throw new Error('git unavailable'); } })).toBe(false);
  });

  it('falls back if the diff crosses product scope or a required wiring check is unavailable', () => {
    expect(supportsDirectSmoke([source, 'src/server/routes.ts'])).toBe(false);
    expect(supportsDirectSmoke([source, 'package-lock.json'])).toBe(false);
    expect(select([source], { [logic]: tests[logic], [routes]: tests[routes] })).toBeNull();
    expect(select([source], { [logic]: '// not a runtime import', [routes]: '', [peer]: '' })).toBeNull();
  });
});

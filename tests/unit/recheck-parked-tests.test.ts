/**
 * The parked-test re-check must parse the exclusion list correctly — including its prose.
 *
 * WHY THIS TEST IS THE IMPORTANT ONE. The first version of the script used a naive
 * `/'([^']+)'/g` over the whole `FLAKY_TESTS` block. That array is heavily commented BY DESIGN —
 * the comments are what stop the next person re-parking a test on a wrong label — and one of those
 * comments contains an apostrophe ("the test's own beforeAll").
 *
 * The damage was worse than a stray entry. A single unbalanced apostrophe shifts quote PAIRING for
 * everything after it, so the naive parser both INVENTED entries (`s own`) and SILENTLY DROPPED
 * dozens of real ones. It reported 42 dangling files where there is exactly one, and a count of 92
 * against a true 91.
 *
 * That count was not only wrong here: it was published in a release note. A parser that fails by
 * producing a plausible number is the exact failure this repository keeps finding — so the parser is
 * pinned against prose, not just against a clean list.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/recheck-parked-tests.mjs');

function runAgainstRealRepo(): { parkedTotal: number; missingFiles: string[]; globPatterns: string[] } {
  const res = spawnSync(process.execPath, [SCRIPT, '--missing-only', '--json'], {
    cwd: ROOT, encoding: 'utf-8', timeout: 120_000,
  });
  expect(res.status, res.stderr).toBe(0);
  return JSON.parse(res.stdout);
}

describe('parked-test re-check', () => {
  it('always exits 0 — it reports, it does not gate', () => {
    // Gating here would recreate the original problem from the other side: a red build for a test
    // somebody parked deliberately.
    const res = spawnSync(process.execPath, [SCRIPT, '--missing-only'], {
      cwd: ROOT, encoding: 'utf-8', timeout: 120_000,
    });
    expect(res.status).toBe(0);
  });

  it('THE PARSER: prose in the array does not become an entry', () => {
    const report = runAgainstRealRepo();
    // Every entry must look like a test path. `s own` — the fragment the naive parser produced from
    // an apostrophe in a comment — could never satisfy this.
    for (const f of [...report.missingFiles, ...report.globPatterns]) {
      expect(f, `${f} is not a test path`).toMatch(/^tests\//);
    }
    expect(report.parkedTotal).toBeGreaterThan(50);
  });

  it('RATCHET: the live exclusion list has no entry for a file that does not exist', () => {
    // This used to assert the OPPOSITE — that the report CONTAINS
    // 'tests/unit/slack-stall-active-gate.test.ts', the one real dangling entry
    // in the repo at the time. That made a known defect load-bearing: fixing the
    // dangling entry broke the test that used it as a fixture, and the only way
    // to go green was to put the defect back.
    //
    // The capability this was reaching for — "the tool detects an exclusion whose
    // file is gone" — is proven properly by the synthetic-config test below,
    // which builds two missing files and requires both to be found. That proof
    // does not need the repo to keep a defect around.
    //
    // So the assertion is inverted into a ratchet: the list must stay clean. Park
    // a test and later delete the file, and this goes red — which is the failure
    // the parked-list re-check exists to surface.
    const report = runAgainstRealRepo();
    expect(
      report.missingFiles,
      'an exclusion points at a file that no longer exists — remove the exclusion, do not re-add the file',
    ).toEqual([]);
  });

  it('reports glob patterns separately rather than pretending they are files', () => {
    const report = runAgainstRealRepo();
    for (const g of report.globPatterns) expect(g).toContain('*');
    // A glob must never be counted as a missing file — it resolves to many, or none.
    for (const g of report.globPatterns) expect(report.missingFiles).not.toContain(g);
  });

  it('REGRESSION: an apostrophe in a comment cannot corrupt the parse', () => {
    // Reproduces the exact failure in miniature, against a synthetic config.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recheck-parse-'));
    try {
      fs.writeFileSync(path.join(dir, 'vitest.push.config.ts'), [
        'const FLAKY_TESTS = [',
        "  // the test's own beforeAll regenerates it — an apostrophe, deliberately",
        "  'tests/unit/alpha.test.ts',",
        "  'tests/unit/beta.test.ts',",
        '];',
      ].join('\n'));
      fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/recheck-parked-tests.mjs'));

      const res = spawnSync(process.execPath, ['scripts/recheck-parked-tests.mjs', '--missing-only', '--json'], {
        cwd: dir, encoding: 'utf-8', timeout: 60_000,
      });
      const out = JSON.parse(res.stdout);
      expect(out.parkedTotal).toBe(2);
      expect(out.missingFiles.sort()).toEqual(['tests/unit/alpha.test.ts', 'tests/unit/beta.test.ts']);
    } finally {
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true, force: true,
        operation: 'tests/unit/recheck-parked-tests.test.ts:cleanup',
      });
    }
  });
});

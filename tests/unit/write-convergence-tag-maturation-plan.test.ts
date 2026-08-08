/**
 * Maturation-plan gate — REFUSES (Maturation Path clause (a), operator ruling 2026-08-07).
 *
 * This file previously pinned the v1 contract: "warns but still stamps a structurally
 * incomplete maturation plan". That was correct for v1, which shipped as a signal
 * deliberately so a corpus of real specs could be reviewed before promotion. The ruling
 * promoted it: a warn that never blocks is advice, and advice is exactly what "ships
 * dark, matures never" already ignores.
 *
 * Two-sided on purpose. An A-case alone would prove only that the harness can produce a
 * stamp; the refusal arms are what show the gate is load-bearing, and the "differs by
 * exactly one section" pair is what shows it refuses for ITS OWN reason rather than
 * because some earlier gate happened to fire.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const script = path.resolve('skills/spec-converge/scripts/write-convergence-tag.mjs');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'write-convergence-tag-maturation-plan.test cleanup' });
});

/** A spec that clears every gate BEFORE the maturation gate, so only `maturation` varies. */
function makeSpec(maturation: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maturation-gate-'));
  roots.push(root);
  const spec = path.join(root, 'spec.md');
  const report = path.join(root, 'report.md');
  const eli16 = path.join(root, 'spec.eli16.md');
  fs.writeFileSync(
    spec,
    `---\ntitle: probe\nslug: probe\neli16-overview: ${eli16}\n---\n# Probe\n\n## Decision points touched\n*(none)*\n${maturation}`,
  );
  fs.writeFileSync(report, '# report\n');
  fs.writeFileSync(eli16, 'x'.repeat(900));
  return { spec, report };
}

const COMPLETE_PLAN = [
  '',
  '## Maturation plan',
  '',
  '- **test-agent-live:** immediately',
  '- **dev-agent-live:** after one clean soak day',
  '- **fleet:** after operator review',
  '- **graduation criterion:** zero refusals attributable to the gate itself',
  '- **dark-window:** 14d',
  '',
].join('\n');

function run(spec: string, report: string) {
  return spawnSync(process.execPath, [script, '--spec', spec, '--iterations', '1', '--report', report], { encoding: 'utf8' });
}

describe('write-convergence-tag maturation gate — refuses, does not warn', () => {
  it('REFUSES a structurally incomplete maturation plan (the v1 warn case, now a block)', () => {
    const { spec, report } = makeSpec('\n## Maturation plan\n- **fleet:** later\n');
    const r = run(spec, report);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('MATURATION_PLAN_REFUSED');
    expect(r.stderr).toContain('invalid-fields');
    // The refusal must name what is missing, or the author cannot act on it.
    expect(r.stderr).toContain('test-agent-live');
    // And it must NOT have stamped.
    expect(fs.readFileSync(spec, 'utf8')).not.toContain('review-convergence:');
  });

  it('REFUSES a spec with no maturation section at all', () => {
    const { spec, report } = makeSpec('');
    const r = run(spec, report);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('MATURATION_PLAN_REFUSED');
    expect(r.stderr).toContain('missing-section');
    expect(fs.readFileSync(spec, 'utf8')).not.toContain('review-convergence:');
  });

  it('REFUSES a duplicated maturation section', () => {
    const { spec, report } = makeSpec(COMPLETE_PLAN + COMPLETE_PLAN);
    const r = run(spec, report);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('MATURATION_PLAN_REFUSED');
    expect(r.stderr).toContain('duplicate-section');
  });

  it('A-CASE: STAMPS a spec whose only difference is a complete maturation plan', () => {
    // Differs from the "no maturation section" case by exactly this section. Without
    // this arm the refusals above would also pass on a harness that refuses everything.
    const { spec, report } = makeSpec(COMPLETE_PLAN);
    const r = run(spec, report);

    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('MATURATION_PLAN_REFUSED');
    expect(fs.readFileSync(spec, 'utf8')).toContain('review-convergence:');
  });

  it('the refusal message renders the required-field list (it interpolates a module export)', () => {
    // Regression pin: the message interpolates REQUIRED_FIELDS from the detector module.
    // That symbol was initially NOT imported, which threw a ReferenceError on the refusal
    // path ONLY — invisible to every A-case, every lint and every other test. The error
    // path is the one nobody exercises, so it is exercised here deliberately.
    const { spec, report } = makeSpec('');
    const r = run(spec, report);

    expect(r.stderr).not.toContain('ReferenceError');
    for (const field of ['test-agent-live', 'dev-agent-live', 'fleet', 'graduation criterion', 'dark-window']) {
      expect(r.stderr).toContain(field);
    }
  });
});

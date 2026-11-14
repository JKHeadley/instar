/**
 * ACT-059 + ACT-053: CI workflow invariants.
 *
 * ACT-059 — every ci.yml job declares timeout-minutes. Without one a job
 * inherits GitHub's 6-hour default; on 2026-10-08 a hung unit shard held
 * PR 2141 BLOCKED for 6h00m while every other check was green. A job added
 * without a limit fails here.
 *
 * ACT-053 — a PR into a feature branch is never shown CLEAN: ci.yml stays
 * main-only (no full suite on every stacked push), and stacked-pr-guard.yml
 * turns every non-main-base PR red with the reason.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

type Job = { 'timeout-minutes'?: unknown; 'runs-on'?: unknown; steps?: Array<{ run?: string; uses?: string }> };
type Workflow = { on?: Record<string, unknown>; jobs?: Record<string, Job> };

function load(file: string): Workflow {
  const parsed = yaml.load(readFileSync(join(process.cwd(), '.github/workflows', file), 'utf8'));
  expect(parsed).toBeTypeOf('object');
  return parsed as Workflow;
}

describe('ci.yml — every job has a timeout (ACT-059)', () => {
  const jobs = Object.entries(load('ci.yml').jobs ?? {});

  it('has jobs to check', () => {
    expect(jobs.length).toBeGreaterThan(5);
  });

  for (const [id, job] of jobs) {
    it(`${id} declares a timeout-minutes between 1 and 120`, () => {
      const t = job['timeout-minutes'];
      expect(typeof t, `${id} has no timeout-minutes — it would inherit GitHub's 6-hour default`).toBe('number');
      expect(t as number).toBeGreaterThanOrEqual(1);
      // A limit near the 6h default is no limit; the slowest job measured ~35 min.
      expect(t as number).toBeLessThanOrEqual(120);
    });
  }

  it('the heavy test jobs keep headroom over their measured slowest runs (2026-11-02)', () => {
    const t = (id: string) => (load('ci.yml').jobs ?? {})[id]?.['timeout-minutes'] as number;
    expect(t('unit')).toBeGreaterThanOrEqual(45); // slowest shard 29.6 min
    expect(t('integration')).toBeGreaterThanOrEqual(40); // slowest 24.4 min
    expect(t('e2e')).toBeGreaterThanOrEqual(55); // slowest 34.9 min
  });
});

describe('stacked PRs are never shown CLEAN (ACT-053)', () => {
  it('ci.yml still runs the suite only for PRs into main (no extra load per stacked push)', () => {
    const pr = load('ci.yml').on?.pull_request as { branches?: string[] };
    expect(pr?.branches).toEqual(['main']);
  });

  it('stacked-pr-guard runs on every non-main base, including base changes', () => {
    const pr = load('stacked-pr-guard.yml').on?.pull_request as { types?: string[]; 'branches-ignore'?: string[]; branches?: string[] };
    expect(pr?.['branches-ignore']).toEqual(['main']);
    expect(pr?.branches).toBeUndefined();
    expect(pr?.types).toEqual(expect.arrayContaining(['opened', 'synchronize', 'reopened', 'edited']));
  });

  it('the guard job always fails, is cheap, and keeps the branch name out of the shell text', () => {
    const jobs = Object.values(load('stacked-pr-guard.yml').jobs ?? {});
    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    expect(job['timeout-minutes']).toBeLessThanOrEqual(5);
    const steps = job.steps ?? [];
    expect(steps.some((s) => s.uses)).toBe(false); // no checkout, no setup
    const run = steps.map((s) => s.run ?? '').join('\n');
    expect(run).toMatch(/exit 1\s*$/);
    // A branch name is attacker-chosen text: it must reach the script via env.
    expect(run).not.toContain('github.base_ref');
    expect(run).not.toContain('head_ref');
  });
});

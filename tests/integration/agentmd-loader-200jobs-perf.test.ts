/**
 * Loader cold-boot performance benchmark — 200-job synthetic fixture.
 *
 * Per INSTAR-JOBS-AS-AGENTMD spec §Performance Budgets:
 *   - Loader cold-boot @ 200 jobs: <1500 ms (CI benchmark fixture asserts this)
 *   - Loader warm-boot @ 200 jobs: <500 ms
 *
 * The fixture is generated at test-setup time (not committed) — the
 * generator is deterministic so the fixture content is stable across
 * runs. This avoids bloating the repo with 200 markdown files while
 * preserving the spec's CI-time assertion.
 *
 * "Cold-boot" here means the first loadJobs() call after fresh fixture
 * generation; "warm-boot" is a second call against the same fixture
 * (filesystem cache primed).
 *
 * The budget is intentionally generous (1500ms cold) — CI runners vary
 * in IO speed. If this benchmark becomes flaky on slow runners, the
 * remediation is to:
 *   1. Profile and identify the slow step.
 *   2. Optimize the loader's IO pattern.
 *   3. NOT to raise the budget — the spec's number is the contract.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadJobs } from '../../src/scheduler/JobLoader.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const NUM_JOBS = 200;
const COLD_BOOT_BUDGET_MS = 1500;
const WARM_BOOT_BUDGET_MS = 500;

describe('agentmd loader — 200-job cold-boot perf', () => {
  let workspace: string;
  let stateDir: string;

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-perf-'));
    stateDir = path.join(workspace, '.instar');
    generate200JobFixture(stateDir);
  });

  afterAll(() => {
    SafeFsExecutor.safeRmSync(workspace, { recursive: true, force: true, operation: 'agentmd-loader-200jobs-perf.test cleanup' });
  });

  it(`cold-boot loads ${NUM_JOBS} per-slug manifests in <${COLD_BOOT_BUDGET_MS}ms`, () => {
    const jobsFile = path.join(stateDir, 'jobs.json');
    const t0 = process.hrtime.bigint();
    const result = loadJobs(jobsFile);
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1_000_000;

    expect(result.length).toBeGreaterThanOrEqual(NUM_JOBS);
    expect(elapsedMs).toBeLessThan(COLD_BOOT_BUDGET_MS);

    // Informational: print measured time so CI logs show the actual cost.
    console.log(`[perf-benchmark] cold-boot loaded ${result.length} jobs in ${elapsedMs.toFixed(1)}ms (budget ${COLD_BOOT_BUDGET_MS}ms)`);
  });

  it(`warm-boot loads ${NUM_JOBS} per-slug manifests in <${WARM_BOOT_BUDGET_MS}ms`, () => {
    const jobsFile = path.join(stateDir, 'jobs.json');
    // Warm: filesystem cache is hot from the cold-boot test.
    const t0 = process.hrtime.bigint();
    const result = loadJobs(jobsFile);
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1_000_000;

    expect(result.length).toBeGreaterThanOrEqual(NUM_JOBS);
    expect(elapsedMs).toBeLessThan(WARM_BOOT_BUDGET_MS);

    console.log(`[perf-benchmark] warm-boot loaded ${result.length} jobs in ${elapsedMs.toFixed(1)}ms (budget ${WARM_BOOT_BUDGET_MS}ms)`);
  });
});

/**
 * Deterministic generator for the 200-job fixture. Produces:
 *   - `.instar/jobs/user/<slug>.md` × 200 with realistic-shaped bodies
 *   - `.instar/jobs/schedule/<slug>.json` × 200 with valid manifests
 *   - `.instar/jobs.json` empty array (the per-slug manifests are the source of truth)
 *
 * Bodies are sized in the 200–600 char range to mirror the typical
 * default-job prompt distribution.
 */
function generate200JobFixture(stateDir: string): void {
  const userDir = path.join(stateDir, 'jobs', 'user');
  const scheduleDir = path.join(stateDir, 'jobs', 'schedule');
  fs.mkdirSync(userDir, { recursive: true });
  fs.mkdirSync(scheduleDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'jobs.json'), '[]', 'utf-8');

  const bodyFragments = [
    'Check the health endpoint. Report any anomalies in plain English.',
    'Summarize the last 24 hours of activity. Highlight unusual patterns.',
    'Review recent commits for security implications. List concerns with severity.',
    'Audit the relationship registry. Flag stale entries.',
    'Scan the degradation digest. Surface any new escalations.',
  ];

  for (let i = 0; i < NUM_JOBS; i++) {
    const slug = `perf-job-${String(i).padStart(3, '0')}`;
    const bodyBase = bodyFragments[i % bodyFragments.length];
    const body = `# ${slug}\n\n${bodyBase}\n\nJob index: ${i}. Synthetic fixture for perf benchmark.\n`;
    const frontmatter = [
      `name: "${slug}"`,
      'description: "synthetic perf fixture job"',
      'toolAllowlist: ["Read"]',
    ].join('\n');
    fs.writeFileSync(path.join(userDir, `${slug}.md`), `---\n${frontmatter}\n---\n${body}`, 'utf-8');

    fs.writeFileSync(
      path.join(scheduleDir, `${slug}.json`),
      JSON.stringify({
        slug,
        origin: 'user',
        schedule: `${i % 60} * * * *`,
        priority: 'low',
        expectedDurationMinutes: 1,
        model: 'haiku',
        enabled: true,
        execute: { type: 'agentmd' },
        manifestVersion: 1,
      }, null, 2),
      'utf-8',
    );
  }
}

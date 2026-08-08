/**
 * B3.1 — CrashLoopPauser is WIRED AT BOOT, and pauses a SEEDED crash-loop.
 *
 * ── Why this file exists, and why it is not another unit test ──────────────
 *
 * `tests/unit/crash-loop-pauser.test.ts` constructs the class EIGHT times and
 * passes. Production source constructed it ZERO times. So eight green tests
 * measured "this class behaves correctly when constructed" while a real job
 * failed 492 consecutive times and nothing paused it — and the suite was read
 * as "this guard works."
 *
 * That is the registry's own defect class: **a passing condition narrower than
 * what the result certifies** (*Verify the State, Not Its Symbol*, tooth D). The
 * missing assertion was never about the class's logic. It was about whether
 * anything constructs it.
 *
 * This file makes both halves checkable:
 *   1. A RATCHET on the boot path — production source must construct it. This
 *      test FAILS on the tree as it stood before B3.1, which is the only
 *      evidence that it is testing the thing that was actually broken.
 *   2. A SEEDED crash-loop driven end-to-end through the same construction the
 *      boot path performs, asserting the job is really disabled on disk.
 *
 * Per the rung-three amendment ratified 2026-08-06, both axes are covered: the
 * guard must ACT on a genuine crash-loop AND HOLD BACK on the jobs its safety
 * rails protect. An A-case alone would certify only half of it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CrashLoopPauser } from '../../src/monitoring/CrashLoopPauser.js';
import { JobRunHistory } from '../../src/scheduler/JobRunHistory.js';
import type { JobDefinition } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function mkJob(over: Partial<JobDefinition>): JobDefinition {
  return {
    slug: 'sample', name: 'Sample', description: 'd', schedule: '0 * * * *',
    priority: 'medium', expectedDurationMinutes: 5, model: 'sonnet', enabled: true,
    execute: { type: 'prompt', prompt: 'noop' } as unknown as JobDefinition['execute'],
    ...over,
  };
}

describe('B3.1 ratchet — the boot path constructs CrashLoopPauser', () => {
  /**
   * The assertion that was missing for the entire life of the defect. Before
   * B3.1 this fails: `new CrashLoopPauser` appeared nowhere outside tests.
   */
  it('production source constructs CrashLoopPauser (it was written, tested, and never wired)', () => {
    const boot = fs.readFileSync(path.join(repoRoot, 'src', 'commands', 'server.ts'), 'utf8');
    expect(boot).toContain('new CrashLoopPauser(');
  });

  it('the construction is reached on the scheduler-enabled boot path, not dead code', () => {
    const boot = fs.readFileSync(path.join(repoRoot, 'src', 'commands', 'server.ts'), 'utf8');
    const at = boot.indexOf('new CrashLoopPauser(');
    expect(at).toBeGreaterThan(-1);
    // It must sit after the scheduler is started — the run history it consumes
    // does not exist before that.
    expect(boot.lastIndexOf('scheduler.start()', at)).toBeGreaterThan(-1);
  });

  it('it is a declared guard, not exempted as scheduler-internal mechanics', async () => {
    const manifest = fs.readFileSync(path.join(repoRoot, 'src', 'monitoring', 'guardManifest.ts'), 'utf8');
    // The old NOT_A_GUARD reason presumed it ran. A guard that is wired must be
    // reportable by the inventory, or "/guards says nothing about it" becomes
    // indistinguishable from "it is fine".
    expect(manifest).toContain("component: 'CrashLoopPauser'");
    expect(manifest).not.toContain('Auto-pause of runaway jobs is scheduler-internal mechanics');
  });
});

describe('B3.1 — a SEEDED crash-loop is actually paused', () => {
  let dir: string;
  let history: JobRunHistory;
  let jobsFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clp-boot-'));
    history = new JobRunHistory(dir);
    jobsFile = path.join(dir, 'jobs.json');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/crash-loop-pauser-wired-at-boot.test.ts' });
  });

  function seedCrashLoop(slug: string, count: number): void {
    for (let i = 0; i < count; i++) {
      const runId = history.recordStart({ slug, sessionId: `s-${i}`, trigger: 'scheduled' });
      history.recordCompletion({ runId, result: 'failure', error: 'tool_use_incomplete' });
    }
  }
  function writeJobs(jobs: JobDefinition[]): void {
    fs.writeFileSync(jobsFile, JSON.stringify({ jobs }, null, 2) + '\n');
  }

  it('ACTS: disables the runaway job on disk and records why', () => {
    const jobs = [mkJob({ slug: 'runaway' })];
    writeJobs(jobs);
    seedCrashLoop('runaway', 4);

    const result = new CrashLoopPauser(history).run({ jobs, jobsFile, dryRun: false });

    expect(result.paused).toEqual(['runaway']);
    const onDisk = JSON.parse(fs.readFileSync(jobsFile, 'utf8')) as { jobs: Array<Record<string, unknown>> };
    const job = onDisk.jobs.find((j) => j.slug === 'runaway')!;
    // The state of the world, not the return value's account of it.
    expect(job.enabled).toBe(false);
    const note = job._crashPauseNote as Record<string, unknown>;
    expect(note.reason).toBe('failures');
    expect(note.failureCount).toBe(4);
    expect(note.lastError).toBe('tool_use_incomplete');
    // Provenance survives independently of the jobs file.
    const audit = fs.readFileSync(path.join(dir, 'crash-loop-pauses.jsonl'), 'utf8');
    expect(audit).toContain('runaway');
  });

  it('HOLDS BACK in dry-run: names the candidate and changes nothing on disk', () => {
    const jobs = [mkJob({ slug: 'runaway' })];
    writeJobs(jobs);
    const before = fs.readFileSync(jobsFile, 'utf8');
    seedCrashLoop('runaway', 4);

    // The shipped default. If dry-run ever silently mutated, the graduated
    // rollout would be a fiction.
    const result = new CrashLoopPauser(history).run({ jobs, jobsFile, dryRun: true });

    expect(result.candidates.map((c) => c.slug)).toEqual(['runaway']);
    expect(result.paused).toEqual([]);
    expect(fs.readFileSync(jobsFile, 'utf8')).toBe(before);
  });

  it('HOLDS BACK on a critical job, however hard it crash-loops', () => {
    const jobs = [mkJob({ slug: 'vital', priority: 'critical' })];
    writeJobs(jobs);
    seedCrashLoop('vital', 20);

    const result = new CrashLoopPauser(history).run({ jobs, jobsFile, dryRun: false });

    expect(result.paused).toEqual([]);
    expect((JSON.parse(fs.readFileSync(jobsFile, 'utf8')) as { jobs: Array<Record<string, unknown>> })
      .jobs.find((j) => j.slug === 'vital')!.enabled).toBe(true);
  });

  it('HOLDS BACK on the built-in deny-list, and config slugs ADD to it rather than replacing it', () => {
    const jobs = [mkJob({ slug: 'session-reaper' }), mkJob({ slug: 'extra' }), mkJob({ slug: 'runaway' })];
    writeJobs(jobs);
    seedCrashLoop('session-reaper', 9);
    seedCrashLoop('extra', 9);
    seedCrashLoop('runaway', 9);

    // Mirrors the boot path: operator slugs are unioned with the built-ins, so
    // naming one unrelated job cannot make session-reaper pausable.
    const pauser = new CrashLoopPauser(history, {
      neverPause: new Set(['infrastructure-auto-fixer', 'orphan-reaper', 'session-reaper', 'extra']),
    });
    const result = pauser.run({ jobs, jobsFile, dryRun: false });

    expect(result.paused).toEqual(['runaway']);
    const onDisk = JSON.parse(fs.readFileSync(jobsFile, 'utf8')) as { jobs: Array<Record<string, unknown>> };
    expect(onDisk.jobs.find((j) => j.slug === 'session-reaper')!.enabled).toBe(true);
    expect(onDisk.jobs.find((j) => j.slug === 'extra')!.enabled).toBe(true);
  });

  it('HOLDS BACK on a healthy job — the negative control that proves it does not fire indiscriminately', () => {
    const jobs = [mkJob({ slug: 'healthy' })];
    writeJobs(jobs);
    for (let i = 0; i < 10; i++) {
      const runId = history.recordStart({ slug: 'healthy', sessionId: `ok-${i}`, trigger: 'scheduled' });
      history.recordCompletion({ runId, result: 'success' });
    }

    const result = new CrashLoopPauser(history).run({ jobs, jobsFile, dryRun: false });

    expect(result.candidates).toEqual([]);
    expect((JSON.parse(fs.readFileSync(jobsFile, 'utf8')) as { jobs: Array<Record<string, unknown>> })
      .jobs.find((j) => j.slug === 'healthy')!.enabled).toBe(true);
  });
});

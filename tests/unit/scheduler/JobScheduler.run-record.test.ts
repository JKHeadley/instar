/**
 * Phase 1b — Run-record observability fields.
 *
 * The scheduler annotates each run record with structural metadata so
 * the Dashboard and the Issues card can correlate runs back to the
 * exact body+frontmatter pair that fired (spec §"Run-record observability"):
 *
 *   - origin: "instar" | "user" | "legacy"
 *   - resolvedPath: path of the .md file (null for non-agentmd)
 *   - bodyHash + frontmatterHash: sha256 over canonicalized content
 *   - manifestVersion: monotonic counter from the per-slug manifest
 *   - toolAllowlist, unrestrictedTools, clampedAllowlist: allowlist resolution
 *
 * Row size is capped at 2 KB. Larger rows condense non-essential fields and
 * record a durable outcome; only an impossible-to-fit row is a degradation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JobScheduler } from '../../../src/scheduler/JobScheduler.js';
import { JobRunHistory } from '../../../src/scheduler/JobRunHistory.js';
import { DegradationReporter } from '../../../src/monitoring/DegradationReporter.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import type { JobDefinition } from '../../../src/core/types.js';

const baseJob: Omit<JobDefinition, 'slug' | 'execute' | 'frontmatter' | 'body' | 'origin'> = {
  name: 'A',
  description: 'A',
  schedule: '*/5 * * * *',
  priority: 'low',
  expectedDurationMinutes: 1,
  model: 'haiku',
  enabled: true,
};

describe('JobScheduler.computeRunObservability (Phase 1b, pure)', () => {
  it('populates origin/resolvedPath/hashes/manifestVersion for agentmd entries', () => {
    const job: JobDefinition = {
      ...baseJob,
      slug: 'health',
      execute: { type: 'agentmd' },
      origin: 'instar',
      body: '# Health Check\n\nDo it.\n',
      frontmatter: { name: 'Health', toolAllowlist: ['Read'] },
      resolvedPath: '/abs/path/instar/health.md',
      manifestVersion: 17,
    };
    const resolution = JobScheduler.resolveAllowlist(job);
    const obs = JobScheduler.computeRunObservability(job, resolution);

    expect(obs.origin).toBe('instar');
    expect(obs.resolvedPath).toBe('/abs/path/instar/health.md');
    expect(obs.bodyHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(obs.frontmatterHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(obs.manifestVersion).toBe(17);
    expect(obs.toolAllowlist).toEqual(['Read']);
    expect(obs.clampedAllowlist).toBe(false);
  });

  it('produces stable hashes for the same content (deterministic)', () => {
    const make = (): JobDefinition => ({
      ...baseJob,
      slug: 'same',
      execute: { type: 'agentmd' },
      origin: 'user',
      body: 'identical body',
      frontmatter: { description: 'd', toolAllowlist: ['Read'] },
    });
    const a = JobScheduler.computeRunObservability(make(), JobScheduler.resolveAllowlist(make()));
    const b = JobScheduler.computeRunObservability(make(), JobScheduler.resolveAllowlist(make()));
    expect(a.bodyHash).toBe(b.bodyHash);
    expect(a.frontmatterHash).toBe(b.frontmatterHash);
  });

  it('produces stable frontmatterHash regardless of YAML key order', () => {
    // Canonicalize must sort keys at every level so the same logical
    // frontmatter produces the same hash even when JS object insertion
    // order differs.
    const j1: JobDefinition = {
      ...baseJob,
      slug: 's', execute: { type: 'agentmd' }, origin: 'user', body: 'x',
      frontmatter: { description: 'd', toolAllowlist: ['Read'] },
    };
    const j2: JobDefinition = {
      ...baseJob,
      slug: 's', execute: { type: 'agentmd' }, origin: 'user', body: 'x',
      frontmatter: { toolAllowlist: ['Read'], description: 'd' },
    };
    const a = JobScheduler.computeRunObservability(j1, JobScheduler.resolveAllowlist(j1));
    const b = JobScheduler.computeRunObservability(j2, JobScheduler.resolveAllowlist(j2));
    expect(a.frontmatterHash).toBe(b.frontmatterHash);
  });

  it('returns origin:"legacy" with null hashes for non-agentmd entries', () => {
    const job: JobDefinition = {
      ...baseJob,
      slug: 'legacy',
      execute: { type: 'prompt', value: 'hi' },
    };
    const obs = JobScheduler.computeRunObservability(job, JobScheduler.resolveAllowlist(job));
    expect(obs.origin).toBe('legacy');
    expect(obs.resolvedPath).toBeNull();
    expect(obs.bodyHash).toBeNull();
    expect(obs.frontmatterHash).toBeNull();
    expect(obs.manifestVersion).toBeNull();
    expect(obs.toolAllowlist).toBeNull();
    expect(obs.clampedAllowlist).toBe(false);
  });

  it('emits clampedAllowlist:true when "*" without unrestrictedTools', () => {
    const job: JobDefinition = {
      ...baseJob,
      slug: 'clamp', execute: { type: 'agentmd' }, origin: 'user',
      body: 'b', frontmatter: { toolAllowlist: '*' },
      unrestrictedTools: false,
    };
    const obs = JobScheduler.computeRunObservability(job, JobScheduler.resolveAllowlist(job));
    expect(obs.clampedAllowlist).toBe(true);
    expect(obs.toolAllowlist).toEqual(['Read']);
  });

  it('emits toolAllowlist:"*" when unrestricted is authorized', () => {
    const job: JobDefinition = {
      ...baseJob,
      slug: 'free', execute: { type: 'agentmd' }, origin: 'user',
      body: 'b', frontmatter: { toolAllowlist: '*' },
      unrestrictedTools: true,
    };
    const obs = JobScheduler.computeRunObservability(job, JobScheduler.resolveAllowlist(job));
    expect(obs.toolAllowlist).toBe('*');
    expect(obs.unrestrictedTools).toBe(true);
    expect(obs.clampedAllowlist).toBe(false);
  });
});

describe('JobScheduler.canonicalize (Phase 1b, pure)', () => {
  it('sorts object keys recursively', () => {
    const a = JobScheduler.canonicalize({ b: 1, a: 2, c: { y: 1, x: 2 } });
    const b = JobScheduler.canonicalize({ c: { x: 2, y: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it('preserves array order', () => {
    expect(JobScheduler.canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('encodes null, true, numbers, strings the same as JSON.stringify', () => {
    expect(JobScheduler.canonicalize(null)).toBe('null');
    expect(JobScheduler.canonicalize(true)).toBe('true');
    expect(JobScheduler.canonicalize(42)).toBe('42');
    expect(JobScheduler.canonicalize('hi')).toBe('"hi"');
  });
});

describe('JobRunHistory row-size cap (Phase 1b, integration)', () => {
  let stateDir: string;
  let history: JobRunHistory;
  let reportSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-runhist-'));
    DegradationReporter.resetForTesting();
    reportSpy = vi.spyOn(DegradationReporter.getInstance(), 'report');
    history = new JobRunHistory(stateDir);
  });

  afterEach(() => {
    reportSpy.mockRestore();
    DegradationReporter.resetForTesting();
    SafeFsExecutor.safeRmSync(stateDir, {
      recursive: true, force: true,
      operation: 'tests/unit/scheduler/JobScheduler.run-record.test.ts:afterEach',
    });
  });

  it('persists Phase 1b observability fields on recordStart', () => {
    const runId = history.recordStart({
      slug: 'health',
      sessionId: 'sess-1',
      trigger: 'scheduled',
      model: 'haiku',
      origin: 'instar',
      resolvedPath: '/abs/path/instar/health.md',
      bodyHash: 'sha256:abc123',
      frontmatterHash: 'sha256:def456',
      manifestVersion: 17,
      toolAllowlist: ['Read'],
      unrestrictedTools: false,
      clampedAllowlist: false,
    });
    const run = history.findRun(runId);
    expect(run).toBeDefined();
    expect(run!.origin).toBe('instar');
    expect(run!.resolvedPath).toBe('/abs/path/instar/health.md');
    expect(run!.bodyHash).toBe('sha256:abc123');
    expect(run!.frontmatterHash).toBe('sha256:def456');
    expect(run!.manifestVersion).toBe(17);
    expect(run!.toolAllowlist).toEqual(['Read']);
    expect(run!.unrestrictedTools).toBe(false);
    expect(run!.clampedAllowlist).toBe(false);
  });

  it('persists null hashes for legacy entries (back-compat-friendly)', () => {
    const runId = history.recordStart({
      slug: 'legacy',
      sessionId: 'sess-2',
      trigger: 'scheduled',
      model: 'haiku',
      origin: 'legacy',
    });
    const run = history.findRun(runId);
    expect(run).toBeDefined();
    expect(run!.origin).toBe('legacy');
    expect(run!.resolvedPath).toBeNull();
    expect(run!.bodyHash).toBeNull();
    expect(run!.frontmatterHash).toBeNull();
    expect(run!.manifestVersion).toBeNull();
    expect(run!.toolAllowlist).toBeNull();
    expect(run!.clampedAllowlist).toBe(false);
  });

  it('condenses non-essential fields without reporting healthy cap enforcement as a defect', () => {
    // Create a base row then record a completion with a huge outputSummary.
    const runId = history.recordStart({
      slug: 'big',
      sessionId: 'sess-3',
      trigger: 'scheduled',
      model: 'haiku',
      origin: 'user',
    });
    // 3 KB string — well over the 2 KB row cap
    const huge = 'A'.repeat(3 * 1024);
    history.recordCompletion({
      runId,
      result: 'success',
      outputSummary: huge,
    });
    const run = history.findRun(runId);
    expect(run).toBeDefined();
    // Truncation must have triggered:
    expect(run!.truncated).toBe(true);
    // outputSummary should have been dropped (largest field is truncated first):
    expect(run!.outputSummary).toBeUndefined();
    // Essential fields preserved:
    expect(run!.slug).toBe('big');
    expect(run!.runId).toBe(runId);
    expect(run!.result).toBe('success');
    expect(run!.origin).toBe('user');

    expect(history.stats('big').budgetCondensedRuns).toBe(1);
    expect(reportSpy).not.toHaveBeenCalled();
  });

  it('does NOT truncate or report when the row is within the cap', () => {
    const runId = history.recordStart({
      slug: 'tiny',
      sessionId: 'sess-4',
      trigger: 'scheduled',
      origin: 'user',
    });
    history.recordCompletion({
      runId,
      result: 'success',
      outputSummary: 'all good',
    });
    const run = history.findRun(runId);
    expect(run).toBeDefined();
    expect(run!.truncated).toBeUndefined();
    expect(run!.outputSummary).toBe('all good');
    // No row-cap-related degradation report
    const truncReports = reportSpy.mock.calls.filter(c =>
      c[0]?.feature === 'JobRunHistory.appendLine',
    );
    expect(truncReports.length).toBe(0);
  });
});

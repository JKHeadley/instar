/**
 * Phase 1b — per-job tool-allowlist enforcement at spawn time.
 *
 * Exercises the JobScheduler.resolveAllowlist static helper (pure
 * function on JobDefinition) AND threads it through a stubbed
 * spawnSession to assert the right `--allowedTools` value flows
 * through to the Claude Code argv.
 *
 * Decision matrix (INSTAR-JOBS-AS-AGENTMD spec §5):
 *   - Array → kind:array, allowlist:[...]
 *   - "*" + unrestrictedTools:true → kind:unrestricted, allowlist:"*", flag omitted
 *   - "*" + unrestrictedTools:false/missing → kind:clamped, allowlist:["Read"], event + run-record flag
 *   - missing + origin:user → kind:default-user, allowlist:["Read"]
 *   - missing + origin:instar → kind:instar-no-allowlist, allowlist:null, degradation event (Phase 1c gap)
 *   - legacy execute.type → kind:legacy, allowlist:null
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateManager } from '../../../src/core/StateManager.js';
import { SessionManager } from '../../../src/core/SessionManager.js';
import { JobScheduler } from '../../../src/scheduler/JobScheduler.js';
import { DegradationReporter } from '../../../src/monitoring/DegradationReporter.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import type {
  JobDefinition,
  JobSchedulerConfig,
  SessionManagerConfig,
} from '../../../src/core/types.js';

const baseJob: Omit<JobDefinition, 'slug' | 'execute' | 'frontmatter' | 'body' | 'origin' | 'unrestrictedTools'> = {
  name: 'A',
  description: 'A',
  schedule: '*/5 * * * *',
  priority: 'low',
  expectedDurationMinutes: 1,
  model: 'haiku',
  enabled: true,
};

function makeAgentMdJob(opts: {
  slug: string;
  origin: 'instar' | 'user';
  frontmatter?: Record<string, unknown>;
  unrestrictedTools?: boolean;
  body?: string;
}): JobDefinition {
  return {
    ...baseJob,
    slug: opts.slug,
    execute: { type: 'agentmd' },
    origin: opts.origin,
    frontmatter: opts.frontmatter ?? {},
    unrestrictedTools: opts.unrestrictedTools,
    body: opts.body ?? `# ${opts.slug}\n\nDo the thing.\n`,
  };
}

describe('JobScheduler.resolveAllowlist (Phase 1b, pure)', () => {
  it('returns kind:array for an array allowlist', () => {
    const job = makeAgentMdJob({ slug: 'j', origin: 'user', frontmatter: { toolAllowlist: ['Read'] } });
    const r = JobScheduler.resolveAllowlist(job);
    expect(r.kind).toBe('array');
    expect(r.allowlist).toEqual(['Read']);
    expect(r.unrestrictedTools).toBe(false);
    expect(r.clampedAllowlist).toBe(false);
  });

  it('preserves multi-entry arrays', () => {
    const job = makeAgentMdJob({
      slug: 'j', origin: 'user',
      frontmatter: { toolAllowlist: ['Read', 'Bash', 'Edit'] },
    });
    const r = JobScheduler.resolveAllowlist(job);
    expect(r.kind).toBe('array');
    expect(r.allowlist).toEqual(['Read', 'Bash', 'Edit']);
  });

  it('returns kind:unrestricted when "*" pairs with unrestrictedTools:true', () => {
    const job = makeAgentMdJob({
      slug: 'j', origin: 'user',
      frontmatter: { toolAllowlist: '*' },
      unrestrictedTools: true,
    });
    const r = JobScheduler.resolveAllowlist(job);
    expect(r.kind).toBe('unrestricted');
    expect(r.allowlist).toBe('*');
    expect(r.unrestrictedTools).toBe(true);
    expect(r.clampedAllowlist).toBe(false);
  });

  it('returns kind:clamped when "*" without unrestrictedTools:true', () => {
    const job = makeAgentMdJob({
      slug: 'j', origin: 'user',
      frontmatter: { toolAllowlist: '*' },
      unrestrictedTools: false,
    });
    const r = JobScheduler.resolveAllowlist(job);
    expect(r.kind).toBe('clamped');
    expect(r.allowlist).toEqual(['Read']);
    expect(r.unrestrictedTools).toBe(false);
    expect(r.clampedAllowlist).toBe(true);
  });

  it('returns kind:clamped when "*" without unrestrictedTools field at all', () => {
    const job = makeAgentMdJob({
      slug: 'j', origin: 'user',
      frontmatter: { toolAllowlist: '*' },
      // unrestrictedTools intentionally omitted
    });
    const r = JobScheduler.resolveAllowlist(job);
    expect(r.kind).toBe('clamped');
    expect(r.allowlist).toEqual(['Read']);
    expect(r.clampedAllowlist).toBe(true);
  });

  it('returns kind:default-user when allowlist missing on a user-origin job', () => {
    const job = makeAgentMdJob({ slug: 'j', origin: 'user', frontmatter: {} });
    const r = JobScheduler.resolveAllowlist(job);
    expect(r.kind).toBe('default-user');
    expect(r.allowlist).toEqual(['Read']);
  });

  it('returns kind:instar-no-allowlist when allowlist missing on an instar-origin job', () => {
    const job = makeAgentMdJob({ slug: 'j', origin: 'instar', frontmatter: {} });
    const r = JobScheduler.resolveAllowlist(job);
    expect(r.kind).toBe('instar-no-allowlist');
    // Phase 1c will close this gap via lock-file defaults. Until then,
    // null means "full tools" (back-compat) — the temporary documented behavior.
    expect(r.allowlist).toBeNull();
    expect(r.unrestrictedTools).toBe(false);
  });

  it('returns kind:legacy for non-agentmd execute.type', () => {
    const job: JobDefinition = {
      ...baseJob,
      slug: 'legacy',
      execute: { type: 'prompt', value: 'hi' },
    };
    const r = JobScheduler.resolveAllowlist(job);
    expect(r.kind).toBe('legacy');
    expect(r.allowlist).toBeNull();
  });
});

describe('JobScheduler.resolveAllowlist lockTrust gap-closure', () => {
  // ─── Real-tamper lockTrust states clamp instar elevation ──────────────────

  for (const lockTrust of ['untrusted-bad-signature', 'untrusted-not-in-lockfile', 'untrusted-hash-mismatch'] as const) {
    it(`refuses "*" + unrestrictedTools elevation for origin:instar when lockTrust=${lockTrust}`, () => {
      const job: JobDefinition = {
        ...makeAgentMdJob({
          slug: 'j', origin: 'instar',
          frontmatter: { toolAllowlist: '*' },
          unrestrictedTools: true,
        }),
        lockTrust,
      };
      const r = JobScheduler.resolveAllowlist(job);
      expect(r.kind).toBe('lock-untrusted-clamped');
      expect(r.allowlist).toEqual(['Read']);
      expect(r.unrestrictedTools).toBe(false);
      expect(r.clampedAllowlist).toBe(true);
      expect(r.lockUntrustedClamp).toBe(true);
    });

    it(`refuses the implicit full-tools fallback for origin:instar no-allowlist when lockTrust=${lockTrust}`, () => {
      const job: JobDefinition = {
        ...makeAgentMdJob({ slug: 'j', origin: 'instar', frontmatter: {} }),
        lockTrust,
      };
      const r = JobScheduler.resolveAllowlist(job);
      expect(r.kind).toBe('lock-untrusted-clamped');
      expect(r.allowlist).toEqual(['Read']);
      expect(r.lockUntrustedClamp).toBe(true);
    });
  }

  // ─── Trusted + transitional preserve elevation (seamless migration) ───────

  it('allows "*" + unrestrictedTools elevation for origin:instar when lockTrust=trusted', () => {
    const job: JobDefinition = {
      ...makeAgentMdJob({
        slug: 'j', origin: 'instar',
        frontmatter: { toolAllowlist: '*' },
        unrestrictedTools: true,
      }),
      lockTrust: 'trusted',
    };
    const r = JobScheduler.resolveAllowlist(job);
    expect(r.kind).toBe('unrestricted');
    expect(r.allowlist).toBe('*');
    expect(r.unrestrictedTools).toBe(true);
    expect(r.lockUntrustedClamp).toBeUndefined();
  });

  it('allows elevation when lockTrust=untrusted-no-lockfile (transitional, pre-Phase-1c-build)', () => {
    // This is the "every existing agent right after applying the update" state.
    // Clamping here would break working agents on the seamless-migration path.
    const job: JobDefinition = {
      ...makeAgentMdJob({
        slug: 'j', origin: 'instar',
        frontmatter: { toolAllowlist: '*' },
        unrestrictedTools: true,
      }),
      lockTrust: 'untrusted-no-lockfile',
    };
    const r = JobScheduler.resolveAllowlist(job);
    expect(r.kind).toBe('unrestricted');
    expect(r.allowlist).toBe('*');
    expect(r.lockUntrustedClamp).toBeUndefined();
  });

  it('preserves instar-no-allowlist behavior when lockTrust=untrusted-no-lockfile (transitional)', () => {
    const job: JobDefinition = {
      ...makeAgentMdJob({ slug: 'j', origin: 'instar', frontmatter: {} }),
      lockTrust: 'untrusted-no-lockfile',
    };
    const r = JobScheduler.resolveAllowlist(job);
    expect(r.kind).toBe('instar-no-allowlist');
    expect(r.allowlist).toBeNull();
  });

  // ─── User-origin jobs unaffected by lockTrust gating ──────────────────────

  it('does NOT clamp user-origin jobs based on lockTrust (gate is instar-scoped)', () => {
    const job: JobDefinition = {
      ...makeAgentMdJob({
        slug: 'j', origin: 'user',
        frontmatter: { toolAllowlist: '*' },
        unrestrictedTools: true,
      }),
      // User jobs have no lockTrust by design; even if a stale value leaks
      // through, the gate must not fire (this is a defense-in-depth assertion).
      lockTrust: 'untrusted-bad-signature' as JobDefinition['lockTrust'],
    };
    const r = JobScheduler.resolveAllowlist(job);
    expect(r.kind).toBe('unrestricted');
    expect(r.allowlist).toBe('*');
  });

  // ─── isLockUntrustedTamper classifier ─────────────────────────────────────

  it('isLockUntrustedTamper classifies the three real-tamper states as tamper', () => {
    expect(JobScheduler.isLockUntrustedTamper('untrusted-bad-signature')).toBe(true);
    expect(JobScheduler.isLockUntrustedTamper('untrusted-not-in-lockfile')).toBe(true);
    expect(JobScheduler.isLockUntrustedTamper('untrusted-hash-mismatch')).toBe(true);
  });

  it('isLockUntrustedTamper classifies trusted, transitional, and undefined as NOT tamper', () => {
    expect(JobScheduler.isLockUntrustedTamper('trusted')).toBe(false);
    expect(JobScheduler.isLockUntrustedTamper('untrusted-no-lockfile')).toBe(false);
    expect(JobScheduler.isLockUntrustedTamper(undefined)).toBe(false);
  });
});

describe('JobScheduler agentmd spawn-time allowlist plumbing (Phase 1b, integration)', () => {
  let stateDir: string;
  let state: StateManager;
  let sessionManager: SessionManager;
  let scheduler: JobScheduler;
  let spawnSpy: ReturnType<typeof vi.fn>;
  let reportSpy: ReturnType<typeof vi.spyOn>;

  const schedulerConfig: JobSchedulerConfig = {
    jobsFile: '',
    enabled: true,
    maxParallelJobs: 1,
    quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
  };

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-allowlist-'));
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    state = new StateManager(stateDir);

    const sessionConfig: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/bin/claude',
      projectDir: stateDir,
      maxSessions: 10,
      protectedSessions: [],
      completionPatterns: [],
    };
    sessionManager = new SessionManager(sessionConfig, state);

    spawnSpy = vi.fn().mockResolvedValue({
      id: 'stub', name: 'stub', status: 'running', tmuxSession: 'stub-tmux',
      startedAt: new Date().toISOString(),
    });
    (sessionManager as unknown as { spawnSession: typeof spawnSpy }).spawnSession = spawnSpy;

    DegradationReporter.resetForTesting();
    reportSpy = vi.spyOn(DegradationReporter.getInstance(), 'report');

    scheduler = new JobScheduler(schedulerConfig, sessionManager, state, stateDir);
  });

  afterEach(() => {
    reportSpy.mockRestore();
    DegradationReporter.resetForTesting();
    SafeFsExecutor.safeRmSync(stateDir, {
      recursive: true, force: true,
      operation: 'tests/unit/scheduler/JobScheduler.tool-allowlist.test.ts:afterEach',
    });
  });

  async function trigger(job: JobDefinition): Promise<{ allowedTools?: string[] }> {
    (scheduler as unknown as { jobs: JobDefinition[] }).jobs = [job];
    await scheduler.triggerJob(job.slug, 'test');
    await new Promise(r => setImmediate(r));
    const call = spawnSpy.mock.calls[0]?.[0] as { allowedTools?: string[] };
    return { allowedTools: call?.allowedTools };
  }

  it('threads [Read] into spawn args', async () => {
    const job = makeAgentMdJob({ slug: 'j1', origin: 'user', frontmatter: { toolAllowlist: ['Read'] } });
    const { allowedTools } = await trigger(job);
    expect(allowedTools).toEqual(['Read']);
  });

  it('threads [Read, Bash] into spawn args', async () => {
    const job = makeAgentMdJob({
      slug: 'j2', origin: 'instar',
      frontmatter: { toolAllowlist: ['Read', 'Bash'] },
    });
    const { allowedTools } = await trigger(job);
    expect(allowedTools).toEqual(['Read', 'Bash']);
  });

  it('omits the flag for "*" + unrestrictedTools:true', async () => {
    const job = makeAgentMdJob({
      slug: 'j3', origin: 'user',
      frontmatter: { toolAllowlist: '*' },
      unrestrictedTools: true,
    });
    const { allowedTools } = await trigger(job);
    // "*" + unrestrictedTools → null/undefined to omit the flag
    expect(allowedTools).toBeUndefined();
  });

  it('clamps "*" without unrestrictedTools to [Read] AND emits the clamp signal', async () => {
    const job = makeAgentMdJob({
      slug: 'j4', origin: 'user',
      frontmatter: { toolAllowlist: '*' },
      unrestrictedTools: false,
    });
    const { allowedTools } = await trigger(job);
    expect(allowedTools).toEqual(['Read']);

    // Dashboard event recorded via state.appendEvent (JSONL log):
    const events = state.queryEvents({ type: 'job_allowlist_clamped', limit: 50 });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].metadata?.slug).toBe('j4');

    // Degradation event:
    expect(reportSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'JobScheduler.allowlistResolution',
        primary: expect.stringContaining('toolAllowlist'),
      }),
    );
  });

  it('user-origin missing allowlist defaults to [Read] (no degradation)', async () => {
    const job = makeAgentMdJob({ slug: 'j5', origin: 'user', frontmatter: {} });
    const { allowedTools } = await trigger(job);
    expect(allowedTools).toEqual(['Read']);
    // No degradation event for the symmetric-minimal default path
    const calls = reportSpy.mock.calls;
    const matchingCalls = calls.filter(c =>
      c[0]?.feature === 'JobScheduler.allowlistResolution',
    );
    expect(matchingCalls.length).toBe(0);
  });

  it('instar-origin missing allowlist spawns with full tools AND emits a Phase-1c-gap degradation', async () => {
    const job = makeAgentMdJob({ slug: 'j6', origin: 'instar', frontmatter: {} });
    const { allowedTools } = await trigger(job);
    // null allowlist → no flag passed to spawnSession
    expect(allowedTools).toBeUndefined();
    expect(reportSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'JobScheduler.allowlistResolution',
        primary: expect.stringContaining('lock-file'),
      }),
    );
  });

  it('legacy entries omit the flag (back-compat preserved)', async () => {
    const job: JobDefinition = {
      ...baseJob,
      slug: 'legacy',
      execute: { type: 'prompt', value: 'hi' },
    };
    const { allowedTools } = await trigger(job);
    expect(allowedTools).toBeUndefined();
    // No allowlist-channel degradation for legacy paths
    const calls = reportSpy.mock.calls;
    const matchingCalls = calls.filter(c =>
      c[0]?.feature === 'JobScheduler.allowlistResolution',
    );
    expect(matchingCalls.length).toBe(0);
  });
});

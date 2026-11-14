// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * EVO-008 (docs/specs/job-tool-allowlist-real-enforcement.md): the scheduler decides
 * whether a job's tool list is APPLIED, passes `confinedTools` to the launch, and records
 * `toolsConfined` / `toolEnforcement` from what the launch actually did.
 *
 * Both sides of every boundary: gate on/off/unreadable, explicit enrolment, tamper-first,
 * the user `["Read"]` default, unknown names, Claude vs Codex outcomes, report-once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateManager } from '../../../src/core/StateManager.js';
import { SessionManager } from '../../../src/core/SessionManager.js';
import { JobScheduler, CLAUDE_CONFINABLE_TOOL_NAMES } from '../../../src/scheduler/JobScheduler.js';
import { DegradationReporter } from '../../../src/monitoring/DegradationReporter.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import type { JobDefinition, JobSchedulerConfig, SessionManagerConfig } from '../../../src/core/types.js';

const baseJob = {
  name: 'A', description: 'A', schedule: '*/5 * * * *', priority: 'low' as const,
  expectedDurationMinutes: 1, model: 'haiku' as const, enabled: true,
};

function agentmd(opts: {
  slug: string; origin: 'instar' | 'user'; frontmatter?: Record<string, unknown>;
  unrestrictedTools?: boolean; lockTrust?: JobDefinition['lockTrust'];
}): JobDefinition {
  return {
    ...baseJob, slug: opts.slug, execute: { type: 'agentmd' }, origin: opts.origin,
    frontmatter: opts.frontmatter ?? {}, unrestrictedTools: opts.unrestrictedTools,
    lockTrust: opts.lockTrust, body: `# ${opts.slug}\n\nDo the thing.\n`,
  };
}

const ON = { on: true as const, explicitOff: false };
const OFF = { on: false as const, explicitOff: false };
const EXPLICIT_OFF = { on: false as const, explicitOff: true };
const UNREADABLE = { on: 'unreadable' as const, explicitOff: false };

describe('resolveAllowlist: tamper is checked first (EVO-008 §1)', () => {
  for (const lockTrust of ['untrusted-bad-signature', 'untrusted-not-in-lockfile', 'untrusted-hash-mismatch'] as const) {
    it(`an instar job with a declared array in ${lockTrust} is clamped to [Read]`, () => {
      const r = JobScheduler.resolveAllowlist(agentmd({ slug: 'x', origin: 'instar', frontmatter: { toolAllowlist: ['Bash', 'Write'] }, lockTrust }));
      expect(r.kind).toBe('lock-untrusted-clamped');
      expect(r.allowlist).toEqual(['Read']);
    });
  }
  it('a user job with a declared array is untouched by lock trust', () => {
    const r = JobScheduler.resolveAllowlist(agentmd({ slug: 'x', origin: 'user', frontmatter: { toolAllowlist: ['Bash'] }, lockTrust: 'untrusted-bad-signature' }));
    expect(r.kind).toBe('array');
  });
  it('the transitional untrusted-no-lockfile state keeps a declared array', () => {
    const r = JobScheduler.resolveAllowlist(agentmd({ slug: 'x', origin: 'instar', frontmatter: { toolAllowlist: ['Bash'] }, lockTrust: 'untrusted-no-lockfile' }));
    expect(r.kind).toBe('array');
  });
});

describe('resolveToolEnforcement (EVO-008 §2, pure)', () => {
  const decide = (job: JobDefinition, gate = ON) => JobScheduler.resolveToolEnforcement(job, JobScheduler.resolveAllowlist(job), gate);

  it('confines a declared array with the gate on; Bash is labelled with-shell', () => {
    expect(decide(agentmd({ slug: 'a', origin: 'instar', frontmatter: { toolAllowlist: ['Bash'] } }))).toMatchObject({ confinedTools: ['Bash'], reason: 'confined-with-shell', requireConfinement: false });
    expect(decide(agentmd({ slug: 'a', origin: 'user', frontmatter: { toolAllowlist: ['Read', 'Grep'] } }))).toMatchObject({ confinedTools: ['Read', 'Grep'], reason: 'confined' });
  });
  it('does not confine with the gate off or the config unreadable', () => {
    const job = agentmd({ slug: 'a', origin: 'instar', frontmatter: { toolAllowlist: ['Bash'] } });
    expect(decide(job, OFF)).toMatchObject({ reason: 'gate-off' });
    expect(decide(job, OFF).confinedTools).toBeUndefined();
    expect(decide(job, UNREADABLE)).toMatchObject({ reason: 'config-unreadable' });
  });
  it('clamped "*" confines to [Read]; tamper confines AND requires confinement', () => {
    expect(decide(agentmd({ slug: 'c', origin: 'user', frontmatter: { toolAllowlist: '*' } }))).toMatchObject({ confinedTools: ['Read'], requireConfinement: false });
    expect(decide(agentmd({ slug: 't', origin: 'instar', frontmatter: { toolAllowlist: '*' }, unrestrictedTools: true, lockTrust: 'untrusted-bad-signature' })))
      .toMatchObject({ confinedTools: ['Read'], requireConfinement: true });
  });
  it('a user job bare ["Read"] is the old default (not applied); ["Read","Grep"] is applied', () => {
    expect(decide(agentmd({ slug: 'r', origin: 'user', frontmatter: { toolAllowlist: ['Read'] } }))).toMatchObject({ reason: 'read-only-default' });
    expect(decide(agentmd({ slug: 'r', origin: 'user', frontmatter: { toolAllowlist: [' Read ', 'Read'] } }))).toMatchObject({ reason: 'read-only-default' });
    expect(decide(agentmd({ slug: 'r', origin: 'user', frontmatter: {} }))).toMatchObject({ reason: 'no-declared-allowlist' });
  });
  it('unrestricted, legacy and instar-no-allowlist are not applicable', () => {
    expect(decide(agentmd({ slug: 'u', origin: 'instar', frontmatter: { toolAllowlist: '*' }, unrestrictedTools: true }))).toMatchObject({ reason: 'not-applicable' });
    expect(decide({ ...baseJob, slug: 'l', execute: { type: 'prompt', value: 'x' } })).toMatchObject({ reason: 'not-applicable' });
  });
  it('unknown, dropped-by-the-CLI, mcp and empty names are never confined (unenrolled: run as today)', () => {
    for (const list of [['Bassh'], ['Read', 'LS'], ['TodoWrite'], ['mcp__threadline__send'], ['Bash(git:*)'], ['bash']]) {
      const d = decide(agentmd({ slug: 'n', origin: 'instar', frontmatter: { toolAllowlist: list } }));
      expect(d.reason, list.join(',')).toBe('unsupported-tool-names');
      expect(d.confinedTools).toBeUndefined();
      expect(d.refuse).toBeFalsy();
    }
  });
  it('the confinable set is the CLI-measured names, not plausible ones', () => {
    for (const t of ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'Task', 'Agent']) expect(CLAUDE_CONFINABLE_TOOL_NAMES.has(t)).toBe(true);
    for (const t of ['LS', 'MultiEdit', 'SlashCommand', 'BashOutput', 'TodoWrite']) expect(CLAUDE_CONFINABLE_TOOL_NAMES.has(t)).toBe(false);
  });

  describe('explicit enrolment toolAllowlistEnforce: true (§2a)', () => {
    const enrolled = (list: unknown, origin: 'user' | 'instar' = 'user') =>
      agentmd({ slug: 'e', origin, frontmatter: { toolAllowlist: list, toolAllowlistEnforce: true } });
    it('applies a bare user ["Read"] and requires confinement', () => {
      expect(decide(enrolled(['Read']))).toMatchObject({ confinedTools: ['Read'], requireConfinement: true });
    });
    it('applies even when the switch defaults off or the config is unreadable', () => {
      expect(decide(enrolled(['Read']), OFF)).toMatchObject({ confinedTools: ['Read'] });
      expect(decide(enrolled(['Read']), UNREADABLE)).toMatchObject({ confinedTools: ['Read'] });
    });
    it('only an explicit false switch turns it off', () => {
      expect(decide(enrolled(['Read']), EXPLICIT_OFF)).toMatchObject({ reason: 'gate-off' });
      expect(decide(enrolled(['Read']), EXPLICIT_OFF).confinedTools).toBeUndefined();
    });
    it('reads the FAILSAFE string form "true" the loader actually delivers', () => {
      const job = agentmd({ slug: 'e', origin: 'user', frontmatter: { toolAllowlist: ['Read'], toolAllowlistEnforce: 'true' } });
      expect(decide(job, OFF)).toMatchObject({ confinedTools: ['Read'], requireConfinement: true });
      const off = agentmd({ slug: 'e', origin: 'user', frontmatter: { toolAllowlist: ['Read'], toolAllowlistEnforce: 'false' } });
      expect(decide(off)).toMatchObject({ reason: 'read-only-default' });
    });
    it('refuses an invalid list instead of widening it', () => {
      expect(decide(enrolled(['Read', 'Grepp']))).toMatchObject({ reason: 'unsupported-tool-names', refuse: true, requireConfinement: true });
    });
  });
});

describe('toolEnforcementOutcome reads the launched session, never the request (§4)', () => {
  const decision = { confinedTools: ['Read'], reason: 'confined' as const, requireConfinement: false };
  it('confined only when the session carries confinedTools', () => {
    expect(JobScheduler.toolEnforcementOutcome(decision, { framework: 'claude-code', confinedTools: ['Read'] })).toEqual({ toolsConfined: true, toolEnforcement: 'confined' });
    expect(JobScheduler.toolEnforcementOutcome(decision, { framework: 'codex-cli' })).toEqual({ toolsConfined: false, toolEnforcement: 'not-applied:codex-cli' });
    expect(JobScheduler.toolEnforcementOutcome(decision, { framework: 'claude-code' })).toEqual({ toolsConfined: false, toolEnforcement: 'not-applied:claude-code' });
    expect(JobScheduler.toolEnforcementOutcome(decision, undefined)).toEqual({ toolsConfined: false, toolEnforcement: 'not-applied:unknown' });
  });
  it('an unapplied decision records its reason', () => {
    expect(JobScheduler.toolEnforcementOutcome({ reason: 'gate-off', requireConfinement: false }, { framework: 'claude-code' }))
      .toEqual({ toolsConfined: false, toolEnforcement: 'gate-off' });
  });
});

describe('scheduler wiring: confinedTools reaches the launch and the record (EVO-008 §3, §6, §7)', () => {
  let stateDir: string;
  let state: StateManager;
  let scheduler: JobScheduler;
  let spawnSpy: ReturnType<typeof vi.fn>;
  let reportSpy: ReturnType<typeof vi.spyOn>;
  let sessionReply: Record<string, unknown>;

  const schedulerConfig: JobSchedulerConfig = {
    jobsFile: '', enabled: true, maxParallelJobs: 1,
    quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
  };

  function writeConfig(cfg: Record<string, unknown>) {
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(cfg));
  }

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-tool-enforce-'));
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    state = new StateManager(stateDir);
    const sessionConfig: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/claude', projectDir: stateDir,
      maxSessions: 10, protectedSessions: [], completionPatterns: [],
    };
    const sessionManager = new SessionManager(sessionConfig, state);
    sessionReply = { framework: 'claude-code' };
    spawnSpy = vi.fn().mockImplementation(async (opts: { confinedTools?: string[] }) => ({
      id: 'stub', name: 'stub', status: 'running', tmuxSession: 'stub-tmux', startedAt: new Date().toISOString(),
      ...sessionReply,
      ...(sessionReply.framework === 'claude-code' && opts.confinedTools ? { confinedTools: opts.confinedTools } : {}),
    }));
    (sessionManager as unknown as { spawnSession: typeof spawnSpy }).spawnSession = spawnSpy;
    DegradationReporter.resetForTesting();
    reportSpy = vi.spyOn(DegradationReporter.getInstance(), 'report');
    scheduler = new JobScheduler(schedulerConfig, sessionManager, state, stateDir);
  });

  afterEach(() => {
    reportSpy.mockRestore();
    DegradationReporter.resetForTesting();
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/scheduler/JobScheduler.tool-enforcement.test.ts:afterEach' });
  });

  async function trigger(job: JobDefinition) {
    (scheduler as unknown as { jobs: JobDefinition[] }).jobs = [job];
    (scheduler as unknown as { activeSessionSpawns: Set<string> }).activeSessionSpawns.clear();
    await scheduler.triggerJob(job.slug, 'test');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    return spawnSpy.mock.calls.at(-1)?.[0] as { confinedTools?: string[]; requireToolConfinement?: boolean; allowedTools?: string[] } | undefined;
  }
  const lastRun = (slug: string) => {
    const rows = fs.readFileSync(path.join(stateDir, 'ledger', 'job-runs.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    return rows.filter((r: { slug: string }) => r.slug === slug).at(-1) as Record<string, unknown>;
  };

  it('gate on (development agent): a declared array is passed as confinedTools and recorded confined', async () => {
    writeConfig({ developmentAgent: true });
    const call = await trigger(agentmd({ slug: 'arr', origin: 'instar', frontmatter: { toolAllowlist: ['Bash'] } }));
    expect(call?.confinedTools).toEqual(['Bash']);
    expect(lastRun('arr')).toMatchObject({ toolsConfined: true, toolEnforcement: 'confined-with-shell', toolAllowlist: ['Bash'] });
  });

  it('gate off (fleet default): no confinedTools, recorded gate-off', async () => {
    writeConfig({ developmentAgent: false });
    const call = await trigger(agentmd({ slug: 'arr2', origin: 'instar', frontmatter: { toolAllowlist: ['Bash'] } }));
    expect(call?.confinedTools).toBeUndefined();
    expect(call?.allowedTools).toEqual(['Bash']);
    expect(lastRun('arr2')).toMatchObject({ toolsConfined: false, toolEnforcement: 'gate-off' });
  });

  it('an explicit switch overrides the development-agent default both ways', async () => {
    writeConfig({ developmentAgent: false, jobs: { toolAllowlistEnforcement: { enabled: true } } });
    expect((await trigger(agentmd({ slug: 'f1', origin: 'user', frontmatter: { toolAllowlist: ['Read', 'Grep'] } })))?.confinedTools).toEqual(['Read', 'Grep']);
    writeConfig({ developmentAgent: true, jobs: { toolAllowlistEnforcement: { enabled: false } } });
    expect((await trigger(agentmd({ slug: 'f2', origin: 'user', frontmatter: { toolAllowlist: ['Read', 'Grep'] } })))?.confinedTools).toBeUndefined();
  });

  it('default-user jobs are never confined (the job keeps the tools it has today)', async () => {
    writeConfig({ developmentAgent: true });
    const call = await trigger(agentmd({ slug: 'du', origin: 'user', frontmatter: {} }));
    expect(call?.confinedTools).toBeUndefined();
    expect(lastRun('du')).toMatchObject({ toolsConfined: false, toolEnforcement: 'no-declared-allowlist' });
  });

  it('a clamped "*" is confined to Read and its event is worded from the outcome, after the launch', async () => {
    writeConfig({ developmentAgent: true });
    const call = await trigger(agentmd({ slug: 'clamp', origin: 'user', frontmatter: { toolAllowlist: '*' }, unrestrictedTools: false }));
    expect(call?.confinedTools).toEqual(['Read']);
    const ev = state.queryEvents({ type: 'job_allowlist_clamped', limit: 5 });
    expect(ev).toHaveLength(1);
    expect(ev[0].summary).toContain('This run had Read only');
    expect(ev[0].metadata).toMatchObject({ toolsConfined: true });
  });

  it('a clamped "*" with the gate off says plainly the limit was NOT applied', async () => {
    writeConfig({ developmentAgent: false });
    await trigger(agentmd({ slug: 'clamp-off', origin: 'user', frontmatter: { toolAllowlist: '*' } }));
    const ev = state.queryEvents({ type: 'job_allowlist_clamped', limit: 5 });
    expect(ev[0].summary).toContain('NOT applied');
    expect(ev[0].summary).not.toContain('This run had Read only');
  });

  it('a launch that came back on Codex records not-applied and reports it as an event, not a filed degradation', async () => {
    writeConfig({ developmentAgent: true });
    sessionReply = { framework: 'codex-cli' };
    await trigger(agentmd({ slug: 'cx', origin: 'instar', frontmatter: { toolAllowlist: ['Bash'] } }));
    expect(lastRun('cx')).toMatchObject({ toolsConfined: false, toolEnforcement: 'not-applied:codex-cli' });
    expect(state.queryEvents({ type: 'job_tool_allowlist_not_enforced', limit: 5 })).toHaveLength(1);
    expect(reportSpy.mock.calls.filter((c) => c[0]?.feature === 'JobScheduler.allowlistResolution')).toHaveLength(0);
  });

  it('a tampered instar job asks the launch to fail closed; a refused launch is reported, never run', async () => {
    writeConfig({ developmentAgent: true });
    const job = agentmd({ slug: 'tamp', origin: 'instar', frontmatter: { toolAllowlist: ['Bash'] }, lockTrust: 'untrusted-bad-signature' });
    const call = await trigger(job);
    expect(call).toMatchObject({ confinedTools: ['Read'], requireToolConfinement: true });
    spawnSpy.mockRejectedValueOnce(new Error('confined-tools-unavailable: this job\'s tool list cannot be applied on codex-cli, so it was not started'));
    // a fresh key: clear report-once so the refusal report is observable
    (scheduler as unknown as { allowlistReports: Map<string, number> | null }).allowlistReports = new Map();
    await trigger(job);
    const rows = fs.readFileSync(path.join(stateDir, 'ledger', 'job-runs.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.at(-1)).toMatchObject({ result: 'spawn-error', toolEnforcement: 'confine-refused' });
    const ev = state.queryEvents({ type: 'job_lock_untrusted_clamped', limit: 5 });
    expect(ev.some((e) => e.summary.includes('NOT started'))).toBe(true);
  });

  it('an enrolled job with an unknown tool name is refused before any launch', async () => {
    writeConfig({ developmentAgent: false });
    spawnSpy.mockClear();
    await trigger(agentmd({ slug: 'enr', origin: 'user', frontmatter: { toolAllowlist: ['Read', 'Grepp'], toolAllowlistEnforce: true } }));
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(lastRun('enr')).toMatchObject({ result: 'spawn-error', toolEnforcement: 'confine-refused' });
    expect(state.queryEvents({ type: 'job_tool_allowlist_refused', limit: 5 })).toHaveLength(1);
  });

  it('report-once: 50 launches of one clamped job file one degradation, and the window survives a restart', async () => {
    writeConfig({ developmentAgent: true });
    const job = agentmd({ slug: 'flood', origin: 'user', frontmatter: { toolAllowlist: '*' } });
    for (let i = 0; i < 50; i++) await trigger(job);
    expect(reportSpy.mock.calls.filter((c) => c[0]?.feature === 'JobScheduler.allowlistResolution')).toHaveLength(1);
    expect(state.queryEvents({ type: 'job_allowlist_clamped', limit: 100 })).toHaveLength(1);
    // A "restart": the in-memory map is gone, the file is read back.
    (scheduler as unknown as { allowlistReports: Map<string, number> | null }).allowlistReports = null;
    await trigger(job);
    expect(reportSpy.mock.calls.filter((c) => c[0]?.feature === 'JobScheduler.allowlistResolution')).toHaveLength(1);
  });

  it('a failing signal after a successful launch never becomes a spawn error', async () => {
    writeConfig({ developmentAgent: true });
    const spy = vi.spyOn(state, 'appendEvent').mockImplementation((e) => {
      if (e.type === 'job_allowlist_clamped') throw new Error('event log unwritable');
    });
    await trigger(agentmd({ slug: 'sigfail', origin: 'user', frontmatter: { toolAllowlist: '*' } }));
    spy.mockRestore();
    expect(lastRun('sigfail')).toMatchObject({ result: 'pending', toolsConfined: true });
  });

  it('no clamp event is written when the launch never happened', async () => {
    writeConfig({ developmentAgent: true });
    spawnSpy.mockRejectedValueOnce(new Error('some unrelated spawn failure'));
    await trigger(agentmd({ slug: 'nolaunch', origin: 'user', frontmatter: { toolAllowlist: '*' } }));
    expect(state.queryEvents({ type: 'job_allowlist_clamped', limit: 5 })).toHaveLength(0);
  });
});

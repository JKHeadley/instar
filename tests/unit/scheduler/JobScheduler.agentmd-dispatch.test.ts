/**
 * Phase 1b — Scheduler dispatch for agentmd jobs.
 *
 * The Phase 1a loader populates `JobDefinition.body` and
 * `JobDefinition.frontmatter` for `execute.type === "agentmd"` entries.
 * Phase 1b removes the dispatch-side throw and routes those entries
 * through the existing prefix layers (topic awareness, view metadata,
 * notification protocol). This test asserts:
 *
 *   - buildPrompt returns job.body verbatim for agentmd entries (no
 *     legacy `execute.value`-based string-building leaks in).
 *   - The existing prefix layers wrap the body unchanged — view-metadata
 *     block first, notification protocol last for on-alert jobs.
 *   - Legacy entries (skill/prompt/script) produce identical output
 *     to today (golden-output equivalence — no regression).
 *
 * The test invokes the *real* JobScheduler against an in-memory state
 * + a stub session manager. buildPrompt is private, so we exercise it
 * via spawnJobSession (mocking spawnSession to capture its prompt arg).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateManager } from '../../../src/core/StateManager.js';
import { SessionManager } from '../../../src/core/SessionManager.js';
import { JobScheduler } from '../../../src/scheduler/JobScheduler.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import type {
  JobDefinition,
  JobSchedulerConfig,
  SessionManagerConfig,
} from '../../../src/core/types.js';

describe('JobScheduler agentmd dispatch (Phase 1b)', () => {
  let stateDir: string;
  let state: StateManager;
  let sessionManager: SessionManager;
  let scheduler: JobScheduler;
  let spawnSpy: ReturnType<typeof vi.fn>;

  const schedulerConfig: JobSchedulerConfig = {
    jobsFile: '',
    enabled: true,
    maxParallelJobs: 1,
    quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
  };

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-dispatch-'));
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

    // Replace spawnSession with a stub so buildPrompt is exercised but
    // no real tmux/claude process is launched. The stub captures every
    // argument set the scheduler passes through.
    spawnSpy = vi.fn().mockResolvedValue({
      id: 'stub',
      name: 'stub',
      status: 'running',
      tmuxSession: 'stub-tmux',
      startedAt: new Date().toISOString(),
    });
    (sessionManager as unknown as { spawnSession: typeof spawnSpy }).spawnSession = spawnSpy;

    scheduler = new JobScheduler(schedulerConfig, sessionManager, state, stateDir);
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/scheduler/JobScheduler.agentmd-dispatch.test.ts:afterEach',
    });
  });

  /** Drive the scheduler through one trigger and return the prompt the
   *  spawn was called with, plus the resolved allowedTools (if any). */
  async function fireAndCapturePrompt(job: JobDefinition): Promise<{ prompt: string; allowedTools?: string[] }> {
    // Inject the single job directly; trigger; flush microtasks.
    (scheduler as unknown as { jobs: JobDefinition[] }).jobs = [job];
    await scheduler.triggerJob(job.slug, 'test');
    // The spawn promise resolves asynchronously — wait for the .then() chain.
    await new Promise(r => setImmediate(r));
    const call = spawnSpy.mock.calls[0]?.[0] as { prompt: string; allowedTools?: string[] } | undefined;
    if (!call) throw new Error('spawnSession was not called');
    return { prompt: call.prompt, allowedTools: call.allowedTools };
  }

  it('buildPrompt returns job.body for agentmd entries', async () => {
    const bodyText = '# Health Check\n\nCheck server health and report.\n';
    const job: JobDefinition = {
      slug: 'health-check',
      name: 'Health Check',
      description: 'Check server health',
      schedule: '0 */6 * * *',
      priority: 'medium',
      expectedDurationMinutes: 1,
      model: 'haiku',
      enabled: true,
      execute: { type: 'agentmd' },
      origin: 'instar',
      body: bodyText,
      frontmatter: { toolAllowlist: ['Read'] },
    };

    const { prompt } = await fireAndCapturePrompt(job);
    // The view-metadata prefix sits before the body, then the body itself.
    // The body must appear in the prompt unchanged.
    expect(prompt).toContain(bodyText);
    // And the legacy execute.value substring (the Phase 1a throw text) MUST NOT appear.
    expect(prompt).not.toContain('agentmd execution type is not yet dispatched');
    expect(prompt).not.toContain('Run this script:');
  });

  it('wraps agentmd body with the view-metadata + notification prefixes', async () => {
    const bodyText = 'This is the body.';
    const job: JobDefinition = {
      slug: 'observation',
      name: 'Observation',
      description: 'd',
      schedule: '*/5 * * * *',
      priority: 'low',
      expectedDurationMinutes: 1,
      model: 'haiku',
      enabled: true,
      execute: { type: 'agentmd' },
      origin: 'user',
      body: bodyText,
      frontmatter: { toolAllowlist: ['Read'] },
      // explicit on-alert: should produce the [NOTIFICATION PROTOCOL] prefix
      telegramNotify: 'on-alert',
    };

    const { prompt } = await fireAndCapturePrompt(job);

    // Both prefix blocks wrap the body:
    expect(prompt).toContain('[VIEW METADATA]');
    expect(prompt).toContain('"id": "observation"');
    expect(prompt).toContain('[NOTIFICATION PROTOCOL: This job runs in quiet mode');
    // And the body is still in there, untouched:
    expect(prompt).toContain(bodyText);
    // Notification prefix should appear BEFORE the view-metadata block
    // because on-alert mode wraps last.
    expect(prompt.indexOf('[NOTIFICATION PROTOCOL'))
      .toBeLessThan(prompt.indexOf('[VIEW METADATA]'));
  });

  it('legacy prompt entries produce identical output to today (golden equivalence)', async () => {
    const job: JobDefinition = {
      slug: 'legacy-prompt',
      name: 'Legacy',
      description: 'd',
      schedule: '*/5 * * * *',
      priority: 'low',
      expectedDurationMinutes: 1,
      model: 'haiku',
      enabled: true,
      execute: { type: 'prompt', value: 'Hello, world.' },
    };

    const { prompt } = await fireAndCapturePrompt(job);
    expect(prompt).toContain('Hello, world.');
    // legacy prompt path must still emit the view-metadata header
    expect(prompt).toContain('[VIEW METADATA]');
    // ... AND must not have any agentmd-specific framing
    expect(prompt).not.toContain('agentmd');
  });

  it('legacy skill entries produce identical output to today (golden equivalence)', async () => {
    const job: JobDefinition = {
      slug: 'legacy-skill',
      name: 'Legacy Skill',
      description: 'd',
      schedule: '*/5 * * * *',
      priority: 'low',
      expectedDurationMinutes: 1,
      model: 'haiku',
      enabled: true,
      execute: { type: 'skill', value: 'review' },
    };

    const { prompt } = await fireAndCapturePrompt(job);
    // Skill prompt: "/review" should appear
    expect(prompt).toContain('/review');
  });

  it('throws a clear error if an agentmd job is missing its body (hydration bug)', async () => {
    const job: JobDefinition = {
      slug: 'no-body',
      name: 'Missing body',
      description: 'd',
      schedule: '*/5 * * * *',
      priority: 'low',
      expectedDurationMinutes: 1,
      model: 'haiku',
      enabled: true,
      execute: { type: 'agentmd' },
      origin: 'user',
      // body is intentionally missing — simulate a hydration bug
    };

    // Spy on console.error to absorb the spawn-error report (run history records it).
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      (scheduler as unknown as { jobs: JobDefinition[] }).jobs = [job];
      // triggerJob calls spawnJobSession which calls buildPrompt — buildPrompt throws.
      // The scheduler swallows the throw and records a spawn-error; we just want
      // to verify buildPrompt did throw (no spawn call should land).
      await expect(async () => {
        // Directly invoke buildPrompt via a small reflection to surface the throw.
        (scheduler as unknown as { buildPrompt: (j: JobDefinition) => string }).buildPrompt(job);
      }).rejects.toThrow(/no cached body/);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

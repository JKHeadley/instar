/**
 * Integration test — agentmd job loaded from disk fires and records observability.
 *
 * This test exercises the FULL Phase 1b pipeline (no real tmux/claude):
 *
 *   1. Build a synthetic agent state on disk with a per-slug manifest
 *      under `<state>/jobs/schedule/<slug>.json` and a markdown body at
 *      `<state>/jobs/instar/<slug>.md` — exactly the on-disk layout the
 *      Phase 1a `AgentMdJobLoader` reads.
 *   2. Construct a real `JobScheduler` whose `jobsFile` points at the
 *      synthetic agent. Calling `start()` invokes the real `loadJobs()`,
 *      which delegates to `loadAgentMdJobs()` for the manifest tree —
 *      so we are not stubbing the loader.
 *   3. Replace `sessionManager.spawnSession` with a stub that touches a
 *      marker file. We do NOT mock tmux or claude; the stub stands in
 *      for the entire spawn-side effect.
 *   4. Trigger the job manually via `triggerJob` (we don't wait on cron
 *      to keep the test deterministic and fast).
 *   5. Assert the marker file exists — proves the agentmd dispatch path
 *      reached spawnSession, which the Phase 1a defensive filter and
 *      buildPrompt throw would have blocked.
 *   6. Assert the job-runs ledger row carries the Phase 1b observability
 *      fields (origin, resolvedPath, bodyHash, frontmatterHash,
 *      manifestVersion, toolAllowlist).
 *
 * Bug-fix evidence bar: a regression that re-introduces the Phase 1a
 * filter or restores the buildPrompt throw will fail step 5 (no marker).
 * A regression that drops the observability extension will fail step 6.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { StateManager } from '../../../src/core/StateManager.js';
import { SessionManager } from '../../../src/core/SessionManager.js';
import { JobScheduler } from '../../../src/scheduler/JobScheduler.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { buildSyntheticAgent, mkManifest, mkAgentMd } from '../../unit/scheduler/agentmd-helpers.js';
import type { JobSchedulerConfig, SessionManagerConfig } from '../../../src/core/types.js';

describe('agentmd job end-to-end (load → trigger → spawn → record)', () => {
  let agent: ReturnType<typeof buildSyntheticAgent>;
  let state: StateManager;
  let sessionManager: SessionManager;
  let scheduler: JobScheduler;
  let markerPath: string;
  let spawnSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Synthetic agent: ONE agentmd job ("daily-health-probe"). Manifest
    // points to instar/daily-health-probe.md; the markdown body declares
    // a tool allowlist of ["Read"] and a manifest version of 7.
    agent = buildSyntheticAgent({
      jobsJson: [], // empty legacy file — exercise the agentmd path alone
      manifests: {
        'daily-health-probe': mkManifest({
          slug: 'daily-health-probe',
          origin: 'instar',
          schedule: '0 4 * * *', // far-future cron — never fires during test
          priority: 'medium',
          model: 'haiku',
          expectedDurationMinutes: 1,
          enabled: true,
          execute: { type: 'agentmd' },
          manifestVersion: 7,
        }),
      },
      instarMd: {
        'daily-health-probe': mkAgentMd({
          frontmatter: {
            name: 'Daily Health Probe',
            description: 'Probes the local server for health drift.',
            toolAllowlist: ['Read'],
          },
          body: '# Daily Health Probe\n\nCurl /health, summarize the result.\n',
        }),
      },
    });

    // Marker file the stub will touch when the spawn fires.
    markerPath = path.join(agent.stateDir, 'spawn-marker.txt');

    // StateManager wants <stateDir>/state/{sessions,jobs}; create them.
    fs.mkdirSync(path.join(agent.stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(agent.stateDir, 'state', 'jobs'), { recursive: true });
    state = new StateManager(agent.stateDir);

    const sessionConfig: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/bin/claude',
      projectDir: agent.stateDir,
      maxSessions: 10,
      protectedSessions: [],
      completionPatterns: [],
    };
    sessionManager = new SessionManager(sessionConfig, state);

    // Stub spawnSession: touches the marker, returns a minimal Session.
    // Captures the full options object so the test can assert on the
    // allowedTools, prompt, and other fields without standing up tmux.
    spawnSpy = vi.fn().mockImplementation(async (options: { name: string; prompt: string }) => {
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          sessionName: options.name,
          promptHash: options.prompt.length, // sentinel: prompt was non-empty
          calledAt: new Date().toISOString(),
        }),
      );
      return {
        id: options.name,
        name: options.name,
        status: 'running' as const,
        tmuxSession: `stub-${options.name}`,
        startedAt: new Date().toISOString(),
      };
    });
    (sessionManager as unknown as { spawnSession: typeof spawnSpy }).spawnSession = spawnSpy;

    const schedulerConfig: JobSchedulerConfig = {
      jobsFile: agent.jobsFile,
      enabled: true,
      maxParallelJobs: 1,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
      // Use a long startup grace so the missed-jobs scan doesn't auto-trigger
      // the daily-cron job during the test. We invoke triggerJob() manually
      // below and assert exactly one spawn happens through that explicit path.
      startupGraceMs: 60_000,
    };
    scheduler = new JobScheduler(schedulerConfig, sessionManager, state, agent.stateDir);
  });

  afterEach(() => {
    try {
      scheduler.stop();
    } catch {
      // best-effort
    }
    try {
      sessionManager.stopMonitoring();
    } catch {
      // best-effort
    }
    agent.cleanup();
    SafeFsExecutor.safeRmSync(markerPath, { force: true, operation: 'agentmd-end-to-end.test.ts:afterEach' });
  });

  it('loads an agentmd manifest from disk, dispatches it, and records full observability', async () => {
    // Step 1: start the scheduler — this loads jobs from disk.
    // We don't wait on cron; we trigger manually below.
    scheduler.start();

    // The job MUST have been loaded as an agentmd entry with body + frontmatter hydrated.
    // If the loader regressed, the job would be missing entirely.
    const loadedJobs = (scheduler as unknown as { jobs: Array<{ slug: string; execute: { type: string }; body?: string; frontmatter?: Record<string, unknown> }> }).jobs;
    const job = loadedJobs.find(j => j.slug === 'daily-health-probe');
    expect(job, 'agentmd job should be loaded from manifest+md tree').toBeDefined();
    expect(job!.execute.type).toBe('agentmd');
    expect(job!.body).toContain('# Daily Health Probe');
    expect(job!.frontmatter?.toolAllowlist).toEqual(['Read']);

    // Step 2: trigger the job manually (bypass cron timing).
    const triggerResult = await scheduler.triggerJob('daily-health-probe', 'test');
    expect(triggerResult).toBe('triggered');

    // The spawn happens async — wait for the .then chain that records the run.
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    // Step 3: marker file exists → spawn was called → dispatch path reached.
    // This is the bug-fix-evidence assertion: a regression that re-introduces
    // the Phase 1a filter or restores buildPrompt's throw would leave this
    // file absent.
    expect(fs.existsSync(markerPath), 'agentmd dispatch should call spawnSession (creates marker)').toBe(true);

    // Step 4: spawn was called with the agentmd body as the prompt and
    // the tool allowlist threaded through to --allowedTools.
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnCall = spawnSpy.mock.calls[0]![0] as {
      prompt: string;
      allowedTools?: string[];
      jobSlug?: string;
    };
    expect(spawnCall.prompt).toContain('# Daily Health Probe');
    expect(spawnCall.allowedTools).toEqual(['Read']);
    expect(spawnCall.jobSlug).toBe('daily-health-probe');

    // Step 5: the run-history row carries the Phase 1b observability fields.
    // We read the ledger file directly — recordStart writes there synchronously.
    const ledgerFile = path.join(agent.stateDir, 'ledger', 'job-runs.jsonl');
    expect(fs.existsSync(ledgerFile), 'ledger file should exist after recordStart').toBe(true);

    const lines = fs
      .readFileSync(ledgerFile, 'utf-8')
      .split('\n')
      .filter(l => l.trim().length > 0)
      .map(l => JSON.parse(l) as Record<string, unknown>);
    const runRow = lines.find(r => r.slug === 'daily-health-probe');
    expect(runRow, 'run row should be persisted to the ledger').toBeDefined();

    // Phase 1b observability extension — every field is present and meaningful.
    expect(runRow!.origin).toBe('instar');
    expect(runRow!.resolvedPath).toBe(path.join(agent.jobsRoot, 'instar', 'daily-health-probe.md'));
    expect(runRow!.bodyHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(runRow!.frontmatterHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(runRow!.manifestVersion).toBe(7);
    expect(runRow!.toolAllowlist).toEqual(['Read']);
    expect(runRow!.unrestrictedTools).toBe(false);
    expect(runRow!.clampedAllowlist).toBe(false);
  });
});

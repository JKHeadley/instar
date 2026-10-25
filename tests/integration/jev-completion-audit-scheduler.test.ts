// safe-fs-allow: test file — SafeFsExecutor removes only the per-test tmpdir.
/**
 * Jev job-completion audit wired into the REAL JobScheduler — the integration
 * tier (spec: docs/specs/jev-job-supervision.md Tests §2).
 *
 * The non-negotiable: completion handling never waits on the audit. Proven
 * with a capture whose detached half HANGS — notifyJobComplete must return
 * while it is still pending — and with a capture that THROWS synchronously.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { JevJobCompletionAudit } from '../../src/scheduler/JevJobCompletionAudit.js';
import { createTempProject, createMockSessionManager, createSampleJobsFile } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';

const FUTURE = new Date(Date.now() + 14 * 86_400_000).toISOString();

describe('JevJobCompletionAudit × JobScheduler', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let scheduler: JobScheduler;

  beforeEach(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();
  });
  afterEach(() => {
    scheduler?.stop();
    project.cleanup();
  });

  function makeScheduler(): JobScheduler {
    const jobsFile = createSampleJobsFile(project.stateDir);
    scheduler = new JobScheduler(
      { jobsFile, enabled: true, maxParallelJobs: 2, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
      mockSM as never,
      project.state,
      project.stateDir,
    );
    return scheduler;
  }

  function makeAudit(over: { fetchImpl?: typeof fetch; hangCapture?: boolean } = {}) {
    const evidenceDir = path.join(project.stateDir, 'state', 'jev-supervision-evidence');
    const logPath = path.join(project.stateDir, '..', 'logs', 'jev-audit-int.jsonl');
    const audit = new JevJobCompletionAudit({
      getConfig: () => ({ enabled: true, soakEndsAt: FUTURE, timeoutMs: 500 }),
      readKey: () => 'k',
      evidenceDir,
      logPath,
      fetchImpl: over.fetchImpl ?? ((async () => ({ ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', usage: {}, answers: {} }) })) as never),
    });
    if (over.hangCapture) {
      // Hang the DETACHED half: capture() itself must stay synchronous.
      const orig = (audit as unknown as { captureDetached: (...a: unknown[]) => Promise<void> }).captureDetached.bind(audit);
      void orig;
      (audit as unknown as { captureDetached: () => Promise<void> }).captureDetached = () => new Promise(() => {});
    }
    return { audit, evidenceDir };
  }

  async function completeOneJob(): Promise<{ tookMs: number }> {
    scheduler.start();
    await scheduler.triggerJob('health-check', 'test');
    await new Promise((r) => setTimeout(r, 50));
    const session = mockSM._sessions[mockSM._sessions.length - 1];
    session.status = 'completed';
    project.state.saveSession(session);
    const t0 = performance.now();
    await scheduler.notifyJobComplete(session.id, session.tmuxSession);
    return { tookMs: performance.now() - t0 };
  }

  it('a completed job produces an evidence pack; the run row is unchanged', async () => {
    makeScheduler();
    const { audit, evidenceDir } = makeAudit();
    scheduler.setJevAudit(audit);
    await completeOneJob();
    await audit.flush();
    await new Promise((r) => setTimeout(r, 50));
    const packs = fs.readdirSync(evidenceDir).filter((f) => f.endsWith('.json'));
    expect(packs).toHaveLength(1);
    const pack = JSON.parse(fs.readFileSync(path.join(evidenceDir, packs[0]), 'utf8'));
    expect(pack.slug).toBe('health-check');
    expect(pack.result).toBe('success');
    expect(project.state.getJobState('health-check')?.lastResult).toBe('success');
  });

  it('completion returns promptly while the detached capture HANGS', async () => {
    makeScheduler();
    const { audit } = makeAudit({ hangCapture: true });
    scheduler.setJevAudit(audit);
    const { tookMs } = await completeOneJob();
    expect(tookMs).toBeLessThan(1500); // never waits on the hung capture
    expect(project.state.getJobState('health-check')?.lastResult).toBe('success');
  });

  it('a synchronously-THROWING capture cannot break notifyJobComplete', async () => {
    makeScheduler();
    scheduler.setJevAudit({ capture: () => { throw new Error('boom'); } } as never);
    await completeOneJob();
    expect(project.state.getJobState('health-check')?.lastResult).toBe('success');
  });

  it('with no audit attached (the fleet default), behaviour is byte-identical', async () => {
    makeScheduler();
    await completeOneJob();
    expect(project.state.getJobState('health-check')?.lastResult).toBe('success');
  });

  it('the batch over a captured pack writes a verdict row through the real pipeline', async () => {
    makeScheduler();
    const answers = {
      produced_declared_effect: { noul: 0.9 },
      false_success: { noul: 0.05 },
      failure_class: { choice: 'cannot-tell' },
    };
    const { audit } = makeAudit({
      fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', usage: { input_tokens: 10 }, answers }) })) as never,
    });
    scheduler.setJevAudit(audit);
    await completeOneJob();
    await audit.flush();
    await new Promise((r) => setTimeout(r, 50));
    const res = await audit.runBatch();
    expect(res.audited).toBe(1);
    const logPath = path.join(project.stateDir, '..', 'logs', 'jev-audit-int.jsonl');
    const rows = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.some((r) => r.kind === 'audited' && r.slug === 'health-check')).toBe(true);
  });
});

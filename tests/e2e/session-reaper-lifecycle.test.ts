/**
 * E2E — SessionReaper on the PRODUCTION path.
 *
 *   Phase 1: GET /sessions/reaper returns 200 (not 503) through the REAL
 *            AgentServer → RouteContext plumbing — the "dead on arrival" /
 *            "wired-but-dropped (?? null)" guard.
 *   Phase 2: the dangerous false-reap vectors from the converged review, driven
 *            through the live wired reaper + asserted on the wire / via the
 *            terminate spy: silent-but-working KEPT, unresolved-transcript
 *            (Codex/no-claudeSessionId) KEPT, genuinely-idle REAPED under
 *            Critical, frame-change-during-grace ABORTS.
 *
 * THE hard requirement (never reap a working session) is asserted end-to-end.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SessionReaper, type SessionReaperDeps, type PressureTier } from '../../src/monitoring/SessionReaper.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig, Session } from '../../src/core/types.js';
import type { TranscriptProbe } from '../../src/monitoring/transcriptProber.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const IDLE_FRAME = 'output\n? for shortcuts\n> ';

function session(id: string, over: Partial<Session> = {}): Session {
  return { id, name: id, status: 'running', tmuxSession: `t-${id}`, startedAt: new Date(0).toISOString(), framework: 'claude-code', claudeSessionId: `c-${id}`, ...over };
}

describe('SessionReaper E2E lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  let reaper: SessionReaper;
  const AUTH_TOKEN = 'test-e2e-session-reaper';

  // Mutable test state the reaper deps read.
  let now = 1_000_000;
  let frame = IDLE_FRAME;
  let transcript: TranscriptProbe = { resolved: true, path: '/t.jsonl', size: 100, mtime: 1000 };
  let tier: PressureTier = 'critical';
  let sessions: Session[] = [session('s1')];
  const terminate = vi.fn(async () => ({ terminated: true }));
  const reaping = new Set<string>();

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-reaper-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e-test', agentName: 'E2E Test' }));

    const deps: SessionReaperDeps = {
      listRunningSessions: () => sessions,
      captureOutput: () => frame,
      hasActiveProcesses: () => false,
      frameworkForSession: () => 'claude-code',
      probeTranscript: () => transcript,
      isRecoveryActive: () => false,
      isRelayLeaseActive: () => false,
      hasPendingInjection: () => false,
      topicBinding: () => null,
      recentUserMessage: () => false,
      activeCommitmentForTopic: () => false,
      activeSubagentCount: () => 0,
      buildOrAutonomousActive: () => false,
      protectedSessions: () => [],
      pressure: () => ({ tier }),
      terminate,
      markReaping: (id) => reaping.add(id),
      clearReaping: (id) => reaping.delete(id),
      now: () => now,
    };
    // Constructed the SAME way server.ts wires it (config-driven), enabled.
    reaper = new SessionReaper(deps, {
      enabled: true, dryRun: false, minAgeMinutes: 0, confirmObservations: 2,
      confirmWindowMinutes: 0, idleThresholdCriticalMinutes: 0, finalGraceSec: 1,
    });

    const config: InstarConfig = {
      projectName: 'e2e-test', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH_TOKEN,
      requestTimeoutMs: 10000, version: '0.10.3',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    };
    const state = new StateManager(stateDir);
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state, sessionReaper: reaper });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    reaper?.stop();
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/session-reaper-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });
  const reset = () => { now = 1_000_000; frame = IDLE_FRAME; transcript = { resolved: true, path: '/t.jsonl', size: 100, mtime: 1000 }; tier = 'critical'; sessions = [session('s1')]; reaping.clear(); terminate.mockClear(); (reaper as any).obs?.clear?.(); };

  describe('Phase 1: feature is alive (not 503)', () => {
    it('GET /sessions/reaper returns 200 with a snapshot through the real AgentServer plumbing', async () => {
      const res = await request(app).get('/sessions/reaper').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      expect(res.body.pressure).toBeDefined();
      expect(Array.isArray(res.body.sessions)).toBe(true);
    });

    it('GET /sessions/reaper/audit returns 200 (not 503) and reads the trail through real plumbing', async () => {
      // Empty trail is still a live 200 (read-only file surface, never 503).
      const empty = await request(app).get('/sessions/reaper/audit').set(auth());
      expect(empty.status).toBe(200);
      expect(empty.body.entries).toEqual([]);

      // A row written to the dedicated trail is read back via ctx.config.stateDir.
      // The trail lives at <stateDir>/../logs (sibling of .instar — production layout).
      const logPath = path.join(stateDir, '..', 'logs', 'reaper-audit.jsonl');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, JSON.stringify({ kind: 'session-reaper', event: 'decision', verdict: 'keep', keptBy: 'active-process', tier: 'normal' }) + '\n');
      const res = await request(app).get('/sessions/reaper/audit?limit=10').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0]).toMatchObject({ event: 'decision', keptBy: 'active-process' });
    });
  });

  describe('Phase 2: never reap a working session (end-to-end)', () => {
    it('KEEPs a silent-but-working session (transcript grew between ticks)', async () => {
      reset();
      await reaper.tick();
      transcript = { ...transcript, size: 9999 }; // produced output → working
      now = 1_120_000; await reaper.tick();
      now = 1_240_000; await reaper.tick();
      expect(terminate).not.toHaveBeenCalled();
    });

    it('KEEPs a session whose transcript is unresolved (Codex / no claudeSessionId)', async () => {
      reset();
      transcript = { resolved: false, path: '', size: 0, mtime: 0 };
      for (let i = 0; i < 4; i++) { now = 1_000_000 + i * 120_000; await reaper.tick(); }
      expect(terminate).not.toHaveBeenCalled();
      const res = await request(app).get('/sessions/reaper').set(auth());
      expect(res.body.sessions[0].verdict).toBe('keep');
    });

    it('REAPS a genuinely-idle, render-static session under Critical pressure', async () => {
      reset();
      now = 1_000_000; await reaper.tick();
      now = 1_120_000; await reaper.tick();
      now = 1_240_000; await reaper.tick();
      // 3rd arg carries the active-process relaxation flag (false: no active
      // process here) and the killer-stamped work evidence (reap-notify R2.1
      // — empty: this idle session showed no work signals).
      expect(terminate).toHaveBeenCalledWith('s1', 'reaped-idle', { bypassActiveProcessKeep: false, workEvidence: [] });
    });

    it('ABORTS the reap when the pane changes during the grace window', async () => {
      reset();
      now = 1_000_000; await reaper.tick();
      now = 1_120_000; await reaper.tick();   // reap-pending
      expect(reaping.has('s1')).toBe(true);
      frame = IDLE_FRAME + '\nnew render!';   // activity during grace
      now = 1_240_000; await reaper.tick();
      expect(terminate).not.toHaveBeenCalled();
      expect(reaping.has('s1')).toBe(false);
    });
  });
});

// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Tier-3 E2E "feature is alive" lifecycle test for resume-idle-autonomous-on-reap
 * (spec: docs/specs/resume-idle-autonomous-on-reap.md).
 *
 * Per TESTING-INTEGRITY-SPEC: boots the REAL AgentServer (the path server.ts
 * uses) with the REAL ResumeQueue + ResumeQueueDrainer + the REAL
 * `autonomousRunRemainingForTopic` helper, composed exactly the way server.ts
 * composes them (including the live-on-dev dryRun resolution, the sessionReaped
 * age-limit augmentation, and the drain-time autonomousRunFinished wiring), and
 * verifies:
 *
 *   Phase 1 — alive on DEV: with developmentAgent:true the queue boots
 *             dryRun:false (LIVE) — GET /sessions/resume-queue returns 200 with
 *             dryRun:false through the real AgentServer plumbing.
 *   Phase 2 — an age-limit reap of a topic with an ACTIVE autonomous run ENTERS
 *             the queue (the run is the work evidence) and revives EXACTLY ONCE;
 *             a second drain after the revive does NOT spawn again (double-spawn
 *             guard: live-session-exists catches it).
 *   Phase 3 — on the FLEET (developmentAgent:false) the same boot path resolves
 *             dryRun:true (observe-only): an age-reaped active-run session is
 *             audited would-resume and NEVER spawns.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createMockSessionManager, type MockSessionManager } from '../helpers/setup.js';
import { ReapLog } from '../../src/monitoring/ReapLog.js';
import { ResumeQueue } from '../../src/monitoring/ResumeQueue.js';
import { ResumeQueueDrainer } from '../../src/monitoring/ResumeQueueDrainer.js';
import { autonomousRunRemainingForTopic } from '../../src/core/AutonomousSessions.js';
import { AGE_LIMIT_ACTIVE_RUN_REASON } from '../../src/core/WorkEvidence.js';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';
import type { InstarConfig, Session } from '../../src/core/types.js';

const TOPIC = 7;
const UUID = '11111111-1111-4111-8111-111111111111';

/**
 * Build a full server harness with the resume queue composed exactly as
 * server.ts composes it — parameterized by developmentAgent so we can prove the
 * live-on-dev vs observe-only-on-fleet boot resolution end to end.
 */
function buildHarness(developmentAgent: boolean) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-idle-e2e-'));
  const stateDir = path.join(tmpDir, '.instar');
  const workDir = path.join(tmpDir, 'worktree');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

  const mockSm: MockSessionManager = createMockSessionManager();
  const reapLog = new ReapLog(stateDir, () => 'e2e-machine');

  const topicByTmux = new Map<string, number>();
  const topicResumeMap = new Map<number, string>();
  const audits: Array<Record<string, unknown>> = [];
  const respawns: string[] = [];

  // server.ts boot config object (the dev-gate input).
  const gateConfig = { developmentAgent };
  // EXACTLY server.ts's consumption-site resolution.
  const resolvedDryRun = undefined ?? !resolveDevAgentGate(undefined, gateConfig);

  const resumeQueue = new ResumeQueue(
    { stateDir, audit: (e) => audits.push(e), raiseAggregated: () => {} },
    { enabled: true, dryRun: resolvedDryRun, maxAttempts: 3, maxResurrections: 2, entryTtlHours: 24, maxQueueSize: 50, includeOperatorKills: false },
  );
  resumeQueue.start();

  const resumeDrainer = new ResumeQueueDrainer(
    {
      queue: resumeQueue,
      pressureTier: () => 'normal',
      canSpawnSession: () => true,
      sessionCountOk: () => mockSm.listRunningSessions().length < 10,
      migrationInFlight: () => false,
      liveSessionForTopic: (topicId) =>
        mockSm.listRunningSessions().some((s) => topicByTmux.get(s.tmuxSession) === topicId),
      currentResumeUuid: (topicId) => topicResumeMap.get(topicId) ?? null,
      topicOwnerElsewhere: () => false,
      topicBindingMatches: () => true,
      operatorStopSince: () => false,
      // The production wiring: drain-time liveness via the real helper.
      autonomousRunFinished: (topicId) => autonomousRunRemainingForTopic(stateDir, topicId) == null,
      jobCheck: () => ({ ok: false, why: 'scheduler-unavailable' }),
      pathExists: (p) => fs.existsSync(p),
      respawnTopic: async (entry, prompt) => {
        respawns.push(entry.id);
        const session = await mockSm.spawnSession({
          name: entry.sessionName,
          prompt,
          cwd: entry.worktreePath ?? entry.cwd,
        } as Parameters<MockSessionManager['spawnSession']>[0]);
        topicByTmux.set(session.tmuxSession, entry.topicId!);
        return session.tmuxSession;
      },
      triggerJob: async () => 'skipped',
      spawnAliveAfterGrace: async (tmux) => mockSm.isSessionAlive(tmux),
      raiseAggregated: () => {},
      audit: (e) => audits.push(e),
    },
    { drainIntervalSec: 60, requiredCalmTicks: 0, maxAttempts: 3, breakerThreshold: 3, breakerCooldownMin: 30, tier1Check: false },
  );

  /** Mirrors the server.ts sessionReaped fan-out — including the age-limit
   *  active-run augmentation. */
  const fireSessionReaped = (e: { session: Session; reason: string }): void => {
    reapLog.recordReaped({ session: e.session.name, tmuxSession: e.session.tmuxSession, reason: e.reason, disposition: 'terminal', origin: 'autonomous' });
    const rawTopic = topicByTmux.get(e.session.tmuxSession);
    const topicId = rawTopic == null ? null : rawTopic;
    let reason = e.reason;
    let workEvidence: string[] = [];
    if (e.reason === 'age-limit' && topicId != null && autonomousRunRemainingForTopic(stateDir, topicId) != null) {
      reason = AGE_LIMIT_ACTIVE_RUN_REASON;
      workEvidence = [...workEvidence, 'build-or-autonomous-active'];
    }
    resumeQueue.considerEnqueue({
      sessionName: e.session.name,
      tmuxSession: e.session.tmuxSession,
      topicId,
      resumeUuid: topicId != null ? (topicResumeMap.get(topicId) ?? null) : null,
      cwd: (e.session as { cwd?: string }).cwd ?? tmpDir,
      reason,
      disposition: 'terminal',
      origin: 'autonomous',
      workEvidence,
    });
  };

  const writeRun = (durationSeconds: number, startedAt: string) => {
    fs.mkdirSync(path.join(stateDir, 'autonomous'), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'autonomous', `${TOPIC}.local.md`),
      `---\nactive: true\npaused: false\niteration: 2\ngoal: "run ${TOPIC}"\nstarted_at: "${startedAt}"\nduration_seconds: ${durationSeconds}\nreport_topic: "${TOPIC}"\n---\n\ntask\n`,
    );
  };

  return { tmpDir, stateDir, workDir, mockSm, reapLog, resumeQueue, resumeDrainer, topicByTmux, topicResumeMap, audits, respawns, fireSessionReaped, writeRun, resolvedDryRun };
}

async function startServer(h: ReturnType<typeof buildHarness>, auth: string): Promise<{ server: AgentServer; app: express.Express }> {
  const config: InstarConfig = {
    projectName: 'e2e', projectDir: h.tmpDir, stateDir: h.stateDir, port: 0, authToken: auth,
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;
  const server = new AgentServer({
    config,
    sessionManager: h.mockSm as never,
    state: new StateManager(h.stateDir),
    reapLog: h.reapLog,
    resumeQueue: h.resumeQueue,
    resumeDrainer: h.resumeDrainer,
  });
  await server.start();
  return { server, app: server.getApp() };
}

describe('Resume-idle-autonomous E2E (feature is alive)', () => {
  let dev: ReturnType<typeof buildHarness>;
  let devServer: AgentServer;
  let devApp: express.Express;
  const AUTH = 'test-e2e-resume-idle';

  beforeAll(async () => {
    dev = buildHarness(true);
    const s = await startServer(dev, AUTH);
    devServer = s.server;
    devApp = s.app;
  });

  afterAll(async () => {
    dev.resumeQueue?.stop();
    await devServer.stop();
    SafeFsExecutor.safeRmSync(dev.tmpDir, { recursive: true, force: true, operation: 'tests/e2e/resume-idle-autonomous-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  describe('Phase 1: alive on dev (dryRun:false)', () => {
    it('GET /sessions/resume-queue returns 200 with dryRun:false through the real AgentServer', async () => {
      expect(dev.resolvedDryRun).toBe(false); // live-on-dev resolution
      const res = await request(devApp).get('/sessions/resume-queue').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.dryRun).toBe(false);
    });

    it('requires Bearer auth', async () => {
      expect((await request(devApp).get('/sessions/resume-queue')).status).toBe(401);
    });
  });

  describe('Phase 2: an age-reaped active-run session enters the queue and revives EXACTLY once', () => {
    it('enters the queue (run is the evidence), revives once, second drain does NOT re-spawn', async () => {
      // A genuinely in-flight autonomous run on the topic.
      dev.writeRun(86400, new Date(Date.now() - 60_000).toISOString());
      const reaped: Session = {
        id: 's-age', name: 'age-session', status: 'running', tmuxSession: 'tmux-age',
        startedAt: new Date().toISOString(), cwd: dev.workDir,
      } as Session;
      dev.topicByTmux.set('tmux-age', TOPIC);
      dev.topicResumeMap.set(TOPIC, UUID);

      // Age-limit reap of a topic with an active run ⇒ augmented + enqueued.
      dev.fireSessionReaped({ session: reaped, reason: 'age-limit' });

      const listed = await request(devApp).get('/sessions/resume-queue').set(auth());
      expect(listed.status).toBe(200);
      expect(listed.body.entries).toHaveLength(1);
      expect(listed.body.entries[0]).toMatchObject({
        stableKey: `topic:${TOPIC}`,
        reason: AGE_LIMIT_ACTIVE_RUN_REASON,
      });
      expect(listed.body.entries[0].workEvidence).toContain('build-or-autonomous-active');

      // The reaped session is no longer running, so the topic appears un-live.
      // First drain → revive exactly once.
      const first = await dev.resumeDrainer.tick();
      expect(first.resumed).toBe(true);
      expect(dev.respawns).toHaveLength(1);

      // The revive registered a live session for the topic (respawnTopic mapped it).
      // Re-enqueue (a fresh reap arriving) + drain again → the double-spawn guard
      // (live-session-exists) catches it: ZERO second spawn.
      dev.fireSessionReaped({ session: reaped, reason: 'age-limit' });
      const second = await dev.resumeDrainer.tick();
      expect(second.resumed).toBeFalsy();
      expect(dev.respawns).toHaveLength(1); // still ONE — no double spawn
    });
  });

  describe('Phase 3: fleet config boots observe-only (dryRun:true) — no spawn', () => {
    it('an age-reaped active-run session is audited would-resume and NEVER spawns', async () => {
      const fleet = buildHarness(false);
      try {
        expect(fleet.resolvedDryRun).toBe(true); // observe-only on the fleet
        fleet.writeRun(86400, new Date(Date.now() - 60_000).toISOString());
        const reaped: Session = {
          id: 's-fleet', name: 'fleet-session', status: 'running', tmuxSession: 'tmux-fleet',
          startedAt: new Date().toISOString(), cwd: fleet.workDir,
        } as Session;
        fleet.topicByTmux.set('tmux-fleet', TOPIC);
        fleet.topicResumeMap.set(TOPIC, UUID);
        fleet.fireSessionReaped({ session: reaped, reason: 'age-limit' });

        const r = await fleet.resumeDrainer.tick();
        expect(r.blocked).toBe('dry-run');
        expect(fleet.respawns).toHaveLength(0); // observe-only — no spawn
        expect(fleet.audits.some((a) => a.event === 'would-resume')).toBe(true);
      } finally {
        fleet.resumeQueue.stop();
        SafeFsExecutor.safeRmSync(fleet.tmpDir, { recursive: true, force: true, operation: 'tests/e2e/resume-idle-autonomous-lifecycle.test.ts' });
      }
    });
  });
});

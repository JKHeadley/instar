/**
 * Tier-3 E2E "feature is alive" lifecycle test for the reap-notify +
 * resume-queue feature (reap-notify spec, Testing section).
 *
 * Per TESTING-INTEGRITY-SPEC: boots the REAL AgentServer (same path
 * server.ts uses) with the REAL ReapLog + PendingRelayStore + ReapNotifier +
 * ReapNoticeDrain + ResumeQueue + ResumeQueueDrainer composed exactly the
 * way `instar server` composes them, and verifies:
 *
 *   Phase 1 — alive: GET /sessions/resume-queue returns 200 (not 503)
 *             through the real AgentServer → RouteContext plumbing; Bearer
 *             auth enforced; wiring integrity — the pressure gauge is the
 *             REAL HostPressureSampler (valid tier), the notice store is a
 *             REAL SQLite file on disk.
 *   Phase 2 — a mid-work reap driven through the server.ts `sessionReaped`
 *             fan-out produces a durable per-topic notice row + a queue
 *             entry (visible over HTTP), and the ReapNoticeDrain delivers
 *             it (reap-log notify pair enqueued→sent).
 *   Phase 3 — the drainer resumes the entry under relaxed gates through the
 *             live HTTP manual-drain route: the spawn gate DELEGATES (a
 *             closed quota gate blocks the tick), the Tier-1 check runs
 *             through a REAL LlmQueue (audited verdict), and the recorded
 *             cwd round-trips into the NEW spawn-path `cwd` options
 *             parameter.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createMockSessionManager, type MockSessionManager } from '../helpers/setup.js';
import { PendingRelayStore } from '../../src/messaging/pending-relay-store.js';
import { ReapLog } from '../../src/monitoring/ReapLog.js';
import { ReapNotifier } from '../../src/monitoring/ReapNotifier.js';
import { ReapNoticeDrain } from '../../src/monitoring/ReapNoticeDrain.js';
import { ResumeQueue } from '../../src/monitoring/ResumeQueue.js';
import { ResumeQueueDrainer } from '../../src/monitoring/ResumeQueueDrainer.js';
import { LlmQueue } from '../../src/monitoring/LlmQueue.js';
import { sampleHostPressure } from '../../src/monitoring/HostPressureSampler.js';
import type { InstarConfig, Session } from '../../src/core/types.js';

const TOPIC = 7;
const LIFELINE = 999;

describe('Reap-notify + resume-queue E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let workDir: string; // the reaped session's recorded cwd — must round-trip
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-reap-notify-resume-queue';

  let mockSm: MockSessionManager;
  let store: PendingRelayStore;
  let reapLog: ReapLog;
  let reapNotifier: ReapNotifier;
  let reapNoticeDrain: ReapNoticeDrain;
  let resumeQueue: ResumeQueue;
  let resumeDrainer: ResumeQueueDrainer;

  // Observable boundaries (each mirrors the server.ts dep it stands in for).
  const topicByTmux = new Map<string, number>(); // telegram.getTopicForSession
  const topicResumeMap = new Map<number, string>(); // _topicResumeMap
  const telegramSends: Array<{ topicId: number; text: string }> = [];
  const attentionIds: string[] = [];
  const resumedNotices: number[] = [];
  const audits: Array<Record<string, unknown>> = [];
  let quotaGateOpen = true; // quotaManager.canSpawnSession().allowed
  let llmQueueCalls = 0;
  const llmQueue = new LlmQueue({ maxConcurrent: 1 });

  // server.ts raiseResumeAggregated: ALL give-up classes fold into ONE
  // rolling attention item with the FIXED id (P17).
  const raiseAggregated = (kind: string, detail: string): void => {
    attentionIds.push('resume-queue:aggregate');
    void kind;
    void detail;
  };

  /** Mirrors the server.ts `sessionManager.on('sessionReaped', …)` fan-out. */
  const fireSessionReaped = (e: {
    session: Session;
    reason: string;
    disposition?: 'terminal' | 'recovery-bounce';
    origin?: 'operator' | 'autonomous';
    midWork?: boolean;
    workEvidence?: string[];
  }): void => {
    reapLog.recordReaped({
      session: e.session.name,
      tmuxSession: e.session.tmuxSession,
      reason: e.reason,
      disposition: e.disposition,
      origin: e.origin,
      ...(e.midWork !== undefined ? { midWork: e.midWork } : {}),
      ...(e.workEvidence && e.workEvidence.length > 0 ? { workEvidence: e.workEvidence } : {}),
    });
    if (resumeQueue && !resumeQueue.isDisabled()) {
      const rawTopic = topicByTmux.get(e.session.tmuxSession);
      const topicId = rawTopic == null ? null : rawTopic;
      resumeQueue.considerEnqueue({
        sessionName: e.session.name,
        tmuxSession: e.session.tmuxSession,
        topicId,
        resumeUuid: topicId != null ? (topicResumeMap.get(topicId) ?? null) : null,
        cwd: (e.session as { cwd?: string }).cwd ?? tmpDir,
        reason: e.reason,
        disposition: e.disposition ?? 'terminal',
        origin: e.origin ?? 'autonomous',
        workEvidence: e.workEvidence ?? [],
      });
    }
    reapNotifier.onReaped({
      session: { name: e.session.name, tmuxSession: e.session.tmuxSession },
      reason: e.reason,
      disposition: e.disposition,
      origin: e.origin,
      midWork: e.midWork,
    });
  };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-notify-rq-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    workDir = path.join(tmpDir, 'worktree-of-record');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

    mockSm = createMockSessionManager();
    reapLog = new ReapLog(stateDir, () => 'e2e-machine');
    store = PendingRelayStore.open('e2e', stateDir);

    // ── ReapNotifier — wired the way server.ts wires it (durable lane) ──
    reapNotifier = new ReapNotifier(
      {
        resolveTopic: (tmuxSession) => topicByTmux.get(tmuxSession) ?? null,
        lifelineTopic: () => LIFELINE,
        send: (topicId, text) => telegramSends.push({ topicId, text }),
        enqueueNotice: (input) =>
          store.enqueue({
            delivery_id: input.delivery_id,
            topic_id: input.topic_id,
            text_hash: createHash('sha256').update(input.text).digest('hex'),
            text: input.text,
            next_attempt_at: input.next_attempt_at,
          }),
        recordNotify: (e) => reapLog.recordNotify(e),
        quietHoursEndAt: () => null,
        summaryReleaseAt: (now) => now,
        resumeQueuedFor: (tmuxSession) => resumeQueue.hasLiveQueuedEntryFor(tmuxSession),
      },
      { enabled: true, coalesceWindowMs: 60_000, maxBuffer: 100, perTopic: true, maxImmediatePerFlush: 5, drainEnabled: true },
    );

    // ── ReapNoticeDrain — the always-on delivery loop ──
    reapNoticeDrain = new ReapNoticeDrain(
      {
        store,
        sendToTopic: async (topicId, text) => {
          telegramSends.push({ topicId, text });
        },
        recordNotify: (e) => reapLog.recordNotify(e),
        emitAttention: async (item) => {
          attentionIds.push(item.id);
        },
        bootId: 'boot-e2e',
      },
      { backoffBaseMs: 1 },
    );

    // ── ResumeQueue — LIVE (dryRun false) so the drainer actually resumes ──
    resumeQueue = new ResumeQueue(
      { stateDir, audit: (e) => audits.push(e), raiseAggregated },
      { enabled: true, dryRun: false, maxAttempts: 3, maxResurrections: 2, entryTtlHours: 24, maxQueueSize: 50, includeOperatorKills: false },
    );
    expect(resumeQueue.start()).toBe(true);

    // ── ResumeQueueDrainer — deps shaped exactly like server.ts ──
    resumeDrainer = new ResumeQueueDrainer(
      {
        queue: resumeQueue,
        // WIRING INTEGRITY: the REAL shared pressure gauge (one definition of
        // "pressure"), with the reaper's default thresholds — never a stub.
        pressureTier: () => sampleHostPressure({ cpuModerateLoadPerCore: 1.0, cpuCriticalLoadPerCore: 1.5 }).tier,
        canSpawnSession: () => quotaGateOpen,
        sessionCountOk: () => mockSm.listRunningSessions().length < 10,
        migrationInFlight: () => false,
        liveSessionForTopic: (topicId) =>
          mockSm.listRunningSessions().some((s) => topicByTmux.get(s.tmuxSession) === topicId),
        currentResumeUuid: (topicId) => topicResumeMap.get(topicId) ?? null,
        topicOwnerElsewhere: () => false, // pool not wired → single-machine
        topicBindingMatches: () => true, // unbound topic → default project
        operatorStopSince: () => false,
        jobCheck: () => ({ ok: false, why: 'scheduler-unavailable' }),
        pathExists: (p) => fs.existsSync(p),
        // The respawn boundary threads the entry's recorded cwd into the NEW
        // spawn-path `cwd` options parameter — exactly like server.ts's
        // respawnTopic → spawnSessionForTopic → spawnSession({ cwd }).
        respawnTopic: async (entry, continuationPrompt) => {
          const session = await mockSm.spawnSession({
            name: entry.sessionName,
            prompt: continuationPrompt,
            cwd: entry.worktreePath ?? entry.cwd,
          } as Parameters<MockSessionManager['spawnSession']>[0]);
          topicByTmux.set(session.tmuxSession, entry.topicId!);
          return session.tmuxSession;
        },
        triggerJob: async () => 'skipped',
        // Delegates to the session manager's liveness probe (server.ts shape,
        // minus the 15s grace sleep — deadline budget).
        spawnAliveAfterGrace: async (tmuxSession) => mockSm.isSessionAlive(tmuxSession),
        notifyResumed: (entry) => {
          if (entry.topicId != null) resumedNotices.push(entry.topicId);
        },
        raiseAggregated,
        audit: (e) => audits.push(e),
        // WIRING INTEGRITY: the Tier-1 check goes through a REAL LlmQueue
        // (background lane), exactly like server.ts — only the model call
        // behind it is stubbed.
        tier1Check: async () => {
          const raw = await llmQueue.enqueue('background', async () => {
            llmQueueCalls++;
            return '{"sensible": true, "reasoning": "coherent mid-work entry"}';
          });
          const parsed = JSON.parse(raw) as { sensible?: boolean; reasoning?: string };
          return { sensible: parsed.sensible !== false, reasoning: parsed.reasoning };
        },
      },
      // Relaxed gates for the E2E loop: no calm-tick dwell.
      { drainIntervalSec: 60, requiredCalmTicks: 0, maxAttempts: 3, breakerThreshold: 3, breakerCooldownMin: 30, tier1Check: true },
    );

    const config: InstarConfig = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as InstarConfig;

    server = new AgentServer({
      config,
      sessionManager: mockSm as never,
      state: new StateManager(stateDir),
      reapLog,
      resumeQueue,
      resumeDrainer,
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    resumeQueue?.stop();
    await server.stop();
    store.close();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/reap-notify-resume-queue-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  describe('Phase 1: feature is alive (not 503)', () => {
    it('GET /sessions/resume-queue returns 200 through the real AgentServer plumbing', async () => {
      const res = await request(app).get('/sessions/resume-queue').set(auth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.entries)).toBe(true);
      expect(res.body.dryRun).toBe(false);
      expect(res.body.paused).toBe(false);
      expect(res.body.breaker.open).toBe(false);
    });

    it('requires Bearer auth', async () => {
      expect((await request(app).get('/sessions/resume-queue')).status).toBe(401);
    });

    it('wiring integrity: the pressure gauge is the real sampler, the notice store is real SQLite', () => {
      const tier = sampleHostPressure({ cpuModerateLoadPerCore: 1.0, cpuCriticalLoadPerCore: 1.5 }).tier;
      expect(['normal', 'moderate', 'critical']).toContain(tier);
      // PendingRelayStore.open creates the durable DB file under the state dir.
      const files = fs.readdirSync(path.join(stateDir, 'state'));
      expect(files.some((f) => f.includes('pending-relay'))).toBe(true);
    });
  });

  describe('Phase 2: mid-work reap → durable topic notice + queue entry', () => {
    it('the sessionReaped fan-out lands a queue entry (visible over HTTP) and a durable notice row', async () => {
      const reaped: Session = {
        id: 's-midwork', name: 'midwork-session', status: 'running', tmuxSession: 'tmux-midwork',
        startedAt: new Date().toISOString(), cwd: workDir,
      } as Session;
      topicByTmux.set('tmux-midwork', TOPIC);
      topicResumeMap.set(TOPIC, '11111111-1111-4111-8111-111111111111');

      fireSessionReaped({
        session: reaped,
        reason: 'quota-shed',
        disposition: 'terminal',
        origin: 'autonomous',
        midWork: true,
        workEvidence: ['build-or-autonomous-active'],
      });
      await reapNotifier.flush();

      // Queue entry — end-to-end through the live HTTP route.
      const res = await request(app).get('/sessions/resume-queue').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0]).toMatchObject({
        stableKey: `topic:${TOPIC}`,
        status: 'queued',
        cwd: workDir,
      });

      // Durable notice row for the affected topic in the REAL store.
      const rows = store.selectClaimableReapNotices(new Date(Date.now() + 3600_000).toISOString(), 100);
      expect(rows.map((r) => r.topic_id)).toContain(TOPIC);

      // Reap-log: the reaped row is mid-work-stamped; the notify 'enqueued'
      // half of the outcome pair is recorded.
      const entries = reapLog.read();
      const reapedRow = entries.find((e) => e.type === 'reaped');
      expect(reapedRow).toMatchObject({ midWork: true, workEvidence: ['build-or-autonomous-active'] });
      const notifies = entries.filter((e) => e.type === 'notify');
      expect(notifies.map((e) => e.outcome)).toContain('enqueued');
    });

    it('the always-on drain delivers the notice (enqueued → sent pair)', async () => {
      const result = await reapNoticeDrain.tick();
      expect(result.sent).toBeGreaterThanOrEqual(1);
      const topicSend = telegramSends.find((s) => s.topicId === TOPIC);
      expect(topicSend).toBeDefined();
      expect(topicSend!.text).toContain('midwork-session');

      const notifies = reapLog.read().filter((e) => e.type === 'notify');
      const outcomes = notifies.map((e) => e.outcome);
      expect(outcomes).toContain('enqueued');
      expect(outcomes).toContain('sent');
    });
  });

  describe('Phase 3: drainer resume under relaxed gates (cwd round-trip + delegating gates)', () => {
    it('a closed spawn gate blocks the tick — the quota dep is real and delegating', async () => {
      quotaGateOpen = false;
      const result = await resumeDrainer.tick();
      expect(result.resumed).toBe(false);
      expect(result.blocked).toBe('quota');
      quotaGateOpen = true;
    });

    it('the HTTP manual-drain route resumes the entry; the recorded cwd round-trips into the spawn-path cwd parameter', async () => {
      const res = await request(app).post('/sessions/resume-queue/drain').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.resumed).toBe(true);

      // cwd round-trip: reaped session's recorded cwd → queue entry →
      // respawn boundary → the NEW spawn-path `cwd` options parameter.
      expect(mockSm._spawnCount).toBe(1);
      expect((mockSm._lastSpawnArgs as { cwd?: string }).cwd).toBe(workDir);
      // The continuation prompt is the R2.8 mid-work pickup prompt.
      expect(mockSm._lastSpawnArgs!.prompt).toContain('shut down mid-work');

      // Entry reached its terminal success state; the topic was told honestly.
      const entry = resumeQueue.list().find((e) => e.stableKey === `topic:${TOPIC}`);
      expect(entry?.status).toBe('respawned');
      expect(resumedNotices).toEqual([TOPIC]);

      // Tier-1 supervision ran through the REAL LlmQueue and was audited.
      expect(llmQueueCalls).toBeGreaterThanOrEqual(1);
      const verdicts = audits.filter((a) => a.event === 'tier1-verdict');
      expect(verdicts.length).toBeGreaterThanOrEqual(1);
      expect(verdicts[verdicts.length - 1]).toMatchObject({ supervision: 'verdict', sensible: true });

      // P17: no per-entry attention items were raised on the happy path.
      expect(attentionIds.filter((id) => id !== 'resume-queue:aggregate')).toEqual([]);
    });
  });
});

/**
 * E2E lifecycle for Promise-Beacon Escalation (PROMISE-BEACON-ESCALATION-SPEC §7).
 *
 * Phase-1 "feature is alive": the escalation surface is reachable from a booted
 * server (200, not 503/404), and the live PromiseBeacon's escalation deps are
 * non-null / not no-op — GET /commitments/escalation-metrics reflects the live
 * beacon, not a stub.
 *
 * Report-only guarantee (round 5, codex#5): an owner-gone commitment whose
 * revival can only REPORT — never complete the work — ends with the user
 * receiving an honest interim status, and the commitment is NOT falsely
 * delivered. Plus the dry-run contract: no spawn, no message, audit only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LlmQueue } from '../../src/monitoring/LlmQueue.js';
import { ProxyCoordinator } from '../../src/monitoring/ProxyCoordinator.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { PromiseBeacon, type EscalationConfig, type ReviveResult } from '../../src/monitoring/PromiseBeacon.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'test-promise-escalation-e2e';
const NEVER_QUIET = (() => {
  const d = new Date(2026, 5, 13, 12, 0, 0);
  const cur = d.getHours() * 60 + d.getMinutes();
  const s = (cur + 600) % 1380;
  const f = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return { start: f(s), end: f(s + 1) };
})();
const FIXED_NOW = new Date(2026, 5, 13, 12, 0, 0).getTime();

describe('Promise-Beacon Escalation lifecycle (e2e)', () => {
  let tmpDir: string; let stateDir: string;
  let tracker: CommitmentTracker;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  let beacon: PromiseBeacon | null = null;
  const sent: Array<{ topicId: number; text: string }> = [];
  let reviveCalls = 0;

  const auth = () => ({ Authorization: `Bearer ${AUTH}`, 'X-Instar-AgentId': 'promise-escalation-e2e' });

  function wireBeacon(esc: EscalationConfig, revive: () => Promise<ReviveResult>) {
    const b = new PromiseBeacon({
      stateDir, commitmentTracker: tracker, llmQueue: new LlmQueue({ maxDailyCents: 100 }),
      proxyCoordinator: new ProxyCoordinator(),
      captureSessionOutput: () => 'x', getSessionForTopic: () => 'dead-sess', isSessionAlive: () => true,
      getSessionEpoch: () => 'NEW-EPOCH', sendMessage: async (topicId, text) => { sent.push({ topicId, text }); },
      now: () => FIXED_NOW, quietHours: NEVER_QUIET, escalation: esc,
      requestRevive: async () => { reviveCalls += 1; return revive(); },
      raiseAttention: () => {},
    });
    (globalThis as Record<string, unknown>).__instarPromiseBeacon = b;
    return b;
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promise-escalation-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');

    const config: InstarConfig = {
      projectName: 'promise-escalation-e2e', projectDir: tmpDir, stateDir, port: 0,
      authToken: AUTH, requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], updates: {},
      monitoring: { promiseBeacon: { escalation: { revalidationTtlMs: 1_800_000 } } },
    } as unknown as InstarConfig;

    tracker = new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) });
    server = new AgentServer({
      config, sessionManager: { listRunningSessions: () => [], getSession: () => null } as never,
      state: new StateManager(stateDir), commitmentTracker: tracker,
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    beacon?.stop();
    delete (globalThis as Record<string, unknown>).__instarPromiseBeacon;
    await server.stop();
    tracker.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/promise-escalation-lifecycle.test.ts' });
  });

  it('feature is alive: escalation-metrics is reachable from boot and reflects the live beacon', async () => {
    beacon = wireBeacon({ enabled: true, dryRun: true }, async () => ({ sessionName: 'r' }));
    const res = await request(app).get('/commitments/escalation-metrics').set(auth());
    expect(res.status).toBe(200); // NOT 503/404
    expect(res.body.enabled).toBe(true);
    expect(res.body.dryRun).toBe(true);
    expect(res.body).toHaveProperty('doubleSpawnCount', 0);
  });

  it('dry-run contract: an epoch-loss commitment produces an audit, no spawn, no message', async () => {
    beacon = wireBeacon({ enabled: true, dryRun: true }, async () => ({ sessionName: 'r' }));
    beacon.start();
    const before = sent.length; const beforeRevive = reviveCalls;
    const c = tracker.record({
      type: 'one-time-action', userRequest: 'send dashboard link', agentResponse: 'will send it',
      topicId: 901, beaconEnabled: true, cadenceMs: 60_000, nextUpdateDueAt: '2099-01-01T00:00:00Z', sessionEpoch: 'OLD-EPOCH',
    });
    await beacon.fire(c.id);

    expect(reviveCalls).toBe(beforeRevive); // no spawn in dry-run
    expect(sent.length).toBe(before); // no message in dry-run
    const after = tracker.get(c.id)!;
    expect(after.status).toBe('pending'); // not terminalized, not falsely delivered
    expect(after.escalationAttempts ?? 0).toBe(0);
    beacon.stop();
  });

  it('report-only: an owner-gone revival that can only report ends with an honest status, never a false completion', async () => {
    // dryRun:false, but revival is refused (owner gone) → Rung 2 honest status.
    beacon = wireBeacon({ enabled: true, dryRun: false }, async () => ({ sessionName: null, refusalReason: 'unbound' }));
    beacon.start();
    const before = sent.length;
    const c = tracker.record({
      type: 'one-time-action', userRequest: 'send dashboard link', agentResponse: 'will send it',
      topicId: 902, beaconEnabled: true, cadenceMs: 60_000, nextUpdateDueAt: '2099-01-01T00:00:00Z', sessionEpoch: 'OLD-EPOCH',
    });
    await beacon.fire(c.id);

    expect(sent.length).toBe(before + 1);
    const msg = sent[sent.length - 1].text;
    expect(msg).toMatch(/can.?t auto-resume|operator may need|still open/i);
    expect(msg).not.toMatch(/delivered|done|completed/i); // never a false completion
    const after = tracker.get(c.id)!;
    expect(after.status).toBe('pending'); // still owed — NOT falsely delivered
    expect(after.atRisk).toBe(true);
    beacon.stop();
  });
});

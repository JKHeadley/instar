// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Readiness chunking, end to end on the operated store's REAL shapes (Mac Studio,
 * 2026-10-01). Live, a 50-candidate readiness call hit the 60 s model budget twice
 * in a row (CodexExecJsonTimeoutError, runs 2b4bebb3 and 0e7b229a) while 10
 * candidates finished in ~31 s. This boots the production AgentServer wiring with
 * the recorded reports and replays the recorded gpt-6-astra replies through the
 * unchanged parser in chunks of 5, with the second call of the first tick timing
 * out the way the live calls did: the first chunk's decisions survive, the tick is
 * honest about the failure, the authority stays active, and the next tick
 * finishes the pass.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { fileURLToPath } from 'node:url';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { CodexExecJsonTimeoutError } from '../../src/providers/adapters/openai-codex/transport/codexSpawn.js';
import type { InstarConfig, IntelligenceProvider } from '../../src/core/types.js';

const AUTH = 'feedback-chunking-e2e-auth';
const PIN = '161803';
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'feedback-drain-live-shapes.json');

interface Shapes {
  firstLines: Array<Record<string, unknown>>;
  laterReports: Array<Record<string, unknown>>;
  arbiterReplies: { ready: string; collecting: string };
  arbiterResolvedModel: { model: string; framework: string };
}
interface RecordedDecision { clusterId: string; outcome: string; confidence: number; reasonCodes: string[]; evidenceIds: string[] }

describe('feedback drain — chunked readiness on the operated store\'s real shapes', () => {
  const shapes = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Shapes;
  const recorded = [shapes.arbiterReplies.ready, shapes.arbiterReplies.collecting]
    .flatMap((raw) => (JSON.parse(raw) as { decisions: RecordedDecision[] }).decisions);
  const collectingTemplate = recorded.find((decision) => decision.outcome === 'collecting')!;
  let root: string;
  let server: AgentServer;
  let nonce = 0;
  const calls: string[][] = [];
  const replayedIds = new Set<string>();
  let timeoutOnCall = 0;
  const auth = { Authorization: `Bearer ${AUTH}` };
  const db = () => (server as unknown as { feedbackDrain: { store: { db: import('better-sqlite3').Database } } }).feedbackDrain.store.db;

  async function tick(): Promise<{ state: string; reason: string }> {
    const app = server.getApp();
    const accepted = await request(app).post('/feedback-factory/drain/tick')
      .set({ ...auth, 'X-Instar-Request': '1', 'X-Instar-AgentId': 'e2e', 'X-Instar-Request-Nonce': `feedback-chunking-e2e-${String(++nonce).padStart(4, '0')}` });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
    for (let attempt = 0; attempt < 500; attempt++) {
      const last = (await request(app).get('/feedback-factory/drain/status').set(auth)).body?.lastRun;
      if (last?.runId === accepted.body.runId && !['accepted', 'running'].includes(last.state)) return last;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('drain run did not finish');
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-chunking-e2e-'));
    const stateDir = path.join(root, '.instar');
    const canonical = path.join(stateDir, 'state', 'feedback-factory', 'store');
    fs.mkdirSync(canonical, { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'e2e', authToken: AUTH, dashboardPin: PIN }));
    fs.writeFileSync(path.join(canonical, 'feedback.jsonl'), [...shapes.firstLines, ...shapes.laterReports].map((row) => `${JSON.stringify(row)}\n`).join(''));
    const intelligence: IntelligenceProvider = {
      evaluate: async (prompt, options) => {
        const packet = JSON.parse(prompt.slice(prompt.indexOf('Candidates: ') + 12)) as Array<{ clusterId: string }>;
        calls.push(packet.map(({ clusterId }) => clusterId));
        if (calls.length === timeoutOnCall) throw new CodexExecJsonTimeoutError(60_000, '');
        options?.onModel?.(shapes.arbiterResolvedModel);
        return JSON.stringify({ decisions: packet.map(({ clusterId }) => {
          const hit = recorded.find((decision) => decision.clusterId === clusterId);
          if (hit) replayedIds.add(clusterId);
          return hit ?? { ...collectingTemplate, clusterId, evidenceIds: [`cluster:${clusterId}`] };
        }) });
      },
    };
    const config = {
      projectName: 'e2e', projectDir: root, stateDir, port: 0, authToken: AUTH, dashboardPin: PIN,
      developmentAgent: true, requestTimeoutMs: 30_000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
      feedbackFactory: { processing: {}, drain: { readinessChunkSize: 5, maxWallClockMs: 90_000 }, consumer: { dryRun: true } },
    } as InstarConfig;
    server = new AgentServer({
      config, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), intelligence,
      sessionManager: { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [], on: () => undefined } as never,
    });
    await server.start();
    expect((await request(server.getApp()).post('/feedback-factory/readiness-authorities').set({ ...auth, 'X-Instar-Request': '1' }).send({
      pin: PIN, action: 'create', operatorDecisionRef: 'operator-approved-chunking-e2e',
      authorityId: 'feedback-readiness-default', agentId: 'e2e', ownerMachineId: 'e2e', ownerEpoch: 1,
      provider: 'codex-cli', modelFamily: 'gpt-6-astra', promptVersion: 'feedback-readiness-v1', schemaVersion: 'feedback-readiness-decision-v1',
      decisionPointId: 'feedback-cluster-readiness', maxBatch: 50, maxTokens: 1200, maxDailySpendUsd: 5,
    })).status).toBe(200);
  });

  afterAll(async () => {
    await server?.stop();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'feedback-drain-readiness-chunking.test.ts' });
  });

  it('keeps the first chunk when a later one times out, then finishes the pass on the next tick', async () => {
    timeoutOnCall = 2;
    const first = await tick();
    expect(first).toMatchObject({ state: 'degraded', reason: 'readiness-authority-failed' });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((call) => call.length <= 5)).toBe(true);
    const firstChunk = calls[0];
    const readiness = (id: string) => db().prepare(`SELECT state, reason_code, last_evaluated_at FROM readiness WHERE cluster_id=?`).get(id) as
      { state: string; reason_code: string | null; last_evaluated_at: number | null };
    // The first chunk's recorded decisions were applied, not discarded with the failed chunk.
    for (const id of firstChunk) expect(readiness(id).reason_code).not.toBe('readiness-authority-failed');
    for (const id of calls[1]) expect(readiness(id)).toMatchObject({ state: 'collecting', reason_code: 'readiness-authority-failed' });
    expect(db().prepare(`SELECT mode FROM authority_posture`).all()).toEqual([]);
    expect(db().prepare(`SELECT value FROM drain_meta WHERE key LIKE 'authority_transient_failures:%'`).all()).toEqual([]);

    // Next tick: the rows not reached are still due and get decided; nothing is demoted.
    const callsBefore = calls.length;
    expect((await tick()).state).toBe('succeeded');
    expect(calls.length).toBeGreaterThan(callsBefore);
    expect(calls.every((call) => call.length <= 5)).toBe(true);
    const failedChunk = new Set(calls[1]);
    const unevaluated = db().prepare(`SELECT cluster_id FROM readiness WHERE state='collecting' AND last_evaluated_at IS NULL`).all() as Array<{ cluster_id: string }>;
    expect(unevaluated).toEqual([]);
    const reviewed = new Set(calls.flat());
    const all = db().prepare(`SELECT cluster_id FROM readiness`).all() as Array<{ cluster_id: string }>;
    for (const row of all) if (!failedChunk.has(row.cluster_id)) expect(reviewed.has(row.cluster_id)).toBe(true);
    // Real recorded "ready" decisions reached the queue through the chunked path.
    const readyIds = recorded.filter((decision) => decision.outcome === 'ready' && replayedIds.has(decision.clusterId)).map((decision) => decision.clusterId);
    expect(readyIds.length).toBeGreaterThanOrEqual(1);
    for (const id of readyIds) expect(readiness(id).state).toBe('queued');
  });
});

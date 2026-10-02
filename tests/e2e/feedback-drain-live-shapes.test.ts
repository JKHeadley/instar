// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Feedback drain, end to end on the operated store's REAL shapes (Mac Studio,
 * 2026-10-01). Live, every run after the first failed with "source record
 * checksum conflicts with its projection": the drain read its own
 * unprocessed->processing re-append as a conflict, and that one record failed
 * the whole run, so 742 clusters never left "collecting".
 *
 * This boots the production AgentServer wiring, replays the recorded report
 * lines and the two recorded gpt-6-astra readiness replies, puts the store in the
 * exact state the live one was left in (stale conflict row + integrity hold,
 * cursor parked on the first re-appended line), and drives HTTP ticks until a
 * full pass: every report processed, every cluster evaluated, ready -> queued ->
 * completed Initiative tasks, with no operator action.
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
import type { InstarConfig, IntelligenceProvider } from '../../src/core/types.js';

const AUTH = 'feedback-live-shapes-auth';
const PIN = '271828';
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'feedback-drain-live-shapes.json');

interface Shapes {
  conflictSourceRecordId: string;
  firstLines: Array<Record<string, unknown>>;
  versionLines: Array<Record<string, unknown>>;
  laterReports: Array<Record<string, unknown>>;
  arbiterReplies: { ready: string; collecting: string };
  arbiterResolvedModel: { model: string; framework: string };
}

interface RecordedDecision { clusterId: string; outcome: string; confidence: number; reasonCodes: string[]; evidenceIds: string[] }

describe('feedback drain — full pass on the operated store\'s real shapes', () => {
  const shapes = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Shapes;
  const recorded = [shapes.arbiterReplies.ready, shapes.arbiterReplies.collecting]
    .flatMap((raw) => (JSON.parse(raw) as { decisions: RecordedDecision[] }).decisions);
  const recordedReady = recorded.filter((decision) => decision.outcome === 'ready').map((decision) => decision.clusterId);
  const collectingTemplate = recorded.find((decision) => decision.outcome === 'collecting')!;
  let root: string;
  let canonical: string;
  let tracker: InitiativeTracker;
  let server: AgentServer;
  let nonce = 0;
  const replayedIds = new Set<string>();

  const db = () => (server as unknown as { feedbackDrain: { store: { db: import('better-sqlite3').Database } } }).feedbackDrain.store.db;
  const auth = { Authorization: `Bearer ${AUTH}` };

  async function tick(): Promise<{ state: string; reason: string }> {
    const app = server.getApp();
    const accepted = await request(app).post('/feedback-factory/drain/tick')
      .set({ ...auth, 'X-Instar-Request': '1', 'X-Instar-AgentId': 'e2e', 'X-Instar-Request-Nonce': `feedback-live-shapes-${String(++nonce).padStart(4, '0')}` });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
    for (let attempt = 0; attempt < 500; attempt++) {
      const status = await request(app).get('/feedback-factory/drain/status').set(auth);
      const last = status.body?.lastRun;
      if (last?.runId === accepted.body.runId && !['accepted', 'running'].includes(last.state)) return last;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('drain run did not finish');
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-live-shapes-'));
    const stateDir = path.join(root, '.instar');
    canonical = path.join(stateDir, 'state', 'feedback-factory', 'store');
    fs.mkdirSync(canonical, { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'e2e', authToken: AUTH, dashboardPin: PIN }));
    fs.writeFileSync(path.join(canonical, 'feedback.jsonl'), shapes.firstLines.map((row) => `${JSON.stringify(row)}\n`).join(''));
    tracker = new InitiativeTracker(stateDir);
    // Replays the recorded gpt-6-astra replies; a cluster the recordings never saw
    // gets the recorded "collecting" decision shape.
    const intelligence: IntelligenceProvider = {
      evaluate: async (prompt, options) => {
        options?.onModel?.(shapes.arbiterResolvedModel);
        const packet = JSON.parse(prompt.slice(prompt.indexOf('Candidates: ') + 12)) as Array<{ clusterId: string }>;
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
      feedbackFactory: { processing: {}, drain: {}, consumer: { dryRun: false } },
    } as InstarConfig;
    server = new AgentServer({
      config, state: new StateManager(stateDir), initiativeTracker: tracker, intelligence,
      sessionManager: { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [], on: () => undefined } as never,
    });
    await server.start();
    const app = server.getApp();
    expect((await request(app).post('/feedback-factory/readiness-authorities').set({ ...auth, 'X-Instar-Request': '1' }).send({
      pin: PIN, action: 'create', operatorDecisionRef: 'operator-approved-live-shapes',
      authorityId: 'feedback-readiness-default', agentId: 'e2e', ownerMachineId: 'e2e', ownerEpoch: 1,
      provider: 'codex-cli', modelFamily: 'gpt-6-astra', promptVersion: 'feedback-readiness-v1', schemaVersion: 'feedback-readiness-decision-v1',
      decisionPointId: 'feedback-cluster-readiness', maxBatch: 50, maxTokens: 1200, maxDailySpendUsd: 5,
    })).status).toBe(200);
    expect((await request(app).post('/feedback-factory/consumer/promote').set({ ...auth, 'X-Instar-Request': '1' })
      .send({ pin: PIN, approvedBatchBound: 10, evidenceHash: 'b'.repeat(64), operatorDecisionId: 'operator-approved-live-shapes' })).status).toBe(200);
  });

  afterAll(async () => {
    await server?.stop();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'feedback-drain-live-shapes.test.ts' });
  });

  it('drains the real shapes to completed Initiative tasks without operator action', async () => {
    // Run 1 — what the first live run did: project, cluster, and re-append each report as processing.
    expect((await tick()).state).toBe('succeeded');
    const lines = fs.readFileSync(path.join(canonical, 'feedback.jsonl'), 'utf8').trim().split('\n').map((raw) => JSON.parse(raw) as Record<string, unknown>);
    const appended = lines.slice(shapes.firstLines.length);
    // The fixed writer appends each processing update as a NEW source record (spec): same row shape
    // as the recorded live update, but its own sourceRecordId.
    const recordedVersion = shapes.versionLines.find((row) => row.sourceRecordId === shapes.conflictSourceRecordId)!;
    const ownVersion = appended.find((row) => row.feedbackId === recordedVersion.feedbackId)!;
    expect(Object.keys(ownVersion).sort()).toEqual(Object.keys(recordedVersion).sort());
    expect(ownVersion).toMatchObject({ status: 'processing', clusterId: recordedVersion.clusterId });
    expect(ownVersion.sourceRecordId).not.toBe(shapes.conflictSourceRecordId);
    expect(appended).toHaveLength(shapes.versionLines.length);

    // The state the live store was left in by the earlier build.
    db().prepare(`INSERT INTO source_conflicts VALUES (?,?,?,?,?)`).run(shapes.conflictSourceRecordId,
      'db9022fccc37b940caa7c131f9d013e5d55ea3a12d5b1667c7160852fc38352d', 'e40510f6c0e95220f25f3eac07128489823a93b0f52a2dd4287186e90beb8bd3',
      'source-record-checksum-conflict', 1790895621839);
    db().prepare(`INSERT INTO drain_meta(key,value) VALUES ('source_integrity_hold','source-record-checksum-conflict') ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
    // The live file also holds the earlier writer's updates under the ORIGINAL ids (real bytes).
    fs.appendFileSync(path.join(canonical, 'feedback.jsonl'), [...shapes.versionLines, ...shapes.laterReports].map((row) => `${JSON.stringify(row)}\n`).join(''));

    // Later runs: no failed run, the stale conflict clears itself, everything flows.
    const states: string[] = [];
    for (let run = 0; run < 6; run++) states.push((await tick()).state);
    expect(states).not.toContain('failed');
    expect(states).not.toContain('degraded');
    const status = (await request(server.getApp()).get('/feedback-factory/drain/status').set(auth)).body;
    expect(status.drain.sourceChecksumConflicts).toBe(0);
    expect(db().prepare(`SELECT value FROM drain_meta WHERE key='source_integrity_hold'`).get()).toBeUndefined();
    expect(db().prepare(`SELECT reason FROM drain_audit WHERE kind='source-record'`).all()).toEqual([{ reason: 'cleared-misclassified-conflict' }]);

    // Every report processed; every cluster evaluated.
    expect(status.processing.byStatus).toEqual({ processing: shapes.firstLines.length + shapes.laterReports.length });
    expect(status.drain.sourceProjectionLagBytes).toBe(0);
    const unevaluated = db().prepare(`SELECT COUNT(*) n FROM readiness WHERE state='collecting' AND last_evaluated_at IS NULL`).get() as { n: number };
    expect(unevaluated.n).toBe(0);

    // The recorded "ready" decisions reached the product and became completed, readable tasks.
    // A cluster is named after its earliest report in the batch that created it, so one live
    // cluster (whose reports arrived in different live batches) carries another name here.
    const present = recordedReady.filter((id) => replayedIds.has(id)).sort();
    expect(present.length).toBeGreaterThanOrEqual(4);
    expect(status.drain.readiness.queued).toBe(present.length);
    expect(status.drain.work.completed).toBe(present.length);
    const tasks = tracker.list().filter((row) => row.feedbackWorkKey?.startsWith('feedback-work:'));
    expect(tasks.map((task) => task.links?.find((link) => link.label === 'Feedback cluster')?.ref).sort()).toEqual(present);
  });
});

// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Running out of tick time is a clean stop, end to end (Mac Studio, 2026-10-01, authority
 * gen 4 maxBatch 50). Live drain runs ef0f6cbf and 10674e04 each made two good readiness
 * calls, then started a one-candidate call with under 8 s left; the tick clock cut it at
 * 70.0 s, the run was labelled degraded/readiness-authority-failed with zero provider
 * errors, and the feedback-factory-process job — whose 60 s poll had already given up —
 * recorded success.
 *
 * This boots the production AgentServer wiring on the recorded reports with the live
 * latency shape (a fixed start-up cost per call plus a per-candidate pace, applied to the
 * drain's clock), replays the recorded gpt-6-astra replies, and then runs the SHIPPED job
 * script against the real server: the run must end succeeded with the informational note,
 * the rest must stay due, and the job must record success honestly.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { installBuiltinJobs } from '../../src/scheduler/InstallBuiltinJobs.js';
import { READINESS_TIME_EXHAUSTED } from '../../src/feedback-factory/drain/FeedbackDrainService.js';
import type { InstarConfig, IntelligenceProvider } from '../../src/core/types.js';

const AUTH = 'feedback-time-exhausted-e2e-auth';
const PIN = '271828';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'feedback-drain-live-shapes.json');
// Live calls: 6 candidates 23.2 s, 9 candidates 30.2 s, 10 candidates 32.2 s → ~9 s start-up
// plus ~2.3 s per candidate. With chunks of 5 the same shape is kept by a 4.5 s pace: call 1
// (5) takes 31.5 s, call 2 (4) 27 s, and 11.5 s is left — too little for a one-candidate call
// (13.5 s), exactly the live third call.
const FIXED_MS = 9_000;
const PER_CANDIDATE_MS = 4_500;

interface Shapes {
  firstLines: Array<Record<string, unknown>>;
  laterReports: Array<Record<string, unknown>>;
  arbiterReplies: { ready: string; collecting: string };
  arbiterResolvedModel: { model: string; framework: string };
}
interface RecordedDecision { clusterId: string; outcome: string; confidence: number; reasonCodes: string[]; evidenceIds: string[] }

describe('feedback drain — a tick that runs out of time succeeds and the job records it honestly', () => {
  const shapes = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Shapes;
  const recorded = [shapes.arbiterReplies.ready, shapes.arbiterReplies.collecting]
    .flatMap((raw) => (JSON.parse(raw) as { decisions: RecordedDecision[] }).decisions);
  const collectingTemplate = recorded.find((decision) => decision.outcome === 'collecting')!;
  const realNow = Date.now.bind(Date);
  let offset = 0;
  let root: string;
  let server: AgentServer;
  const calls: string[][] = [];
  const db = () => (server as unknown as { feedbackDrain: { store: { db: import('better-sqlite3').Database } } }).feedbackDrain.store.db;

  beforeAll(async () => {
    // The drain captures Date.now at construction; the latency shape advances it.
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-time-exhausted-e2e-'));
    const stateDir = path.join(root, '.instar');
    const canonical = path.join(stateDir, 'state', 'feedback-factory', 'store');
    fs.mkdirSync(canonical, { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'e2e', authToken: AUTH, dashboardPin: PIN, developmentAgent: true }));
    fs.writeFileSync(path.join(canonical, 'feedback.jsonl'), [...shapes.firstLines, ...shapes.laterReports].map((row) => `${JSON.stringify(row)}\n`).join(''));
    const intelligence: IntelligenceProvider = {
      evaluate: async (prompt, options) => {
        const packet = JSON.parse(prompt.slice(prompt.indexOf('Candidates: ') + 12)) as Array<{ clusterId: string }>;
        calls.push(packet.map(({ clusterId }) => clusterId));
        offset += FIXED_MS + packet.length * PER_CANDIDATE_MS;
        options?.onModel?.(shapes.arbiterResolvedModel);
        return JSON.stringify({ decisions: packet.map(({ clusterId }) =>
          recorded.find((decision) => decision.clusterId === clusterId) ?? { ...collectingTemplate, clusterId, evidenceIds: [`cluster:${clusterId}`] }) });
      },
    };
    const config = {
      projectName: 'e2e', projectDir: root, stateDir, port: 0, host: '127.0.0.1', authToken: AUTH, dashboardPin: PIN,
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
    const port = ((server as unknown as { server: { address(): AddressInfo } }).server.address()).port;
    const created = await fetch(`http://127.0.0.1:${port}/feedback-factory/readiness-authorities`, {
      method: 'POST', headers: { Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pin: PIN, action: 'create', operatorDecisionRef: 'operator-approved-time-exhausted-e2e',
        authorityId: 'feedback-readiness-default', agentId: 'e2e', ownerMachineId: 'e2e', ownerEpoch: 1,
        provider: 'codex-cli', modelFamily: 'gpt-6-astra', promptVersion: 'feedback-readiness-v1', schemaVersion: 'feedback-readiness-decision-v1',
        decisionPointId: 'feedback-cluster-readiness', maxBatch: 50, maxTokens: 1200, maxDailySpendUsd: 5,
      }),
    });
    expect(created.status).toBe(200);
  });

  afterAll(async () => {
    await server?.stop();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'feedback-drain-time-exhausted.test.ts' });
  });

  it('the shipped job script drives a tick that stops for time: run succeeded with the note, rest due, job success', async () => {
    const stateDir = path.join(root, '.instar');
    expect(installBuiltinJobs({ agentStateDir: stateDir, packageRoot: REPO_ROOT, port: 4044 }).errors).toEqual([]);
    const body = fs.readFileSync(path.join(stateDir, 'jobs', 'instar', 'feedback-factory-process.md'), 'utf8');
    const open = "python3 - <<'FEEDBACK_DRAIN_TICK'\n";
    const script = body.slice(body.indexOf(open) + open.length, body.indexOf('\nFEEDBACK_DRAIN_TICK\n') + 1);
    const port = ((server as unknown as { server: { address(): AddressInfo } }).server.address()).port;
    const failureFile = path.join(root, 'declared-failure.txt');
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn('python3', ['-'], {
        cwd: root,
        env: { ...process.env, INSTAR_AUTH_TOKEN: AUTH, INSTAR_AGENT_ID: 'e2e', INSTAR_PORT: String(port), INSTAR_JOB_FAILURE_FILE: failureFile, FEEDBACK_DRAIN_POLL_SECONDS: '30' },
      });
      let out = '';
      child.stdout.on('data', (chunk) => { out += String(chunk); });
      child.stderr.on('data', (chunk) => { out += String(chunk); });
      child.on('error', reject);
      child.on('close', (code) => { if (code === 0) resolve(out); else reject(new Error(`script exited ${code}: ${out}`)); });
      child.stdin.end(script);
    });

    // Two good calls, then a clean stop: the live third call is never started.
    expect(calls.map((call) => call.length)).toEqual([5, 4]);
    expect(stdout, stdout).toMatch(/FEEDBACK_DRAIN_RESULT succeeded run:/);
    expect(fs.existsSync(failureFile)).toBe(false);
    const run = db().prepare(`SELECT state, reason FROM drain_runs ORDER BY created_at DESC LIMIT 1`).get() as { state: string; reason: string };
    expect(run).toEqual({ state: 'succeeded', reason: READINESS_TIME_EXHAUSTED });
    expect(db().prepare(`SELECT COUNT(*) n FROM readiness WHERE reason_code='readiness-authority-failed'`).get()).toEqual({ n: 0 });
    // The candidates not reached stay due, untouched, for the next tick.
    const untouched = db().prepare(`SELECT COUNT(*) n FROM readiness WHERE state='collecting' AND last_evaluated_at IS NULL`).get() as { n: number };
    expect(untouched.n).toBeGreaterThan(0);
    expect(db().prepare(`SELECT mode FROM authority_posture`).all()).toEqual([]);
  });
});

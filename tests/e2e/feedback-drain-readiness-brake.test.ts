// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * The readiness brake, end to end. Live 2026-10-02 02:30 PDT (Mac Studio, drain run
 * 2e06aa3b, authority generation 4): one real gpt-6-astra answer cross-cited a near-duplicate
 * sibling's evidence id, the parser called it a contract violation, the operator's approval
 * was voided, and every later job run was refused with 403 and no reason.
 *
 * This boots the production AgentServer wiring on the real incident candidates and runs the
 * SHIPPED job script against it: the recorded answer now keeps the approval; a different
 * model answering still pauses it at once; and the next job run fails once (no retry) naming
 * why the authority is paused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import type { InstarConfig, IntelligenceProvider } from '../../src/core/types.js';

const AUTH = 'feedback-brake-e2e-auth';
const PIN = '161803';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'feedback-readiness-cross-cite-shapes.json'), 'utf8')) as {
  candidates: Array<Record<string, unknown>>; replies: Array<{ oldVerdict: string; raw: string }>;
};
const crossCite = fixture.replies.find((r) => r.oldVerdict.includes('cited evidence outside'))!;

describe('feedback drain — one imperfect answer keeps the approval; a real brake is explained', () => {
  let root: string;
  let server: AgentServer;
  let port = 0;
  let reply = { raw: crossCite.raw, model: 'gpt-6-astra' };
  const db = () => (server as unknown as { feedbackDrain: { store: { db: import('better-sqlite3').Database } } }).feedbackDrain.store.db;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-brake-e2e-'));
    const stateDir = path.join(root, '.instar');
    const canonical = path.join(stateDir, 'state', 'feedback-factory', 'store');
    fs.mkdirSync(canonical, { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'e2e', authToken: AUTH, dashboardPin: PIN, developmentAgent: true }));
    fs.writeFileSync(path.join(canonical, 'feedback.jsonl'), '');
    fs.writeFileSync(path.join(canonical, 'clusters.jsonl'), fixture.candidates.map((c) => `${JSON.stringify(c)}\n`).join(''));
    const intelligence: IntelligenceProvider = {
      evaluate: async (_prompt, options) => {
        options?.onModel?.({ model: reply.model, framework: 'codex-cli' });
        return reply.raw;
      },
    };
    const config = {
      projectName: 'e2e', projectDir: root, stateDir, port: 0, host: '127.0.0.1', authToken: AUTH, dashboardPin: PIN,
      developmentAgent: true, requestTimeoutMs: 30_000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
      feedbackFactory: { processing: {}, drain: {}, consumer: { dryRun: true } },
    } as InstarConfig;
    server = new AgentServer({
      config, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), intelligence,
      sessionManager: { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [], on: () => undefined } as never,
    });
    await server.start();
    port = ((server as unknown as { server: { address(): AddressInfo } }).server.address()).port;
    const created = await fetch(`http://127.0.0.1:${port}/feedback-factory/readiness-authorities`, {
      method: 'POST', headers: { Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pin: PIN, action: 'create', operatorDecisionRef: 'operator-approved-brake-e2e',
        authorityId: 'feedback-readiness-default', agentId: 'e2e', ownerMachineId: 'e2e', ownerEpoch: 1,
        provider: 'codex-cli', modelFamily: 'gpt-6-astra', promptVersion: 'feedback-readiness-v1', schemaVersion: 'feedback-readiness-decision-v1',
        decisionPointId: 'feedback-cluster-readiness', maxBatch: 50, maxTokens: 1200, maxDailySpendUsd: 5,
      }),
    });
    expect(created.status).toBe(200);
    expect(installBuiltinJobs({ agentStateDir: stateDir, packageRoot: REPO_ROOT, port: 4044 }).errors).toEqual([]);
  });

  afterAll(async () => {
    await server?.stop();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'feedback-drain-readiness-brake.test.ts' });
  });

  async function runJob(name: string): Promise<{ stdout: string; failure: string | null }> {
    const body = fs.readFileSync(path.join(root, '.instar', 'jobs', 'instar', 'feedback-factory-process.md'), 'utf8');
    const open = "python3 - <<'FEEDBACK_DRAIN_TICK'\n";
    const script = body.slice(body.indexOf(open) + open.length, body.indexOf('\nFEEDBACK_DRAIN_TICK\n') + 1);
    const failureFile = path.join(root, `declared-failure-${name}.txt`);
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
    return { stdout, failure: fs.existsSync(failureFile) ? fs.readFileSync(failureFile, 'utf8') : null };
  }
  const runs = () => (db().prepare(`SELECT COUNT(*) n FROM drain_runs`).get() as { n: number }).n;

  it('the recorded live answer: job success, approval kept, the two cross-citing rows held back', async () => {
    const job = await runJob('cross-cite');
    expect(job.stdout, job.stdout).toMatch(/FEEDBACK_DRAIN_RESULT succeeded run:/);
    expect(job.failure).toBeNull();
    expect(db().prepare(`SELECT mode FROM authority_posture`).all()).toEqual([]);
    expect(db().prepare(`SELECT COUNT(*) n FROM readiness WHERE reason_code='evidence-not-own'`).get()).toEqual({ n: 2 });
  });

  it('a different model answering pauses at once; the next job run fails once, naming why', async () => {
    db().prepare(`UPDATE readiness SET next_review_at=0 WHERE state='collecting'`).run();
    reply = { raw: crossCite.raw, model: 'gpt-5.5' };
    const braked = await runJob('braked');
    expect(braked.failure, braked.stdout).toMatch(/drain run degraded: readiness-authority-failed/);
    const status = await (await fetch(`http://127.0.0.1:${port}/feedback-factory/drain/status`, { headers: { Authorization: `Bearer ${AUTH}` } })).json() as {
      authority: { mode: string; pausedBecause: string }; lastReadinessFailure: { outcome: string; diagnosis: { check: string; resolvedModel: string } };
    };
    expect(status.authority.mode).toBe('proposal-only');
    expect(status.lastReadinessFailure).toMatchObject({ outcome: 'contract-violation', diagnosis: { check: 'resolved-model-mismatch', resolvedModel: 'gpt-5.5' } });

    const before = runs();
    const refused = await runJob('refused');
    expect(refused.failure, refused.stdout).toMatch(/drain tick refused: HTTP 403 .*\(authority paused: The answer did not come from the approved model/);
    expect(runs()).toBe(before); // one refused request, no run admitted, no retry
  });
});

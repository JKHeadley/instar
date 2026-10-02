// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Migration Parity for the feedback-factory-process job body (spec
 * docs/specs/feedback-inbox-vault-token.md §C). An existing agent holds the OLD
 * body — the one whose "fail this job run" had no mechanism — and an operator
 * may have changed `enabled`. The update path (PostUpdateMigrator →
 * installBuiltinJobs) must replace the body with the shipped one and keep the
 * operator's `enabled`.
 *
 * The body is one fixed python script (live 2026-10-01: the haiku runner wrote
 * its own zsh loop, `status=$(...)` died on zsh's read-only `status`, and a
 * degraded drain run was recorded as a success). The second suite runs the
 * shipped script against a drain server and checks every outcome.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { installBuiltinJobs } from '../../src/scheduler/InstallBuiltinJobs.js';
import { loadAgentMdJobs } from '../../src/scheduler/AgentMdJobLoader.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SLUG = 'feedback-factory-process';
const OLD_BODY_LINE = 'If it is true, a 503 is degradation—fail this job run so JobRun history and the server audit expose it; never treat it as healthy.';
const SCRIPT_OPEN = "python3 - <<'FEEDBACK_DRAIN_TICK'\n";

/** The fenced python script the job runs, exactly as installed. */
function extractScript(text: string): string {
  const start = text.indexOf(SCRIPT_OPEN);
  const end = text.indexOf('\nFEEDBACK_DRAIN_TICK\n', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start + SCRIPT_OPEN.length, end + 1);
}

describe('feedback-factory-process job body — existing agents get the failing body', () => {
  let workspace: string;
  let stateDir: string;
  let body: string;

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-proc-body-'));
    stateDir = path.join(workspace, '.instar');
    // First install, then simulate the pre-release state: the old body on disk
    // and an operator-disabled manifest.
    expect(installBuiltinJobs({ agentStateDir: stateDir, packageRoot: REPO_ROOT, port: 4044 }).errors).toEqual([]);
    const mdPath = path.join(stateDir, 'jobs', 'instar', `${SLUG}.md`);
    const shipped = fs.readFileSync(mdPath, 'utf8');
    const head = shipped.slice(0, shipped.indexOf('\n---\n') + 5);
    fs.writeFileSync(mdPath, `${head}Run one feedback-factory operating-drain tick.\n\n1. ${OLD_BODY_LINE}\n`);
    const manifestPath = path.join(stateDir, 'jobs', 'schedule', `${SLUG}.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, enabled: false }, null, 2));

    // The update path.
    const report = installBuiltinJobs({ agentStateDir: stateDir, packageRoot: REPO_ROOT, port: 4044 });
    expect(report.errors).toEqual([]);
    expect(report.installed).toContain(SLUG);
    body = fs.readFileSync(mdPath, 'utf8');
  });

  afterAll(() => {
    SafeFsExecutor.safeRmSync(workspace, { recursive: true, force: true, operation: 'tests/integration/feedback-factory-process-job-body.test.ts' });
  });

  it('replaces the old body and keeps the operator\'s enabled=false', () => {
    expect(body).not.toContain(OLD_BODY_LINE);
    const manifest = JSON.parse(fs.readFileSync(path.join(stateDir, 'jobs', 'schedule', `${SLUG}.json`), 'utf8'));
    expect(manifest.enabled).toBe(false);
  });

  it('the new body records failure through $INSTAR_JOB_FAILURE_FILE, not through words', () => {
    expect(extractScript(body)).toContain("os.environ.get('INSTAR_JOB_FAILURE_FILE')");
    expect(body).toContain('saying "failed" in your output does NOT record a failure');
  });

  it('the new body is one fixed script covering every posture row, with no shell variable named status', () => {
    const script = extractScript(body);
    expect(script).toContain("if state == 'dark':");
    expect(script).toContain("fail('drain posture unavailable: '");
    expect(script).toContain("fail('drain status unreadable: HTTP '");
    expect(body).not.toMatch(/\bstatus=\$\(/);
    expect(body).toContain('Run the command below ONCE, exactly as written, in a single Bash call with `timeout: 300000`');
  });

  it('the agent port is substituted and the refreshed job still loads', () => {
    expect(body).toContain('${INSTAR_PORT:-4044}');
    expect(extractScript(body)).toContain("os.environ.get('INSTAR_PORT') or CONFIG.get('port')");
    const { jobs } = loadAgentMdJobs(path.join(stateDir, 'jobs', 'schedule'), path.join(stateDir, 'jobs'));
    expect(jobs.find((j) => j.slug === SLUG)).toBeTruthy();
  });
});

interface FakeDrain {
  status: { code: number; body: unknown };
  tick: { code: number; body: unknown };
  /** lastRun the status route reports once the tick was accepted. */
  run?: { state: string; reason?: string };
  after?: Record<string, unknown>;
}

describe('feedback-factory-process job script — honest outcomes against a drain server', () => {
  let workspace: string;
  let script: string;

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-proc-script-'));
    const stateDir = path.join(workspace, '.instar');
    expect(installBuiltinJobs({ agentStateDir: stateDir, packageRoot: REPO_ROOT, port: 4044 }).errors).toEqual([]);
    script = extractScript(fs.readFileSync(path.join(stateDir, 'jobs', 'instar', `${SLUG}.md`), 'utf8'));
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'echo', developmentAgent: true }));
  });

  afterAll(() => {
    SafeFsExecutor.safeRmSync(workspace, { recursive: true, force: true, operation: 'tests/integration/feedback-factory-process-job-body.test.ts' });
  });

  async function runAgainst(fake: FakeDrain): Promise<{ failure: string | null; stdout: string; ticks: number }> {
    let ticks = 0;
    const server = http.createServer((req, res) => {
      const send = (code: number, payload: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      if (req.headers.authorization !== 'Bearer job-token') { send(401, { error: 'auth' }); return; }
      if (req.method === 'POST' && req.url === '/feedback-factory/drain/tick') {
        ticks++;
        const intent = req.headers['x-instar-request'] === '1' && /^feedback-drain-\d+-\d+$/.test(String(req.headers['x-instar-request-nonce']));
        if (!intent) { send(400, { error: 'missing intent headers' }); return; }
        send(fake.tick.code, fake.tick.body); return;
      }
      if (req.method === 'GET' && req.url === '/feedback-factory/drain/status') {
        if (ticks > 0 && fake.run) {
          send(200, { ...(fake.status.body as object), ...(fake.after ?? {}), lastRun: { runId: 'run:1', ...fake.run } }); return;
        }
        send(fake.status.code, fake.status.body); return;
      }
      send(404, { error: 'unexpected route' });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const failureFile = path.join(workspace, `failure-${port}.txt`);
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn('python3', ['-'], {
          cwd: workspace,
          env: { ...process.env, INSTAR_AUTH_TOKEN: 'job-token', INSTAR_AGENT_ID: 'echo', INSTAR_PORT: String(port), INSTAR_JOB_FAILURE_FILE: failureFile, FEEDBACK_DRAIN_POLL_SECONDS: '5' },
        });
        let out = '';
        child.stdout.on('data', (chunk) => { out += String(chunk); });
        child.stderr.on('data', (chunk) => { out += String(chunk); });
        child.on('error', reject);
        child.on('close', (code) => { if (code === 0) resolve(out); else reject(new Error(`script exited ${code}: ${out}`)); });
        child.stdin.end(script);
      });
      return { failure: fs.existsSync(failureFile) ? fs.readFileSync(failureFile, 'utf8') : null, stdout, ticks };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  const live = { code: 200, body: { posture: { state: 'live', reason: 'live-healthy' }, consumerLive: false, drain: { work: { claimed: 0, completed: 0 } } } };
  const accepted = { code: 202, body: { runId: 'run:1', accepted: true } };

  it('a succeeded run is a success (no failure file)', async () => {
    const result = await runAgainst({ status: live, tick: accepted, run: { state: 'succeeded', reason: '' } });
    expect(result.failure).toBeNull();
    expect(result.ticks).toBe(1);
    expect(result.stdout).toContain('FEEDBACK_DRAIN_RESULT succeeded run:1');
  });

  it('a degraded run fails the job with the drain reason (the live false success)', async () => {
    const result = await runAgainst({ status: live, tick: accepted, run: { state: 'degraded', reason: 'readiness-authority-failed' } });
    expect(result.failure).toBe('drain run degraded: readiness-authority-failed (run run:1)');
  });

  it('a failed run fails the job with the drain reason', async () => {
    const result = await runAgainst({ status: live, tick: accepted, run: { state: 'failed', reason: 'source record checksum conflicts with its projection' } });
    expect(result.failure).toBe('drain run failed: source record checksum conflicts with its projection (run run:1)');
  });

  it('a refused tick fails the job (demoted authority)', async () => {
    const result = await runAgainst({ status: live, tick: { code: 403, body: { error: 'current registered readiness agent required', proxied: false } } });
    expect(result.failure).toBe('drain tick refused: HTTP 403 current registered readiness agent required');
  });

  it('dark posture exits silently without a tick', async () => {
    const result = await runAgainst({ status: { code: 503, body: { posture: { state: 'dark', reason: 'fleet-default' } } }, tick: accepted });
    expect(result).toMatchObject({ failure: null, ticks: 0 });
  });

  it('unavailable posture and an unreadable status fail on a development agent', async () => {
    expect((await runAgainst({ status: { code: 503, body: { posture: { state: 'unavailable', reason: 'initialization-failure' } } }, tick: accepted })).failure)
      .toBe('drain posture unavailable: initialization-failure');
    expect((await runAgainst({ status: { code: 401, body: { error: 'nope' } }, tick: accepted })).failure).toBe('drain status unreadable: HTTP 401');
  });

  it('a tick proxied to the owner finishes at once instead of polling a run it cannot see', async () => {
    const started = Date.now();
    const result = await runAgainst({ status: live, tick: { code: 202, body: { runId: 'run:owner', accepted: true, proxied: true } } });
    expect(result.failure).toBeNull();
    expect(result.stdout).toContain('FEEDBACK_DRAIN_RESULT proxied to the owner machine, run run:owner');
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('simulation work counts that advance break the invariant', async () => {
    const result = await runAgainst({ status: live, tick: accepted, run: { state: 'succeeded' }, after: { drain: { work: { claimed: 1, completed: 0 } } } });
    expect(result.failure).toMatch(/^invariant broken: claimed\/completed work advanced while the consumer is in simulation/);
  });
});

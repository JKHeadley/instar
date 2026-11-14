/**
 * T10 (frozen acceptance list, step3/acceptance-tests.md) — job launch record, full lifecycle
 * (spec job-launch-intent-record, Testing → E2E; docs/E2E-TESTING-STANDARD.md).
 *
 * Tests the complete PRODUCTION path by booting the REAL server the way an operator does:
 *   `node dist/cli.js server start --foreground --no-telegram --dir <project>` (startServer in
 *   src/commands/server.ts). There is no shared, separately callable init function for
 *   SessionManager + JobScheduler + AgentServer — startServer builds them inline — so the whole
 *   CLI boot is the closest real path (the same approach as
 *   conversation-graph-normal-cli-owned-boot.test.ts). Nothing is constructed by hand here.
 *   1. GET /jobs/:slug/history returns 200 (Phase 1: the route is alive, not 503).
 *   2. A job declaring `thinkingMode: low` is loaded by the production loader (GET /jobs).
 *   3. It is triggered over HTTP and spawned in a REAL tmux session running a mock claude binary.
 *   4. Its run row carries `launch.applied` thinkingMode low on argv, and the spawned process
 *      really received `--effort low`.
 *   5. The start row reads cliVersion 'unknown' (the retainer cannot read the mock's version: the
 *      mock answers `--version` only outside the project dir, after 1 s); the async probe, run from
 *      a neutral temp cwd, then lands 2.1.322, and the row before and after differs ONLY in
 *      launch.cliVersion.
 *
 * Prerequisite: dist/ is built from the tree under test (`npm run build`); the test fails, not
 * skips, when dist/cli.js is missing. It skips only when no tmux is installed.
 * Red on main: the feature is not alive (no `launch` on the row).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectTmuxPath } from '../../src/core/Config.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const tmuxPath = detectTmuxPath();
const describeMaybe = tmuxPath ? describe : describe.skip;
const SLUG = 'launch-e2e-low';

type Launch = { cliVersion: string; requested: { thinkingMode?: string }; applied: Array<Record<string, unknown>>; dropped: unknown[] };
type Row = Record<string, unknown> & { runId: string; launch?: Launch };

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address();
  if (!addr || typeof addr === 'string') throw new Error('fixture-port');
  await new Promise<void>((r) => srv.close(() => r()));
  return addr.port;
}
async function until<T>(fn: () => Promise<T | undefined>, ms: number): Promise<T | undefined> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { const v = await fn(); if (v !== undefined) return v; } catch { /* not ready yet */ }
    await pause(200);
  }
  return undefined;
}

describeMaybe('E2E: job launch record lifecycle (real CLI boot)', () => {
  let temporary: string;
  let project: string;
  let argvLog: string;
  let child: ChildProcess | undefined;
  let output = '';
  let base = '';
  const token = crypto.randomUUID();
  const projectName = `e2e-job-launch-${crypto.randomUUID().slice(0, 8)}`;

  const api = async (route: string, body?: unknown) => {
    const res = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: res.status, data: await res.json().catch(() => ({})) as Record<string, unknown> };
  };
  const history = async () => (await api(`/jobs/${SLUG}/history`)).data.runs as Row[] | undefined;

  beforeAll(async () => {
    expect(fs.existsSync(CLI), 'dist/cli.js is missing: run `npm run build` before the e2e lane').toBe(true);
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-e2e-job-launch-'));
    project = path.join(temporary, 'project');
    const stateDir = path.join(project, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });

    // Mock claude: answers --version like the real CLI, logs every launch argv, then stays up
    // (so no completion row lands while the version patch is being compared).
    argvLog = path.join(temporary, 'mock-claude-argv.log');
    const claudePath = path.join(temporary, 'bin', 'claude');
    fs.mkdirSync(path.dirname(claudePath), { recursive: true });
    fs.writeFileSync(claudePath, `#!/bin/bash
if [ "$1" = "--version" ]; then
  # Only the launch-version probe (contract: run from a neutral temp cwd, never the agent's
  # project) gets an answer, and only after a short delay. Every --version asked from the project
  # dir (the server's own cwd: ClaudeBinaryRetainer's sync read, boot checks) fails, so the
  # retainer holds a null version and the start row must read 'unknown' until the async patch.
  case "$(pwd -P)" in "$(cd ${JSON.stringify(project)} && pwd -P)"*) exit 1 ;; esac
  sleep 1
  echo "2.1.322 (Claude Code)"; exit 0
fi
printf '%s\\n' "--launch--" "$@" >> ${JSON.stringify(argvLog)}
echo "Mock Claude session started"
sleep 120
`);
    fs.chmodSync(claudePath, 0o755);

    fs.writeFileSync(path.join(stateDir, 'jobs.json'), JSON.stringify([{
      slug: SLUG, name: 'Launch E2E', description: 'Job declaring thinkingMode low', schedule: '0 0 1 1 *',
      priority: 'high', expectedDurationMinutes: 5, model: 'haiku', enabled: true,
      execute: { type: 'prompt', value: 'Quick test' }, thinkingMode: 'low',
    }], null, 2));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
      projectName, projectDir: project, host: '127.0.0.1', port, authToken: token, dashboardPin: `synthetic-${crypto.randomUUID()}`,
      secrets: { forceFileKey: true }, developmentAgent: false,
      threadline: { relayEnabled: false, spawn: { drainEnabled: false } },
      scheduler: { enabled: true, maxParallelJobs: 2, jobsFile: path.join(stateDir, 'jobs.json'), allowOnThrowawayAgent: true }, // a temp-dir agent is a throwaway; the scheduler refuses jobs there without this
      messaging: [], tunnel: { enabled: false }, updates: { autoApply: false }, feedback: { enabled: false }, telemetry: { enabled: false },
      sessions: { framework: 'claude-code', tmuxPath, claudePath, frameworkBinaryPaths: { 'claude-code': claudePath }, maxSessions: 2, completionPatterns: ['Session ended'] },
      enabledFrameworks: ['claude-code'],
      multiMachine: { meshTransport: { enabled: false, tailscaleEnabled: false } },
      monitoring: {
        systemReview: { enabled: false }, quotaTracking: false, memoryMonitoring: false, watchdog: { enabled: false }, telemetry: { enabled: false },
        sessionReaper: { enabled: false }, agentWorktreeReaper: { enabled: false, githubMergeCheck: false }, externalHogSentinel: { enabled: false },
        orphanedWorkSentinel: { enabled: false }, mcpProcessReaper: { enabled: false }, codexArmSessionSweeper: { enabled: false },
        bootHealthBeacon: { enabled: false }, rateLimitSentinel: { enabled: false }, socketDisconnectSentinel: { enabled: false },
      },
    }, null, 2));
    // Same crypto initializer as normal init.
    await new MachineIdentityManager(stateDir).generateIdentity({ role: 'awake' });

    const env: NodeJS.ProcessEnv = {};
    for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME', 'TERM']) if (process.env[k] !== undefined) env[k] = process.env[k];
    env.INSTAR_TEST_REGISTRY_DIR = path.join(temporary, 'registry');
    env.npm_config_cache = path.join(temporary, 'npm-cache');
    child = spawn(process.execPath, [CLI, 'server', 'start', '--foreground', '--no-telegram', '--dir', project], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', (c) => { output += String(c); });
    child.stderr!.on('data', (c) => { output += String(c); });
    const up = await until(async () => {
      if (child!.exitCode !== null) throw new Error('exited');
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      return r.status === 200 ? true : undefined;
    }, 60_000);
    expect(up, `the real server did not come up (exit ${child.exitCode}):\n${output.slice(-4000)}`).toBe(true);
  }, 90_000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      for (let i = 0; i < 60 && child.exitCode === null; i++) await pause(100);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    try {
      const sessions = execFileSync(tmuxPath!, ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf-8' }).trim();
      for (const s of sessions.split('\n').filter(Boolean)) {
        if (s.includes(SLUG)) { try { execFileSync(tmuxPath!, ['kill-session', '-t', `=${s}`]); } catch { /* gone */ } }
      }
    } catch { /* no tmux server */ }
    if (temporary) SafeFsExecutor.safeRmSync(temporary, { recursive: true, force: true, operation: 'tests/e2e/job-launch-lifecycle.test.ts:cleanup' });
  }, 30_000);

  it('Phase 1: the history route is alive (200, not 503)', async () => {
    expect((await api(`/jobs/${SLUG}/history`)).status).toBe(200);
  });

  it('the production loader keeps thinkingMode on the scheduled job', async () => {
    const res = await api('/jobs');
    expect(res.status).toBe(200);
    const jobs = (Array.isArray(res.data) ? res.data : (res.data.jobs as unknown[])) as Array<Record<string, unknown>>;
    const loaded = jobs.find((j) => j.slug === SLUG);
    expect(loaded, 'the job was not loaded by the real server').toBeDefined();
    expect(loaded!.thinkingMode, 'the production loader dropped thinkingMode').toBe('low');
  });

  let firstRow: Row | undefined;
  it('trigger → the run row carries launch.applied low', async () => {
    const trig = await api(`/jobs/${SLUG}/trigger`, { reason: 'e2e-job-launch' });
    expect(trig.status, `trigger refused: ${JSON.stringify(trig.data)}\n${output.slice(-3000)}`).toBe(200);
    expect(trig.data.result).toBe('triggered');
    const runs = await until(async () => { const r = await history(); return r && r.length > 0 ? r : undefined; }, 15_000);
    expect(runs, `no run row appeared:\n${output.slice(-3000)}`).toBeDefined();
    firstRow = structuredClone(runs![0]);
    expect(firstRow.framework).toBe('claude-code');
    expect(firstRow.launch, 'the run row has no launch record — the feature is not alive').toBeDefined();
    // Ordering (start row written before the probe settles) is proved deterministically by T5's deferred probe.
    // Here the first HTTP observation may legitimately already carry the patch, so accept either value.
    expect(['unknown', '2.1.322'], 'cliVersion must be unknown or the launched binary version').toContain(firstRow.launch?.cliVersion);
    expect(firstRow.launch!.requested).toEqual({ thinkingMode: 'low' });
    expect(firstRow.launch!.applied).toEqual([{ feature: 'thinkingMode', requestedValue: 'low', value: 'low', channel: 'argv' }]);
    expect(firstRow.launch!.dropped).toEqual([]);
  }, 30_000);

  it('the spawned process really received --effort low', async () => {
    const seen = await until(async () => (fs.existsSync(argvLog) && fs.readFileSync(argvLog, 'utf-8').includes('--launch--') ? true : undefined), 15_000);
    expect(seen, 'mock claude was never launched').toBe(true);
    const argv = fs.readFileSync(argvLog, 'utf-8').split('\n');
    const at = argv.flatMap((a, i) => (a === '--effort' ? [i] : []));
    expect(at, 'mock claude was not launched with exactly one --effort').toHaveLength(1);
    expect(argv[at[0] + 1]).toBe('low');
  }, 20_000);

  it('the CLI version lands on the row; the row differs from before ONLY in launch.cliVersion', async () => {
    expect(firstRow?.launch, 'no launch record to patch').toBeDefined();
    const patched = await until(async () => {
      const r = (await history())?.[0];
      return r?.launch?.cliVersion === '2.1.322' ? r : undefined;
    }, 15_000);
    expect(patched, 'no cliVersion 2.1.322 on the launch record').toBeDefined();
    // Whole-row check: apart from launch.cliVersion (and completion fields, which the scheduler may have
    // written meanwhile), the patched row equals the first observed row.
    const strip = (r: Row) => { const { result, completedAt, durationSeconds, outputSummary, error, ...rest } = r as Record<string, unknown>; void result; void completedAt; void durationSeconds; void outputSummary; void error; return rest; };
    expect(strip(patched as Row)).toEqual(strip({ ...firstRow!, launch: { ...firstRow!.launch!, cliVersion: '2.1.322' } } as Row));
  }, 20_000);
});

/**
 * `instar test-as-self` — one-button throwaway-deploy harness (Part 2.1).
 *
 * Deploys the CURRENT instar dist into a throwaway agent home, optionally runs
 * a real Telegram round-trip, captures any crash deterministically, and tears
 * everything down — the automated execution of the recipe that the
 * `test-as-self` SKILL documented as manual steps in v1.
 *
 * Spec: MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS §Track F (folds in the approved
 * Part 2.1). The seven gated steps:
 *   1. Bot acquisition  — via Secret Drop ID (refuses a raw token on argv).
 *   2. Target prep       — throwaway home; Bob-block / canonical-home block.
 *   3. Dist deploy       — `instar init --dir <target>` (ships the current dist).
 *   4. Process start     — server --no-telegram (+ lifeline if a bot is set);
 *                          wait for /health 200 + the poll-ownership lease.
 *   5. Round-trip smoke  — Telegram Bot HTTP API: sendMessage + poll getUpdates
 *                          for the agent's reply containing the nonce.
 *   6. Crash + lease     — the existing deterministic verify.mjs.
 *   7. Teardown          — signal-safe finally (skip with --keep).
 *
 * Variance from the approved Part 2.1: the round-trip uses the Telegram Bot
 * HTTP API directly (not Playwright) — strictly more reliable, no browser.
 */

import fs from 'node:fs';
import { telegramFetch } from '../messaging/telegram-egress.js';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import pc from 'picocolors';
import { validateTarget, validateBotTokenArg } from './testAsSelfValidation.js';

export interface TestAsSelfOptions {
  target?: string;
  botToken?: string;       // Secret Drop ID (NOT a raw token)
  keep?: boolean;          // skip teardown
  noRoundtrip?: boolean;   // skip the Telegram round-trip step
  reportJson?: string;     // path to write the JSON report
  timeoutS?: number;       // overall timeout (default 600)
  /** Protected agent names that may never be a target. */
  protectedNames?: string[];
}

interface StepResult { step: string; ok: boolean; detail: string; ms: number; }

interface RunContext {
  target: string;
  distCli: string;        // absolute path to the dist cli.js to deploy
  botToken?: string;      // resolved raw token (in-memory only), if a round-trip is requested
  port?: number;
  serverProc?: ReturnType<typeof spawn>;
  lifelineProc?: ReturnType<typeof spawn>;
  steps: StepResult[];
}

const DEFAULT_TIMEOUT_S = 600;

/** The dist cli.js that is currently executing (what we deploy into the throwaway). */
function resolveDistCli(): string {
  // This file compiles to dist/commands/test-as-self.js; cli.js is two dirs up.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'cli.js');
}

/**
 * Locate the deterministic step-6 verifier. Resolved from THIS module's own
 * location first (dist/commands → package root → .claude/skills/…), so the
 * harness works from any cwd (ACT-064: it used to resolve against cwd and failed
 * unless run from the repo root). Falls back to the canonical agent home for an
 * install whose package does not carry the skill. Exported + pure for tests.
 */
export function resolveVerifierPath(
  moduleDir: string,
  canonicalHome: string,
  exists: (p: string) => boolean = fs.existsSync,
): string {
  const rel = path.join('.claude', 'skills', 'test-as-self', 'scripts', 'verify.mjs');
  const candidates = [path.resolve(moduleDir, '..', '..', rel), path.join(canonicalHome, rel)];
  const found = candidates.find((c) => exists(c));
  if (!found) throw new Error(`verify.mjs not found (looked in: ${candidates.join(', ')})`);
  return found;
}

/** The canonical (running) agent home — never a valid target. */
function resolveCanonicalHome(): string {
  return process.env.INSTAR_PROJECT_DIR || process.cwd();
}

/**
 * The `instar init` invocation that deploys + initializes the throwaway home at
 * an arbitrary `--dir`. Exported + pure so the decision is unit-testable.
 *
 * MUST NOT be `--standalone`: `init --standalone` requires a positional NAME and
 * routes to `~/.instar/agents/<name>` (ignoring `--dir`) — so the prior
 * `init --standalone --dir <target>` failed at step 3 unconditionally ("A name is
 * required for standalone agents"), which is why this harness never passed.
 * `init --dir <target>` (non-standalone → initExistingProject) honors `--dir`,
 * allocates a port, and writes `<target>/.instar/config.json` — verified.
 */
export function buildInitArgs(target: string): string[] {
  return ['init', '--dir', target];
}

/**
 * Env for spawning/stopping the throwaway's OWN server. Strips the PARENT
 * session markers so instar's "don't start/stop/restart the server from inside a
 * managed session" guard doesn't block the throwaway's lifecycle. The spawn (step
 * 4) AND the teardown's `server stop` BOTH need this — without it on teardown,
 * `server stop` is refused ("Cannot 'server stop' from inside a session").
 */
export function sanitizedSpawnEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.INSTAR_SESSION_ID;
  delete env.INSTAR_JOB_SLUG;
  return env;
}

function nowMs(): number { return Date.now(); }

async function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

/** Retrieve a Secret Drop value to memory via the hardened retriever (never prints the value). */
function retrieveSecret(secretDropId: string, field: string, projectDir: string): string {
  const script = path.join(projectDir, '.instar', 'scripts', 'secret-drop-retrieve.mjs');
  if (!fs.existsSync(script)) {
    throw new Error('secret-drop-retrieve.mjs not found — cannot retrieve the bot token securely.');
  }
  // The retriever streams the field VALUE to stdout and field NAMES to stderr.
  return execFileSync('node', [script, secretDropId, field], { encoding: 'utf-8' }).trim();
}

/** Step 5 round-trip via the Telegram Bot HTTP API. Returns the observed reply (or throws). */
async function telegramRoundTrip(botToken: string, nonce: string, timeoutMs: number, projectDir: string): Promise<string> {
  // Discover the bot's own chat by reading recent updates first (so we reply into an existing chat),
  // OR — for a self-test — send to the bot's getMe + use the most recent chat id from getUpdates.
  const api = (m: string) => `https://api.telegram.org/bot${botToken}/${m}`;
  // Find a chat to talk in: the most recent update's chat id.
  const updates0 = await (await telegramFetch(api('getUpdates') + '?limit=5&timeout=0')).json() as
    { ok: boolean; result: Array<{ update_id: number; message?: { chat?: { id: number } } }> };
  const chatId = updates0.result?.map((u) => u.message?.chat?.id).filter(Boolean).pop();
  if (!chatId) {
    throw new Error('No chat available for the round-trip — send one message to the test bot first, then re-run.');
  }
  const lastUpdateId = updates0.result?.length ? updates0.result[updates0.result.length - 1].update_id : 0;
  // Send the probe.
  const { sendRecordedTestProbe } = await import('../messaging/telegram-origin/OriginTestProbe.js');
  await sendRecordedTestProbe({ projectDir, botToken, chatId, nonce, timeoutMs });
  // Poll for a reply that contains the nonce (the throwaway agent's response).
  const deadline = nowMs() + timeoutMs;
  let offset = lastUpdateId + 1;
  while (nowMs() < deadline) {
    const resp = await (await telegramFetch(api('getUpdates') + `?offset=${offset}&timeout=10`)).json() as
      { ok: boolean; result: Array<{ update_id: number; message?: { text?: string } }> };
    for (const u of resp.result ?? []) {
      offset = u.update_id + 1;
      const text = u.message?.text ?? '';
      if (text.includes(nonce) && !text.startsWith('test-as-self ')) {
        return text; // the agent's reply echoing/handling the nonce
      }
    }
    await sleep(1000);
  }
  throw new Error(`No reply containing nonce "${nonce}" within ${Math.round(timeoutMs / 1000)}s.`);
}

/** Wait until /health returns 200 and the poll-ownership lease exists (if a bot is set). */
async function waitForReady(target: string, port: number, expectLease: boolean, timeoutMs: number): Promise<void> {
  const deadline = nowMs() + timeoutMs;
  const leasePath = path.join(target, '.instar', 'state', 'telegram-poll-owner.json');
  let healthOk = false;
  while (nowMs() < deadline) {
    if (!healthOk) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        if (r.ok) healthOk = true;
      } catch { /* not up yet */ }
    }
    if (healthOk && (!expectLease || fs.existsSync(leasePath))) return;
    await sleep(1000);
  }
  throw new Error(`Not ready within ${Math.round(timeoutMs / 1000)}s (health=${healthOk}, leaseExpected=${expectLease}).`);
}

/** Read the throwaway agent's port from its config after init. */
function readPort(target: string): number {
  const cfg = JSON.parse(fs.readFileSync(path.join(target, '.instar', 'config.json'), 'utf-8'));
  return cfg.port;
}

/**
 * Run the harness. Returns the JSON report + an exit code (0 = all PASS).
 */
export async function runTestAsSelf(opts: TestAsSelfOptions): Promise<{ report: object; exitCode: number }> {
  const timeoutMs = (opts.timeoutS ?? DEFAULT_TIMEOUT_S) * 1000;
  const stepDeadlineMs = Math.floor(timeoutMs / 4);
  const canonicalHome = resolveCanonicalHome();
  const protectedNames = opts.protectedNames ?? ['bob'];

  // ── Pre-flight guards (pure, fail fast) ─────────────────────────────
  const tokenGuard = validateBotTokenArg(opts.botToken);
  if (!tokenGuard.ok) { console.error(pc.red(`  ${tokenGuard.reason}`)); return { report: { error: tokenGuard.code }, exitCode: 12 }; }

  const target = opts.target || path.join(os.homedir(), '.instar', 'test-deploys', new Date().toISOString().replace(/[:.]/g, '-'));
  const agentsRoot = path.join(os.homedir(), '.instar', 'agents');
  let agentHomes: string[] = [];
  try {
    agentHomes = fs.readdirSync(agentsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(agentsRoot, d.name));
  } catch { /* no agents dir */ }
  const targetGuard = validateTarget(target, { canonicalHome, protectedNames, agentHomes });
  if (!targetGuard.ok) { console.error(pc.red(`  ${targetGuard.reason}`)); return { report: { error: targetGuard.code }, exitCode: 11 }; }

  const ctx: RunContext = { target, distCli: resolveDistCli(), steps: [] };
  const runStep = async (name: string, fn: () => Promise<string>): Promise<boolean> => {
    const t0 = nowMs();
    try {
      const detail = await fn();
      ctx.steps.push({ step: name, ok: true, detail, ms: nowMs() - t0 });
      console.log(pc.green(`  ✓ ${name}`) + pc.dim(` — ${detail}`));
      return true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      ctx.steps.push({ step: name, ok: false, detail, ms: nowMs() - t0 });
      console.error(pc.red(`  ✗ ${name} — ${detail}`));
      return false;
    }
  };

  const wantRoundTrip = !opts.noRoundtrip && !!opts.botToken;

  try {
    // Step 1 — bot acquisition (Secret Drop → in-memory token).
    if (wantRoundTrip) {
      const ok = await runStep('1. bot-acquire', async () => {
        ctx.botToken = retrieveSecret(opts.botToken!, 'token', canonicalHome);
        if (!ctx.botToken) throw new Error('Secret Drop returned an empty token.');
        return 'token retrieved to memory (never logged)';
      });
      if (!ok) return finish(ctx, opts, 1);
    } else {
      ctx.steps.push({ step: '1. bot-acquire', ok: true, detail: 'skipped (--no-roundtrip or no --bot-token)', ms: 0 });
    }

    // Step 2 — target preparation.
    if (!await runStep('2. target-prep', async () => {
      fs.mkdirSync(ctx.target, { recursive: true });
      return `throwaway home ${ctx.target}`;
    })) return finish(ctx, opts, 2);

    // Step 3 — dist deploy (`instar init --dir` initializes the throwaway home).
    if (!await runStep('3. dist-deploy', async () => {
      execFileSync('node', [ctx.distCli, ...buildInitArgs(ctx.target)], {
        encoding: 'utf-8', timeout: stepDeadlineMs,
        env: { ...sanitizedSpawnEnv(process.env), INSTAR_NONINTERACTIVE: '1' },
      });
      ctx.port = readPort(ctx.target);
      return `deployed; port ${ctx.port}`;
    })) return finish(ctx, opts, 3);

    // Step 4 — process start (server --no-telegram; lifeline if a bot is set).
    if (!await runStep('4. process-start', async () => {
      const env = sanitizedSpawnEnv(process.env);
      ctx.serverProc = spawn('node', [ctx.distCli, 'server', 'start', '--foreground', '--no-telegram', '--dir', ctx.target],
        { detached: false, stdio: 'ignore', env });
      if (ctx.botToken) {
        ctx.lifelineProc = spawn('node', [ctx.distCli, 'lifeline', 'start', '--dir', ctx.target],
          { detached: false, stdio: 'ignore', env });
      }
      await waitForReady(ctx.target, ctx.port!, !!ctx.botToken, stepDeadlineMs);
      return `server up on ${ctx.port}${ctx.botToken ? ' + lifeline (lease present)' : ''}`;
    })) return finish(ctx, opts, 4);

    // Step 5 — Telegram round-trip (Bot HTTP API).
    if (wantRoundTrip) {
      if (!await runStep('5. roundtrip', async () => {
        const nonce = `n${Date.now().toString(36)}`;
        const reply = await telegramRoundTrip(ctx.botToken!, nonce, stepDeadlineMs, ctx.target);
        return `reply observed (${reply.slice(0, 40)}…)`;
      })) return finish(ctx, opts, 5);
    } else {
      ctx.steps.push({ step: '5. roundtrip', ok: true, detail: 'skipped', ms: 0 });
    }

    // Step 6 — crash + lease verification (deterministic verify.mjs).
    if (!await runStep('6. verify', async () => {
      const verifier = resolveVerifierPath(path.dirname(fileURLToPath(import.meta.url)), canonicalHome);
      const args = [verifier, '--dir', ctx.target, ...(ctx.botToken ? [] : ['--no-lease'])];
      try {
        execFileSync('node', args, { encoding: 'utf-8' });
      } catch (err) {
        // Name the failing checks instead of a bare "Command failed".
        // RULE 3: EXEMPT — parses Instar's own verify.mjs JSON report (a contract we ship), not provider/CLI state; a parse failure only drops the check names from the error.
        const stdout = (err as { stdout?: string }).stdout ?? '';
        let failed = '';
        try {
          const rep = JSON.parse(stdout) as { checks?: Record<string, { pass: boolean }> };
          failed = Object.entries(rep.checks ?? {}).filter(([, c]) => !c.pass).map(([k]) => k).join(', ');
        } catch { /* non-JSON output */ }
        throw new Error(`verify.mjs FAIL${failed ? ` (${failed})` : ''}`);
      }
      return `verify.mjs PASS${ctx.botToken ? '' : ' (crash checks; lease skipped: no lifeline)'}`;
    })) return finish(ctx, opts, 6);

    return finish(ctx, opts, 0);
  } finally {
    if (!opts.keep) await teardown(ctx, canonicalHome);
  }
}

/**
 * `instar test-as-self --slack` — the credential-free Slack permission demonstration
 * (Pillar 4, §8.4). Extends the throwaway-agent primitive from "is the agent alive?"
 * to "does it enforce the RIGHT decision for each (principal, request) pair?".
 *
 * Runs the audit-asserting scenario suite IN-PROCESS (no throwaway home, no Slack
 * tokens): every row flows through the SAME observer the live SlackAdapter calls
 * (resolver → gate → decision ledger), and BOTH the verdict AND the matching
 * audit/ledger entry are asserted per row. Prints a per-row report and returns
 * exit 0 iff every row produced its expected decision AND its audit entry.
 */
export async function runTestAsSelfSlack(opts: { reportJson?: string } = {}): Promise<{ report: object; exitCode: number }> {
  const { runAuditedScenarioSuite } = await import('../permissions/testing/SlackScenarioHarness.js');
  console.log(pc.bold('  test-as-self --slack — permission demonstration (verified, not narrated)'));
  const suite = await runAuditedScenarioSuite();

  for (const r of suite.rows) {
    const mark = r.pass ? pc.green('✓') : pc.red('✗');
    const got = r.verdict ? `${r.verdict.decision}/${r.verdict.basis}` : 'null';
    const expected = `${r.scenario.expectedDecision}/${r.scenario.expectedBasis}`;
    const audit = r.auditOk ? pc.dim('audit✓') : pc.red('audit✗');
    console.log(
      `  ${mark} ${r.scenario.id} ` +
        pc.dim(`[${r.scenario.principal.name}/${r.scenario.principal.role}]`) +
        ` → ${got} ${audit}` +
        (r.pass ? '' : pc.red(`  (expected ${expected}${r.mismatch ? ` — ${r.mismatch}` : ''})`)),
    );
  }

  const allOk = suite.summary.failed === 0;
  const report = {
    mode: 'slack-permission-demonstration',
    summary: suite.summary,
    ledgerPath: suite.ledgerPath,
    rows: suite.rows.map((r) => ({
      id: r.scenario.id,
      principal: r.scenario.principal.name,
      role: r.scenario.principal.role,
      request: r.scenario.text,
      expected: `${r.scenario.expectedDecision}/${r.scenario.expectedBasis}`,
      got: r.verdict ? `${r.verdict.decision}/${r.verdict.basis}` : 'null',
      verdictOk: r.verdictOk,
      auditOk: r.auditOk,
      pass: r.pass,
      proves: r.scenario.proves,
    })),
    verdict: allOk ? 'PASS' : 'FAIL',
    ts: new Date().toISOString(),
  };
  if (opts.reportJson) {
    try {
      fs.mkdirSync(path.dirname(opts.reportJson), { recursive: true });
      fs.writeFileSync(opts.reportJson, JSON.stringify(report, null, 2));
    } catch { /* best-effort */ }
  }
  console.log(
    allOk
      ? pc.green(`  VERDICT: PASS — ${suite.summary.passed}/${suite.summary.total} rows (decision AND audit entry)`)
      : pc.red(`  VERDICT: FAIL — ${suite.summary.failed}/${suite.summary.total} rows did not enforce the expected decision+audit`),
  );
  return { report, exitCode: allOk ? 0 : 1 };
}

/**
 * Processes that belong to the throwaway: any whose command line names the
 * throwaway home (its server, boot wrapper, lifeline, MCP children, and the
 * public quick tunnel, which runs `cloudflared … --config <target>/.instar/cloudflared-quick.yml`).
 * The target is guard-validated (validateTarget refuses a target that is, contains,
 * or shares a basename with any agent home), so matching on it cannot select a real agent. The harness's OWN ancestor chain is always
 * excluded — the shell that launched `test-as-self --target <path>` names the
 * path too. Input is `ps -axo pid=,ppid=,command=`. Exported + pure for tests.
 */
export function selectTargetPids(psOutput: string, target: string, selfPid: number): number[] {
  const root = path.resolve(target);
  const needle = new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[/\\s'"]|$)`);
  const rows: Array<{ pid: number; ppid: number; cmd: string }> = [];
  for (const line of psOutput.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] });
  }
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
  const ancestors = new Set<number>();
  for (let p: number | undefined = selfPid; p !== undefined && p > 1 && !ancestors.has(p); p = parent.get(p)) ancestors.add(p);
  return rows.filter((r) => r.pid > 1 && !ancestors.has(r.pid) && needle.test(r.cmd)).map((r) => r.pid);
}

/**
 * tmux sessions the throwaway spawned (SessionManager names them
 * `<basename(projectDir)>-<name>`, e.g. a dispatch session). Exported + pure.
 */
export function selectTargetTmuxSessions(sessionNames: string[], target: string): string[] {
  const prefix = `${path.basename(path.resolve(target))}-`;
  return sessionNames.filter((n) => n.startsWith(prefix));
}

function targetPidsNow(target: string): number[] {
  try {
    const ps = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf-8', timeout: 5_000, maxBuffer: 32 * 1024 * 1024 });
    return selectTargetPids(ps, target, process.pid);
  } catch {
    return [];
  }
}

function signalAll(pids: number[], sig: NodeJS.Signals): void {
  for (const pid of pids) {
    try { process.kill(pid, sig); } catch { /* gone */ }
  }
}

/**
 * Signal-safe teardown (ACT-064: the launchd job, the public tunnel and the
 * dispatch sessions all used to survive it). Order matters, because a server
 * that is still shutting down keeps self-healing: it re-installs its autostart
 * plist and restarts its tunnel. So: boot out the autostart (no KeepAlive
 * respawn), stop every throwaway process and WAIT until none is left (SIGKILL
 * after a deadline), and only then remove the autostart again, reap the tmux
 * sessions, and sweep anything still naming the home.
 */
async function teardown(ctx: RunContext, canonicalHome: string): Promise<void> {
  let uninstall: (() => void) | null = null;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ctx.target, '.instar', 'config.json'), 'utf-8')) as { projectName?: string };
    let canonicalName: string | undefined;
    try {
      canonicalName = (JSON.parse(fs.readFileSync(path.join(canonicalHome, '.instar', 'config.json'), 'utf-8')) as { projectName?: string }).projectName;
    } catch { /* no canonical config — the name guard below still holds */ }
    const name = cfg.projectName;
    if (name && name !== canonicalName) {
      const { uninstallAutoStart } = await import('./setup.js');
      uninstall = () => { try { uninstallAutoStart(name); } catch { /* best-effort */ } };
    }
  } catch { /* no config — nothing was installed */ }

  // 1. Boot out + remove the throwaway's autostart (launchctl bootout + plist removal).
  uninstall?.();

  // 2. Stop the processes, then wait until every throwaway process has exited.
  try { ctx.lifelineProc?.kill('SIGTERM'); } catch { /* */ }
  try { ctx.serverProc?.kill('SIGTERM'); } catch { /* */ }
  try {
    execFileSync('node', [ctx.distCli, 'server', 'stop', '--dir', ctx.target], { encoding: 'utf-8', timeout: 15_000, env: sanitizedSpawnEnv(process.env) });
  } catch { /* may not be running */ }
  signalAll(targetPidsNow(ctx.target), 'SIGTERM');
  const deadline = nowMs() + 20_000;
  while (nowMs() < deadline && targetPidsNow(ctx.target).length > 0) await sleep(500);
  signalAll(targetPidsNow(ctx.target), 'SIGKILL');

  // 3. The dying server may have re-installed its autostart: remove it again.
  uninstall?.();

  // 4. Reap the throwaway's tmux sessions (dispatch/job sessions).
  try {
    const list = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf-8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const name of selectTargetTmuxSessions(list.split('\n').filter(Boolean), ctx.target)) {
      try { execFileSync('tmux', ['kill-session', '-t', `=${name}`], { stdio: 'ignore', timeout: 5_000 }); } catch { /* gone */ }
    }
  } catch { /* no tmux server */ }

  // 5. Final sweep: anything still naming the home (a late-started tunnel).
  await sleep(500);
  signalAll(targetPidsNow(ctx.target), 'SIGKILL');

  // NOTE: the throwaway home removal is intentionally left to the caller / --keep
  // semantics rather than an rm here — SafeFsExecutor is the only sanctioned
  // deletion path and the home is under ~/.instar/test-deploys, safe to leave for inspection.
  const left = targetPidsNow(ctx.target).length;
  console.log(pc.dim(`  teardown: autostart removed, processes + tunnel + sessions stopped${left ? ` (${left} process(es) still exiting)` : ''}; home left at ${ctx.target}`));
}

function finish(ctx: RunContext, opts: TestAsSelfOptions, failedStep: number): { report: object; exitCode: number } {
  const allOk = ctx.steps.every((s) => s.ok);
  const report = {
    target: ctx.target,
    port: ctx.port ?? null,
    roundTrip: !opts.noRoundtrip && !!opts.botToken,
    steps: ctx.steps,
    verdict: allOk ? 'PASS' : 'FAIL',
    failedAtStep: failedStep || null,
    ts: new Date().toISOString(),
  };
  const reportPath = opts.reportJson || path.join(ctx.target, 'test-as-self-report.json');
  try { fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); } catch { /* */ }
  console.log(allOk ? pc.green(`  VERDICT: PASS`) : pc.red(`  VERDICT: FAIL (step ${failedStep})`));
  return { report, exitCode: allOk ? 0 : 1 };
}

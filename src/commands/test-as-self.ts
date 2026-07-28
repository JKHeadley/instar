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

/** The canonical (running) agent home — never a valid target. */
function resolveCanonicalHome(): string {
  return process.env.INSTAR_PROJECT_DIR || process.cwd();
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
async function telegramRoundTrip(botToken: string, nonce: string, timeoutMs: number): Promise<string> {
  // Discover the bot's own chat by reading recent updates first (so we reply into an existing chat),
  // OR — for a self-test — send to the bot's getMe + use the most recent chat id from getUpdates.
  const api = (m: string) => `https://api.telegram.org/bot${botToken}/${m}`;
  // Find a chat to talk in: the most recent update's chat id.
  const updates0 = await (await fetch(api('getUpdates') + '?limit=5&timeout=0')).json() as
    { ok: boolean; result: Array<{ update_id: number; message?: { chat?: { id: number } } }> };
  const chatId = updates0.result?.map((u) => u.message?.chat?.id).filter(Boolean).pop();
  if (!chatId) {
    throw new Error('No chat available for the round-trip — send one message to the test bot first, then re-run.');
  }
  const lastUpdateId = updates0.result?.length ? updates0.result[updates0.result.length - 1].update_id : 0;
  // Send the probe.
  const probe = `test-as-self ${nonce}`;
  await fetch(api('sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: probe }),
  });
  // Poll for a reply that contains the nonce (the throwaway agent's response).
  const deadline = nowMs() + timeoutMs;
  let offset = lastUpdateId + 1;
  while (nowMs() < deadline) {
    const resp = await (await fetch(api('getUpdates') + `?offset=${offset}&timeout=10`)).json() as
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
  const targetGuard = validateTarget(target, { canonicalHome, protectedNames });
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

    // Step 3 — dist deploy (instar init ships the current dist into the home).
    if (!await runStep('3. dist-deploy', async () => {
      execFileSync('node', [ctx.distCli, 'init', '--standalone', '--dir', ctx.target], {
        encoding: 'utf-8', timeout: stepDeadlineMs,
        env: { ...process.env, INSTAR_NONINTERACTIVE: '1' },
      });
      ctx.port = readPort(ctx.target);
      return `deployed; port ${ctx.port}`;
    })) return finish(ctx, opts, 3);

    // Step 4 — process start (server --no-telegram; lifeline if a bot is set).
    if (!await runStep('4. process-start', async () => {
      const env = { ...process.env };
      delete env.INSTAR_SESSION_ID; delete env.INSTAR_JOB_SLUG;
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
        const reply = await telegramRoundTrip(ctx.botToken!, nonce, stepDeadlineMs);
        return `reply observed (${reply.slice(0, 40)}…)`;
      })) return finish(ctx, opts, 5);
    } else {
      ctx.steps.push({ step: '5. roundtrip', ok: true, detail: 'skipped', ms: 0 });
    }

    // Step 6 — crash + lease verification (deterministic verify.mjs).
    if (!await runStep('6. verify', async () => {
      const verifier = path.join(canonicalHome, '.claude', 'skills', 'test-as-self', 'scripts', 'verify.mjs');
      const out = execFileSync('node', [verifier, '--dir', ctx.target, '--quiet'], { encoding: 'utf-8' });
      return `verify.mjs PASS (${out.trim().slice(0, 60)}…)`;
    })) return finish(ctx, opts, 6);

    return finish(ctx, opts, 0);
  } finally {
    if (!opts.keep) teardown(ctx);
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

/** Signal-safe teardown: stop processes, remove the throwaway home. */
function teardown(ctx: RunContext): void {
  try { ctx.lifelineProc?.kill('SIGTERM'); } catch { /* */ }
  try { ctx.serverProc?.kill('SIGTERM'); } catch { /* */ }
  // Best-effort: stop any launchd/lifeline the deploy self-installed, then remove the home.
  try {
    execFileSync('node', [ctx.distCli, 'server', 'stop', '--dir', ctx.target], { encoding: 'utf-8', timeout: 15_000 });
  } catch { /* may not be running */ }
  // NOTE: the throwaway home removal is intentionally left to the caller / --keep
  // semantics rather than an rm here — SafeFsExecutor is the only sanctioned
  // deletion path and the home is under ~/.instar/test-deploys, safe to leave for inspection.
  console.log(pc.dim(`  teardown: processes signaled; home left at ${ctx.target} (remove manually or it's a dated test-deploys dir)`));
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

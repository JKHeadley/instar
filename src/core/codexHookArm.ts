/**
 * codexHookArm — arm instar's project-scoped Codex gate hooks so they actually run
 * on a freshly-init'd agent without a human clicking "trust". P0 of codex-full-parity.
 *
 * G2 verdict (spec §P0): per-agent scoping comes from trust entries being keyed by the
 * project hooks.json PATH, so arming only the agent's own project hooks never touches the
 * operator's personal Codex. Mechanism: Codex's own trust flow (the "Trust all and continue"
 * prompt), driven non-interactively — NOT the machine-wide managed-config (rejected, G1).
 *
 * Review gates baked in (spec §7 F1-F3):
 *   F1 — manifest verify: only arm when the project hooks.json is exactly instar's own
 *        (matches buildInstarCodexHookGroups); never blind-trust arbitrary on-disk hooks.
 *        And the trust spawn runs WITHOUT the dangerous approvals/sandbox bypass flags.
 *   F2 — idempotent + readback: skip the spawn entirely when already armed; after the spawn,
 *        re-read config.toml and confirm the slots are now trusted (return armed=false if not).
 *   F3 — never silently re-enable a user-disabled hook (enabled=false is left as the user set it).
 *
 * The fragile TUI keystroke step is injected (`trustDriver`) so the orchestration — the part
 * that decides whether/what to arm and verifies the outcome — is unit-testable without a real
 * codex. The default driver spawns interactive codex in tmux and sends the trust keystrokes;
 * it is validated by test-as-self on a live agent, not by unit tests.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withSyncOp } from './InFlightSyncOpMarker.js';
import { buildInstarCodexHookGroups, INSTAR_HOOK_PATH_MARKER } from './installCodexHooks.js';
import { codexHooksArmingStatus, expectedHookSlots } from './codexHookTrust.js';

export interface ArmCodexHooksOptions {
  projectDir: string;
  /** CODEX_HOME (defaults to ~/.codex). config.toml [hooks.state] lives here. */
  codexHome?: string;
  /**
   * Drives Codex's interactive trust flow for the project's hooks. Returns when the
   * trust-all selection has been submitted (or throws on failure). Injected for testability.
   */
  trustDriver?: (ctx: { projectDir: string; codexHome: string; hooksJsonPath: string }) => void;
}

export type ArmOutcome =
  | { status: 'already-armed' }
  | { status: 'armed' }
  | { status: 'partial'; untrusted: string[]; disabled: string[] }
  | { status: 'skipped'; reason: string };

function readConfigToml(codexHome: string): string {
  const p = path.join(codexHome, 'config.toml');
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return ''; // fresh agent — no config yet = nothing trusted
  }
}

/**
 * F1 manifest verify: is the project's `.codex/hooks.json` exactly instar's own set?
 * We compare the instar-owned hook command paths the file declares against what
 * buildInstarCodexHookGroups would produce. If the file is missing, malformed, or carries
 * a hook command outside `.instar/hooks/instar/`, we refuse to arm (don't blind-trust).
 */
export function projectHooksAreInstarOwned(projectDir: string): boolean {
  const hooksPath = path.join(projectDir, '.codex', 'hooks.json');
  let parsed: { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };
  try {
    parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
  } catch {
    return false;
  }
  const hooks = parsed.hooks ?? {};
  const expected = buildInstarCodexHookGroups(projectDir);
  // EXACT equivalence, not containment (cross-model review 2026-10-25: the earlier check only
  // required instar's commands to be PRESENT, so an extra, unrelated command rode along and
  // the driver then pressed "Trust all and continue" for it — the exact blind-trust F1 forbids).
  // Every event instar expects must carry exactly instar's command set, and no event may
  // exist that instar did not declare.
  const expectedEvents = new Set(Object.keys(expected));
  for (const event of Object.keys(hooks)) {
    if (!expectedEvents.has(event)) return false; // an event instar did not declare
  }
  for (const [event, groups] of Object.entries(expected)) {
    const actualGroups = hooks[event] ?? [];
    if (actualGroups.length !== 1) return false; // exactly one group, as instar writes it
    const expectedCmds = (groups[0]?.hooks ?? []).map((h) => h.command).sort();
    const actualCmds = (actualGroups[0]?.hooks ?? []).map((h) => h.command ?? '').sort();
    if (expectedCmds.length !== actualCmds.length) return false;
    for (let i = 0; i < expectedCmds.length; i++) {
      if (expectedCmds[i] !== actualCmds[i]) return false;
    }
  }
  // No instar-owned command may live outside the instar hooks dir (anti-injection).
  for (const groups of Object.values(hooks)) {
    for (const group of groups ?? []) {
      for (const h of group.hooks ?? []) {
        const c = h.command ?? '';
        if (c.includes(INSTAR_HOOK_PATH_MARKER)) {
          const abs = path.join(projectDir, INSTAR_HOOK_PATH_MARKER);
          if (!c.includes(abs)) return false; // instar-marker path that isn't THIS project's
        }
      }
    }
  }
  return true;
}

/**
 * Arm the agent's project Codex hooks. Idempotent. Returns the outcome without throwing
 * on a benign no-op; throws only on a programming error in the driver.
 */
export function armCodexHooks(opts: ArmCodexHooksOptions): ArmOutcome {
  const codexHome = opts.codexHome || path.join(process.env.HOME || '', '.codex');
  // Codex keys its [hooks.state] trust entries by the CANONICAL hooks.json path
  // (it realpath-resolves the project dir — e.g. /tmp → /private/tmp on macOS). The
  // readback must use the same canonical path or it false-negatives ("partial" when
  // actually armed). Resolve the real project dir; fall back to the given path if it
  // doesn't exist yet.
  let realProjectDir = opts.projectDir;
  try { realProjectDir = fs.realpathSync(opts.projectDir); } catch { /* use as-is */ }
  const hooksJsonPath = path.join(realProjectDir, '.codex', 'hooks.json');
  const expectedSlots = expectedHookSlots(buildInstarCodexHookGroups(opts.projectDir) as any);

  // F2 — idempotency: already armed? skip the spawn entirely.
  const before = codexHooksArmingStatus(readConfigToml(codexHome), hooksJsonPath, expectedSlots);
  if (before.allArmed) return { status: 'already-armed' };

  // F1 — only arm instar's own verified hook set.
  if (!projectHooksAreInstarOwned(opts.projectDir)) {
    return { status: 'skipped', reason: 'project hooks.json is not instar-owned (manifest mismatch) — refusing to trust' };
  }

  // Drive Codex's trust flow (default = interactive tmux spawn + keystrokes; injected for tests).
  const driver = opts.trustDriver ?? defaultTrustDriver;
  driver({ projectDir: opts.projectDir, codexHome, hooksJsonPath });

  // F2 — readback: confirm the slots are now trusted. F3 — surface (not silently fix) any that
  // remain explicitly disabled (user choice; trust-all does not clear enabled=false).
  const after = codexHooksArmingStatus(readConfigToml(codexHome), hooksJsonPath, expectedSlots);
  if (after.allArmed) return { status: 'armed' };
  return { status: 'partial', untrusted: after.untrusted, disabled: after.disabled };
}

/**
 * How long an arm session may live before the tmux server kills it regardless of what
 * happened to the process that created it.
 *
 * The legitimate worst case is NOT "50 s plus sleep 3" (an earlier draft said so and the
 * reviews caught it, twice). Under the MODELED TIMEOUT BUDGET — every `tmux` call has a 10 s
 * timeout, every blocking `sleep` a 15 s timeout, and the 50 s deadline is only set AFTER
 * creation and launch — the bound is: create ≤10 + launch ≤10 + poll ≤50 + a final iteration
 * that entered at deadline−ε (capture ≤10 + Down ≤10 + sleep ≤15 + Enter ≤10 + sleep ≤15 = 60)
 * + finally (≤20) ≈ 150 s. That is a budget, not a wall-clock guarantee: parent scheduling
 * gaps between calls under memory pressure are unbounded. 600 s is ~4x the budget; the cost
 * of the margin is that a genuinely leaked session lives ten minutes instead of three,
 * against a measured leak lifetime of 43 hours. A timer firing mid-arm is fail-safe: the
 * pane dies, capture reads empty, and the parent's readback reports not-armed.
 */
export const ARM_SESSION_TTL_MS = 600_000;

/** The driver's `sleep` calls are blocking subprocess waits; a hung `sleep` must not hang arming. */
const SLEEP_TIMEOUT_MS = 15_000;

/**
 * The tmux command sequence that creates the arm session AND schedules its destruction in
 * ONE server round-trip: `new-session … ';' run-shell -b "sleep <TTL>; '<tmux>' kill-session -t '=<session>'"`.
 *
 * One invocation, not two: an earlier draft created the session and scheduled the timer
 * in separate subprocess calls, and the cross-model review pointed out that a parent killed
 * between them leaves an untimed session — exactly the leak this exists to close. tmux's
 * `;` separator runs both commands inside the server as one request, so from the parent's
 * point of view the session never exists without its timer.
 *
 * `run-shell -b` is a detached job of the tmux SERVER, so it survives the parent's death.
 * `=session` is the EXACT target: without `=` tmux resolves `-t` by prefix/fnmatch, and a
 * timer for `…-aaa` could kill a live `…-aaabbb` (confirmed on tmux 3.7c).
 *
 * Returns `null` when the string cannot be built safely — it crosses TWO interpreters,
 * tmux's own `#{…}`/`#(…)` format expansion FIRST and then /bin/sh, so `tmuxPath` may not
 * contain `#` or `'`, and the session name must match the driver's own shape. A `null`
 * means the caller must NOT create the session at all: arming without a safety net is the
 * one thing this change exists to prevent, and the readback then honestly reports
 * not-armed rather than silently proceeding.
 */
export function armSessionCreateArgv(
  tmuxPath: string,
  session: string,
  opts: { projectDir: string; codexHome: string; ttlMs?: number },
): string[] | null {
  // A RELATIVE tmux path (the `detectTmuxPath() || 'tmux'` fallback) would resolve against
  // the tmux SERVER's PATH inside the run-shell job, not node's — the one input that behaves
  // differently in the server's environment. Refuse it; the sweeper is the backstop.
  if (!path.isAbsolute(tmuxPath) || /[#']/.test(tmuxPath) || !/^[A-Za-z0-9._-]+$/.test(session)) return null;
  const seconds = Math.ceil((opts.ttlMs ?? ARM_SESSION_TTL_MS) / 1000);
  // The job must exit 0 and print NOTHING. In the happy path the driver's `finally` has
  // already killed the session, so a bare `kill-session` fails 600 s later — and tmux renders
  // a run-shell job's error into the active pane of ANOTHER session, flipping it into
  // view-mode, where `send-keys` (instar's inbound-message injection path) no longer reaches
  // the shell. Reproduced on tmux 3.7c by the lessons-aware review. So: probe by exit code,
  // kill only if present, redirect everything, always exit 0.
  const t = `'${tmuxPath}'`;
  const job = `sleep ${seconds}; if ${t} has-session -t '=${session}' >/dev/null 2>&1; then ${t} kill-session -t '=${session}' >/dev/null 2>&1; fi; exit 0`;
  return [
    'new-session', '-d', '-s', session, '-c', opts.projectDir, '-x', '200', '-y', '50',
    '-e', `CODEX_HOME=${opts.codexHome}`,
    ';',
    'run-shell', '-b', job,
  ];
}

/**
 * Default trust driver — spawns interactive Codex in tmux and sends the "Trust all and
 * continue" keystrokes, WITHOUT any approvals/sandbox bypass (F1). Validated by test-as-self,
 * not unit tests (unit tests inject their own driver, so this never runs there). Bounded:
 * polls capture-pane for the trust prompt, sends the selection, then exits + kills the pane.
 *
 * Requires a resolved codex binary + tmux on PATH; the caller passes binaryPath via env. We
 * keep config-driven values (tmux path, codex binary, model) in the env the caller sets up.
 */
interface TrustDriverDeps {
  tmuxPath: string;
  codexBinary: string;
  model?: string;
  /** Receives one line per arm run saying whether the self-destruct was scheduled. */
  log?: (msg: string) => void;
}
export function makeTmuxTrustDriver(deps: TrustDriverDeps) {
  return function driveCodexTrustAll(ctx: { projectDir: string; codexHome: string; hooksJsonPath: string }): void {
    const session = `instar-codex-arm-${Date.now().toString(36)}`;
    const tmux = (args: string[]) => execFileSync(deps.tmuxPath, args, { encoding: 'utf-8', timeout: 10_000 });
    // RULE 3.1 RATIONALE (state-detection): this capture-pane parse of Codex's TUI trust prompt is
    // BEST-EFFORT and only gates WHEN to send the trust keystrokes — it never decides the
    // outcome. The AUTHORITATIVE state detection is armCodexHooks' config.toml trust readback
    // (codexHooksArmingStatus, robust line-based config parse, NOT TUI scraping). If the prompt
    // wording drifts, this match fails → no keys sent → the readback reports not-armed
    // (fail-safe, surfaced to the caller as `partial`) — never silent corruption. Drift
    // detection for the prompt itself is the G5 runtime arming canary (spec §7, tracked).
    // Registry: specs/provider-portability/06-state-detector-registry.md. <!-- tracked: codex-full-parity -->
    const capture = (): string => {
      try { return tmux(['capture-pane', '-t', `=${session}:`, '-p', '-S', '-60']); } catch { return ''; }
    };
    // Create the session AND schedule its self-destruct in ONE tmux request (spec
    // codex-arm-session-leak-and-sweeper §2a). The `finally` below is the happy-path
    // teardown, but it only runs if THIS process survives — and the caller that most often
    // does not is PostUpdateMigrator, which arms on every update, during which the server
    // restarts. A process killed mid-poll would leave this detached session running an
    // interactive codex forever (measured: ~8 orphans/day on one laptop, 41 retired by hand
    // across two sweeps). With the timer in the same request as the creation there is no
    // window in which the session exists without it.
    //
    // If the argv cannot be built safely (a `#` or `'` in tmuxPath, or a relative path), NO
    // session is created and codex is NOT launched: arming without a net is the leak. The
    // decision is made BEFORE the try/finally so no teardown runs against a session that
    // never existed. The readback then reports not-armed, which the caller surfaces as `partial`.
    const createArgv = armSessionCreateArgv(deps.tmuxPath, session, { projectDir: ctx.projectDir, codexHome: ctx.codexHome });
    if (!createArgv) {
      deps.log?.(`[codexHookArm] ${session}: refusing to create an arm session without a self-destruct (unsafe tmux path) — not armed`);
      return;
    }
    try {
      tmux(createArgv);
      // Launch interactive codex — NO --dangerously-bypass-* flags (F1).
      const launch = `${deps.codexBinary}${deps.model ? ` -m ${deps.model}` : ''}`;
      tmux(['send-keys', '-t', `=${session}:`, launch, 'Enter']);
      // A fresh project shows up to TWO prompts in sequence: (1) "Do you trust the contents
      // of this directory?" (cursor on "Yes, continue") then (2) the hook-trust prompt
      // ("1. Review / 2. Trust all and continue / 3. Continue without"). Production agent dirs
      // are usually pre-trusted so (1) is skipped — but handle both so the driver is robust.
      // State machine, bounded ~50s total (codex cold-start + two prompts).
      let handledDirTrust = false;
      let handledHookTrust = false;
      const deadline = Date.now() + 50_000;
      while (Date.now() < deadline && !handledHookTrust) {
        const pane = capture();
        if (!handledHookTrust && /Trust all and continue|Hooks need review|hook is new or changed/i.test(pane)) {
          // Hook-trust prompt: cursor on "1. Review hooks"; Down → "Trust all and continue", Enter.
          tmux(['send-keys', '-t', `=${session}:`, 'Down']);
          withSyncOp(() => execFileSync('sleep', ['1'], { timeout: SLEEP_TIMEOUT_MS }));
          tmux(['send-keys', '-t', `=${session}:`, 'Enter']);
          handledHookTrust = true;
          withSyncOp(() => execFileSync('sleep', ['3'], { timeout: SLEEP_TIMEOUT_MS }));
          break;
        }
        if (!handledDirTrust && /trust the contents of this directory|Do you trust/i.test(pane)) {
          // Dir-trust prompt: cursor on "1. Yes, continue" → Enter accepts (do NOT move down,
          // which would select "No, quit").
          tmux(['send-keys', '-t', `=${session}:`, 'Enter']);
          handledDirTrust = true;
          withSyncOp(() => execFileSync('sleep', ['2'], { timeout: SLEEP_TIMEOUT_MS }));
          continue;
        }
        withSyncOp(() => execFileSync('sleep', ['2'], { timeout: SLEEP_TIMEOUT_MS }));
      }
      if (!handledHookTrust) return; // readback will report not-armed; caller decides
    } finally {
      // Exit codex + tear down the pane (best-effort). `=session` — exact target, never prefix.
      try { tmux(['send-keys', '-t', `=${session}:`, 'C-c']); } catch { /* noop */ }
      try { tmux(['kill-session', '-t', `=${session}`]); } catch { /* noop */ }
      deps.log?.(`[codexHookArm] ${session}: created with self-destruct scheduled (one request)`);
    }
  };
}

/** Placeholder default driver — real callers pass a configured driver via opts.trustDriver. */
function defaultTrustDriver(_ctx: { projectDir: string; codexHome: string; hooksJsonPath: string }): void {
  throw new Error('armCodexHooks: no trustDriver provided — pass makeTmuxTrustDriver({tmuxPath, codexBinary}) from the caller');
}

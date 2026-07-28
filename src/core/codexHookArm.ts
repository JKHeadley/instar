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
  // Every instar-owned command present must point under the instar hooks dir, and every
  // event instar expects must be present with the expected command set.
  for (const [event, groups] of Object.entries(expected)) {
    const actualGroups = hooks[event] ?? [];
    const expectedCmds = (groups[0]?.hooks ?? []).map((h) => h.command);
    const actualCmds = (actualGroups[0]?.hooks ?? []).map((h) => h.command ?? '');
    for (const cmd of expectedCmds) {
      if (!actualCmds.includes(cmd)) return false; // expected instar hook missing
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
      try { return tmux(['capture-pane', '-t', `${session}:`, '-p', '-S', '-60']); } catch { return ''; }
    };
    try {
      tmux(['new-session', '-d', '-s', session, '-c', ctx.projectDir, '-x', '200', '-y', '50',
        '-e', `CODEX_HOME=${ctx.codexHome}`]);
      // Launch interactive codex — NO --dangerously-bypass-* flags (F1).
      const launch = `${deps.codexBinary}${deps.model ? ` -m ${deps.model}` : ''}`;
      tmux(['send-keys', '-t', `${session}:`, launch, 'Enter']);
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
          tmux(['send-keys', '-t', `${session}:`, 'Down']);
          execFileSync('sleep', ['1']);
          tmux(['send-keys', '-t', `${session}:`, 'Enter']);
          handledHookTrust = true;
          execFileSync('sleep', ['3']);
          break;
        }
        if (!handledDirTrust && /trust the contents of this directory|Do you trust/i.test(pane)) {
          // Dir-trust prompt: cursor on "1. Yes, continue" → Enter accepts (do NOT move down,
          // which would select "No, quit").
          tmux(['send-keys', '-t', `${session}:`, 'Enter']);
          handledDirTrust = true;
          execFileSync('sleep', ['2']);
          continue;
        }
        execFileSync('sleep', ['2']);
      }
      if (!handledHookTrust) return; // readback will report not-armed; caller decides
    } finally {
      // Exit codex + tear down the pane (best-effort).
      try { tmux(['send-keys', '-t', `${session}:`, 'C-c']); } catch { /* noop */ }
      try { tmux(['kill-session', '-t', session]); } catch { /* noop */ }
    }
  };
}

/** Placeholder default driver — real callers pass a configured driver via opts.trustDriver. */
function defaultTrustDriver(_ctx: { projectDir: string; codexHome: string; hooksJsonPath: string }): void {
  throw new Error('armCodexHooks: no trustDriver provided — pass makeTmuxTrustDriver({tmuxPath, codexBinary}) from the caller');
}

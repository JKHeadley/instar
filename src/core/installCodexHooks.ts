/**
 * installCodexHooks — wire instar's safety gates into a Codex CLI agent's
 * native hook system, the Codex mirror of `installClaudeSettings`.
 *
 * Spec: docs/specs/codex-enforcement-hook-layer.md
 *
 * WHY: on Claude agents, instar's gates (external-operation, response-review,
 * grounding, deferral, session-start, topic-context) are enforced via
 * `.claude/settings.json` hooks. On Codex agents nothing enforced them — the
 * gates were awareness-only. Codex CLI supports a Claude-compatible blocking
 * hook system (verified: developers.openai.com/codex/hooks — PreToolUse can
 * deny via `permissionDecision` or exit-2; events incl. SessionStart,
 * PreToolUse, PermissionRequest, PostToolUse, UserPromptSubmit, Stop). This
 * writes the gate registrations into Codex's discovery path.
 *
 * SCOPING (correctness-critical): writes the **per-project**
 * `<projectDir>/.codex/hooks.json`, NOT the global `~/.codex/hooks.json`.
 * The global root is shared with the operator's personal desktop Codex and
 * every other Codex project on the machine — global enforcement hooks would
 * intercept the operator's personal sessions. Per-project `.codex/` is a
 * documented Codex discovery path and scopes the gates to this agent only.
 *
 * Invocation contract (Codex): the command receives the event JSON on stdin
 * (no args), runs with the session cwd as working directory. We register
 * absolute paths so discovery does not depend on cwd. The gate scripts'
 * Codex-payload parsing is handled by the framework shim (spec P2); this
 * module only writes the registrations.
 *
 * Idempotent + merge-safe: instar-owned entries are identified by a command
 * path under `.instar/hooks/instar/` and replaced on every run; any
 * user-added Codex hooks are preserved untouched.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Marker that identifies an instar-owned hook command (for merge-safe replace). */
export const INSTAR_HOOK_PATH_MARKER = '.instar/hooks/instar/';
/**
 * The autonomous-loop driver hook lives in the autonomous skill, not under
 * `.instar/hooks/instar/`, so it needs its own ownership marker — used both to build
 * its command path and to let groupIsInstarOwned() recognize (and replace, never
 * duplicate) the autonomous Stop group on every re-install.
 */
export const CODEX_AUTONOMOUS_HOOK_MARKER = '.claude/skills/autonomous/hooks/autonomous-stop-hook.sh';

interface CodexHookHandler {
  type: 'command';
  command: string;
  timeout?: number;
}
interface CodexHookGroup {
  matcher?: string;
  hooks: CodexHookHandler[];
}
interface CodexHooksConfig {
  hooks?: Record<string, CodexHookGroup[]>;
  [key: string]: unknown;
}

/** Build the instar-owned hook groups for each Codex event, with absolute script paths. */
export function buildInstarCodexHookGroups(
  projectDir: string,
): Record<string, CodexHookGroup[]> {
  const node = (script: string): CodexHookHandler => ({
    type: 'command',
    command: `node ${path.join(projectDir, INSTAR_HOOK_PATH_MARKER, script)}`,
    timeout: 5000,
  });
  const sh = (script: string): CodexHookHandler => ({
    type: 'command',
    command: `bash ${path.join(projectDir, INSTAR_HOOK_PATH_MARKER, script)}`,
    timeout: 5000,
  });
  // The autonomous-loop driver lives in the autonomous SKILL (not .instar/hooks/instar),
  // so it has its own path constant. `--codex` tells the shared hook it was invoked from
  // codex (vs Claude's settings.json registration) so it can self-gate on the
  // autonomousSessions.codexLoopDriver flag (DARK by default → exits immediately).
  const autonomousLoopHook = (): CodexHookHandler => ({
    type: 'command',
    command: `bash ${path.join(projectDir, CODEX_AUTONOMOUS_HOOK_MARKER)} --codex`,
    timeout: 10000,
  });

  return {
    // Pre-action gate. matcher '.*' = all tool calls (Codex treats the matcher as
    // a regex against the tool name; a bare '*' is an invalid quantifier that
    // matches NOTHING, so the gate silently never fires — '.*' is required.
    // Verified live 2026-05-24: with '.*', dangerous-command-guard fires on Codex's
    // exec_command tool and blocks `rm -rf /`; with '*'/'' it did not fire at all).
    // Each script classifies and decides: dangerous-command-guard covers Codex's
    // native shell/exec_command (the main destructive surface); external-operation-gate
    // covers mcp__* tools; grounding-before-messaging gates messaging commands;
    // deferral-detector inspects messaging commands for false-blocker / orphan-TODO
    // language (it is a PreToolUse hook on Claude too — NOT a Stop hook). All read the
    // command from Codex's stdin payload — Codex's exec_command puts it in
    // tool_input.cmd (Claude uses tool_input.command); the scripts accept both field
    // names AND both tool names (Bash | exec_command).
    PreToolUse: [
      { matcher: '.*', hooks: [sh('dangerous-command-guard.sh'), node('external-operation-gate.js'), sh('grounding-before-messaging.sh'), node('deferral-detector.js')] },
    ],
    // Codex-only checkpoint. Routes to the same gate; the trust system
    // auto-decides (allow/deny) with NO human prompt so autonomy is preserved.
    PermissionRequest: [
      { matcher: '.*', hooks: [node('external-operation-gate.js')] },
    ],
    // End-of-turn review chain — starts with the unjustified-stop router
    // (shadow by default), then MUST MIRROR the Claude Stop trio
    // (settings-template.json): response-review + claim-intercept-response +
    // scope-coherence-checkpoint. (Earlier this wrongly substituted
    // deferral-detector — a PreToolUse hook whose `tool_name==='Bash'` guard
    // no-ops on a Stop payload; deferral-detector now lives on PreToolUse above,
    // matching Claude.) All three are framework-neutral (read stdin, POST to the
    // local server). Codex honors `{decision:"block", reason}` on Stop (verified
    // in the 0.133 binary's StopCommandOutputWire) — the same grounding-pause
    // semantics as Claude, NOT a hard termination. scope-coherence defaults to
    // `approve` and self-throttles (depth threshold + 30-min cooldown), so it
    // can't loop an autonomous Codex run.
    // End-of-turn chain: the standing review trio, then the autonomous-loop driver as
    // the LAST hook IN THE SAME group (slot stop:0:4) — NOT a separate group. A separate
    // group would emit a stop:1:0 arm slot that codex may never render/trust, which would
    // permanently break armCodexHooks's idempotency (recurring codex-TUI arm spawns on
    // every update, even while the driver is dark). Keeping it in group 0 means it's
    // armed/trusted/fired alongside the trio it already runs. The driver self-gates: with
    // codexLoopDriver disabled (default) it exits immediately, so it's a no-op until the
    // flag is flipped on. (Within-group block precedence vs the trio is verified live
    // before enabling — see the spec's Phase 5; worst case the session still continues
    // via the unjustified-stop router, never strands.)
    Stop: [
      { matcher: '', hooks: [node('stop-gate-router.js'), { ...node('response-review.js'), timeout: 10000 }, node('claim-intercept-response.js'), node('scope-coherence-checkpoint.js'), autonomousLoopHook()] },
    ],
    // Identity/context injection.
    SessionStart: [
      { matcher: '', hooks: [sh('session-start.sh')] },
    ],
    UserPromptSubmit: [
      { matcher: '', hooks: [sh('telegram-topic-context.sh')] },
    ],
  };
}

function groupIsInstarOwned(group: CodexHookGroup): boolean {
  return (group.hooks ?? []).some(
    (h) =>
      typeof h.command === 'string' &&
      (h.command.includes(INSTAR_HOOK_PATH_MARKER) ||
        h.command.includes(CODEX_AUTONOMOUS_HOOK_MARKER)),
  );
}

/**
 * Write/merge instar gate hooks into `<projectDir>/.codex/hooks.json`.
 * Preserves any user-added hooks; replaces instar-owned entries.
 */
export function installCodexHooks(projectDir: string): string {
  const codexDir = path.join(projectDir, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  const hooksPath = path.join(codexDir, 'hooks.json');

  let config: CodexHooksConfig = {};
  if (fs.existsSync(hooksPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
      if (parsed && typeof parsed === 'object') config = parsed as CodexHooksConfig;
    } catch {
      // Corrupted — start fresh rather than block install.
    }
  }
  const hooks = (config.hooks ??= {});
  const desired = buildInstarCodexHookGroups(projectDir);

  for (const [event, instarGroups] of Object.entries(desired)) {
    const userGroups = (hooks[event] ?? []).filter((g) => !groupIsInstarOwned(g));
    hooks[event] = [...userGroups, ...instarGroups];
  }

  fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2) + '\n');
  return hooksPath;
}

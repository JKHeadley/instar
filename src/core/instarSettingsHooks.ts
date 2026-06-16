/**
 * instarSettingsHooks.ts — the single source of truth for the instar
 * PreToolUse hook ENTRIES written into `.claude/settings.json`.
 *
 * Why this module exists (the dark-guardrail migration gap, 2026-05-27):
 * `init.ts` wired a full set of PreToolUse Bash hooks for NEW agents, but the
 * existing-agent path (`PostUpdateMigrator.migrateSettings`) only ever ensured
 * two of them (slopcheck-guard + the MCP gate). So four guardrails —
 * grounding-before-messaging, deferral-detector (the false-blocker pre-filter),
 * external-communication-guard, post-action-reflection — shipped to disk on
 * every existing agent but were never switched on in settings. They looked
 * installed and did nothing. Root cause: the "what hooks does an agent get"
 * list lived in two places that drifted.
 *
 * Both the new-agent path (init.ts) and the existing-agent path
 * (PostUpdateMigrator.ensureInstarPreToolUseBashHooks) now import these
 * constants, so the two can never drift again — add a hook here and both
 * paths get it. An anti-drift unit test locks the canonical filename set.
 *
 * NOTE: the objects here are written verbatim into settings.json, so their
 * shape (type/command/blocking/timeout) must stay byte-stable. Presence
 * detection during migration derives the script filename from the command
 * via `instarHookFilename()` — never add a `filename` field to these objects,
 * or new agents' settings would gain a stray key.
 *
 * Scope: the Claude-Code `Bash` and `mcp__.*` PreToolUse matchers only.
 * slopcheck-guard keeps its own dedicated ensure-block in migrateSettings
 * (it is intentionally NOT in this set — it is added by that block for both
 * new and existing agents). Codex hooks (installCodexHooks.ts, `.*` matcher)
 * are a separate path and are not governed by this module.
 */

export interface InstarSettingsHookEntry {
  type: 'command';
  command: string;
  blocking?: boolean;
  timeout?: number;
}

const PD = '${CLAUDE_PROJECT_DIR}';

/**
 * The canonical instar PreToolUse `Bash`-matcher hook entries, in canonical
 * order. Mirrors (and is consumed by) init.ts's former `instarBashHooks`.
 */
export const INSTAR_BASH_PRETOOLUSE_HOOKS: ReadonlyArray<InstarSettingsHookEntry> = [
  {
    type: 'command',
    command: `bash ${PD}/.instar/hooks/instar/dangerous-command-guard.sh "$TOOL_INPUT"`,
    blocking: true,
  },
  {
    type: 'command',
    command: `bash ${PD}/.instar/hooks/instar/grounding-before-messaging.sh "$TOOL_INPUT"`,
    blocking: false,
  },
  {
    type: 'command',
    command: `node ${PD}/.instar/hooks/instar/deferral-detector.js`,
    timeout: 5000,
  },
  {
    type: 'command',
    command: `node ${PD}/.instar/hooks/instar/self-stop-guard.js`,
    timeout: 5000,
  },
  {
    type: 'command',
    command: `node ${PD}/.instar/hooks/instar/external-communication-guard.js`,
    timeout: 5000,
  },
  {
    type: 'command',
    command: `node ${PD}/.instar/hooks/instar/post-action-reflection.js`,
    timeout: 5000,
  },
  {
    // Parallel-Hand PR Lease guard (spec: parallel-hand-pr-lease.md): before a
    // `git push`, asks the server whether another LIVE session of this agent owns
    // the branch's lease; blocks (exit 2) only on a deny. Dev-gated dark + dryRun;
    // fail-open on every uncertainty (a broken guard never blocks a push).
    type: 'command',
    command: `node ${PD}/.instar/hooks/instar/pr-hand-lease-guard.js`,
    blocking: true,
    timeout: 6000,
  },
];

/**
 * The canonical instar PreToolUse `mcp__.*`-matcher hook entries.
 * Mirrors (and is consumed by) init.ts's former `instarMcpHooks`.
 */
export const INSTAR_MCP_PRETOOLUSE_HOOKS: ReadonlyArray<InstarSettingsHookEntry> = [
  {
    type: 'command',
    command: `node ${PD}/.instar/hooks/instar/external-operation-gate.js`,
    blocking: true,
    timeout: 5000,
  },
];

/**
 * The canonical script filenames for the Bash set, in order. Used by the
 * anti-drift test and as the documented contract. Derived once from the
 * command strings so it can never silently disagree with the entries above.
 */
export const INSTAR_BASH_PRETOOLUSE_FILENAMES: ReadonlyArray<string> =
  INSTAR_BASH_PRETOOLUSE_HOOKS.map((h) => instarHookFilename(h.command) ?? '');

/**
 * Extract the instar hook script filename from a settings hook command, e.g.
 * `node ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/deferral-detector.js` ->
 * `deferral-detector.js`. Returns null if the command does not reference an
 * instar hook script. Used for idempotent presence detection during migration
 * (substring/filename match is robust to ${CLAUDE_PROJECT_DIR} vs absolute
 * path variations, unlike an exact-command compare).
 */
export function instarHookFilename(command: string): string | null {
  const m = command.match(/\/\.instar\/hooks\/instar\/([\w.-]+\.(?:sh|js|mjs|cjs))/);
  return m ? m[1] : null;
}

/** Minimal structural shape of a settings PreToolUse matcher entry. */
export interface SettingsMatcherEntry {
  matcher?: string;
  hooks?: Array<{ command?: string; type?: string; blocking?: boolean; timeout?: number }>;
}

/**
 * Idempotently ensure every canonical instar Bash PreToolUse hook is present
 * in an existing agent's settings. Mirrors init.ts (both consume
 * INSTAR_BASH_PRETOOLUSE_HOOKS), closing the dark-guardrail migration gap.
 *
 * Behavior:
 * - Finds the `Bash` matcher (creates one if absent).
 * - For each canonical hook, adds it ONLY IF no existing hook command already
 *   references that script filename (filename/substring match — robust to
 *   ${CLAUDE_PROJECT_DIR} vs absolute path; prevents duplicates).
 * - APPENDS missing hooks in canonical order; never reorders or removes
 *   existing entries (hand-curated settings are preserved).
 * - Pushes fresh copies of the canonical entries (never the shared objects).
 *
 * Returns the list of filenames that were added (empty array == no-op, so the
 * caller can decide whether to flag the settings file as patched). Safe to run
 * repeatedly: once every hook is present, every subsequent call returns [].
 *
 * Does NOT touch slopcheck-guard (its own dedicated ensure-block owns it) or
 * any non-Bash matcher.
 */
export function ensureInstarBashPreToolUseHooks(preToolUse: SettingsMatcherEntry[]): string[] {
  const added: string[] = [];
  let bashEntry = preToolUse.find((e) => e.matcher === 'Bash');
  if (!bashEntry) {
    bashEntry = { matcher: 'Bash', hooks: [] };
    preToolUse.push(bashEntry);
  }
  if (!bashEntry.hooks) bashEntry.hooks = [];

  for (const canonical of INSTAR_BASH_PRETOOLUSE_HOOKS) {
    const fname = instarHookFilename(canonical.command);
    if (!fname) continue;
    const present = bashEntry.hooks.some((h) => typeof h.command === 'string' && h.command.includes(fname));
    if (!present) {
      bashEntry.hooks.push({ ...canonical });
      added.push(fname);
    }
  }
  return added;
}

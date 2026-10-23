/**
 * baselineProcessPatterns.ts — the ONE definition of "processes that are always
 * present and never mean work is running".
 *
 * WHY ITS OWN MODULE. This list had drifted into three hand-copies (the session
 * manager's process probe, the stand-down drain predicate, and the server's
 * PresenceProxy tier-3 filter), one of which carried a comment claiming the
 * copies "cannot drift" — which was simply false. All three now import THIS
 * module (the tier-3 filter spreads two extra claude-process entries of its own
 * on top, declared at its callsite). The obvious fix, exporting it from
 * SessionManager, creates a load-order CYCLE: SessionManager imports the drain
 * module, so the drain module importing SessionManager back means a
 * module-init-time `.filter()` over the constant can observe `undefined`
 * depending on evaluation order. A leaf module every consumer imports has no
 * such hazard, which is the whole reason this file exists rather than an export
 * added where the list happened to live.
 */

/** Descendant commands that are baseline noise, never evidence of work. */
export const BASELINE_PROCESS_PATTERNS: readonly RegExp[] = [
  /\bplaywright-mcp\b/,
  /\bplaywright\/mcp\b/,
  /\bmcp-stdio-entry\b/,
  /\bmcp.*server\b/i,
  /\bcaffeinate\b/,
  /\bnpm exec\b.*mcp/,
  // Any MCP server a session launched from its .mcp.json, whatever the binary
  // is called: `workspace-mcp --tool-tier complete`, `@plaud-ai/mcp@latest`,
  // `mcp-server-foo`. Every MCP binary carries the `mcp` token by convention,
  // and the entries above only ever named the ones we happened to ship. The
  // 2026-10-22 sagemind pile-up: the Google Workspace MCP matched none of them,
  // so every conversation counted as working forever and nothing idle was ever
  // closed. A tool shell is judged BEFORE this list (CLAUDE_TOOL_SHELL_PATTERN
  // wins), so a command that merely mentions mcp inside a Bash call stays work.
  /\bmcp\b/i,
];

/**
 * The subset that are MCP stack ROOTS — everything descending from one of these
 * is part of the resident MCP stack (Chromium under playwright-mcp, a language
 * server under an MCP bridge, …). `caffeinate` is the one baseline entry that is
 * not an MCP root, so it is subtracted by name and every other entry follows the
 * single source above. Derived, not copied: adding an MCP pattern above extends
 * both consumers by construction.
 */
export const MCP_STACK_ROOT_PATTERNS: readonly RegExp[] =
  BASELINE_PROCESS_PATTERNS.filter((p) => !/caffeinate/.test(p.source));

/**
 * Claude Code runs every Bash tool call — foreground AND `run_in_background` —
 * as `<shell> -c source <config-home>/shell-snapshots/snapshot-….sh … eval '…'`.
 * A live process matching this is the agent's OWN in-flight command (a build,
 * a test run, a watch loop waiting on other sessions), never resident noise.
 * The session reaper uses it so a quiet session that is WAITING on its own
 * background shells is not mistaken for an abandoned one.
 */
export const CLAUDE_TOOL_SHELL_PATTERN = /\/shell-snapshots\/snapshot-/;

/**
 * Framework-neutral tool shell: the `<shell> -c …` / `zsh -lc …` child a
 * framework spawns to run ONE tool command (Claude's snapshot shell matches
 * this too; Codex runs `/bin/zsh -lc '<cmd>'` with no snapshot token). A tool
 * shell is the agent's own in-flight command and is judged BEFORE any baseline
 * entry, so a command whose text merely mentions an MCP (`grep -rn mcp src/`,
 * `vitest run tests/unit/mcp-stdio.test.ts`) is never mistaken for a resident
 * helper. Added with the generic `mcp` baseline entry, whose review found that
 * only Claude's shell had this precedence.
 */
export const TOOL_SHELL_PATTERN = /(?:^|[\s/])(?:ba|z|da|k)?sh\s+-(?:l?c|cl?)\b/;

/** Either framework's tool shell. */
export function isToolShellCommand(command: string): boolean {
  return CLAUDE_TOOL_SHELL_PATTERN.test(command) || TOOL_SHELL_PATTERN.test(command);
}

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

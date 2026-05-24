/**
 * claudeForbiddenGuard — structural enforcement of "Codex-only" agents.
 *
 * PROBLEM: A codex-only agent (enabledFrameworks = ['codex-cli'], no
 * 'claude-code') must NEVER invoke Claude — not for the main session, and
 * not for any internal LLM call (gates, sentinels, summaries, relationship
 * intelligence, supervision tiers). The framework-aware provider factory
 * routes the MAIN path to Codex, but several fallback paths construct a
 * ClaudeCliIntelligenceProvider directly when the Codex provider can't be
 * built. On a machine where the `claude` binary happens to be installed,
 * those fallbacks SILENTLY use Claude — an invisible violation (no error).
 *
 * SOLUTION (Structure > Willpower): a single process-level guard. When the
 * agent is codex-only, `setClaudeForbidden()` is called once at startup.
 * Thereafter, ANY attempt to construct a Claude intelligence provider (or
 * any code that wants to spawn `claude`) calls `assertClaudeAllowed()`,
 * which throws `ClaudeForbiddenError`. The violation surfaces loudly at the
 * exact call site instead of silently degrading to Claude. Callers that
 * have a legitimate "no LLM available" degradation path catch the error and
 * disable the LLM-backed feature rather than reaching for Claude.
 *
 * This is deliberately a module-level singleton: there is exactly one agent
 * per process, and its framework policy is fixed at boot.
 */

export class ClaudeForbiddenError extends Error {
  constructor(context: string, reason: string) {
    super(
      `Claude is forbidden on this agent (${reason}). ` +
      `Refused to construct/invoke Claude for: ${context}. ` +
      `This is a codex-only agent — route through the Codex intelligence provider instead.`,
    );
    this.name = 'ClaudeForbiddenError';
  }
}

let _claudeForbidden = false;
let _reason = '';

/**
 * Mark Claude as forbidden for this process. Call once at server startup
 * when the agent is codex-only. Idempotent.
 *
 * @param reason human-readable reason, surfaced in the thrown error
 *   (e.g. "enabledFrameworks=['codex-cli'], no claude-code").
 */
export function setClaudeForbidden(reason: string): void {
  _claudeForbidden = true;
  _reason = reason;
}

/** Test/back-compat helper — clear the flag. */
export function clearClaudeForbidden(): void {
  _claudeForbidden = false;
  _reason = '';
}

/** Is Claude currently forbidden in this process? */
export function isClaudeForbidden(): boolean {
  return _claudeForbidden;
}

/**
 * Throw `ClaudeForbiddenError` if Claude is forbidden. Call this from every
 * Claude-construction / Claude-spawn site so a codex-only agent physically
 * cannot reach for Claude.
 *
 * @param context what was about to use Claude (for the error message).
 */
export function assertClaudeAllowed(context: string): void {
  if (_claudeForbidden) {
    throw new ClaudeForbiddenError(context, _reason);
  }
}

/**
 * Derive whether an agent is codex-only from its enabledFrameworks list.
 * codex-only ⇔ the list is a non-empty array that does NOT include
 * 'claude-code'. An empty/undefined list is NOT treated as codex-only
 * (back-compat: legacy installs without the field default to allowing
 * Claude, matching v0.x behavior).
 */
export function isCodexOnly(
  enabledFrameworks: ReadonlyArray<string> | undefined | null,
): boolean {
  if (!Array.isArray(enabledFrameworks) || enabledFrameworks.length === 0) {
    return false;
  }
  return !enabledFrameworks.includes('claude-code');
}

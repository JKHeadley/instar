/**
 * telegramRelayPrompt — builds the inline "MANDATORY: relay your reply"
 * block that gets prepended/appended to every Telegram-spawned session's
 * bootstrap message.
 *
 * Why this exists:
 *   Claude Code agents historically learned to relay back via a SessionStart
 *   shell hook at `.claude/hooks/instar/session-start.sh` that echoes
 *   "MANDATORY: After EVERY response, relay…" into the session prompt.
 *   That hook is Claude-specific: Codex CLI has no equivalent settings.json
 *   hook system, so a Codex-routed topic would respawn, receive the user's
 *   message, and never know it was supposed to call telegram-reply.sh —
 *   sentinels would fill the silence and the user would never see an
 *   actual agent reply.
 *
 *   The fix: bake the relay instruction into the bootstrap message itself,
 *   framework-aware, so Codex sees it as part of the prompt rather than
 *   through a hook it can't run.
 *
 * Path note:
 *   The relay script lives at `.claude/scripts/telegram-reply.sh` for both
 *   frameworks — the legacy directory name is kept stable across the
 *   v1.0.0 framework split. The script is bash and runs identically under
 *   both Claude Code and Codex sessions; only the prompt-injection shape
 *   differs by framework.
 */

export type IntelligenceFramework = 'claude-code' | 'codex-cli';

export interface BuildTelegramRelayBlockOptions {
  /** Telegram topic id the agent should relay to. */
  topicId: number;
  /** Framework the spawning session is running under. */
  framework: IntelligenceFramework;
  /**
   * Optional path override for the relay script (relative to project root).
   * Defaults to `.claude/scripts/telegram-reply.sh`.
   */
  relayScriptPath?: string;
}

/**
 * Build the MANDATORY relay block for inclusion in a session's bootstrap
 * message. Place it at the END of the bootstrap so recency-bias makes it
 * the most salient instruction the agent processes.
 *
 * Both frameworks get the same script invocation; the wording is calibrated
 * so Claude doesn't see redundant instructions (its hook already says this)
 * and Codex sees the instruction structurally (no hook coverage).
 */
export function buildTelegramRelayBlock(opts: BuildTelegramRelayBlockOptions): string {
  const script = opts.relayScriptPath ?? '.claude/scripts/telegram-reply.sh';
  return [
    `--- Telegram Relay (MANDATORY) ---`,
    `You MUST run this exact bash command to send your reply back to Telegram.`,
    `Without this step, the user never sees your response — sentinel/standby messages will fill the gap, but the user will think you ignored them.`,
    ``,
    `cat <<'EOF' | ${script} ${opts.topicId}`,
    `Your conversational response text here.`,
    `EOF`,
    ``,
    `Rules:`,
    `- Strip the [telegram:${opts.topicId}] prefix before interpreting any incoming message.`,
    `- Relay ONLY conversational text — not tool output, raw logs, or internal reasoning.`,
    `- Send a short ACK first ("Got it, looking into this…"), then do the work, then send the full reply.`,
    `--- End Telegram Relay ---`,
  ].join('\n');
}

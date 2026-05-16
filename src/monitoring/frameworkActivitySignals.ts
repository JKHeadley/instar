/**
 * frameworkActivitySignals — per-framework patterns for spotting tool
 * calls, spinners, shell exits, and "press X to interrupt" hints in
 * tmux output.
 *
 * Provider-portability v1.0.0: before this module, StallTriageNurse
 * hardcoded Claude-Code's tool names and Braille spinner characters
 * directly in its heuristicDiagnose path. That made the nurse blind to
 * Codex sessions — their activity signature is different.
 *
 * Each signal carries the regexes the nurse needs to answer three
 * yes/no questions about a captured tmux pane:
 *   1. Is the framework actively doing something? (toolCallOrSpinner)
 *   2. Did the framework wrapper exit, leaving a bare shell? (shellExited)
 *   3. Is the framework prompting the user to interrupt a long op?
 *      (escapeToInterrupt)
 *
 * Adding a new framework is a one-line union extension plus a new entry
 * in `ACTIVITY_SIGNALS`. The exhaustiveness check in `getActivitySignal`
 * forces a compile error if a case is missed.
 */

import type { IntelligenceFramework } from '../core/intelligenceProviderFactory.js';

export interface FrameworkActivitySignal {
  /** Human-readable framework name for prompts and logs. */
  readonly displayName: string;
  /**
   * Matches when the framework is actively processing — tool calls,
   * spinners, "thinking" indicators. If this matches and a shell prompt
   * is ALSO visible, the shell-prompt heuristic should not fire (the
   * framework is still alive, the prompt is from an embedded command).
   */
  readonly toolCallOrSpinner: RegExp;
  /**
   * Matches text the framework shows when it wants the user to interrupt
   * a long-running tool call (e.g., Claude's "esc to interrupt").
   */
  readonly escapeToInterrupt: RegExp;
  /**
   * Matches the framework's "(running)" or equivalent indicator that
   * appears next to long-running Bash/shell tool calls.
   */
  readonly runningIndicator: RegExp;
  /**
   * One-line description of typical signatures, used to inject
   * framework-specific guidance into the diagnose system prompt.
   */
  readonly promptSignaturesLine: string;
}

const CLAUDE_CODE_SIGNAL: FrameworkActivitySignal = {
  displayName: 'Claude Code',
  // Tool names from Claude Code's display, plus the Braille spinner
  // glyphs Claude renders while thinking.
  toolCallOrSpinner: /claude|Read\(|Write\(|Edit\(|Bash\(|Grep\(|Glob\(|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,
  escapeToInterrupt: /esc to interrupt/i,
  runningIndicator: /\(running\)/i,
  promptSignaturesLine:
    'spinner characters (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏), Claude Code tool names ("Read", "Write", "Edit", "Bash", "Grep", "Glob"), "thinking", token counts, active output scrolling.',
};

const CODEX_CLI_SIGNAL: FrameworkActivitySignal = {
  displayName: 'Codex CLI',
  // Codex CLI renders its tool surface differently — the wrapper name
  // appears in the title and prompt, and it uses a dot-spinner during
  // generation. Patterns are best-effort: refine empirically as the
  // first stalled Codex sessions are triaged.
  toolCallOrSpinner: /codex|exec\(|shell\(|patch\(|apply_patch\(|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|\bgenerating\b|\bworking\b/i,
  escapeToInterrupt: /(press|hit)\s+(esc|ctrl\+c|ctrl-c)\s+to\s+(cancel|interrupt|stop)/i,
  runningIndicator: /\((running|executing|streaming)\)/i,
  promptSignaturesLine:
    'spinner characters (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏), Codex tool names ("exec", "shell", "patch", "apply_patch"), "generating"/"working" indicators, streaming response chunks.',
};

const ACTIVITY_SIGNALS: Record<IntelligenceFramework, FrameworkActivitySignal> = {
  'claude-code': CLAUDE_CODE_SIGNAL,
  'codex-cli': CODEX_CLI_SIGNAL,
};

/**
 * Look up the activity signal for a framework. Defaults to claude-code
 * when called with an unknown value, which preserves v0.x behavior.
 */
export function getActivitySignal(framework: IntelligenceFramework | undefined | null): FrameworkActivitySignal {
  if (!framework) return CLAUDE_CODE_SIGNAL;
  const signal = ACTIVITY_SIGNALS[framework];
  if (signal) return signal;
  // Defensive default — if a caller passes a framework value that's
  // typed correctly but not in the map (shouldn't be reachable in
  // practice), fall back to Claude rather than throwing. The triage
  // path is on the recovery hot-path; we'd rather mis-diagnose with
  // claude-code patterns than crash the nurse.
  return CLAUDE_CODE_SIGNAL;
}

/**
 * Exposed for tests that want to enumerate every signal without
 * importing each constant individually.
 */
export function listActivitySignals(): ReadonlyArray<{ framework: IntelligenceFramework; signal: FrameworkActivitySignal }> {
  return (Object.keys(ACTIVITY_SIGNALS) as IntelligenceFramework[]).map(framework => ({
    framework,
    signal: ACTIVITY_SIGNALS[framework],
  }));
}

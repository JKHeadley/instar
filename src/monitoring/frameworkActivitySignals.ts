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
  // Empirically derived from live gpt-5.3-codex panes (2026-05-23 harness).
  // The canonical "actively working" indicator is the status line Codex
  // renders during generation: `• Working (Ns • esc to interrupt)`, plus
  // action bullets (`• Ran ...`) and the dot-spinner.
  //
  // CRITICAL: do NOT match the bare word "codex". The model name
  // "gpt-5.3-codex" is ALWAYS present in Codex's IDLE status line
  // (`gpt-5.3-codex medium · ~/project`), so matching it made every idle
  // Codex session read as "actively working" — the false positive that hid
  // genuinely-stuck sessions from the silence sentinel and let the presence
  // proxy default to "still working" forever (the 2026-05-23 stuck-session
  // incident). The placeholder prompt "Find and fix a bug in @filename" is
  // likewise an IDLE indicator, not work.
  //
  // codex EXEC --json mode (jobs, autonomous spawns) emits a JSON EVENT STREAM,
  // not the TUI status line: {"type":"thread.started"}, {"type":"turn.started"},
  // {"type":"item.started"|"item.completed"|"item.updated"}, etc. None of the
  // TUI patterns above match that, so a working `codex exec --json` session read
  // as NOT active → marked paused → skipped by ActiveWorkSilenceSentinel. That
  // hid a genuinely-wedged exec-json job (frozen mid-turn ~8.5h) from the
  // silence watchdog. Match the event-stream namespaces so an exec-json session
  // that streamed events THEN froze is silence-eligible (the OutputActivity-
  // Tracker's observed-change requirement still gates "frozen before we watched").
  // These are structured JSON markers, not idle status text.
  toolCallOrSpinner: /Working\s*\(\d+\s*s|•\s*Ran\b|exec\(|shell\(|apply_patch\(|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|\bgenerating\b|"type":\s*"(thread|turn|item)\./i,
  // Codex shows a BARE "esc to interrupt" (no "press"/"hit" prefix) inside
  // its working status line, so the Claude-style prefixed pattern never
  // matched a real Codex pane. Match the bare form.
  escapeToInterrupt: /esc to interrupt/i,
  runningIndicator: /\((running|executing|streaming)\)|background terminal running/i,
  promptSignaturesLine:
    'the working status line "Working (Ns • esc to interrupt)", action bullets ("• Ran ..."), spinner characters (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏), "generating". IDLE (NOT work): the model-name status line "gpt-5.3-codex medium · <dir>" and the placeholder prompt "Find and fix a bug in @filename".',
};

const GEMINI_CLI_SIGNAL: FrameworkActivitySignal = {
  displayName: 'Gemini CLI',
  // CONSERVATIVE (apprenticeship Step 2): the minimal Gemini body runs ONE-SHOT
  // (`gemini -p`), not a long-lived TUI, so the precise interactive-pane
  // signatures are not yet live-characterized (a §6 build-time discovery item
  // when the TUI/loop-driver path is taken up). This entry matches the generic
  // "actively working" indicators (the dot/Braille spinner glyphs + the bare
  // word "Generating"/"Thinking" Gemini shows during a turn) plus the
  // "esc to interrupt" hint shared across CLIs. It deliberately does NOT match
  // the bare word "gemini" (which appears in idle status / the model name) to
  // avoid the codex idle-status false-positive that hid stuck sessions.
  toolCallOrSpinner: /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|\b(generating|thinking)\b/i,
  escapeToInterrupt: /esc to interrupt/i,
  runningIndicator: /\((running|executing|streaming)\)/i,
  promptSignaturesLine:
    'spinner characters (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏), "Generating"/"Thinking" during a turn, "esc to interrupt". NOTE: the Gemini interactive-TUI signatures are not yet live-characterized (the minimal Step-2 body runs one-shot); this is a conservative default refined when the loop-driver/TUI path lands.',
};

const ACTIVITY_SIGNALS: Record<IntelligenceFramework, FrameworkActivitySignal> = {
  'claude-code': CLAUDE_CODE_SIGNAL,
  'codex-cli': CODEX_CLI_SIGNAL,
  'gemini-cli': GEMINI_CLI_SIGNAL,
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

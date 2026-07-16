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
   * LIVE-generation markers ONLY — the subset of activity signals that appear
   * exclusively WHILE a turn is generating and vanish the instant it ends (the
   * animated braille spinner, the "Working (Ns" status line, "generating"). It
   * deliberately EXCLUDES the scrollback-persistent markers in toolCallOrSpinner —
   * tool-call names (Read(/Write(/Bash(/exec(/…) and the bare framework word
   * (e.g. "claude") — which linger in an IDLE session's visible history long after
   * the turn finished. The SessionReaper's positive-idle proof must use THIS, not
   * toolCallOrSpinner: a 200-line capture of an idle Claude session is full of past
   * tool-names + "claude", so toolCallOrSpinner mis-read every idle session as
   * "working" and the reaper could never reap (2026-06-07 grounding; same class as
   * the codex "do not match bare 'codex'" lesson). Other consumers that genuinely
   * want "is this a tool-using framework" keep using toolCallOrSpinner.
   */
  readonly liveActivity: RegExp;
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
  // NOTE: the bare word "claude" was REMOVED (2026-06-07) — it matched the
  // omnipresent tool name in every Claude Code pane, making idle sessions read as
  // working (the documented codex "do not match bare 'codex'" lesson, never applied
  // here). Tool-call names remain for consumers that want "is this tool-using".
  toolCallOrSpinner: /Read\(|Write\(|Edit\(|Bash\(|Grep\(|Glob\(|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,
  // Live-only: the animated braille spinner. Tool-names + "claude" persist in idle
  // scrollback, so they are NOT live markers (see FrameworkActivitySignal.liveActivity).
  liveActivity: /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,
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
  toolCallOrSpinner: /Working\s*\(\d+\s*(?:m\s*\d+\s*)?s|•\s*Ran\b|exec\(|shell\(|apply_patch\(|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|\bgenerating\b|"type":\s*"(thread|turn|item)\./i,
  // Live-only: the working status line + spinner + "generating". Excludes "• Ran"
  // and exec(/shell(/apply_patch( + the event-stream markers, which persist in
  // scrollback / the JSONL after a turn ends.
  liveActivity: /Working\s*\(\d+\s*(?:m\s*\d+\s*)?s|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|\bgenerating\b/i,
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
  // Gemini's toolCallOrSpinner is already live-only (spinner + generating/thinking,
  // no scrollback-persistent tool-names), so liveActivity mirrors it.
  liveActivity: /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|\b(generating|thinking)\b/i,
  escapeToInterrupt: /esc to interrupt/i,
  runningIndicator: /\((running|executing|streaming)\)/i,
  promptSignaturesLine:
    'spinner characters (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏), "Generating"/"Thinking" during a turn, "esc to interrupt". NOTE: the Gemini interactive-TUI signatures are not yet live-characterized (the minimal Step-2 body runs one-shot); this is a conservative default refined when the loop-driver/TUI path lands.',
};

const PI_CLI_SIGNAL: FrameworkActivitySignal = {
  displayName: 'Pi',
  // CONSERVATIVE (PI-HARNESS-INTEGRATION-SPEC §2.2, P0.1 eval pi 0.78.1): the
  // hands-on eval characterized the pane during tool execution — pi renders
  // the executed command as a `$ <cmd>` line and stamps `Took N.Ns` on
  // completion; pi-tui also uses the shared Braille spinner family while
  // streaming. This entry matches those plus the generic working words. It
  // deliberately does NOT match the bare word "pi", the model name in the
  // status line, or the STATIC banner hint "escape interrupt" (always visible
  // near boot even when idle — matching it would recreate the codex
  // idle-status false-positive that hid stuck sessions).
  toolCallOrSpinner: /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|^\s*\$\s\S|\bTook \d+(\.\d+)?s\b|\b(generating|thinking|streaming)\b/im,
  // Live-only: spinner + generating/thinking/streaming. Excludes the "$ cmd" shell
  // echo and "Took Ns" completion line, which persist in scrollback after a turn.
  liveActivity: /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|\b(generating|thinking|streaming)\b/i,
  // pi's interrupt hint is the banner's "escape interrupt", but that banner is
  // visible while IDLE too — so it is NOT a reliable in-flight indicator. Use a
  // deliberately unmatchable pattern until a live-provider pane characterizes a
  // work-scoped hint (refinement noted in the spec's build-time discovery list).
  escapeToInterrupt: /pi-has-no-work-scoped-interrupt-hint(?!)/,
  runningIndicator: /\((running|executing|streaming)\)/i,
  promptSignaturesLine:
    'executed-command lines ("$ <cmd>") with "Took N.Ns" completion stamps, spinner characters (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏). IDLE (NOT work): the status line "<cwd> … <model>" and the static banner "escape interrupt · ctrl+c/ctrl+d clear/exit".',
};

const ACTIVITY_SIGNALS: Record<IntelligenceFramework, FrameworkActivitySignal> = {
  'claude-code': CLAUDE_CODE_SIGNAL,
  'codex-cli': CODEX_CLI_SIGNAL,
  'gemini-cli': GEMINI_CLI_SIGNAL,
  'pi-cli': PI_CLI_SIGNAL,
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

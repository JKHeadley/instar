/**
 * Readiness classification for a framework TUI pane tail.
 *
 * WHY THIS EXISTS AS ITS OWN MODULE
 * ---------------------------------
 * On 2026-07-26 a user's message was injected into a freshly-spawned Claude Code
 * pane 15 seconds before that pane could accept input. The paste was swallowed by
 * the TUI still painting itself, and the delivery was logged as a SUCCESS
 * (`Injected initial message into "…" (915 chars, after stabilization delay)`).
 * The message reached the agent only because an unrelated start-hook backstop
 * re-read recent history.
 *
 * The cause was the readiness probe, not the injector. It accepted a bare
 * slash-command mention anywhere in the captured tail:
 *
 *     if (/\/(effort|model|fast)/.test(tail)) return true;
 *
 * Claude Code's startup banner advertises slash commands IN PROSE — the pane that
 * fooled it carried "…Run /model and select Fable to use it." So the probe matched
 * a promotional line and declared a still-booting pane ready. A string matcher
 * fooled by its own subject: the banner that proves the app is NOT yet accepting
 * input was read as proof that it is.
 *
 * THOSE CLAUSES ARE DELETED, NOT TUNED. The first fix attempt kept them and
 * required "status-bar shape" (line-start, or directly after an interpunct).
 * Second-pass review falsified that:
 *   - The banner uses the same shape. `⚠ CLAUDE.md is over the … limit · /memory
 *     to free up context` and `+1 more · /status` are BANNER lines in interpunct
 *     shape. The only thing separating them from a status bar was that `memory`
 *     and `status` fall outside the three-word set — i.e. still vocabulary, and a
 *     plausible `· /model to opt in` promo line matched outright.
 *   - The line-start branch reinstated the Anthropic-copy dependency it claimed to
 *     remove: at a fixed pane width an edit shifting the wrap by ~14 characters
 *     puts `/model` at column 0 and the original defect returns.
 * A signal that cannot separate an ADVERT for a command from a STATUS BAR showing
 * one carries no information about readiness. Widening the genuinely structural
 * markers below costs nothing and covers the same panes.
 *
 * WHY THE ANSWER IS NOT A BOOLEAN
 * -------------------------------
 * There are three consumers and they want OPPOSITE responses to the two ways a
 * pane can fail to be ready:
 *   - the spawn/inject path — must not type into a pane that is still painting,
 *     and must not type into a MENU (see below);
 *   - `waitForClaudeReadyWithRetry` — waits, then falls back;
 *   - the Slack stuck-session path (`server.ts`) — calls this on an ALREADY-LIVE
 *     session and KILLS it when the answer is not-ready.
 * A bare `false` tells that third caller "kill this" for a pane that is merely
 * mid-boot or politely waiting on a question. So the probe reports WHICH state it
 * saw and each caller applies its own policy. `isReadyPromptTail` is retained as
 * the boolean façade for callers that genuinely only want "can I type now".
 *
 * THE MENU CASE (found by the operator, 2026-07-26)
 * -------------------------------------------------
 * Claude Code paints the SAME `❯` glyph on a menu's focused option as it uses for
 * the input box (`PermissionPromptAutoResolver.SELECTOR_GLYPH`). So a session
 * sitting on a startup question read as READY. This is strictly worse than the
 * banner case: text typed at a banner is lost, but text typed at a menu is not —
 * Enter SELECTS AN OPTION, so an arriving message can answer a permission question
 * on the operator's behalf. A menu is therefore classified as its own state, never
 * as ready, no matter which glyphs it carries.
 *
 * Kept pure (text in, verdict out) so it is testable without tmux, and so the
 * regression fixtures are the literal pane text that caused each finding.
 *
 * RULE 3.1 RATIONALE (state-detection; registry:
 * `specs/provider-portability/06-state-detector-registry.md`)
 * ------------------------------------------------------------------------------
 * - **Criticality:** silent-corruption-if-wrong — the worst class, demonstrated
 *   twice. A false `ready` on a painting pane loses a user message AND writes a
 *   success line for it; a false `ready` on a menu is worse still, because Enter
 *   SELECTS an option, so an arriving message can answer a permission question on
 *   the operator's behalf.
 * - **Frequency:** per-spawn and per-inject, plus per-stuck-check on the Slack
 *   path.
 * - **Stability:** UNSTABLE. Claude Code's TUI is a private surface. This is not a
 *   theoretical rating — the 2026-07-26 incident WAS an upstream copy change (a
 *   Fable-5 promo line) turning a passing detector into a failing one, and the
 *   menu case is an upstream glyph reuse.
 * - **Fallback:** partial and asymmetric. The spawn path has an extended wait and
 *   a blind-inject-if-alive fallback; the loss on 2026-07-26 was caught only by
 *   the start hook's unanswered-message backstop, which is an unrelated path and
 *   cannot be relied on as this detector's safety net. The Slack path's not-ready
 *   branch is DESTRUCTIVE (kill + respawn), so a wrong answer there costs a live
 *   session, not a delay.
 * - **→ Verdict: deterministic + canary REQUIRED.** This module ships the
 *   deterministic half plus regression fixtures carrying the literal pane text of
 *   both known failures. It does NOT ship a canary, so it detects the two shapes
 *   that already bit us and not the next drift. Canary tracked as CMT-1044.
 *   <!-- tracked: CMT-1044 -->
 */

/**
 * What a captured pane tail shows.
 *
 * - `ready`        — an input surface is drawn and accepting input.
 * - `menu`         — a numbered selection menu is focused. NOT ready, and NOT a
 *                    stuck session: something is waiting on an answer. A caller
 *                    that kills on not-ready must not kill on this.
 * - `not-ready`    — no input surface found (typically still painting).
 */
export type PaneReadiness = 'ready' | 'menu' | 'not-ready';

/**
 * Status-bar / footer strings that only exist once the TUI has finished starting.
 *
 * Sourced from the probes already trusted for this elsewhere in the tree
 * (`SessionReaper`, the interactive-pool adapter config) rather than invented
 * here, so the readiness question gets one vocabulary instead of four. Verified
 * absent from the boot banner. `bypass permissions` alone covered only ONE of
 * Claude Code's permission-mode footers — a session in auto-accept mode shows
 * none of it — which is why the `❯`-is-always-present assumption was load-bearing
 * before and is not now.
 */
const AT_PROMPT_FOOTERS = [
  'bypass permissions',
  '? for shortcuts',
  'shift+tab to cycle',
  'auto-accept edits',
];

/**
 * A menu option line: an optional glyph run, then `N.` or `N)` and a label.
 * Matches the shape Claude Code uses for approval / consent / trust prompts.
 */
const MENU_OPTION_RE = /^[^\w\n]{0,4}\s*\d+[.)]\s+\S/;

/** The selector cursor Claude Code paints on the focused option — and on nothing else. */
const SELECTOR_GLYPH = '❯';

/**
 * True when the tail shows a FOCUSED selection menu.
 *
 * Requires the selector glyph to sit ON a numbered option line, AND at least two
 * numbered option lines overall. Both halves are load-bearing:
 *
 *   - "glyph on the option line" separates a menu from the input box. The box
 *     renders `❯` alone on its own line; a menu renders `❯ 1. Yes`. Testing only
 *     "the tail contains ❯ somewhere" would classify ordinary assistant output
 *     that happens to list `1.` and `2.` above the prompt as a menu, stalling a
 *     genuinely ready session — an over-block on the inject path.
 *   - "at least two options" separates a menu from a single numbered line of
 *     ordinary output.
 *
 * This mirrors `PermissionPromptAutoResolver`'s requirement (a line whose lead
 * glyphs contain ❯ whose text is `N.` + a label) rather than inventing a second,
 * divergent notion of what a menu looks like.
 */
export function tailShowsMenu(tail: string): boolean {
  if (!tail || !tail.includes(SELECTOR_GLYPH)) return false;
  let options = 0;
  let glyphOnOption = false;
  for (const line of tail.split('\n')) {
    if (!MENU_OPTION_RE.test(line)) continue;
    options++;
    if (line.includes(SELECTOR_GLYPH)) glyphOnOption = true;
  }
  return glyphOnOption && options >= 2;
}

/**
 * Classify a captured pane tail.
 *
 * `tail` is the joined last-N non-blank lines of a `capture-pane` read. Never pass
 * the whole scrollback: a banner that has scrolled far above the prompt is not
 * evidence either way, and older content only adds false-positive surface.
 */
export function classifyPaneReadiness(tail: string): PaneReadiness {
  if (!tail) return 'not-ready';

  // A menu is checked FIRST and wins over every positive marker below, because it
  // carries the same `❯` the input box does. Typing here selects an option.
  if (tailShowsMenu(tail)) return 'menu';

  // The framework prompt character. Codex uses ›; keeping this probe Claude-only
  // previously delayed continuation bootstraps to the full timeout.
  if (tail.includes(SELECTOR_GLYPH) || tail.includes('›')) return 'ready';

  // Footer/status-bar strings that only render once the TUI is up.
  if (AT_PROMPT_FOOTERS.some(marker => tail.includes(marker))) return 'ready';

  return 'not-ready';
}

/**
 * Boolean façade: can text be typed into this pane right now?
 *
 * A menu answers `false` — correct for every caller that is about to type. A
 * caller whose not-ready branch is DESTRUCTIVE (kill/respawn) must use
 * `classifyPaneReadiness` instead and leave a `menu` pane alone.
 */
export function isReadyPromptTail(tail: string): boolean {
  return classifyPaneReadiness(tail) === 'ready';
}

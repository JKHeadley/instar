/**
 * Startup of a CONFINED Claude Code session on the interactive (subscription) lane
 * (docs/specs/confined-spawn-subscription-reroute.md, D2).
 *
 * `claude -p` skips the workspace trust dialog; an interactive launch does not. The rerouted lane's
 * generic delivery would type into that dialog, and its Enter selects `No, exit`. Neither measured
 * dialog has numbered options, so the generic menu detector (`tailShowsMenu`) reads both as a READY
 * prompt. So a confined session's startup is driven only by this module:
 *
 * - `classifyConfinedStartupPane` is the DETECTOR: it names what the pane shows.
 * - `stepConfinedStartup` is the AUTHORITY: a deterministic floor whose whole action space is
 *   "answer the trust dialog for this exact workspace with its verified `Yes`", "accept the browser
 *   offer's focused safe default", "wait without a key", "type the one fixed line", or "fail".
 *   Anything not matched exactly fails closed. Pure: no I/O, no clock; the caller passes `now`.
 *
 * Fixtures are the panes measured on Claude Code 2.1.300 / 2.1.303 (2026-10-19). A reworded dialog
 * lands in `dialog-unknown`: a visible failure, never a wrong answer.
 */

import { tailShowsMenu } from './claudeReadinessProbe.js';

export type ConfinedStartupObservation = 'trust-dialog' | 'browser-offer' | 'dialog-unknown' | 'ready' | 'starting';

export const TRUST_QUESTION = 'Is this a project you created or one you trust';
export const TRUST_YES = 'Yes, I trust this folder';
export const TRUST_NO = 'No, exit';
export const BROWSER_OFFER = 'Claude in Chrome extension detected';
export const BROWSER_SAFE_DEFAULT = 'No, keep browser tools off';
/** The footer Claude Code renders only in `--permission-mode dontAsk` — live proof the confined mode is active. */
export const CONFINED_FOOTER = "don't ask on";
const DIALOG_AFFORDANCES = [/Enter to confirm/i, /Esc to cancel/i, /Esc to keep/i];

/**
 * Whole-session startup budget, and the per-transition budgets (spec D2). The whole-run budget is the
 * reroute's measured ready-gate worst case (~90 s, june15-headless-spawn-reroute) plus 30 s for two
 * dialogs; the per-transition budgets and the 500 ms poll come from the 2026-10-19 measurements
 * (a dialog redraws within one poll; a dismissal within ~2 s).
 */
export const CONFINED_STARTUP_BUDGET_MS = 120_000;
export const TRUST_FOCUS_BUDGET_MS = 5_000;
export const DIALOG_DISMISSAL_BUDGET_MS = 10_000;

/**
 * True when the pane shows EXACTLY `workspace` as a whole path: one trimmed line equal to it, or up
 * to four consecutive trimmed lines that join to it (a path wrapped by a narrow pane). A path that
 * merely STARTS with the workspace (`…-a1-publish`) does not match.
 */
export function namesExactPath(pane: string, workspace: string): boolean {
  if (!workspace.startsWith('/') || workspace.length < 2 || /\s/.test(workspace)) return false;
  const lines = pane.split('\n').map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    let joined = '';
    for (let j = i; j < Math.min(lines.length, i + 4); j++) {
      joined += lines[j];
      if (joined === workspace) return true;
      if (!workspace.startsWith(joined)) break;
    }
  }
  return false;
}

/** The text after the selector glyph on the focused line, or null when no line carries one. */
export function focusedOption(pane: string): string | null {
  for (const line of pane.split('\n')) {
    const at = line.indexOf('❯');
    if (at < 0) continue;
    const text = line.slice(at + 1).trim();
    if (text) return text;
  }
  return null;
}

const OTHER_MODE_FOOTER = /bypass permissions on|accept edits on|plan mode on|auto mode on/i;
/** Text that means the CLI cannot run at all (login expired/missing): named distinctly in reports. */
const isRule = (line: string): boolean => /^\s*─{20,}\s*$/.test(line);

/**
 * The POSITIVE composer shape (measured on 2.1.300/2.1.303, idle and working): the confined
 * `don't ask on` footer, directly above it a rule, above that the `❯` input line, above that another
 * rule. A dialog or overlay does not draw this frame, so `ready` never rests on absence alone.
 */
export function showsComposer(lines: string[]): boolean {
  const footer = lines.findIndex((l) => l.includes(CONFINED_FOOTER));
  if (footer < 3) return false; // needs rule, input, rule above it
  if (!isRule(lines[footer - 1])) return false;
  // The input may wrap onto several lines; walk up to the rule that opens the composer.
  for (let i = footer - 2; i >= 0 && i >= footer - 8; i--) {
    if (isRule(lines[i])) return i < footer - 2 && lines[i + 1].trimStart().startsWith('❯');
  }
  return false;
}

/** True when the screen shows any permission mode other than the confined `dontAsk`. */
export function showsOtherPermissionMode(pane: string): boolean { return OTHER_MODE_FOOTER.test(pane); }

export const LOGIN_REQUIRED = /Please run \/login|Not logged in|Invalid API key|OAuth token has expired/i;

/**
 * Name what a confined session's VISIBLE screen shows during startup. `workspace` is the exact
 * absolute cwd. Precedence (spec D2): unsafe or conflicting first, then one coherent known dialog
 * with its focused option, then any other dialog, then the confined ready prompt.
 */
export function classifyConfinedStartupPane(pane: string, workspace: string): ConfinedStartupObservation {
  if (!pane || !pane.trim()) return 'starting';
  // 1. Unsafe: a footer of any other permission mode means this is not a confined session.
  if (OTHER_MODE_FOOTER.test(pane)) return 'dialog-unknown';
  const trustMarker = pane.includes(TRUST_QUESTION);
  const browserMarker = pane.includes(BROWSER_OFFER);
  // 2. Conflicting: two dialogs at once is not a state we have measured.
  if (trustMarker && browserMarker) return 'dialog-unknown';
  // 3. One coherent known dialog (the path may wrap: whitespace-insensitive exact match).
  if (trustMarker) {
    return pane.includes(TRUST_YES) && namesExactPath(pane, workspace) ? 'trust-dialog' : 'dialog-unknown';
  }
  if (browserMarker) return pane.includes(BROWSER_SAFE_DEFAULT) ? 'browser-offer' : 'dialog-unknown';
  // 4. Any other dialog or numbered menu.
  if (DIALOG_AFFORDANCES.some((re) => re.test(pane))) return 'dialog-unknown';
  const lines = pane.split('\n').filter((l) => l.trim());
  if (tailShowsMenu(lines.slice(-6).join('\n'))) return 'dialog-unknown';
  if (LOGIN_REQUIRED.test(pane)) return 'dialog-unknown';
  // 5. The confined ready prompt: the dontAsk footer (proof G2 is live) plus a prompt glyph.
  if (showsComposer(lines)) return 'ready';
  return 'starting';
}

export type ConfinedStartupPhase =
  | 'starting'
  | 'awaiting-trust-focus'
  | 'awaiting-trust-dismissal'
  | 'awaiting-browser-dismissal'
  | 'delivered'
  | 'failed';

export interface ConfinedStartupState {
  phase: ConfinedStartupPhase;
  startedAt: number;
  phaseStartedAt: number;
  answeredTrust: boolean;
  answeredBrowser: boolean;
  /** A `dialog-unknown` seen on the previous frame: one more consecutive one fails (a half-drawn frame must not kill). */
  unknownPending?: boolean;
  /** Set on `failed`: the rule that refused and what was observed. */
  failure?: { rule: string; observation: ConfinedStartupObservation };
}

export type ConfinedStartupAction =
  | { kind: 'keys'; keys: Array<'Down' | 'Enter'> }
  | { kind: 'type-line' }
  | { kind: 'wait' }
  | { kind: 'fail' };

export function initialConfinedStartupState(now: number): ConfinedStartupState {
  return { phase: 'starting', startedAt: now, phaseStartedAt: now, answeredTrust: false, answeredBrowser: false };
}

const fail = (state: ConfinedStartupState, rule: string, observation: ConfinedStartupObservation): { state: ConfinedStartupState; action: ConfinedStartupAction } =>
  ({ state: { ...state, phase: 'failed', failure: { rule, observation } }, action: { kind: 'fail' } });

const enter = (state: ConfinedStartupState, phase: ConfinedStartupPhase, now: number, patch: Partial<ConfinedStartupState> = {}): ConfinedStartupState =>
  ({ ...state, ...patch, phase, phaseStartedAt: now });

/**
 * One step of the startup state machine (spec D2 table). Repeated identical frames never produce a
 * key; each dialog is answered at most once; nothing is ever answered after delivery.
 */
export function stepConfinedStartup(state: ConfinedStartupState, pane: string, workspace: string, now: number): { state: ConfinedStartupState; action: ConfinedStartupAction } {
  if (state.phase === 'delivered' || state.phase === 'failed') return { state, action: { kind: 'wait' } };
  const observation = classifyConfinedStartupPane(pane, workspace);
  const inPhase = now - state.phaseStartedAt;
  if (now - state.startedAt > CONFINED_STARTUP_BUDGET_MS) return fail(state, 'startup-budget-exhausted', observation);

  switch (state.phase) {
    case 'starting':
      if (observation !== 'dialog-unknown' && state.unknownPending) state = { ...state, unknownPending: false };
      if (observation === 'starting') return { state, action: { kind: 'wait' } };
      if (observation === 'ready') return { state: enter(state, 'delivered', now), action: { kind: 'type-line' } };
      if (observation === 'trust-dialog') {
        if (state.answeredTrust) return fail(state, 'trust-dialog-reappeared', observation);
        return { state: enter(state, 'awaiting-trust-focus', now, { answeredTrust: true }), action: { kind: 'keys', keys: ['Down'] } };
      }
      if (observation === 'browser-offer') {
        if (state.answeredBrowser) return fail(state, 'browser-offer-reappeared', observation);
        if (focusedOption(pane) !== BROWSER_SAFE_DEFAULT) return fail(state, 'browser-offer-focus-not-safe-default', observation);
        return { state: enter(state, 'awaiting-browser-dismissal', now, { answeredBrowser: true }), action: { kind: 'keys', keys: ['Enter'] } };
      }
      // A TUI redraw can show a half-drawn dialog for one frame: fail only on two in a row.
      if (!state.unknownPending) return { state: { ...state, unknownPending: true }, action: { kind: 'wait' } };
      return fail(state, 'unrecognised-startup-dialog', observation);

    case 'awaiting-trust-focus': {
      if (inPhase > TRUST_FOCUS_BUDGET_MS) return fail(state, 'trust-focus-not-confirmed', observation);
      if (observation !== 'trust-dialog') return fail(state, 'trust-dialog-vanished-before-confirm', observation);
      const focus = focusedOption(pane);
      if (focus === TRUST_YES) return { state: enter(state, 'awaiting-trust-dismissal', now), action: { kind: 'keys', keys: ['Enter'] } };
      // The stale focus (Down not yet rendered): wait, sending nothing. Any OTHER focused line is a deviation.
      if (focus === TRUST_NO) return { state, action: { kind: 'wait' } };
      return fail(state, 'trust-focus-unexpected-option', observation);
    }

    case 'awaiting-trust-dismissal':
    case 'awaiting-browser-dismissal': {
      const same = state.phase === 'awaiting-trust-dismissal' ? 'trust-dialog' : 'browser-offer';
      // The state's own deadline is evaluated before its observation rules.
      if (inPhase > DIALOG_DISMISSAL_BUDGET_MS) return fail(state, `${same}-not-dismissed`, observation);
      if (observation === same || observation === 'starting') return { state, action: { kind: 'wait' } };
      // The dialog is gone: back to `starting`, and evaluate this same frame there.
      return stepConfinedStartup(enter(state, 'starting', now), pane, workspace, now);
    }
  }
  return fail(state, 'unreachable-phase', observation);
}

/** The ONLY text ever typed into a confined interactive session (spec D1). */
export function confinedPromptLine(promptPath: string): string {
  // Typed literally (no Enter in the text) into a line that starts with "Your", so nothing in it can
  // be a slash command; only a control character (newline, escape) could act as input. Printable
  // ASCII only — a space in an agent home is fine.
  if (!/^\/[\x20-\x7E]+$/.test(promptPath)) throw new Error('confinement-adapter-missing: the prompt file path is not a printable absolute path');
  return `Your task is in ${promptPath}. Read that file with the Read tool and follow it exactly.`;
}

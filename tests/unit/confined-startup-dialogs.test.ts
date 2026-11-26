/**
 * Confined interactive startup (docs/specs/confined-spawn-subscription-reroute.md D2): the pane
 * classifier (detector) and the startup state machine (authority). Frames below are the panes
 * measured 2026-10-19 on Claude Code 2.1.300 / 2.1.303 with the confined argv, in a fresh executor
 * workspace. Neither dialog has numbered options — the generic `tailShowsMenu` reads both as READY,
 * which is why this classifier exists.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyConfinedStartupPane, stepConfinedStartup, initialConfinedStartupState, focusedOption, confinedPromptLine,
  CONFINED_STARTUP_BUDGET_MS, TRUST_FOCUS_BUDGET_MS, DIALOG_DISMISSAL_BUDGET_MS,
} from '../../src/core/confinedStartupDialogs.js';
import { isReadyPromptTail } from '../../src/core/claudeReadinessProbe.js';

const WS = '/Users/dabombstudio/.instar/agents/echo/.worktrees/feedback-preflight-canary-a1';
const RULE = '─'.repeat(120);

const TRUST_NO_FOCUSED = [
  RULE,
  ' Accessing workspace:',
  '',
  ` ${WS}`,
  '',
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this",
  ' folder first.',
  '',
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' Security guide',
  '',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');
const TRUST_YES_FOCUSED = TRUST_NO_FOCUSED.replace(' ❯ No, exit\n   Yes, I trust this folder', '   No, exit\n ❯ Yes, I trust this folder');

const BROWSER_OFFER = [
  RULE,
  '  Claude in Chrome extension detected',
  '',
  '  Claude will use your Chrome browser by default — navigating sites, filling forms, and capturing screenshots in your existing session.',
  "  This session is in Don't Ask mode, so browser actions that need approval are skipped rather than prompted. Turn browser tools off for future sessions with /chrome.",
  '',
  '  ❯ No, keep browser tools off',
  '    Yes, use my browser',
  '',
  '  Enter to confirm · Esc to keep browser tools off',
].join('\n');

const READY = [
  ' ▐▛███▛█   Claude Code v2.1.303',
  '▝▜██████▀  Opus 5.5 · Claude Max',
  ' ▝▝   ▝▝   ~/.instar/agents/echo/.worktrees/feedback-preflight-canary-a1',
  RULE,
  '❯ Try "fix typecheck errors"',
  RULE,
  "  ⏵⏵ don't ask on (shift+tab to cycle) · ← for agents",
].join('\n');

/** Measured 2026-10-19 (2.1.303) 0.3 s after submitting a task: the dontAsk footer stays, with `esc to interrupt`. */
const WORKING = [
  '✳ Noodling…',
  RULE,
  '❯ ',
  RULE,
  "  ⏵⏵ don't ask on (shift+tab to cycle) · esc to interrupt · ← for agents",
].join('\n');

describe('classifyConfinedStartupPane — measured frames', () => {
  it('the measured post-submit (working) frame still shows the confined mode and no dialog', () => {
    expect(classifyConfinedStartupPane(WORKING, WS)).toBe('ready');
  });
  it('the generic readiness probe misreads the trust dialog as ready (why this module exists)', () => {
    expect(isReadyPromptTail(TRUST_NO_FOCUSED.split('\n').filter((l) => l.trim()).slice(-6).join('\n'))).toBe(true);
  });
  it('classifies trust, browser offer and ready', () => {
    expect(classifyConfinedStartupPane(TRUST_NO_FOCUSED, WS)).toBe('trust-dialog');
    expect(classifyConfinedStartupPane(BROWSER_OFFER, WS)).toBe('browser-offer');
    expect(classifyConfinedStartupPane(READY, WS)).toBe('ready');
    expect(classifyConfinedStartupPane('', WS)).toBe('starting');
  });
  it('a wrapped workspace path still matches', () => {
    const wrapped = TRUST_NO_FOCUSED.replace(` ${WS}`, ` ${WS.slice(0, 40)}\n${WS.slice(40)}`);
    expect(classifyConfinedStartupPane(wrapped, WS)).toBe('trust-dialog');
  });
  it('a trust dialog naming a DIFFERENT path is unknown', () => {
    expect(classifyConfinedStartupPane(TRUST_NO_FOCUSED, '/Users/someone/elsewhere')).toBe('dialog-unknown');
    expect(classifyConfinedStartupPane(TRUST_NO_FOCUSED, WS.slice(0, -3))).toBe('dialog-unknown'); // a prefix of the shown path
    expect(classifyConfinedStartupPane(TRUST_NO_FOCUSED.replace(` ${WS}`, ` ${WS}-publish`), WS)).toBe('dialog-unknown'); // shown path extends ours
  });
  it('the ToS consent menu, a rate-limit menu, an unknown dialog, a login prompt and mixed frames are unknown', () => {
    const tos = 'Do you accept the terms?\n ❯ 1. No, exit\n   2. Yes, I accept\n Enter to confirm';
    const rate = "  What do you want to do?\n  ❯ 1. Stop and wait for limit to reset\n    2. Wait here, then continue automatically\n  Enter to confirm · Esc to cancel";
    const unknown = '  Something new\n  ❯ Maybe\n    Perhaps\n  Enter to confirm · Esc to cancel';
    const login = `${READY}\n  Please run /login to continue`;
    for (const frame of [tos, rate, unknown, login, `${TRUST_NO_FOCUSED}\n${BROWSER_OFFER}`]) {
      expect(classifyConfinedStartupPane(frame, WS)).toBe('dialog-unknown');
    }
  });
  it('a ready prompt in any other permission mode is never ready', () => {
    expect(classifyConfinedStartupPane(READY.replace("don't ask on", 'bypass permissions on'), WS)).toBe('dialog-unknown');
    expect(classifyConfinedStartupPane(READY.replace(/  ⏵⏵.*$/m, ''), WS)).toBe('starting');
    // Footer and glyph alone are not enough: an overlay without the composer frame is not ready.
    expect(classifyConfinedStartupPane("  Some overlay\n  ❯ something\n  ⏵⏵ don't ask on (shift+tab to cycle)", WS)).toBe('starting');
  });
  it('reads the focused option', () => {
    expect(focusedOption(TRUST_NO_FOCUSED)).toBe('No, exit');
    expect(focusedOption(TRUST_YES_FOCUSED)).toBe('Yes, I trust this folder');
    expect(focusedOption(BROWSER_OFFER)).toBe('No, keep browser tools off');
  });
});

describe('stepConfinedStartup — the authority', () => {
  type Frame = string;
  /** Drive the machine over frames at 500 ms intervals; collect every action. */
  function run(frames: Frame[], t0 = 1_000) {
    let state = initialConfinedStartupState(t0);
    const actions: string[] = [];
    frames.forEach((frame, i) => {
      const step = stepConfinedStartup(state, frame, WS, t0 + (i + 1) * 500);
      state = step.state;
      actions.push(step.action.kind === 'keys' ? `keys:${step.action.keys.join('+')}` : step.action.kind);
    });
    return { state, actions };
  }

  it('trust → browser offer → ready types the fixed line once', () => {
    const { state, actions } = run(['', TRUST_NO_FOCUSED, TRUST_YES_FOCUSED, TRUST_YES_FOCUSED, '', BROWSER_OFFER, BROWSER_OFFER, READY, READY]);
    expect(actions).toEqual(['wait', 'keys:Down', 'keys:Enter', 'wait', 'wait', 'keys:Enter', 'wait', 'type-line', 'wait']);
    expect(state.phase).toBe('delivered');
  });
  it('an unchanged frame while focus moves sends no extra key', () => {
    const { actions } = run([TRUST_NO_FOCUSED, TRUST_NO_FOCUSED, TRUST_NO_FOCUSED, TRUST_YES_FOCUSED]);
    expect(actions).toEqual(['keys:Down', 'wait', 'wait', 'keys:Enter']);
  });
  it('an unexpected focused option after Down fails at once; the stale No focus waits', () => {
    let state = initialConfinedStartupState(0);
    state = stepConfinedStartup(state, TRUST_NO_FOCUSED, WS, 500).state;
    expect(stepConfinedStartup(state, TRUST_NO_FOCUSED, WS, 1000).action.kind).toBe('wait');
    const odd = TRUST_NO_FOCUSED.replace(' ❯ No, exit', ' ❯ Something else');
    const step = stepConfinedStartup(state, odd, WS, 1500);
    expect(step.action.kind).toBe('fail');
    expect(step.state.failure?.rule).toBe('trust-focus-unexpected-option');
  });
  it('focus that never reaches Yes fails without pressing Enter', () => {
    let state = initialConfinedStartupState(0);
    state = stepConfinedStartup(state, TRUST_NO_FOCUSED, WS, 500).state;
    const step = stepConfinedStartup(state, TRUST_NO_FOCUSED, WS, 500 + TRUST_FOCUS_BUDGET_MS + 1);
    expect(step.action.kind).toBe('fail');
    expect(step.state.failure?.rule).toBe('trust-focus-not-confirmed');
  });
  it('a dialog that reappears after its dismissal fails', () => {
    // Trust answered and dismissed (the browser offer replaced it), then the trust dialog comes back.
    const { state } = run([TRUST_NO_FOCUSED, TRUST_YES_FOCUSED, BROWSER_OFFER, TRUST_NO_FOCUSED]);
    expect(state.phase).toBe('failed');
    expect(state.failure?.rule).toBe('trust-dialog-reappeared');
  });
  it('a dialog that is never dismissed fails at its budget', () => {
    let state = initialConfinedStartupState(0);
    state = stepConfinedStartup(state, BROWSER_OFFER, WS, 500).state;
    expect(state.phase).toBe('awaiting-browser-dismissal');
    const step = stepConfinedStartup(state, BROWSER_OFFER, WS, 500 + DIALOG_DISMISSAL_BUDGET_MS + 1);
    expect(step.state.failure?.rule).toBe('browser-offer-not-dismissed');
  });
  it('a browser offer whose focus is not the safe default fails', () => {
    const unsafe = BROWSER_OFFER.replace('  ❯ No, keep browser tools off\n    Yes, use my browser', '    No, keep browser tools off\n  ❯ Yes, use my browser');
    const { state, actions } = run([unsafe]);
    expect(actions).toEqual(['fail']);
    expect(state.failure?.rule).toBe('browser-offer-focus-not-safe-default');
  });
  it('an unknown dialog fails on two consecutive frames; one half-drawn frame does not kill; the budget fails a session that never becomes ready', () => {
    const unknown = '  Something new\n  ❯ Maybe\n    Perhaps\n  Enter to confirm';
    expect(run([unknown]).state.phase).toBe('starting');
    expect(run([unknown, unknown]).state.failure?.rule).toBe('unrecognised-startup-dialog');
    const halfDrawnTrust = TRUST_NO_FOCUSED.replace('   Yes, I trust this folder', '');
    const recovered = run([halfDrawnTrust, TRUST_NO_FOCUSED]);
    expect(recovered.actions).toEqual(['wait', 'keys:Down']);
    const step = stepConfinedStartup(initialConfinedStartupState(0), '', WS, CONFINED_STARTUP_BUDGET_MS + 1);
    expect(step.state.failure?.rule).toBe('startup-budget-exhausted');
  });
  it('nothing is ever answered after delivery', () => {
    const { state } = run([READY]);
    expect(state.phase).toBe('delivered');
    expect(stepConfinedStartup(state, TRUST_NO_FOCUSED, WS, 9_999).action.kind).toBe('wait');
  });
});

describe('confinedPromptLine (D1)', () => {
  it('is built only from a plain absolute path and carries no sentinel piece', () => {
    const line = confinedPromptLine('/a/b/.worktrees/feedback-x-a1-tmp/confined-prompt-0f8c.md');
    expect(line).toBe('Your task is in /a/b/.worktrees/feedback-x-a1-tmp/confined-prompt-0f8c.md. Read that file with the Read tool and follow it exactly.');
    expect(line).not.toMatch(/INSTAR_JOB_COMPLETE/);
  });
  it('accepts a printable path with a space (common on macOS)', () => {
    expect(confinedPromptLine('/Users/a b/.worktrees/x-tmp/p.md')).toContain('/Users/a b/');
  });
  it('refuses anything that could carry REPL input', () => {
    for (const bad of ['relative/path.md', '/a/b\n/permissions', '/a/b\u001b[201~.md', '/a/b\r.md']) {
      expect(() => confinedPromptLine(bad)).toThrow(/confinement-adapter-missing/);
    }
  });
});

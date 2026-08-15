/**
 * Unit — the always-on permission floor must not be BLIND to grok's approval menu.
 *
 * THE LIVE FAILURE THIS PINS (2026-08-15). A grok-build agent was driven a real
 * task, hit its first tool approval, and froze. The resolver — which ships as an
 * unconditional safety floor whose stated contract is that it "never freezes
 * silently" — emitted NOTHING: no auto-answer, and no attention item either. Its
 * audit file did not exist and the agent's attention queue held zero items while
 * the session sat wedged.
 *
 * The reason is the sharpest shape in this codebase: **the escalation fires when a
 * menu is DETECTED and declined. An UNDETECTED menu is indistinguishable from no
 * menu**, so the alarm is silent exactly where the floor is blind. Every structural
 * detector missed grok — no `N. ` options (it uses `N (●)` radios), no `❯` selector,
 * no "Esc to cancel", no "Do you want to proceed".
 *
 * SCOPE, deliberately narrow: this covers DETECTION only (Layer 3 — raise one
 * notice), NOT auto-answering. Auto-approving grok tool calls is a real authority
 * change: the grok-build spec deliberately withholds `--always-approve` until the
 * interactive lane's confinement is proven to the bar the one-shot lane meets. So
 * the silent half is closed here; the answering half stays an operator decision.
 */

import { describe, it, expect } from 'vitest';
import {
  detectPersistingMenu,
  toPaneTailLines,
  APPROVAL_PROMPT_SIGNATURES,
} from '../../src/monitoring/PermissionPromptAutoResolver.js';

/**
 * The REAL pane tail, transcribed from the live wedge. Kept verbatim (including
 * grok's box-drawing lead glyphs) because a hand-idealised fixture is how a
 * detector comes to pass against a shape production never emits — the failure
 * this branch caught in its own live-proof earlier the same day.
 */
const GROK_APPROVAL_TAIL = [
  '  ┃  Find instar source repo from config',
  "  ┃  python3 - <<'PY'",
  '  ┃  import json',
  '  ┃  ... Ctrl-F to expand',
  '  ┃',
  "  ┃  1 (●) Yes, and don't ask again for anything (always-approve mode)",
  '  ┃  2 (○) Yes, proceed',
  '  ┃  3 (○) No, reject (type to add feedback)',
  '  ┃',
  '  1/3:select  │  Tab:next option  │  Ctrl+f:expand  │  Ctrl+o:always-approve  │  Ctrl+c:cancel  │  Esc:scrollback',
].join('\n');

/** A claude-code menu — the shape that already worked, as a no-regression control. */
const CLAUDE_APPROVAL_TAIL = [
  '  Compound command contains cd with output redirection — manual approval required',
  '  Do you want to proceed?',
  '  ❯ 1. Yes',
  '    2. No',
  '  Esc to cancel',
].join('\n');

describe('permission floor — grok-build approval menu is DETECTED', () => {
  it('detects grok\'s radio-option approval menu (the live wedge)', () => {
    const match = detectPersistingMenu(toPaneTailLines(GROK_APPROVAL_TAIL), false);
    expect(match, 'grok approval menu must be detected so the floor can escalate').not.toBeNull();
    // All three options participate in the structure key.
    expect(match!.optionLabels.length).toBe(3);
  });

  it('CONTROL: still detects the claude-code menu (no regression)', () => {
    const match = detectPersistingMenu(toPaneTailLines(CLAUDE_APPROVAL_TAIL), false);
    expect(match).not.toBeNull();
  });

  it('CONTROL: stays silent while the pane is generating', () => {
    // A menu mid-generation is not a wedge — the floor must not cry wolf on a
    // session that is still working.
    expect(detectPersistingMenu(toPaneTailLines(GROK_APPROVAL_TAIL), true)).toBeNull();
  });

  it('grok-build is NOT registered for auto-ANSWER — the same keystroke is a different act', () => {
    // This is the guard that makes the comment in the resolver load-bearing
    // instead of advisory. Registering a grok-build signature in this table is
    // the ONE-LINE change that turns auto-answering on, and it looks like the
    // obvious completion of the detection fix.
    //
    // It is not. The resolver answers by sending Enter. On claude-code that is
    // option 1 = "Yes", approving THE CALL IN FRONT OF IT. On grok, the
    // pre-selected option 1 is "Yes, and don't ask again for ANYTHING" — the
    // approve-once equivalent is option 2, which is not where the cursor starts.
    // So the same key grants a single approval on one framework and a standing
    // session-wide approval on the other.
    //
    // Whoever removes this test must first decide, WITH THE OPERATOR, that the
    // floor may hand out standing tool approval — and must fix the keystroke,
    // because Enter cannot be the answer for grok whichever way the TUI commits.
    expect(Object.keys(APPROVAL_PROMPT_SIGNATURES)).not.toContain('grok-build');
  });

  it('CONTROL: the table is real and populated (so the assertion above is not vacuous)', () => {
    // Without this, an empty or renamed table would satisfy the negative check
    // while proving nothing — the "passing condition narrower than what it
    // certifies" shape. At least one framework must genuinely be registered.
    const keys = Object.keys(APPROVAL_PROMPT_SIGNATURES);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toContain('claude-code');
  });

  it('CONTROL: does not fire on ordinary numbered prose', () => {
    // The radio glyphs are what make the widened matcher safe; plain enumerated
    // text must not read as a blocking menu.
    const prose = [
      'Here are the steps:',
      '1. read the file',
      '2. write the patch',
      'and that is the plan.',
    ].join('\n');
    expect(detectPersistingMenu(toPaneTailLines(prose), false)).toBeNull();
  });
});

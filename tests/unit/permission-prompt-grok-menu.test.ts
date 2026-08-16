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
 * SCOPE — WIDENED 2026-08-16 on an explicit operator decision. This originally
 * covered DETECTION only, because auto-approving grok tool calls is a real
 * authority change and the answering half was left to the operator. Justin made
 * that call: "yes we need the auto-answering feature on and working. It should be
 * intelligent enough to select the correct answer."
 *
 * "Intelligent" is the load-bearing word, and it rules out both obvious
 * implementations. Pressing Enter is wrong: Enter commits whatever row the dot
 * rests on, the dot starts on grok's row 1, and row 1 is a USER-GLOBAL persisted
 * always-approve grant — so an Enter floor would disable approval for the whole
 * machine on a session's first prompt. Hardcoding "press 2" is also wrong: the
 * grok agent's own account of its menu warns the order shifts when optional rows
 * appear. So the floor reads the option LABELS, presses the row meaning "approve
 * THIS call", positively excludes any row meaning "always", and DECLINES rather
 * than guesses when the menu is ambiguous or an unfamiliar shape.
 */

import { describe, it, expect } from 'vitest';
import {
  detectPersistingMenu,
  detectApprovalPrompt,
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

  it('ANSWERS grok by the allow-once DIGIT — never Enter, never the always row', () => {
    // Operator decision (Justin, 2026-08-16): auto-answering must be on for grok,
    // "intelligent enough to select the correct answer". So the floor no longer
    // declines — but what it presses is chosen by LABEL.
    const m = detectApprovalPrompt(toPaneTailLines(GROK_APPROVAL_TAIL), 'grok-build', false);
    expect(m).not.toBeNull();
    // Row 2 is "Yes, proceed" — approve THIS call.
    expect(m!.approveKey).toBe('2');
    // The two answers that must never be sent: Enter follows the dot, which
    // starts on row 1; row 1 is the machine-wide, persisted always-approve grant.
    expect(m!.approveKey).not.toBe('Enter');
    expect(m!.approveKey).not.toBe('1');
  });

  it('is NOT positional — a reordered menu still answers the allow-once row', () => {
    // THE point of intent mode. The grok agent warned that the row order changes
    // when optional rows appear, so a floor hardcoded to "press 2" would be a
    // slower way of being wrong. Here allow-once sits at 3 and always-approve at
    // 2; a positional implementation would press 2 and disable approval globally.
    const reordered = [
      '  ┃  Some tool call',
      '  ┃',
      '  ┃  1 (●) No, reject (type to add feedback)',
      "  ┃  2 (○) Yes, and don't ask again for anything (always-approve mode)",
      '  ┃  3 (○) Yes, proceed',
      '  ┃',
      '  1/3:select  │  Tab:next option  │  Ctrl+c:cancel',
    ].join('\n');
    const m = detectApprovalPrompt(toPaneTailLines(reordered), 'grok-build', false);
    expect(m).not.toBeNull();
    expect(m!.approveKey).toBe('3');
  });

  it('CONTROL: declines an AMBIGUOUS menu rather than guessing', () => {
    // Two rows readable as allow-once. Failing closed hands it to Layer 3, which
    // reports an un-cleared menu — strictly better than a coin flip on a
    // permission prompt.
    const ambiguous = [
      '  ┃  Some tool call',
      "  ┃  1 (●) Yes, and don't ask again for anything (always-approve mode)",
      '  ┃  2 (○) Yes, proceed',
      '  ┃  3 (○) Yes, proceed with edits',
      '  1/3:select  │  Ctrl+c:cancel',
    ].join('\n');
    expect(detectApprovalPrompt(toPaneTailLines(ambiguous), 'grok-build', false)).toBeNull();
  });

  it('CONTROL: declines a menu with NO always-approve row (uncharacterized shape)', () => {
    // The signature was characterized against a menu that HAS the always row. A
    // menu without it is a different shape; extrapolating is how a detector comes
    // to answer something it was never verified against.
    const noAlways = [
      '  ┃  Some tool call',
      '  ┃  1 (●) Yes, proceed',
      '  ┃  2 (○) No, reject',
      '  1/2:select  │  Ctrl+c:cancel',
    ].join('\n');
    expect(detectApprovalPrompt(toPaneTailLines(noAlways), 'grok-build', false)).toBeNull();
  });

  it('CONTROL: claude-code still answers with Enter (cursor mode unchanged)', () => {
    // Intent mode is additive. The framework that already worked must be
    // byte-identical, or this change traded one framework's safety for another's.
    const m = detectApprovalPrompt(toPaneTailLines(CLAUDE_APPROVAL_TAIL), 'claude-code', false);
    expect(m).not.toBeNull();
    expect(m!.approveKey).toBe('Enter');
  });

  it('CONTROL: grok is registered, and registered WITH an intent block', () => {
    // Guards the lazy regression: registering grok without `intent` would fall
    // through to cursor mode and press Enter — the exact catastrophe this exists
    // to prevent.
    expect(Object.keys(APPROVAL_PROMPT_SIGNATURES)).toContain('grok-build');
    expect(APPROVAL_PROMPT_SIGNATURES['grok-build']!.intent).toBeDefined();
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

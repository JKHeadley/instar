/**
 * Positive-control stall-signature evidence for the claude-code stall-coverage
 * matrix (docs/frameworks/claude-code-stall-coverage.md).
 *
 * Spec: docs/specs/framework-stall-coverage-matrix.md (§2.2 evidence contract)
 *
 * Each block carries: the `stall-class: <id>` marker, a REALISTIC RAW
 * claude-code stall signature (a multi-line tmux-tail / transcript excerpt —
 * the actual text the detector matches in production), and an
 * `expectStallDetectorFires` call wiring the REAL imported detector — so the
 * test genuinely proves the detector fires on that signature. If a detector's
 * logic drifts away from its signature family, this file goes red.
 */

import { describe, it } from 'vitest';
import { classifyPromptTextPresentation } from '../../src/core/StuckInputSentinel.js';
import {
  classifyWedgeTail,
  detectAupRejection,
} from '../../src/monitoring/ContextWedgeSentinel.js';
import { classifyStuckSignature } from '../../src/monitoring/StuckSignatureClassifier.js';
import { detectContextExhaustion } from '../../src/monitoring/QuotaExhaustionDetector.js';
import {
  detectApprovalPrompt,
  toPaneTailLines,
} from '../../src/monitoring/PermissionPromptAutoResolver.js';
import { expectStallDetectorFires } from '../helpers/stallEvidence.js';

const FRAMEWORK = 'claude-code';

describe('claude-code stall-signature evidence (positive controls)', () => {
  // stall-class: input-not-draining
  it('input-not-draining: real injected text stuck at the ❯ prompt classifies as real (not ghost)', () => {
    // An ANSI capture of an idle pane: a delivered message sits at the prompt
    // at NORMAL intensity (only the footer is dim-styled) — the exact state the
    // 2026-05-11 crash-loop left three sessions in.
    const stuckPromptText = 'Please check the deploy status and report back';
    const fixture = [
      '✻ Churned for 1m 16s',
      '',
      '╭──────────────────────────────────────────────────────────────╮',
      `│ ❯ ${stuckPromptText}`,
      '╰──────────────────────────────────────────────────────────────╯',
      '  \x1b[2m⏵⏵ bypass permissions on (shift+tab to cycle)\x1b[22m',
    ].join('\n');
    expectStallDetectorFires({
      framework: FRAMEWORK,
      classId: 'input-not-draining',
      fixture,
      detect: (fixtureText) =>
        classifyPromptTextPresentation(fixtureText, stuckPromptText) === 'real',
    });
  });

  // stall-class: wedged-context
  it('wedged-context: thinking-block-400 fast-fail tail classifies as the wedge', () => {
    // The transcript-poisoned session: every resume re-sends the corrupted turn
    // and the API rejects it instantly ("Cooked for 0s") — permanently dead
    // while still emitting output (2026-05-28 signature family).
    const fixture = [
      '> continue the migration run',
      '  ⎿  API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":' +
        '"messages.121.content.2: `thinking` blocks in the latest assistant message cannot be modified. ' +
        'When `thinking` is enabled, a final `assistant` message must start with a thinking block."}}',
      '✳ Cooked for 0s',
      '> retrying the last step',
      '  ⎿  API Error: 400 messages.123.content.1: `thinking` blocks in the latest assistant message cannot be modified',
      '✳ Cooked for 0s',
    ].join('\n');
    expectStallDetectorFires({
      framework: FRAMEWORK,
      classId: 'wedged-context',
      fixture,
      detect: (fixtureText) => classifyWedgeTail(fixtureText) === 'thinking-block-400',
    });
  });

  // stall-class: policy-rejection-loop
  it('policy-rejection-loop: repeated AUP rejection tail classifies as the policy wedge', () => {
    // The AUP-rejection loop (2026-06-05 EXO 3.0 incident): every turn re-sends
    // the full conversation, so EVERY reply is rejected — the signature repeats
    // on more than one line, which is what separates the loop from a benign
    // one-off rejection.
    const fixture = [
      '> summarize the harness findings',
      '  ⎿  API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy',
      '✳ Cooked for 0s',
      '> try the summary again',
      '  ⎿  API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy',
      '✳ Cooked for 0s',
    ].join('\n');
    expectStallDetectorFires({
      framework: FRAMEWORK,
      classId: 'policy-rejection-loop',
      fixture,
      detect: (fixtureText) =>
        detectAupRejection(fixtureText) && classifyWedgeTail(fixtureText) === 'aup-rejection',
    });
  });

  // stall-class: quota-wall
  it('quota-wall: usage-limit tail classifies as rate-limited with the reset hint', () => {
    // The blocking usage-limit form Claude Code prints when it actually blocks
    // a turn — the state the honest standby surfaces instead of "actively
    // working".
    const fixture = [
      '✻ Compiling the weekly report…',
      '> keep going with the analysis',
      "You've hit your usage limit · resets 10:30pm",
    ].join('\n');
    expectStallDetectorFires({
      framework: FRAMEWORK,
      classId: 'quota-wall',
      fixture,
      detect: (fixtureText) => classifyStuckSignature(fixtureText)?.kind === 'rate-limited',
    });
  });

  // stall-class: approval-prompt-wedge
  it('approval-prompt-wedge: the cd-redirect approval menu with ❯ on Yes is detected', () => {
    // The Claude Code 2.1.176-177 hardcoded-classifier prompt: runs before all
    // permission rules, so --dangerously-skip-permissions cannot pre-answer it;
    // a remote-driven session freezes on it forever without the resolver.
    const fixture = [
      '● Bash(cd /tmp/build && npm run verify > verify.log)',
      '  Compound command contains cd with output redirection — manual approval required',
      '',
      '  Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No, and tell Claude what to do differently (esc)',
    ].join('\n');
    expectStallDetectorFires({
      framework: FRAMEWORK,
      classId: 'approval-prompt-wedge',
      fixture,
      detect: (fixtureText) =>
        detectApprovalPrompt(toPaneTailLines(fixtureText), FRAMEWORK, false) !== null,
    });
  });

  // stall-class: context-window-wall
  it('context-window-wall: the framed conversation-too-long CLI error is detected', () => {
    // The REAL exhaustion error always renders with its CLI recovery framing
    // ("Press esc twice…" / "Error during compaction") — the framing is what
    // separates a live wall from a session merely DISCUSSING the failure mode
    // (the RUN-2 2026-06-06 false-positive flood).
    const fixture = [
      '✻ Compacting conversation…',
      '  ⎿  Error during compaction: Conversation too long. Press esc twice to go up a few messages ' +
        'and try again, or use /clear to start a new conversation.',
      'Context limit reached · /compact or /clear to continue',
    ].join('\n');
    expectStallDetectorFires({
      framework: FRAMEWORK,
      classId: 'context-window-wall',
      fixture,
      detect: (fixtureText) => detectContextExhaustion(fixtureText).matched === true,
    });
  });
});

// safe-fs-allow: test file — no fs.

/**
 * Unit tests for StuckSignatureClassifier (honest turn-receipts).
 *
 * Grounded in the real 2026-06-05 incidents: a live-but-failing session was
 * reported as "actively working" because its process was alive, and stale
 * "conversation too long" text in scrollback fired as noise on healthy
 * sessions. Both are tail-gating bugs.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyStuckSignature,
  extractResetHint,
} from '../../../src/monitoring/StuckSignatureClassifier.js';

// Real pane shape — Claude usage limit blocking every turn (the EXO incident).
const RATE_LIMIT_TAIL = [
  '❯ [telegram:19437] did you get my last 3 messages?',
  "You've hit your session limit · resets 10:30pm (America/Los_Angeles)",
  '✻ Cooked for 0s',
].join('\n');

// Real pane shape — AUP-rejection loop (#888 incident), repeated.
const AUP_ERROR =
  '⏺ API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup).';
const AUP_TAIL = [
  '❯ msg one', AUP_ERROR, '✻ Churned for 8s',
  '❯ msg two', AUP_ERROR, '✻ Cogitated for 8s',
].join('\n');

// Real pane shape — thinking-block 400 wedge.
const THINKING_BLOCK_TAIL = [
  '  ⎿  API Error: 400 messages.9.content.20: `thinking` blocks in the latest assistant message cannot be modified.',
  '✻ Cooked for 0s',
].join('\n');

// Real pane shape — conversation too long, as the live tail.
const CONTEXT_TOO_LONG_TAIL = [
  '❯ continue please',
  'This conversation is too long. Press esc twice to go up a few messages and try a different approach.',
  '❯',
].join('\n');

describe('classifyStuckSignature — positive cases (the lie it ends)', () => {
  it('rate-limited: surfaces the honest reason + reset hint, assessed as self-clearing', () => {
    const r = classifyStuckSignature(RATE_LIMIT_TAIL);
    expect(r?.kind).toBe('rate-limited');
    expect(r?.message).toMatch(/usage limit/i);
    expect(r?.message).toMatch(/10:30pm/);
    expect(r?.message).toMatch(/not lost/i);
  });

  it('policy-wedge: AUP-rejection loop → fresh-session guidance', () => {
    const r = classifyStuckSignature(AUP_TAIL);
    expect(r?.kind).toBe('policy-wedge');
    expect(r?.message).toMatch(/content-policy/i);
    expect(r?.message).toMatch(/resend/i);
  });

  it('context-wedge: thinking-block 400 → fresh-session guidance', () => {
    const r = classifyStuckSignature(THINKING_BLOCK_TAIL);
    expect(r?.kind).toBe('context-wedge');
    expect(r?.message).toMatch(/stuck-context/i);
  });

  it('context-too-long: live-tail "conversation too long" → fresh-session guidance', () => {
    const r = classifyStuckSignature(CONTEXT_TOO_LONG_TAIL);
    expect(r?.kind).toBe('context-too-long');
    expect(r?.message).toMatch(/too long/i);
  });
});

describe('classifyStuckSignature — negative cases (the noise it ends)', () => {
  it('a healthy working session returns null (no false positive)', () => {
    const working = [
      '⏺ Bash(npm test)',
      '  ⎿  Running 412 tests...',
      '✻ Crunching (45s · 1.2k tokens)',
    ].join('\n');
    expect(classifyStuckSignature(working)).toBeNull();
  });

  it('STALE "conversation too long" scrolled out of the tail → null (the noise fix)', () => {
    // The phrase appears once, far up, then the session recovered and kept working.
    const recovered =
      CONTEXT_TOO_LONG_TAIL + '\n' +
      Array.from({ length: 20 }, (_, i) => `⏺ working line ${i}: real progress`).join('\n') +
      '\n✻ Crunching (12s)';
    expect(classifyStuckSignature(recovered)).toBeNull();
  });

  it('normal compaction lifecycle (not the too-long error) → null', () => {
    const compacting = [
      '❯ continue',
      'Conversation compacted. Paused for context compaction — resuming.',
      '✻ Compaction recovery in progress',
    ].join('\n');
    expect(classifyStuckSignature(compacting)).toBeNull();
  });

  it('a session merely DISCUSSING a usage limit (not blocked) → null (tail-gated)', () => {
    const discussing = [
      "⏺ I'll explain: when you hit your usage limit, the session pauses.",
      '⏺ Bash(grep -n "usage limit" src/)',
      '  ⎿  found 3 matches',
      '✻ Crunching (8s) — actively working on the explanation',
    ].join('\n');
    expect(classifyStuckSignature(discussing)).toBeNull();
  });

  it('empty / whitespace capture → null (no throw)', () => {
    expect(classifyStuckSignature('')).toBeNull();
    expect(classifyStuckSignature('   \n  ')).toBeNull();
  });
});

describe('classifyStuckSignature — precedence (most actionable wins)', () => {
  it('a wedge in the tail beats a co-present rate-limit mention', () => {
    const both = [
      "❯ you've hit your session limit · resets 11pm",
      AUP_ERROR,
      '❯ retry', AUP_ERROR,
      '✻ Cooked for 0s',
    ].join('\n');
    expect(classifyStuckSignature(both)?.kind).toBe('policy-wedge');
  });
});

describe('extractResetHint', () => {
  it('parses clock-time resets', () => {
    expect(extractResetHint('resets 10:30pm today')).toBe('10:30pm');
    expect(extractResetHint('limit resets at 9pm')).toBe('9pm');
  });
  it('parses relative resets', () => {
    expect(extractResetHint('resets in 5 minutes')).toBe('5 minutes');
    expect(extractResetHint('try again, resets in 2h')).toBe('2h');
  });
  it('returns undefined when no hint present', () => {
    expect(extractResetHint('you hit your limit')).toBeUndefined();
  });
});

describe('classifyStuckSignature — approval-prompt-waiting (framework permission floor)', () => {
  // The real Claude Code 2.1.176-177 cd-redirection prompt.
  const APPROVAL_PROMPT_TAIL = [
    'Compound command contains cd with output redirection — manual approval required',
    'to prevent path resolution bypass.',
    'Do you want to proceed?',
    '❯ 1. Yes',
    '  2. No',
    '  Esc to cancel',
  ].join('\n');

  it('names a live glyph-led approval menu as approval-prompt-waiting', () => {
    expect(classifyStuckSignature(APPROVAL_PROMPT_TAIL)?.kind).toBe('approval-prompt-waiting');
  });

  it('is PROSE-AGNOSTIC: names a drifted/unrecognized prompt whose wording changed', () => {
    // Different prose the registry does not know — but the ❯-led menu + a
    // generic affordance are present, so Layer 3 still NAMES it (drift detector).
    const drifted = [
      'Some brand-new approval wording the prose patterns do not recognize',
      '❯ 1. Allow',
      '  2. Deny',
      '  Esc to cancel',
    ].join('\n');
    expect(classifyStuckSignature(drifted)?.kind).toBe('approval-prompt-waiting');
  });

  it('does NOT fire without a blocking affordance (a bare numbered list is not a focused menu)', () => {
    const notAMenu = ['Here are the options I considered:', '❯ 1. first idea', '  2. second idea'].join('\n');
    expect(classifyStuckSignature(notAMenu)?.kind).not.toBe('approval-prompt-waiting');
  });

  it('a real rate-limit wedge still wins over an incidental menu (precedence)', () => {
    expect(classifyStuckSignature(RATE_LIMIT_TAIL)?.kind).toBe('rate-limited');
  });
});

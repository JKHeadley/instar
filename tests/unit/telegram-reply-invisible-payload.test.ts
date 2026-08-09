import { describe, it, expect } from 'vitest';

/**
 * Regression test for the invisible-payload refusal on POST /telegram/reply/:topicId.
 *
 * Earned from a live incident (2026-08-09): a peer agent's relay accepted a send whose entire
 * body was one ZERO-WIDTH SPACE, failed with a 500 carrying an EMPTY error body, burned nine
 * retries across 4h17m, and emitted a user-facing "I had a reply for you but couldn't deliver
 * it" notice for content that never existed.
 *
 * Review pass 8 then found the first fix closed U+200B but NOT the class — U+200E, U+2061,
 * U+FE0F, U+00AD and U+180E all survived a hand-enumerated character list — and that no
 * regression test had been committed. Both are addressed here.
 *
 * The predicate under test is kept in lockstep with the route by construction: it is the same
 * expression, and the BOTH-DIRECTIONS cases below are the point. A guard that only proves its
 * refusals can be over-broad and silently eat real messages.
 */
const isInvisible = (text: string): boolean =>
  text.replace(/[\s\p{Default_Ignorable_Code_Point}\p{Cf}]/gu, '').length === 0;

describe('POST /telegram/reply/:topicId — invisible payload refusal', () => {
  it('refuses the exact incident payload (a lone U+200B)', () => {
    expect(isInvisible('​')).toBe(true);
  });

  it('refuses the wider invisible class pass 8 found surviving the hand-written list', () => {
    for (const ch of ['‎', '⁡', '️', '­', '᠎', '⁢', '‌', '‍', '⁠', '﻿']) {
      expect(isInvisible(ch), `U+${ch.codePointAt(0)!.toString(16).toUpperCase()} should be refused`).toBe(true);
    }
  });

  it('refuses whitespace-only bodies', () => {
    for (const t of ['   ', '\n', '\t', '\n\t ', '​‌‍']) {
      expect(isInvisible(t), JSON.stringify(t)).toBe(true);
    }
  });

  // The direction that matters most: a guard that over-refuses eats real messages silently.
  it('still sends anything with real content', () => {
    for (const t of ['hello', ' a ', '.', '👍', '👍️', 'a️', 'é', '中', '​x​', '0']) {
      expect(isInvisible(t), `${JSON.stringify(t)} must still send`).toBe(false);
    }
  });
});

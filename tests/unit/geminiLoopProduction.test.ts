/**
 * Unit tests for the GeminiLoopDriver production wiring (need-gem-002, increment 2):
 *   - parseLatestGeminiSessionHandle: picks the FRESHEST session by min age (not
 *     list order), tolerates title parentheses, returns null when nothing parses.
 *   - createQuotaBudgetGate: maps the QuotaTracker spawn-admission signal, fails
 *     OPEN when no tracker is wired.
 */

import { describe, it, expect } from 'vitest';
import {
  parseLatestGeminiSessionHandle,
  createQuotaBudgetGate,
} from '../../src/monitoring/geminiLoopProduction.js';

const REAL_LIST = `Available sessions for this project (3):
  1. Reply with exactly the word: PONG (1 day ago) [9b06d03d-f990-49c0-9cd5-1df66c06cf16]
  2. You are a mentee in an AI-agent apprenticeship (16 minutes ago) [761d6464-8228-49a7-b385-f9e2bfa3511f]
  3. Remember this codeword for later: PELICAN-7 (Just now) [ef951c6e-49b4-49df-a8f0-b8aa62b4403f]`;

describe('parseLatestGeminiSessionHandle', () => {
  it('returns the FRESHEST session (min age = "Just now"), not the last/first line', () => {
    expect(parseLatestGeminiSessionHandle(REAL_LIST)).toBe('ef951c6e-49b4-49df-a8f0-b8aa62b4403f');
  });

  it('picks min age even when the freshest is NOT listed last', () => {
    const out = `Available sessions (3):
  1. fresh one (Just now) [aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa]
  2. old one (2 hours ago) [bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb]
  3. medium (5 minutes ago) [cccccccc-cccc-cccc-cccc-cccccccccccc]`;
    expect(parseLatestGeminiSessionHandle(out)).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });

  it('is not confused by parentheses inside the title (age is the LAST parens)', () => {
    const out = `  1. Fix the thing (part 1/4) (3 minutes ago) [dddddddd-dddd-dddd-dddd-dddddddddddd]`;
    expect(parseLatestGeminiSessionHandle(out)).toBe('dddddddd-dddd-dddd-dddd-dddddddddddd');
  });

  it('handles seconds / hours / days units', () => {
    const out = `  1. a (30 seconds ago) [11111111-1111-1111-1111-111111111111]
  2. b (3 hours ago) [22222222-2222-2222-2222-222222222222]
  3. c (2 days ago) [33333333-3333-3333-3333-333333333333]`;
    // 30 seconds is the smallest
    expect(parseLatestGeminiSessionHandle(out)).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('returns null when no session row parses', () => {
    expect(parseLatestGeminiSessionHandle('No sessions found for this project.')).toBeNull();
    expect(parseLatestGeminiSessionHandle('')).toBeNull();
  });
});

describe('createQuotaBudgetGate', () => {
  it('passes through an allowing tracker', () => {
    const gate = createQuotaBudgetGate({ shouldSpawnSession: () => ({ allowed: true, reason: 'ok' }) });
    expect(gate()).toEqual({ ok: true, reason: undefined });
  });

  it('closes (with reason) when the tracker denies', () => {
    const gate = createQuotaBudgetGate({
      shouldSpawnSession: () => ({ allowed: false, reason: 'memory pressure' }),
    });
    expect(gate()).toEqual({ ok: false, reason: 'memory pressure' });
  });

  it('fails OPEN when no tracker is wired', () => {
    expect(createQuotaBudgetGate(null)()).toEqual({ ok: true });
    expect(createQuotaBudgetGate(undefined)()).toEqual({ ok: true });
  });
});

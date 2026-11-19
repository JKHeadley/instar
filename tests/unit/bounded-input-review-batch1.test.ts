/**
 * Bounded-input derivation review, batch 1 (STD-SUBCOUNTDOWN-bounded-input-derivation-review).
 *
 * Each case pins a BEHAVIOUR the review changed, not the wording of the code:
 *  - Gemini: the retry/defer decision reads the FULL stderr, so a capacity line
 *    printed after a long preamble still leads to a retry instead of a failure.
 *  - Standing authorization: the grant phrase reaches the tone gate even when it
 *    sits past the old 280-character cut, and a longer message says it was cut.
 *  (Job reflection's command bound is pinned in JobReflector.test.ts.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const spawnMock = vi.fn();
vi.mock('../../src/providers/adapters/gemini-cli/transport/geminiSpawn.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, spawnGeminiAndWait: (...args: unknown[]) => spawnMock(...args) };
});

import { GeminiCliIntelligenceProvider } from '../../src/core/GeminiCliIntelligenceProvider.js';
import {
  resolveStandingAuthorization,
  STANDING_GRANT_QUOTE_CHARS,
  type OperatorHistoryRow,
} from '../../src/core/standing-authorization.js';

describe('Gemini provider — capacity decision reads the whole stderr', () => {
  beforeEach(() => spawnMock.mockReset());

  it('retries when the RESOURCE_EXHAUSTED line comes after 2,000 chars of preamble', async () => {
    const preamble = 'warning: deprecated flag\n'.repeat(80); // ~2,000 chars, no capacity words
    spawnMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: `${preamble}Error 429 RESOURCE_EXHAUSTED: retry after 0s` })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'ok', stderr: '' });
    const p = new GeminiCliIntelligenceProvider({ geminiPath: '/bin/false', capacityPolicy: { backoffMs: 1 } });
    await expect(p.evaluate('hi', { model: 'fast' })).resolves.toBe('ok');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('a non-capacity failure still fails, and its long stderr is disclosed as cut', async () => {
    spawnMock.mockResolvedValueOnce({ exitCode: 2, stdout: '', stderr: 'boom '.repeat(1000) });
    const p = new GeminiCliIntelligenceProvider({ geminiPath: '/bin/false' });
    const err = await p.evaluate('hi').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^Gemini CLI exited 2 — boom/);
    expect((err as Error).message).toContain('[BOUNDED INPUT:');
  });
});

describe('standing authorization — the grant phrase survives the bound', () => {
  const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
  const OP = 7812716706;
  const deps = (rows: OperatorHistoryRow[]) => ({
    getVerifiedOperatorUid: () => OP,
    getRecentMessages: () => rows,
    now: () => NOW,
  });

  it('keeps a grant phrase that sits past character 280', () => {
    const text = `${'Context about the migration and the plan. '.repeat(10)}You have my preapproval to merge it.`;
    expect(text.indexOf('preapproval')).toBeGreaterThan(280);
    const r = resolveStandingAuthorization(1, deps([{ telegramUserId: OP, text, ts: NOW - 60_000, forwarded: false }]));
    expect(r.present).toBe(true);
    expect(r.evidenceQuote).toContain('You have my preapproval to merge it.');
    expect(r.evidenceQuote).not.toContain('[BOUNDED INPUT:');
  });

  it('a message longer than the bound is cut AND says so', () => {
    const text = `go ahead. ${'x'.repeat(6000)}`;
    const r = resolveStandingAuthorization(1, deps([{ telegramUserId: OP, text, ts: NOW - 60_000, forwarded: false }]));
    expect(r.present).toBe(true);
    expect(r.evidenceQuote!.length).toBeLessThanOrEqual(STANDING_GRANT_QUOTE_CHARS);
    expect(r.evidenceQuote).toContain('LATER content was omitted');
  });
});

/**
 * Unit tests for the Layer 4 summarizer core (A2ACheckInSummarizer): the prompt is redacted +
 * frames peer content as untrusted + demands attribution; the output guard rejects empty /
 * URL / command / credential-request summaries.
 */
import { describe, it, expect } from 'vitest';
import {
  buildSummaryPrompt,
  guardSummary,
  type SummaryPromptInput,
} from '../../../src/threadline/A2ACheckInSummarizer.js';

const base: SummaryPromptInput = {
  peerName: 'Dawn',
  historyText: 'Dawn: how is the migration going?\nMe: parity is green on 1327 clusters.',
  kind: 'salience',
};

describe('buildSummaryPrompt', () => {
  it('redacts credentials out of the conversation before the LLM sees it', () => {
    const prompt = buildSummaryPrompt({
      ...base,
      historyText: 'Dawn: here is the key API_KEY=supersecret12345 use it',
    });
    expect(prompt).not.toContain('supersecret12345');
    expect(prompt).toContain('[REDACTED]');
  });

  it('frames the conversation as untrusted data and demands attribution', () => {
    const prompt = buildSummaryPrompt(base);
    expect(prompt).toContain('UNTRUSTED DATA');
    expect(prompt).toMatch(/ATTRIBUTE/);
    expect(prompt).toContain('Dawn'); // the peer name appears for attribution
    expect(prompt).toContain('--- CONVERSATION (untrusted, redacted) ---');
  });

  it('asks for an operator-facing update on salience, and a brief heartbeat on heartbeat', () => {
    const salience = buildSummaryPrompt({ ...base, kind: 'salience' });
    expect(salience).toMatch(/needs the operator|concrete result/i);

    const heartbeat = buildSummaryPrompt({ ...base, kind: 'heartbeat' });
    expect(heartbeat).toMatch(/still here|heartbeat|ongoing/i);
  });

  it('caps the conversation text fed to the summarizer', () => {
    const big = 'x'.repeat(50_000);
    const prompt = buildSummaryPrompt({ ...base, historyText: big, maxHistoryBytes: 200 });
    // The conversation section is bounded; the whole prompt stays small (frame + <=200 of history).
    expect(prompt.length).toBeLessThan(2_000);
  });
});

describe('guardSummary', () => {
  it('accepts a clean conversational summary', () => {
    const r = guardSummary('Dawn says the migration parity is green; nothing needs you yet.');
    expect(r.safe).toBe(true);
    expect(r.text).toBeTruthy();
  });

  it('rejects an empty summary', () => {
    expect(guardSummary('').safe).toBe(false);
    expect(guardSummary('   ').safe).toBe(false);
    expect(guardSummary(null).safe).toBe(false);
  });

  it('rejects a summary containing a URL', () => {
    const r = guardSummary('Dawn shared a link: https://evil.example/login to continue.');
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/URL/i);
  });

  it('rejects a summary that asks for a credential (poisoning guard)', () => {
    const r = guardSummary('Dawn says you should enter your password to proceed.');
    expect(r.safe).toBe(false);
  });
});

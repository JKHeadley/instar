/**
 * Unit tests for MessagingToneGate B15_CONTEXT_DEATH_STOP.
 *
 * Spec: specs/dev-infrastructure/context-death-stop-hook.md
 *
 * The rule catches outbound messages that propose stopping/handing-off the
 * current in-flight work for context-window / fresh-session / end-of-session
 * reasons rather than a legitimate stop reason. Operator explicitly asked
 * for this structural guard against a recurring self-stop pattern that
 * documentation alone has not eliminated.
 *
 * Strategy mirrors messaging-tone-gate-health-alerts.test.ts:
 *   - Mock IntelligenceProvider with vi.fn() to capture the rendered prompt
 *     and to return whatever JSON we want the LLM to have produced.
 *   - Assert the prompt contains the B15 rule definition and its literal
 *     pattern markers (the rule TEXT is loaded structurally — what the
 *     remote LLM does with it is itself observable in production
 *     telemetry, not in unit tests).
 *   - Assert that the gate accepts B15 as a valid rule id (the drift-
 *     detection branch does not fail-open when an LLM cites B15 the way
 *     it would for an invented rule).
 *   - Assert that valid B15 responses propagate through unchanged.
 */

import { describe, it, expect, vi } from 'vitest';
import { MessagingToneGate } from '../../src/core/MessagingToneGate.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';

function captureProvider(response: object) {
  let lastPrompt = '';
  const provider: IntelligenceProvider = {
    evaluate: vi.fn(async (prompt: string, _options?: IntelligenceOptions) => {
      lastPrompt = prompt;
      return JSON.stringify(response);
    }),
  };
  return { provider, getPrompt: () => lastPrompt };
}

describe('MessagingToneGate — B15_CONTEXT_DEATH_STOP', () => {
  it('renders the B15 rule definition in the prompt for every review', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('Any candidate at all.', { channel: 'telegram' });
    const prompt = getPrompt();
    expect(prompt).toContain('B15_CONTEXT_DEATH_STOP');
    expect(prompt).toContain('SELF-STOP rule');
  });

  it('lists the context-death literal pattern markers in the prompt', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('Any candidate at all.', { channel: 'telegram' });
    const prompt = getPrompt();
    // Markers the operator listed; the LLM must be told to look for them.
    expect(prompt).toContain('"fresh session"');
    expect(prompt).toContain('"next session"');
    expect(prompt).toContain('"tail of this session"');
    expect(prompt).toContain('"hand off cleanly"');
    expect(prompt).toContain('"pick this up later"');
  });

  it('documents the legitimate-stop carve-outs in the prompt', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('Any candidate at all.', { channel: 'telegram' });
    const prompt = getPrompt();
    expect(prompt).toContain('LEGITIMATE STOP CLAUSES');
    expect(prompt).toContain('completion report');
    expect(prompt).toContain('genuine error / blocker');
  });

  it('allows B15 as the response format rule list', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('Any candidate.', { channel: 'telegram' });
    const prompt = getPrompt();
    // The response-format section enumerates allowed rule ids; B15 must be there.
    expect(prompt).toMatch(/B1[–-]B9.*B11.*B12.*B13.*B14.*B15/);
  });

  it('accepts B15 as a valid rule id without fail-opening (no invalidRule flag)', async () => {
    // If the LLM cites B15 and the gate's drift-detection didn't know about B15,
    // it would fail-open with invalidRule: true. This test asserts B15 is in
    // the VALID_RULES set.
    const { provider } = captureProvider({
      pass: false,
      rule: 'B15_CONTEXT_DEATH_STOP',
      issue: 'candidate proposes picking this up in a fresh session',
      suggestion: 'delete the handoff framing and continue the work',
    });
    const gate = new MessagingToneGate(provider);
    const result = await gate.review(
      "Quality risk on completing in this session — let me hand off cleanly and pick this up in a fresh session.",
      { channel: 'telegram' },
    );
    expect(result.pass).toBe(false);
    expect(result.rule).toBe('B15_CONTEXT_DEATH_STOP');
    expect(result.invalidRule).toBeFalsy();
    expect(result.failedOpen).toBeFalsy();
    expect(result.issue).toContain('fresh session');
    expect(result.suggestion).toContain('continue');
  });

  it('passes a completion-report message through unchanged (LLM returns pass)', async () => {
    // The LLM is expected to recognize "shipped to npm" as a legitimate-stop
    // clause and pass even though no other rule fired. We mock pass=true and
    // verify the gate doesn't muck with it.
    const { provider } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    const result = await gate.review(
      'Done — v1.2.31 is on npm and the PR is merged to main.',
      { channel: 'telegram' },
    );
    expect(result.pass).toBe(true);
    expect(result.rule).toBe('');
  });

  it('passes a genuine-blocker message through unchanged (LLM returns pass)', async () => {
    const { provider } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    const result = await gate.review(
      "I'm blocked on your call between options A, B, or C — those are real product decisions only you can make.",
      { channel: 'telegram' },
    );
    expect(result.pass).toBe(true);
  });

  it('passes a topic-split / continuation message through unchanged (LLM returns pass)', async () => {
    const { provider } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    const result = await gate.review(
      'Created a new topic for the tunnel work and continuing there now.',
      { channel: 'telegram' },
    );
    expect(result.pass).toBe(true);
  });

  it('still treats unknown rules as invalidRule fail-open (drift detection preserved)', async () => {
    // Sanity: adding B15 didn't accidentally widen the gate to accept any
    // rule id the LLM invents.
    const { provider } = captureProvider({
      pass: false,
      rule: 'B16_INVENTED_RULE',
      issue: '...',
      suggestion: '...',
    });
    const gate = new MessagingToneGate(provider);
    const result = await gate.review('Whatever.', { channel: 'telegram' });
    expect(result.pass).toBe(true);
    expect(result.invalidRule).toBe(true);
    expect(result.failedOpen).toBe(true);
  });
});

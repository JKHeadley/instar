/**
 * Unit tests for MessagingToneGate B18_AUTONOMY_STOP.
 *
 * Spec: docs/specs/AUTONOMOUS-OPERATION-JUDGMENT-AND-APPROVAL-AS-DATA-SPEC.md (P13).
 *
 * B18 is the message-layer backstop for the constitutional standard P13 "The
 * Stop Reason Is the Work" (the PRIMARY enforcement is the autonomous-completion
 * evaluator). It catches an outbound message that announces ending an autonomous
 * run for a judgment-call / needs-real-engineering reason WITHOUT showing a derived
 * standard, a built artifact, or a genuinely operator-only residual.
 *
 * Strategy mirrors messaging-tone-gate-b15.test.ts:
 *   - the rule TEXT is loaded structurally into the prompt (assert it renders);
 *   - the gate accepts B18 as a valid rule id (drift-detection knows it — it is in
 *     VALID_RULES and the response-format enumeration), so a B18 citation does not
 *     fail-open with invalidRule.
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

describe('MessagingToneGate — B18_AUTONOMY_STOP', () => {
  it('renders the B18 rule definition in the prompt for every review', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('Any candidate at all.', { channel: 'telegram' });
    const prompt = getPrompt();
    expect(prompt).toContain('B18_AUTONOMY_STOP');
    expect(prompt).toContain('The Stop Reason Is the Work');
  });

  it('lists the autonomy-stop + judgment/engineering markers in the prompt', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('Any candidate at all.', { channel: 'telegram' });
    const prompt = getPrompt();
    expect(prompt).toContain('ending the autonomous run');
    expect(prompt).toContain('needs your judgment');
    expect(prompt).toContain('this needs real engineering');
  });

  it('documents the legitimate carve-outs (derived standard / built artifact / operator-only / duration-emergency)', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('Any candidate at all.', { channel: 'telegram' });
    const prompt = getPrompt();
    expect(prompt).toContain('DERIVED STANDARD');
    expect(prompt).toContain('BUILT ARTIFACT');
    expect(prompt).toContain('OPERATOR-ONLY');
    expect(prompt).toContain('DURATION / EMERGENCY');
  });

  it('declares the B15 > B16 > B17 > B18 citation precedence', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('Any candidate at all.', { channel: 'telegram' });
    expect(getPrompt()).toContain('B15 > B16 > B17 > B18');
  });

  it('lists B18 in the response-format rule enumeration', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('Any candidate.', { channel: 'telegram' });
    // The LLM must be told B18 is a citable rule id, else it would never cite it.
    // The enumeration now runs through B20 ("…B17, B18, B19, or B20").
    expect(getPrompt()).toMatch(/B17,\s*B18/);
    expect(getPrompt()).toMatch(/or\s*B20/);
  });

  it('accepts B18 as a valid rule id without fail-opening (no invalidRule flag)', async () => {
    const { provider } = captureProvider({
      pass: false,
      rule: 'B18_AUTONOMY_STOP',
      issue: 'announces ending the autonomous run because it "needs your judgment", with no derived standard or artifact',
      suggestion: 'derive and document the standard and continue, or build the artifact and hand it over',
    });
    const gate = new MessagingToneGate(provider);
    const result = await gate.review(
      'Ending the autonomous run here — this needs your judgment on the approach before I can continue.',
      { channel: 'telegram' },
    );
    expect(result.pass).toBe(false);
    expect(result.rule).toBe('B18_AUTONOMY_STOP');
    expect(result.invalidRule).toBeFalsy();
    expect(result.failedOpen).toBeFalsy();
    expect(result.suggestion).toContain('build');
  });

  it('passes a stop-with-artifact message through unchanged (LLM returns pass)', async () => {
    const { provider } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    const result = await gate.review(
      'Stage 1 is built and tested — opened PR #710 and handing it over for review.',
      { channel: 'telegram' },
    );
    expect(result.pass).toBe(true);
  });
});

/**
 * Unit tests for MessagingToneGate B17_FALSE_BLOCKER.
 *
 * Spec: docs/specs/never-a-false-blocker-standard.md
 *
 * The rule catches outbound messages that hand a doable task back to the user as
 * "needs a human / I can't / blocked pending you / I'd want a second opinion /
 * this needs reverse-engineering" when the task is within the agent's own means
 * (computer use, terminal, send-keys, dashboard, MCP) and no capability inventory
 * is shown. It is the deference-shaped sibling of B16 (A Wall Is a Hypothesis):
 * where B16 surrenders on FEASIBILITY ("no mechanism exists"), B17 surrenders on
 * AGENCY ("a person is required"). Earned from the 2026-05-24 codex-trust miss
 * (an instance claimed a human had to click a trust prompt it was looking at).
 *
 * Strategy mirrors messaging-tone-gate-b16.test.ts:
 *   - Mock IntelligenceProvider to capture the rendered prompt and return a chosen verdict.
 *   - Assert the prompt loads the B17 rule + deference markers + the genuinely-human-only
 *     allowlist + the de-confliction/straddle guidance (the rule TEXT is loaded
 *     structurally; the remote LLM's decision is exercised by the canary + test-as-self).
 *   - Assert the gate accepts B17 as a valid rule id (no drift fail-open).
 *   - Cover BOTH sides: a false blocker blocks; password/value-judgment/account-grant/
 *     post-inventory/self-fetched-second-opinion all pass.
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

describe('MessagingToneGate — B17_FALSE_BLOCKER', () => {
  it('renders the B17 rule definition in the prompt for every review', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('Any candidate at all.', { channel: 'telegram' });
    const prompt = getPrompt();
    expect(prompt).toContain('B17_FALSE_BLOCKER');
    expect(prompt).toContain('Never a False Blocker');
  });

  it('lists the deference pattern markers in the prompt', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('Any candidate at all.', { channel: 'telegram' });
    const prompt = getPrompt();
    expect(prompt).toContain('this needs a human');
    expect(prompt).toContain('second opinion');
    expect(prompt).toContain('reverse-engineering');
  });

  it('documents the genuinely-human-only allowlist in the prompt', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('Any candidate at all.', { channel: 'telegram' });
    const prompt = getPrompt();
    expect(prompt).toContain('password');
    expect(prompt).toContain('CAPTCHA');
    expect(prompt).toContain('account');
    expect(prompt).toContain('approval');
    expect(prompt).toContain('rate-limit');
    // Asking the user a genuine decision must pass.
    expect(prompt).toContain('value / priority / risk-appetite judgment');
    expect(prompt).toContain('favor FALSE-NEGATIVES');
  });

  it('documents the named-outcome inventory requirement and self-fetched-review carve-out', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('Any candidate at all.', { channel: 'telegram' });
    const prompt = getPrompt();
    expect(prompt).toContain('SPECIFIC OUTCOMES');
    expect(prompt).toContain('HOLLOW');
    expect(prompt).toContain('cross-model review');
  });

  it('documents the B16/B17 straddle and citation precedence', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('Any candidate at all.', { channel: 'telegram' });
    const prompt = getPrompt();
    expect(prompt).toContain('STRADDLE');
    expect(prompt).toContain('B15 > B16 > B17');
  });

  it('includes B17 in the response-format rule list', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('Any candidate.', { channel: 'telegram' });
    const prompt = getPrompt();
    expect(prompt).toMatch(/B15.*B16.*B17/);
  });

  it('accepts B17 as a valid rule id without fail-opening (the codex-trust false blocker)', async () => {
    // The crystallizing failure: claiming a human must click a prompt the agent
    // could click itself, with no inventory. If drift detection didn't know B17,
    // it would fail-open with invalidRule: true.
    const { provider } = captureProvider({
      pass: false,
      rule: 'B17_FALSE_BLOCKER',
      issue: 'defers clicking the trust prompt to a human and wants a second opinion; no inventory of computer-use shown',
      suggestion: 'try computer-use on the prompt yourself before deferring',
    });
    const gate = new MessagingToneGate(provider);
    const result = await gate.review(
      "This needs a human to click the trust prompt, and the durable fix needs reverse-engineering, so I'd want a second opinion before I proceed.",
      { channel: 'telegram' },
    );
    expect(result.pass).toBe(false);
    expect(result.rule).toBe('B17_FALSE_BLOCKER');
    expect(result.invalidRule).toBeFalsy();
    expect(result.failedOpen).toBeFalsy();
    expect(result.suggestion).toContain('computer-use');
  });

  it('accepts a B17 citation on the fused straddle ("no API, so a human must")', async () => {
    // The dangerous straddle: a missing-mechanism claim fused with a person-required
    // claim. The person-required half is B17's; the gate must accept the B17 citation.
    const { provider } = captureProvider({
      pass: false,
      rule: 'B17_FALSE_BLOCKER',
      issue: 'fuses "no API" with "a human has to" — the person-required half is a false blocker',
      suggestion: 'enumerate your own means before saying a human is required',
    });
    const gate = new MessagingToneGate(provider);
    const result = await gate.review(
      "There's no API to flip this setting, so a human has to do it in the UI.",
      { channel: 'telegram' },
    );
    expect(result.pass).toBe(false);
    expect(result.rule).toBe('B17_FALSE_BLOCKER');
    expect(result.invalidRule).toBeFalsy();
  });

  it('passes a genuinely human-only password request (LLM returns pass)', async () => {
    const { provider } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    const result = await gate.review(
      "I can't unlock the vault myself — I need the master password, which is yours alone. Can you drop it via the Secret Drop link?",
      { channel: 'telegram' },
    );
    expect(result.pass).toBe(true);
    expect(result.rule).toBe('');
  });

  it('passes a genuine value-judgment question (LLM returns pass)', async () => {
    const { provider } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    const result = await gate.review(
      'Do you want me to ship the bundled B16+B17 PR, or split them into two? Your call.',
      { channel: 'telegram' },
    );
    expect(result.pass).toBe(true);
  });

  it('passes a deferral reported AFTER a named-outcome inventory (LLM returns pass)', async () => {
    const { provider } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    const result = await gate.review(
      "I tried send-keys into the Codex pane (the prompt didn't advance) and computer-use on the button (it's disabled until you authenticate) — so I genuinely need you to sign in first.",
      { channel: 'telegram' },
    );
    expect(result.pass).toBe(true);
  });

  it('passes a self-fetched cross-model second opinion (LLM returns pass)', async () => {
    const { provider } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    const result = await gate.review(
      'Let me get a second opinion from GPT and Gemini via cross-model review before I finalize the spec.',
      { channel: 'telegram' },
    );
    expect(result.pass).toBe(true);
  });

  it('preserves drift detection — an invented rule id still fails open', async () => {
    // Adding B17 must not widen the gate to accept any rule the LLM invents.
    const { provider } = captureProvider({
      pass: false,
      rule: 'B18_NOT_A_REAL_RULE',
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

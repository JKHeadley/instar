/**
 * Unit tests for MessagingToneGate B16_UNVERIFIED_WALL.
 *
 * Spec: docs/specs/wall-is-a-hypothesis-standard.md
 *
 * The rule catches outbound messages that declare a path impossible / blocked /
 * infeasible / "can't be done" because some interface / API / mechanism is
 * missing, WITHOUT evidence the agent first inventoried the capabilities it
 * already has. It is the structural enforcement of the constitution's
 * "A Wall Is a Hypothesis" standard — the feasibility-judgment cousin of B15's
 * self-stop guard. Earned from the 2026-05-24 /goal-delegation miss (an instance
 * declared native /goal delegation "infeasible — no API" while overlooking that
 * driving interactive sessions by injecting text is a core instar capability).
 *
 * Strategy mirrors messaging-tone-gate-b15.test.ts:
 *   - Mock IntelligenceProvider with vi.fn() to capture the rendered prompt and
 *     return whatever JSON we want the LLM to have produced.
 *   - Assert the prompt loads the B16 rule definition + its infeasibility markers
 *     + the legitimate carve-outs (the rule TEXT is loaded structurally; what the
 *     remote LLM does with it is observable in production telemetry).
 *   - Assert the gate accepts B16 as a valid rule id (the drift-detection branch
 *     does not fail-open when an LLM cites B16 the way it would an invented rule).
 *   - Cover BOTH sides of the decision boundary: an unverified wall blocks; a
 *     wall reported after a visible inventory, a genuinely-external limit, and a
 *     message merely discussing the rule all pass.
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

describe('MessagingToneGate — B16_UNVERIFIED_WALL', () => {
  it('renders the B16 rule definition in the prompt for every review', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('Any candidate at all.', { channel: 'telegram' });
    const prompt = getPrompt();
    expect(prompt).toContain('B16_UNVERIFIED_WALL');
    // Ties the rule to the constitution standard it enforces.
    expect(prompt).toContain('A Wall Is a Hypothesis');
  });

  it('lists the infeasibility pattern markers in the prompt', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('Any candidate at all.', { channel: 'telegram' });
    const prompt = getPrompt();
    expect(prompt).toContain('no API');
    expect(prompt).toContain("can't be done");
    expect(prompt).toContain("isn't feasible");
    expect(prompt).toContain('missing interface');
  });

  it('documents the legitimate carve-outs (inventory-shown, external limit) in the prompt', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('Any candidate at all.', { channel: 'telegram' });
    const prompt = getPrompt();
    expect(prompt).toContain('inventory');
    expect(prompt).toContain('genuinely EXTERNAL');
    expect(prompt).toContain('favor FALSE-NEGATIVES');
  });

  it('includes B16 in the response-format rule list', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('Any candidate.', { channel: 'telegram' });
    const prompt = getPrompt();
    expect(prompt).toMatch(/B14.*B15.*B16/);
  });

  it('accepts B16 as a valid rule id without fail-opening (the /goal-style unverified wall)', async () => {
    // The crystallizing failure: declaring a path infeasible from a missing API
    // without inventorying the agent's own mechanisms. If the gate's drift
    // detection didn't know B16, it would fail-open with invalidRule: true.
    const { provider } = captureProvider({
      pass: false,
      rule: 'B16_UNVERIFIED_WALL',
      issue: 'declares native /goal delegation infeasible citing "no programmatic API", no inventory shown',
      suggestion: 'inventory existing mechanisms (e.g. session injection) before declaring it impossible',
    });
    const gate = new MessagingToneGate(provider);
    const result = await gate.review(
      "Native /goal delegation isn't feasible — there's no programmatic API for /goal, so we can't drive it.",
      { channel: 'telegram' },
    );
    expect(result.pass).toBe(false);
    expect(result.rule).toBe('B16_UNVERIFIED_WALL');
    expect(result.invalidRule).toBeFalsy();
    expect(result.failedOpen).toBeFalsy();
    expect(result.suggestion).toContain('inventory');
  });

  it('passes a wall reported AFTER a visible capability inventory (LLM returns pass)', async () => {
    // A dead-end named honestly after checking the toolkit is good engineering,
    // not a violation. We mock pass=true and verify the gate propagates it.
    const { provider } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    const result = await gate.review(
      "I checked session injection, the HTTP API, and the topic registry — none can reach this without a new endpoint, so this path is genuinely blocked.",
      { channel: 'telegram' },
    );
    expect(result.pass).toBe(true);
    expect(result.rule).toBe('');
  });

  it('passes a genuinely-external limit through unchanged (LLM returns pass)', async () => {
    const { provider } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    const result = await gate.review(
      "I can't read your email until you connect the Gmail account — that's on your side to authorize.",
      { channel: 'telegram' },
    );
    expect(result.pass).toBe(true);
  });

  it('passes a message merely DISCUSSING the rule/concept through unchanged (LLM returns pass)', async () => {
    const { provider } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    const result = await gate.review(
      'The new standard says before I call something impossible I have to inventory my own tools first — that’s what "A Wall Is a Hypothesis" means.',
      { channel: 'telegram' },
    );
    expect(result.pass).toBe(true);
  });

  it('preserves drift detection — an invented rule id re-prompts then fails CLOSED', async () => {
    // Adding B16 must not widen the gate to accept any rule the LLM invents.
    // Drift now HOLDS (fail-closed, §Design 6), not fail-open.
    const { provider } = captureProvider({
      pass: false,
      rule: 'B17_NOT_A_REAL_RULE',
      issue: '...',
      suggestion: '...',
    });
    const gate = new MessagingToneGate(provider);
    const result = await gate.review('Whatever.', { channel: 'telegram' });
    expect(result.pass).toBe(false);
    expect(result.failedClosed).toBe(true);
  });
});

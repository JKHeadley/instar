/**
 * Unit tests for MessagingToneGate B21_USER_TASK_SUBSTITUTION.
 *
 * Spec: docs/specs/correction-derived-hardening.md.
 *
 * B21 catches the "user-task substitution" anti-pattern (operator correction
 * 2026-07-18): an outbound message handing the USER a multi-step procedure —
 * portal click-paths, UI steps, command sequences — for work the AGENT could
 * perform itself given at most a credential or an approval. The legitimate
 * escalation shapes when self-unblock exhausts are an approval, a credential
 * request (e.g. a Secret Drop link), or a mid-flow challenge code — never a
 * procedure for the human to execute.
 *
 * Strategy mirrors messaging-tone-gate-b18.test.ts:
 *   - the rule TEXT is loaded structurally into the prompt (assert it renders);
 *   - the gate accepts B21 as a valid rule id (it is in VALID_RULES), so a B21
 *     citation does not fail-open with invalidRule;
 *   - both decision boundaries are exercised with realistic candidates.
 */

import { describe, it, expect, vi } from 'vitest';
import { MessagingToneGate, VALID_RULES, RULE_CLASSES, RULE_DISPOSITIONS } from '../../src/core/MessagingToneGate.js';
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

describe('MessagingToneGate — B21_USER_TASK_SUBSTITUTION', () => {
  it('registers B21 in VALID_RULES and classifies it behavioral-judgment', () => {
    expect(VALID_RULES.has('B21_USER_TASK_SUBSTITUTION')).toBe(true);
    expect(RULE_CLASSES['B21_USER_TASK_SUBSTITUTION']).toBe('behavioral-judgment');
  });

  it('DISPOSITION ratchet: RULE_DISPOSITIONS covers exactly VALID_RULES; B21 is advisory (operator directive 2026-07-18)', () => {
    expect(Object.keys(RULE_DISPOSITIONS).sort()).toEqual([...VALID_RULES].sort());
    expect(RULE_DISPOSITIONS['B21_USER_TASK_SUBSTITUTION']).toBe('advisory');
    // Every OTHER rule keeps its blocking disposition until its own migration spec.
    for (const rule of VALID_RULES) {
      if (rule !== 'B21_USER_TASK_SUBSTITUTION') {
        expect(RULE_DISPOSITIONS[rule]).toBe('blocking');
      }
    }
  });

  it('a B21 citation carries advisory:true (a nudge, never a terminal block); a blocking rule does not', async () => {
    const { provider } = captureProvider({
      pass: false,
      rule: 'B21_USER_TASK_SUBSTITUTION',
      issue: 'hands the user a click procedure',
      suggestion: 'do it yourself',
    });
    const gate = new MessagingToneGate(provider);
    const r = await gate.review('Open the portal and click through these four steps.', { channel: 'telegram' });
    expect(r.pass).toBe(false);
    expect(r.advisory).toBe(true);

    const { provider: p18 } = captureProvider({
      pass: false,
      rule: 'B18_AUTONOMY_STOP',
      issue: 'stops the run on a judgment reason',
      suggestion: 'derive the standard and continue',
    });
    const r18 = await new MessagingToneGate(p18).review('Ending the run — needs your judgment.', { channel: 'telegram' });
    expect(r18.pass).toBe(false);
    expect(r18.advisory).toBeFalsy();
  });

  it('renders the B21 rule definition in the prompt for every review', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('Any candidate at all.', { channel: 'telegram' });
    const prompt = getPrompt();
    expect(prompt).toContain('B21_USER_TASK_SUBSTITUTION');
    expect(prompt).toContain('user-task substitution');
    expect(prompt).toContain('JUDGE BY MEANING');
  });

  it('documents the legitimate carve-outs (asked-to-learn / human-reserved / one-tap / discussion)', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('Any candidate at all.', { channel: 'telegram' });
    const prompt = getPrompt();
    expect(prompt).toContain('EXPLICITLY asked to do it themselves');
    expect(prompt).toContain('STRUCTURALLY reserved to the human');
    expect(prompt).toContain('SINGLE one-tap action');
    expect(prompt).toContain('DISCUSSING this rule');
  });

  it('declares the extended B15 > B16 > B17 > B18 > B21 citation precedence and the B17/B19 de-confliction', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review('Any candidate at all.', { channel: 'telegram' });
    const prompt = getPrompt();
    expect(prompt).toContain('B15 > B16 > B17 > B18 > B21');
    expect(prompt).toContain('RELATIONSHIP TO B17/B19');
  });

  it('accepts B21 as a valid rule id without fail-opening (no invalidRule flag)', async () => {
    const { provider } = captureProvider({
      pass: false,
      rule: 'B21_USER_TASK_SUBSTITUTION',
      issue:
        'hands the user a four-step Slack portal procedure (open app config, add scopes, reinstall, /invite) that the agent could perform itself with at most a credential',
      suggestion:
        'perform the portal steps yourself and ask the user only for the credential or approval you actually lack',
    });
    const gate = new MessagingToneGate(provider);
    const result = await gate.review(
      'Quick 60-second fix on your side: open api.slack.com/apps, pick the demo app, add the four scopes under OAuth & Permissions, click Reinstall, then /invite the bot in both channels.',
      { channel: 'telegram' },
    );
    expect(result.pass).toBe(false);
    expect(result.rule).toBe('B21_USER_TASK_SUBSTITUTION');
    expect(result.invalidRule).toBeFalsy();
    expect(result.failedOpen).toBeFalsy();
    expect(result.suggestion).toContain('credential');
  });

  it('passes a Secret-Drop-link credential ask through unchanged (LLM returns pass)', async () => {
    const { provider } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    const result = await gate.review(
      "Here's the secure one-time link — submit the Slack password there and I'll do the whole setup myself: https://example.dawn-tunnel.dev/secrets/drop/abc123",
      { channel: 'telegram' },
    );
    expect(result.pass).toBe(true);
  });

  it('passes a PIN-gated dashboard action walkthrough (structurally human-reserved) unchanged', async () => {
    const { provider } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    const result = await gate.review(
      'To approve the mandate, open the dashboard Mandates tab and enter your PIN — that part is yours by design; everything else is already staged.',
      { channel: 'telegram' },
    );
    expect(result.pass).toBe(true);
  });
});

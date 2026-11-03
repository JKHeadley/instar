/**
 * Unit tests for MessagingToneGate B22_AGENT_COORDINATION_TO_USER.
 *
 * Origin: bug 2026-11-03 (Echo Bugs topic 10000001474). A desk session posted
 * "From the 07:30 holistic review (2/4 reports): please own a bounded,
 * non-authoritative affected unit/integration preflight experiment …" into the
 * user's Telegram topic, because the user topic was the only path that reached
 * the other session. The operator: messages like this must not be shown to the
 * user, while real progress updates still belong there.
 *
 * Strategy mirrors messaging-tone-gate-b21.test.ts: the rule text renders into
 * every prompt, B22 is a valid citable id (no fail-open), its class and
 * disposition are registered, and both sides of the decision are exercised.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MessagingToneGate,
  VALID_RULES,
  RULE_CLASSES,
  RULE_DISPOSITIONS,
  ADVISORY_MIGRATION_EXEMPT_RULES,
  resolveRuleDisposition,
} from '../../src/core/MessagingToneGate.js';
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

const LEAKED =
  'From the 07:30 holistic review (2/4 reports): please own a bounded, non-authoritative affected unit/integration preflight experiment on Mama before Studio full-suite admission. Measure early catches, added cost, red full-suite minutes and ready-to-green latency. Reply with the experiment owner and slot-conflict status.';

describe('MessagingToneGate — B22_AGENT_COORDINATION_TO_USER', () => {
  it('registers B22 as a behavioral-judgment rule with an advisory baseline', () => {
    expect(VALID_RULES.has('B22_AGENT_COORDINATION_TO_USER')).toBe(true);
    expect(RULE_CLASSES['B22_AGENT_COORDINATION_TO_USER']).toBe('behavioral-judgment');
    expect(RULE_DISPOSITIONS['B22_AGENT_COORDINATION_TO_USER']).toBe('advisory');
  });

  it('is advisory with the migration on AND off — never a hard wall on the fleet — and not self-stop exempt', () => {
    expect(ADVISORY_MIGRATION_EXEMPT_RULES.has('B22_AGENT_COORDINATION_TO_USER')).toBe(false);
    expect(resolveRuleDisposition('B22_AGENT_COORDINATION_TO_USER', true)).toBe('advisory');
    expect(resolveRuleDisposition('B22_AGENT_COORDINATION_TO_USER', false)).toBe('advisory');
  });

  it('renders the B22 rule, its meaning-judgment framing and its carve-outs in every prompt', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    await new MessagingToneGate(provider).review('Any candidate at all.', { channel: 'telegram' });
    const prompt = getPrompt();
    expect(prompt).toContain('B22_AGENT_COORDINATION_TO_USER');
    expect(prompt).toContain('AUDIENCE rule');
    expect(prompt).toContain('JUDGE BY MEANING');
    expect(prompt).toContain('intended READER is another agent, session, job, desk, worker');
    // Progress updates for the user stay allowed — the operator still wants them.
    expect(prompt).toContain('PROGRESS UPDATE for the user');
    expect(prompt).toContain('The user asked to see the internal message');
    expect(prompt).toContain('When uncertain, PASS.');
  });

  it('a B22 citation on the leaked coordination text is accepted (no fail-open) and holds it as an advisory', async () => {
    const { provider } = captureProvider({
      pass: false,
      rule: 'B22_AGENT_COORDINATION_TO_USER',
      issue: 'written to another session: assigns an experiment owner and asks for slot status',
      suggestion: 'send it to the throughput session directly; tell the user one line of progress if useful',
    });
    const result = await new MessagingToneGate(provider).review(LEAKED, { channel: 'telegram' });
    expect(result.pass).toBe(false);
    expect(result.rule).toBe('B22_AGENT_COORDINATION_TO_USER');
    expect(result.invalidRule).toBeFalsy();
    // Advisory: returned to the agent with the reason, never a terminal block.
    expect(result.advisory).toBe(true);
    expect(result.failedOpen).toBeFalsy();
  });

  it('a user-facing progress update that mentions sessions passes when the judge passes it', async () => {
    const { provider } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const result = await new MessagingToneGate(provider).review(
      'Update: I asked the throughput session to try a cheaper pre-check on the Mama PC before the big test run. I will tell you here whether it saves time.',
      { channel: 'telegram' },
    );
    expect(result.pass).toBe(true);
    expect(result.rule).toBeFalsy();
  });
});

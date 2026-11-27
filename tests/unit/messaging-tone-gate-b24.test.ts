/**
 * B24_OLD_VIEW_LINK (docs/specs/instar-document-viewer.md §3.9b): while documents replace pages,
 * an outgoing message that hands the reader an old-style page link is nudged back to the agent.
 * The rule is advisory and travels with its signal, so every other message's prompt is unchanged.
 */
import { describe, expect, it, vi } from 'vitest';
import { MessagingToneGate, RULE_CLASSES, RULE_DISPOSITIONS, VALID_RULES } from '../../src/core/MessagingToneGate.js';
import type { IntelligenceOptions, IntelligenceProvider } from '../../src/core/types.js';

function captureProvider(response: object) {
  let lastPrompt = '';
  const provider: IntelligenceProvider = {
    evaluate: vi.fn(async (prompt: string, _o?: IntelligenceOptions) => { lastPrompt = prompt; return JSON.stringify(response); }),
  };
  return { provider, getPrompt: () => lastPrompt };
}

const LINK = 'https://echo-mini.dawn-tunnel.dev/view/87217124-385f-4047-a28c-8eecfc82d279';

describe('MessagingToneGate — B24_OLD_VIEW_LINK', () => {
  it('is registered, judged by meaning and advisory', () => {
    expect(VALID_RULES.has('B24_OLD_VIEW_LINK')).toBe(true);
    expect(RULE_CLASSES['B24_OLD_VIEW_LINK']).toBe('behavioral-judgment');
    expect(RULE_DISPOSITIONS['B24_OLD_VIEW_LINK']).toBe('advisory');
  });

  it('adds the rule and the inert link only when the signal is present', async () => {
    const { provider, getPrompt } = captureProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const gate = new MessagingToneGate(provider);
    await gate.review(`The full list: ${LINK}`, { channel: 'telegram', signals: { oldViewLink: { detected: true, match: LINK } } } as never);
    expect(getPrompt()).toContain('B24_OLD_VIEW_LINK');
    expect(getPrompt()).toContain(JSON.stringify(LINK));
    expect(getPrompt()).toContain('fromView');
    expect(getPrompt()).toContain('ownership=unknown');
    await gate.review('An ordinary reply.', { channel: 'telegram' });
    expect(getPrompt()).not.toContain('B24_OLD_VIEW_LINK');
  });

  it('a B24 citation is a nudge (advisory), never a terminal block', async () => {
    const { provider } = captureProvider({ pass: false, rule: 'B24_OLD_VIEW_LINK', issue: 'old-style page link', suggestion: 'make it a document' });
    const r = await new MessagingToneGate(provider).review(`See ${LINK}`, { channel: 'telegram', signals: { oldViewLink: { detected: true, match: LINK } } } as never);
    expect(r.pass).toBe(false);
    expect(r.rule).toBe('B24_OLD_VIEW_LINK');
    expect(r.advisory).toBe(true);
  });
});

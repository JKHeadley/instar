/**
 * Bounded-input derivation review, batch 4 (STD-SUBCOUNTDOWN-bounded-input-derivation-review).
 * Behaviour pins:
 *  - the reply-necessity classifier, which can only SUPPRESS a reply, is not
 *    asked about a message too long to show whole: that message is replied to;
 *  - the Slack intent classifier and the conversation-brief prompt disclose a cut.
 */
import { describe, it, expect } from 'vitest';
import { WarrantsReplyGate, WARRANTS_REPLY_CLASSIFY_MAX_CHARS } from '../../src/threadline/WarrantsReplyGate.js';
import type { Conversation } from '../../src/threadline/ConversationStore.js';
import type { IntelligenceProvider } from '../../src/core/types.js';
import { LlmIntentClassifier } from '../../src/permissions/LlmIntentClassifier.js';
import { __testing as brief } from '../../src/threadline/openConversationBrief.js';
import { AmbientContributionGate } from '../../src/permissions/AmbientContributionGate.js';
import { buildHubIntentPrompt } from '../../src/threadline/HubIntentClassifier.js';
import { buildForensicPrompt } from '../../src/scheduler/MentorStageBForensics.js';

const conv = (partial: Partial<Conversation>): Conversation => {
  const now = new Date().toISOString();
  return { threadId: 't', version: 1, participants: { peers: ['peer'] }, state: 'active', pinned: false, messageCount: 1, turnCount: 0, createdAt: now, savedAt: now, lastActivityAt: now, ...partial };
};

describe('reply-necessity classifier refuses to suppress on a partial view', () => {
  const statement = 'the build status looks fine to me overall';
  let asked = 0;
  const intel = { evaluate: async () => { asked++; return 'NO_REPLY'; } } as unknown as IntelligenceProvider;
  const gate = new WarrantsReplyGate({ intelligence: intel });

  it('a short ambiguous message still reaches the classifier (and can be suppressed)', async () => {
    asked = 0;
    const v = await gate.evaluate({ threadId: 't', text: statement, humanInLoop: false, conversation: conv({ turnCount: 2, lastInboundHash: statement }) });
    expect(asked).toBe(1);
    expect(v.warrants).toBe(false);
  });

  it('a message over the bound is NOT classified and is replied to (a question after the cut cannot be silenced)', async () => {
    asked = 0;
    const long = `${statement} `.repeat(Math.ceil((WARRANTS_REPLY_CLASSIFY_MAX_CHARS + 50) / (statement.length + 1))).trim();
    expect(long.length).toBeGreaterThan(WARRANTS_REPLY_CLASSIFY_MAX_CHARS);
    const v = await gate.evaluate({ threadId: 't', text: long, humanInLoop: false, conversation: conv({ turnCount: 2, lastInboundHash: long }) });
    expect(asked).toBe(0);
    expect(v.warrants).toBe(true);
    expect(v.signal).toBe('too-long-to-classify'); // not mislabelled as a classifier verdict
  });

  it('the boundary: exactly the bound is classified, one more character is not', async () => {
    const at = 'deploys '.repeat(WARRANTS_REPLY_CLASSIFY_MAX_CHARS / 8); // whole words (a mid-word cut reads as novel)
    expect(at.length).toBe(WARRANTS_REPLY_CLASSIFY_MAX_CHARS);
    asked = 0;
    await gate.evaluate({ threadId: 't', text: at, humanInLoop: false, conversation: conv({ turnCount: 2, lastInboundHash: at }) });
    expect(asked).toBe(1);
    asked = 0;
    const over = `${at} `; // one more character, same words
    const v = await gate.evaluate({ threadId: 't', text: over, humanInLoop: false, conversation: conv({ turnCount: 2, lastInboundHash: over }) });
    expect(asked).toBe(0);
    expect(v.signal).toBe('too-long-to-classify');
  });
});

describe('cuts are disclosed to the model', () => {
  it('the Slack intent classifier is told a long message was cut', async () => {
    let seen = '';
    const c = new LlmIntentClassifier({
      intelligence: { evaluate: async (p: string) => { seen = p; return '{"action":"discuss","tier":1,"directed":true,"confidence":0.8}'; } } as unknown as IntelligenceProvider,
    });
    await c.classify(`could you summarize the thread? ${'context about the project. '.repeat(120)}`, { directed: true });
    expect(seen).toContain('LATER content was omitted');
  });

  it('the conversation-brief prompt discloses a cut message instead of a bare "…"', () => {
    const prompt = brief.buildLlmPrompt([{ direction: 'in', remoteAgentName: 'dawn', text: `${'detail '.repeat(300)}END-MARK` } as never]);
    expect(prompt).toContain('LATER content was omitted');
    expect(prompt).not.toContain('END-MARK');
  });

  it('the ambient-contribution gate is told an overheard message was cut', async () => {
    let seen = '';
    const gate = new AmbientContributionGate({
      config: { enabledChannelIds: ['C1'] },
      intelligence: { evaluate: async (p: string) => { seen = p; return '{"action":"silent","confidence":0.9,"reason":"chatter"}'; } } as unknown as IntelligenceProvider,
    } as never);
    await gate.decideAction({ channelId: 'C1', text: `has anyone seen the flaky test? ${'more chatter about it. '.repeat(120)}` });
    expect(seen).toContain('LATER content was omitted');
  });

  it('hub-intent context turns keep their configured content, disclose the cut, and stay one line each', () => {
    const prompt = buildHubIntentPrompt('open a topic for this', [], [{ fromUser: true, text: `${'word '.repeat(200)}TAIL` } as never], 4, 400);
    const line = prompt.split('\n').find((l) => l.startsWith('User: '))!;
    expect(line).toContain('word '.repeat(80).trim());
    expect(line).toContain('LATER content was omitted');
    expect(line).not.toContain('TAIL');
  });

  it('mentor forensics discloses cut signals (this cut was outside the lint)', () => {
    const p = buildForensicPrompt('codex', `## Recent server-log signals\n${'err line\n'.repeat(3000)}`);
    expect(p).toContain('LATER content was omitted');
    expect(p).toContain('## Recent server-log signals');
  });
});

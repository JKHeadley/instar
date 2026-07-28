/**
 * Unit tests for WarrantsReplyGate — Threadline Phase 1 keystone (spec §3).
 *
 * Both sides of every decision boundary, with realistic inputs:
 *  - control token / question / imperative ALWAYS reply (never suppressed);
 *  - pure ack with no novelty → suppress;
 *  - novelty: a genuine new question is forward progress; a paraphrased re-ask
 *    is NOT (deterministic layer flags it; the classifier is the authority);
 *  - novelty-gated turn budget: an ack-storm trips in ~2; a novel 30-turn
 *    collaboration never does; human-in-loop is exempt;
 *  - expectsReply bypasses suppression but NOT the budget;
 *  - control token bypasses the budget (terminal directives).
 */

import { describe, it, expect } from 'vitest';
import {
  WarrantsReplyGate,
  normalizeForNovelty,
  tokenSet,
  tokenSetSimilarity,
} from '../../src/threadline/WarrantsReplyGate.js';
import type { Conversation } from '../../src/threadline/ConversationStore.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

function conv(partial: Partial<Conversation>): Conversation {
  const now = new Date().toISOString();
  return {
    threadId: 't', version: 1, participants: { peers: ['peer'] }, state: 'active',
    pinned: false, messageCount: 1, turnCount: 0,
    createdAt: now, savedAt: now, lastActivityAt: now,
    ...partial,
  };
}

/** Stub intelligence that always returns the configured verdict. */
function stubIntel(reply: 'REPLY' | 'NO_REPLY'): IntelligenceProvider {
  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    evaluate: async (_prompt: string) => reply,
  } as unknown as IntelligenceProvider;
}

describe('WarrantsReplyGate — normalization helpers', () => {
  it('strips greetings/sign-offs and punctuation', () => {
    expect(normalizeForNovelty('Hey, can you check the build?')).toBe('can you check the build');
    expect(normalizeForNovelty('Looks good, thanks!')).toBe('looks good');
  });

  it('token-set similarity: identical = 1, disjoint = 0', () => {
    expect(tokenSetSimilarity(tokenSet('check the build'), tokenSet('check the build'))).toBe(1);
    expect(tokenSetSimilarity(tokenSet('check the build'), tokenSet('deploy now'))).toBe(0);
  });
});

describe('WarrantsReplyGate — decisive signals always reply', () => {
  const gate = new WarrantsReplyGate();

  it('control token replies even past the budget', async () => {
    const v = await gate.evaluate({
      threadId: 't', text: 'proceed', humanInLoop: false,
      conversation: conv({ turnCount: 20, lastInboundHash: 'proceed' }),
    });
    expect(v.warrants).toBe(true);
    expect(v.signal).toBe('control-token');
  });

  it('question always replies', async () => {
    const v = await gate.evaluate({ threadId: 't', text: 'What is the status of the merge?', humanInLoop: false, conversation: conv({ turnCount: 1, lastInboundHash: 'foo' }) });
    expect(v.warrants).toBe(true);
    expect(v.signal).toBe('question');
  });

  it('imperative always replies', async () => {
    const v = await gate.evaluate({ threadId: 't', text: 'Run the integration suite and report back', humanInLoop: false, conversation: conv({ turnCount: 1, lastInboundHash: 'foo' }) });
    expect(v.warrants).toBe(true);
    expect(v.signal).toBe('imperative');
  });
});

describe('WarrantsReplyGate — pure acks suppressed', () => {
  const gate = new WarrantsReplyGate();

  it('a content-free ack mid-thread does NOT reply', async () => {
    const v = await gate.evaluate({
      threadId: 't', text: 'Thanks, got it!', humanInLoop: false,
      conversation: conv({ turnCount: 2, lastInboundHash: 'thanks got it' }),
    });
    expect(v.warrants).toBe(false);
    expect(v.signal).toBe('pure-ack');
  });

  it('the auto-ack "Message received. Composing response..." does NOT reply', async () => {
    const v = await gate.evaluate({
      threadId: 't', text: 'Message received. Composing response...', humanInLoop: false,
      conversation: conv({ turnCount: 3, lastInboundHash: 'message received composing response' }),
    });
    expect(v.warrants).toBe(false);
    expect(v.signal).toBe('pure-ack');
  });

  it('first contact replies even to an ack (writes a row / responsive)', async () => {
    const v = await gate.evaluate({ threadId: 't', text: 'thanks', humanInLoop: false, conversation: null });
    expect(v.warrants).toBe(true);
    expect(v.signal).toBe('first-contact');
  });
});

describe('WarrantsReplyGate — novelty', () => {
  const gate = new WarrantsReplyGate({ intelligence: stubIntel('NO_REPLY') });

  it('a genuinely new question is forward progress', async () => {
    const v = await gate.evaluate({
      threadId: 't', text: 'How did the deploy go?', humanInLoop: false,
      conversation: conv({ turnCount: 2, lastInboundHash: 'check the build status' }),
    });
    expect(v.warrants).toBe(true);
  });

  it('novel non-question content replies', async () => {
    const v = await gate.evaluate({
      threadId: 't', text: 'The migration touched forty files across three modules', humanInLoop: false,
      conversation: conv({ turnCount: 2, lastInboundHash: 'check the build status' }),
    });
    expect(v.warrants).toBe(true);
    expect(v.signal).toBe('novel');
  });

  it('a near-duplicate non-ack statement falls to the classifier (suppresses here)', async () => {
    const v = await gate.evaluate({
      threadId: 't', text: 'the build status looks fine to me overall', humanInLoop: false,
      conversation: conv({ turnCount: 2, lastInboundHash: 'the build status looks fine to me overall' }),
    });
    // Not novel, not a control/question/imperative, not pure-ack vocab →
    // ambiguous → classifier authority (stubbed NO_REPLY) suppresses.
    expect(v.warrants).toBe(false);
    expect(v.signal).toBe('classifier-no-reply');
  });
});

describe('WarrantsReplyGate — turn budget', () => {
  it('an ack-storm trips the budget fast (suppressed past cap, no novelty)', async () => {
    const gate = new WarrantsReplyGate({ softCap: 2 });
    // A non-ack, non-novel statement past the soft cap is budget-exhausted.
    const v = await gate.evaluate({
      threadId: 't', text: 'i still think the build status looks fine overall here', humanInLoop: false,
      conversation: conv({ turnCount: 2, lastInboundHash: 'i still think the build status looks fine overall here' }),
    });
    expect(v.warrants).toBe(false);
    expect(v.signal).toBe('budget-exhausted');
    expect(v.budgetExhausted).toBe(true);
  });

  it('a novel 30-turn collaboration never trips the budget', async () => {
    const gate = new WarrantsReplyGate();
    const v = await gate.evaluate({
      threadId: 't', text: 'Next, lets tackle the SQLite WAL contention in the poller', humanInLoop: false,
      conversation: conv({ turnCount: 30, lastInboundHash: 'earlier we discussed the relay handshake timeout' }),
    });
    expect(v.warrants).toBe(true);
    expect(v.signal).toBe('novel');
  });

  it('human-in-loop is exempt from the budget and stays instant', async () => {
    const gate = new WarrantsReplyGate({ softCap: 2 });
    const v = await gate.evaluate({
      threadId: 't', text: 'thanks', humanInLoop: true,
      conversation: conv({ turnCount: 20, lastInboundHash: 'thanks' }),
    });
    expect(v.warrants).toBe(true);
    expect(v.signal).toBe('human-in-loop');
  });

  it('control token bypasses the budget (terminal directive)', async () => {
    const gate = new WarrantsReplyGate({ softCap: 2 });
    const v = await gate.evaluate({
      threadId: 't', text: 'stop', humanInLoop: false,
      conversation: conv({ turnCount: 20, lastInboundHash: 'stop' }),
    });
    expect(v.warrants).toBe(true);
    expect(v.signal).toBe('control-token');
  });

  it('expectsReply bypasses suppression but NOT the budget', async () => {
    const gate = new WarrantsReplyGate({ softCap: 2 });
    // Past cap, non-novel, expectsReply set → budget still wins.
    const exhausted = await gate.evaluate({
      threadId: 't', text: 'pinging you again about the same non novel thing here', expectsReply: true, humanInLoop: false,
      conversation: conv({ turnCount: 5, lastInboundHash: 'pinging you again about the same non novel thing here' }),
    });
    expect(exhausted.warrants).toBe(false);
    expect(exhausted.signal).toBe('budget-exhausted');

    // Under cap, a pure ack with expectsReply DOES reply (bypasses ack suppression).
    const forced = await gate.evaluate({
      threadId: 't', text: 'thanks', expectsReply: true, humanInLoop: false,
      conversation: conv({ turnCount: 1, lastInboundHash: 'thanks' }),
    });
    expect(forced.warrants).toBe(true);
    expect(forced.signal).toBe('expects-reply');
  });
});

describe('WarrantsReplyGate — authority layer', () => {
  it('classifier REPLY verdict on ambiguous non-novel content replies', async () => {
    const gate = new WarrantsReplyGate({ intelligence: stubIntel('REPLY') });
    const v = await gate.evaluate({
      threadId: 't', text: 'the build status looks fine to me overall', humanInLoop: false,
      conversation: conv({ turnCount: 2, lastInboundHash: 'the build status looks fine to me overall' }),
    });
    expect(v.warrants).toBe(true);
    expect(v.signal).toBe('classifier-reply');
  });

  it('no intelligence available → fail toward responsive', async () => {
    const gate = new WarrantsReplyGate();
    const v = await gate.evaluate({
      threadId: 't', text: 'the build status looks fine to me overall', humanInLoop: false,
      conversation: conv({ turnCount: 2, lastInboundHash: 'the build status looks fine to me overall' }),
    });
    expect(v.warrants).toBe(true);
  });
});

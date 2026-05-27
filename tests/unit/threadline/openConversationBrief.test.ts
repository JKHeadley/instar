/**
 * Unit tests for generateConversationBrief (CMT-567) — the 3-tier brief
 * (LLM → template → slug) for "open this". Covers both sides of every
 * degradation boundary + the never-empty invariant.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  generateConversationBrief,
  type BriefDeps,
  type BriefConversation,
  __testing,
} from '../../../src/threadline/openConversationBrief.js';

const NOW = Date.parse('2026-05-27T20:00:00Z');

function makeConv(over: Partial<BriefConversation> = {}): BriefConversation {
  return {
    remoteAgent: 'instar-codey',
    participants: { peers: ['codey-fp'] },
    messageCount: 5,
    lastActivityAt: '2026-05-27T19:58:00Z',
    lastInboundHash: 'last inbound text',
    ...over,
  };
}

function makeMessages(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    direction: (i % 2 === 0 ? 'in' : 'out') as 'in' | 'out',
    text: `message ${i}`,
    remoteAgentName: 'Codey',
    timestamp: `2026-05-27T19:${String(10 + i).padStart(2, '0')}:00Z`,
  }));
}

function makeDeps(over: Partial<BriefDeps> = {}): BriefDeps {
  return {
    observability: { getThread: () => ({ messages: makeMessages(4) }) },
    llmQueue: { enqueue: async (_lane, fn) => fn(new AbortController().signal) } as unknown as BriefDeps['llmQueue'],
    intelligence: { evaluate: async () => 'PURPOSE: OAuth refresh failure triage\n\nCodey flagged a token-refresh bug. Decision pending on the retry window.' },
    topicNameFallback: () => 'instar-codey · abcd1234',
    now: () => NOW,
    ...over,
  };
}

describe('generateConversationBrief — Tier A (LLM)', () => {
  it('happy path: PURPOSE → name, body → summary, source=llm', async () => {
    const b = await generateConversationBrief('t1', makeConv(), makeDeps());
    expect(b.topicName).toBe('OAuth refresh failure triage');
    expect(b.summary).toContain('Codey flagged a token-refresh bug');
    expect(b.nameSource).toBe('llm');
    expect(b.summarySource).toBe('llm');
    expect(b.reason).toBe('ok');
  });

  it('PURPOSE present but body empty → name from PURPOSE, summary = template (never the PURPOSE echo)', async () => {
    const deps = makeDeps({ intelligence: { evaluate: async () => 'PURPOSE: Some title here' } });
    const b = await generateConversationBrief('t1', makeConv(), deps);
    expect(b.nameSource).toBe('llm');
    expect(b.topicName).toBe('Some title here');
    expect(b.summary).not.toMatch(/^PURPOSE:/i);
    expect(b.summarySource).toBe('template');
  });

  it('no PURPOSE line but a real body → name degrades to slug, summary = body', async () => {
    const deps = makeDeps({ intelligence: { evaluate: async () => 'Just a plain summary with no purpose line at all.' } });
    const b = await generateConversationBrief('t1', makeConv(), deps);
    expect(b.nameSource).toBe('slug');
    expect(b.summarySource).toBe('llm');
    expect(b.summary).toContain('plain summary');
  });

  it('PURPOSE > 40 chars → name trimmed to 40 on a word boundary (no mid-word cut)', async () => {
    const long = 'PURPOSE: Free text guard hook template path resolution fix\n\nbody text here for the summary.';
    const deps = makeDeps({ intelligence: { evaluate: async () => long } });
    const b = await generateConversationBrief('t1', makeConv(), deps);
    expect(b.topicName.length).toBeLessThanOrEqual(40);
    expect(b.nameSource).toBe('llm');
    // Does not end mid-word (the slice backed off to the last space).
    expect(b.topicName.endsWith('resol')).toBe(false);
    expect(/\s$/.test(b.topicName)).toBe(false);
    expect(long).toContain(b.topicName); // it's a clean prefix of the PURPOSE words
  });

  it('credential in PURPOSE → name degrades to slug; clean body still used', async () => {
    const deps = makeDeps({ intelligence: { evaluate: async () => 'PURPOSE: sk-secret-key-leak\n\nA normal clean summary body.' } });
    const b = await generateConversationBrief('t1', makeConv(), deps);
    expect(b.nameSource).toBe('slug');
    expect(b.summarySource).toBe('llm');
    expect(b.reason).toBe('credential-scrub');
  });

  it('credential VALUE in body → summary degrades to template; clean name kept', async () => {
    const deps = makeDeps({ intelligence: { evaluate: async () => 'PURPOSE: Clean title\n\nThey shared a Slack token xoxb-1234567890-abcdefghij here.' } });
    const b = await generateConversationBrief('t1', makeConv(), deps);
    expect(b.nameSource).toBe('llm');
    expect(b.topicName).toBe('Clean title');
    expect(b.summarySource).toBe('template');
    expect(b.reason).toBe('credential-scrub');
  });

  it('topic vocabulary ("token refresh", "API key rotation") is NOT scrubbed', async () => {
    const deps = makeDeps({ intelligence: { evaluate: async () => 'PURPOSE: Token refresh + API key rotation\n\nCodey is debugging the token refresh flow and the API key rotation schedule.' } });
    const b = await generateConversationBrief('t1', makeConv(), deps);
    expect(b.nameSource).toBe('llm');
    expect(b.summarySource).toBe('llm');
    expect(b.summary).toContain('token refresh flow');
    expect(b.reason).toBe('ok');
  });

  it('LLM timeout → Tier B (template + slug)', async () => {
    const deps = makeDeps({ intelligence: { evaluate: async () => { throw new Error('LLM timeout'); } } });
    const b = await generateConversationBrief('t1', makeConv(), deps);
    expect(b.summarySource).toBe('template');
    expect(b.nameSource).toBe('slug');
    expect(b.reason).toBe('llm-timeout');
  });

  it('LLM abort → Tier B, reason=llm-abort', async () => {
    const deps = makeDeps({ intelligence: { evaluate: async () => { throw new Error('LLM aborted by higher-priority lane'); } } });
    const b = await generateConversationBrief('t1', makeConv(), deps);
    expect(b.reason).toBe('llm-abort');
    expect(b.summarySource).toBe('template');
  });

  it('LLM daily cap exceeded (rejected by queue) → Tier B, reason=llm-capped', async () => {
    const deps = makeDeps({
      llmQueue: { enqueue: async () => { throw new Error('LLM daily spend cap exceeded'); } } as unknown as BriefDeps['llmQueue'],
    });
    const b = await generateConversationBrief('t1', makeConv(), deps);
    expect(b.reason).toBe('llm-capped');
    expect(b.summarySource).toBe('template');
  });

  it('LLM returns empty/whitespace → Tier B, reason=parse-empty', async () => {
    const deps = makeDeps({ intelligence: { evaluate: async () => '   ' } });
    const b = await generateConversationBrief('t1', makeConv(), deps);
    expect(b.reason).toBe('parse-empty');
    expect(b.summarySource).toBe('template');
  });

  it('truncates a 50-message thread to the last 10 in the prompt', async () => {
    const captured: string[] = [];
    const deps = makeDeps({
      observability: { getThread: () => ({ messages: makeMessages(50) }) },
      intelligence: { evaluate: async (p: string) => { captured.push(p); return 'PURPOSE: t\n\nbody.'; } },
    });
    await generateConversationBrief('t1', makeConv(), deps);
    expect(captured[0]).toContain('message 49');
    expect(captured[0]).not.toContain('message 39');
  });
});

describe('generateConversationBrief — Tier B (template)', () => {
  it('intelligence null → template summary, no LLM call', async () => {
    const evaluate = vi.fn();
    const b = await generateConversationBrief('t1', makeConv(), makeDeps({ intelligence: null }));
    expect(b.reason).toBe('no-deps');
    expect(b.summarySource).toBe('template');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('llmQueue null → template summary, no LLM call', async () => {
    const b = await generateConversationBrief('t1', makeConv(), makeDeps({ llmQueue: null }));
    expect(b.reason).toBe('no-deps');
    expect(b.summarySource).toBe('template');
  });

  it('single message → template "just getting started", NO LLM call', async () => {
    const evaluate = vi.fn(async () => 'PURPOSE: x\n\ny');
    const deps = makeDeps({
      observability: { getThread: () => ({ messages: [{ direction: 'in', text: 'hi there', remoteAgentName: 'Codey', timestamp: '2026-05-27T19:00:00Z' }] }) },
      intelligence: { evaluate },
    });
    const b = await generateConversationBrief('t1', makeConv({ messageCount: 1 }), deps);
    expect(b.reason).toBe('too-few-messages');
    expect(b.summary).toContain('Opening message');
    expect(b.summary).toContain('hi there');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('template scrubs a credential out of the inbound snippet', async () => {
    const deps = makeDeps({
      llmQueue: null,
      observability: { getThread: () => ({ messages: makeMessages(2).map((m, i) => i === 1 ? m : { ...m, direction: 'in' as const, text: 'my key is sk-abc123def456' }) }) },
    });
    const b = await generateConversationBrief('t1', makeConv(), deps);
    expect(b.summary).not.toContain('sk-abc123def');
  });
});

describe('generateConversationBrief — Tier C (slug, no conversation)', () => {
  it('conv null → slug + legacy marker, NO LLM call', async () => {
    const evaluate = vi.fn();
    const b = await generateConversationBrief('t1', null, makeDeps({ intelligence: { evaluate } }));
    expect(b.nameSource).toBe('slug');
    expect(b.summarySource).toBe('slug');
    expect(b.reason).toBe('no-conversation');
    expect(b.summary).toBe(__testing.LEGACY_MARKER);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('conversation exists but zero messages → slug + legacy marker', async () => {
    const deps = makeDeps({ observability: { getThread: () => ({ messages: [] }) } });
    const b = await generateConversationBrief('t1', makeConv(), deps);
    expect(b.reason).toBe('no-conversation');
    expect(b.summary).toBe(__testing.LEGACY_MARKER);
  });
});

describe('generateConversationBrief — never-empty invariant', () => {
  it('topicName and summary are non-empty across tiers, including empty threadId', async () => {
    const variants: BriefDeps[] = [
      makeDeps(),
      makeDeps({ intelligence: null }),
      makeDeps({ llmQueue: null }),
      makeDeps({ observability: { getThread: () => ({ messages: [] }) } }),
    ];
    for (const deps of variants) {
      for (const tid of ['t1', '', '   ']) {
        const b = await generateConversationBrief(tid, makeConv(), deps);
        expect(b.topicName.length).toBeGreaterThan(0);
        expect(b.summary.length).toBeGreaterThan(0);
      }
    }
  });
});

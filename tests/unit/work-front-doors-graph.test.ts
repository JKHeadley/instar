import { describe, it, expect } from 'vitest';
import { cosConversationRef, cardPlacementsFromBoard, projectSuggestionSources } from '../../src/core/workFrontDoorsGraph.js';
import { nodeKey } from '../../src/core/conversationGraph.js';

describe('cosConversationRef', () => {
  it('maps telegram and app keys; telegram needs the chat id; other kinds have no ref yet', () => {
    expect(cosConversationRef('telegram:142909', '-1001')).toEqual({ kind: 'conversation', platform: 'telegram', chatId: '-1001', topicId: 142909 });
    expect(cosConversationRef('telegram:142909', '')).toBeNull();
    expect(cosConversationRef('app:a930b2a4-5276-4540-b0a0-59fbbb3606ac', '')).toEqual({ kind: 'conversation', platform: 'app', conversationKey: 'a930b2a4-5276-4540-b0a0-59fbbb3606ac' });
    expect(cosConversationRef('slack:C1:123.4', '-1001')).toBeNull();
    expect(cosConversationRef('telegram:abc', '-1001')).toBeNull();
  });
});

describe('cardPlacementsFromBoard', () => {
  const card = (status: string, projectKey: string | null, created = true) => ({ status, card: { created, projectKey, conversationKey: `conv-${status}-${projectKey ?? 'none'}` } });
  const board = (views: Record<string, ReturnType<typeof card> | null>) => ({ cardIds: () => Object.keys(views), view: (id: string) => views[id] ?? null });

  it('lists each open card with a project; done, archived, removed, uncreated and projectless cards drop off', () => {
    const out = cardPlacementsFromBoard(board({
      a: card('needs-approval', 'telegram:5'), b: card('done', 'telegram:5'), c: card('archived', 'telegram:5'), d: card('removed', 'telegram:5'),
      e: card('held', null), f: card('parked', 'app:proj-1'), g: card('needs-approval', 'telegram:5', false), h: null, i: card('claims-done', 'slack:C1:1'),
    }), '-1001');
    expect(out).toEqual([
      { card: { kind: 'conversation', platform: 'app', conversationKey: 'conv-needs-approval-telegram:5' }, project: { kind: 'conversation', platform: 'telegram', chatId: '-1001', topicId: 5 } },
      { card: { kind: 'conversation', platform: 'app', conversationKey: 'conv-parked-app:proj-1' }, project: { kind: 'conversation', platform: 'app', conversationKey: 'proj-1' } },
    ]);
  });
});

describe('projectSuggestionSources', () => {
  it('each bound project with its graph key and its tree children; unmapped projects and children are skipped', () => {
    const loop = {
      projectsSummary: () => [{ conversationKey: 'telegram:42', title: 'Ship the thing' }, { conversationKey: 'slack:C1:1', title: 'Slack one' }],
      tree: () => new Map([
        ['telegram:43', { conversationKey: 'telegram:43', parentConversationKey: 'telegram:42' }],
        ['slack:C2:9', { conversationKey: 'slack:C2:9', parentConversationKey: 'telegram:42' }],
        ['telegram:50', { conversationKey: 'telegram:50', parentConversationKey: null }],
      ]),
    };
    const out = projectSuggestionSources(loop, '-1001');
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Ship the thing');
    expect(out[0].key).toBe(nodeKey({ kind: 'conversation', platform: 'telegram', chatId: '-1001', topicId: 42 }));
    expect(out[0].children.map((c) => (c.ref as { topicId: number }).topicId)).toEqual([43]);
  });
});

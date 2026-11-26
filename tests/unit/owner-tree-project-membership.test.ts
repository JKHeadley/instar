import { expect, it } from 'vitest';
import { nodeKey, type ConversationRef } from '../../src/core/conversationGraph.js';
import { ownerTreeProjectMembership } from '../../src/core/ownerTreeProjectMembership.js';

const topic = (topicId: number): ConversationRef => ({ kind: 'conversation', platform: 'telegram', chatId: '-100123', topicId });

it('classifies confirmed ancestry and explicit roots while withholding missing or invisible evidence', () => {
  const app: ConversationRef = { kind: 'conversation', platform: 'app', conversationKey: '8dd76d04-3e1d-4784-9f9e-d70635910f3c' };
  const refs = [...[1, 2, 3, 4, 5, 6].map(topic), app];
  const snapshot = {
    version: 'test', complete: true, confirmedProjects: new Set(['telegram:1']),
    parents: new Map<string, string | null>([
      ['telegram:2', 'telegram:1'], ['telegram:3', 'telegram:2'], ['telegram:4', null],
      ['telegram:5', 'telegram:99'],
    ]),
  };
  expect(ownerTreeProjectMembership(refs, snapshot)).toEqual(new Map([
    [nodeKey(topic(1)), 'telegram:1'], [nodeKey(topic(2)), { projectConversationKey: 'telegram:1', parentNodeKey: nodeKey(topic(1)) }],
    [nodeKey(topic(3)), { projectConversationKey: 'telegram:1', parentNodeKey: nodeKey(topic(2)) }],
    [nodeKey(topic(4)), null], [nodeKey(topic(6)), null],
  ]));
  expect(ownerTreeProjectMembership(refs, { ...snapshot, complete: false })).toBeNull();
});

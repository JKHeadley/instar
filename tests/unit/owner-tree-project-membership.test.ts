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

it('places a chat nested under a non-project root, such as the Chief of Staff topic, outside every project', () => {
  const app = (conversationKey: string): ConversationRef => ({ kind: 'conversation', platform: 'app', conversationKey });
  const chief = topic(10), child = topic(11), grandchild = topic(12), appUnderChild = app('0f1e2d3c-4b5a-6978-8a9b-acbdcedf0011');
  const unrecordedTop = topic(20), underUnrecorded = topic(21), underInvisible = topic(30);
  const refs = [chief, child, grandchild, appUnderChild, unrecordedTop, underUnrecorded, underInvisible];
  const snapshot = {
    version: 'test', complete: true, confirmedProjects: new Set<string>(),
    parents: new Map<string, string | null>([
      ['telegram:10', null], ['telegram:11', 'telegram:10'], ['telegram:12', 'telegram:11'],
      ['app:0f1e2d3c-4b5a-6978-8a9b-acbdcedf0011', 'telegram:11'],
      ['telegram:21', 'telegram:20'], ['telegram:30', 'telegram:99'],
    ]),
  };
  expect(ownerTreeProjectMembership(refs, snapshot)).toEqual(new Map([
    [nodeKey(chief), null], [nodeKey(child), null], [nodeKey(grandchild), null], [nodeKey(appUnderChild), null],
    [nodeKey(unrecordedTop), null], [nodeKey(underUnrecorded), null],
  ]));
});

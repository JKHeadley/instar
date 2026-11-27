import { describe, it, expect } from 'vitest';
import { localConversationListPage, type MobileConversationRouteDeps } from '../../src/server/mobileConversationRoutes.js';

// While the Telegram preview index is still building, the Telegram source marks its rows
// partial: every topic is still listed, but the page says it is incomplete, so a reader such as
// the conversation graph inventory does not record a missing preview as "no activity"
// (review of the 2026-11-27 conversation-list stall fix).
function deps(topics: () => ReturnType<NonNullable<MobileConversationRouteDeps['telegramTopics']>>): MobileConversationRouteDeps {
  return {
    config: {} as never, pairing: null as never, machineId: () => 'm1',
    service: { store: { listConversations: () => ({ conversations: [], nextCursor: null }) } } as never,
    telegramTopics: topics,
  } as MobileConversationRouteDeps;
}
const rows = [
  { topicId: 1, topicName: 'known', lastActivity: '2026-11-27T10:00:00.000Z', lastPreview: 'hi' },
  { topicId: 2, topicName: 'not indexed yet', lastActivity: null, lastPreview: null },
];

describe('conversation list with previews still being indexed', () => {
  it('lists every topic and marks the page partial', () => {
    const page = localConversationListPage(deps(() => Object.assign([...rows], { partial: true as const })), 50, null);
    expect(page.rows.map((r) => r.id)).toEqual([1, 2]);
    expect(page.partial).toBe(true);
  });

  it('is complete once every preview is known', () => {
    const page = localConversationListPage(deps(() => [...rows]), 50, null);
    expect(page.rows).toHaveLength(2);
    expect(page.partial).toBe(false);
  });
});

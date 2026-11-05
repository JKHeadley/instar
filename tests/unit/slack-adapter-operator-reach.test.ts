/**
 * SlackAdapter pieces the dead-key recovery needs: who of the agent's people reads a channel,
 * a direct message to one person, and a conversation's latest messages read from Slack itself.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';

function adapter(api: (method: string, params: Record<string, unknown>) => Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-reach-'));
  const a = new SlackAdapter({ botToken: 'xoxb-test', appToken: 'xapp-test', authorizedUserIds: ['U_JUSTIN', 'U_DAWN'], workspaceMode: 'dedicated' } as never, dir);
  const calls: Array<[string, Record<string, unknown>]> = [];
  (a as unknown as { apiClient: { call: (m: string, p: Record<string, unknown>) => Promise<Record<string, unknown>> } }).apiClient.call =
    async (m, p) => { calls.push([m, p]); return { ok: true, ...api(m, p) }; };
  return { a, calls };
}

describe('SlackAdapter operator reach', () => {
  it('lists only the agent\'s people who are members, across pages', async () => {
    const { a } = adapter((m, p) => (m === 'conversations.members'
      ? (p.cursor ? { members: ['U_DAWN'] } : { members: ['U_BOT', 'U_OTHER'], response_metadata: { next_cursor: 'next' } })
      : {}));
    expect(await a.authorizedMembersOf('C_ALERTS')).toEqual(['U_DAWN']);
  });

  it('an alert channel with only the bot in it has no readers (the drill fault)', async () => {
    const { a } = adapter(() => ({ members: ['U_BOT'] }));
    expect(await a.authorizedMembersOf('C_ALERTS')).toEqual([]);
  });

  it('a direct message opens the conversation and posts into it', async () => {
    const { a, calls } = adapter((m) => (m === 'conversations.open' ? { channel: { id: 'D_JUSTIN' } } : m === 'chat.postMessage' ? { ts: '1.2' } : {}));
    await a.sendDirectMessage('U_JUSTIN', 'key rejected');
    expect(calls[0]).toEqual(['conversations.open', { users: 'U_JUSTIN' }]);
    const post = calls.find(([m]) => m === 'chat.postMessage');
    expect(post?.[1]).toMatchObject({ channel: 'D_JUSTIN' });
  });

  it('a direct message that cannot be opened throws, so it is not counted as delivered', async () => {
    const { a } = adapter(() => ({}));
    await expect(a.sendDirectMessage('U_JUSTIN', 'x')).rejects.toThrow();
  });

  it('a long thread is walked to its end, so the latest reply is seen', async () => {
    const page = (from: number) => Array.from({ length: 200 }, (_, i) => ({ ts: `${from + i}.0`, user: 'U_DAWN', text: `r${from + i}` }));
    const { a } = adapter((m, p) => (m === 'conversations.replies'
      ? (p.cursor ? { messages: page(200).slice(0, 30) } : { messages: page(0), response_metadata: { next_cursor: 'more' } })
      : {}));
    const got = await a.recentConversationMessages('C_ROOM:0.0', 50);
    expect(got).toHaveLength(50);
    expect(got.at(-1)?.text).toBe('r229');
  });

  it('a channel key also reads the thread its latest message came from', async () => {
    const { a } = adapter((m) => (m === 'conversations.replies'
      ? { messages: [{ ts: '5.0', user: 'U_DAWN', text: 'root' }, { ts: '7.0', user: 'U_BOT', text: 'answer in thread', thread_ts: '5.0', bot_id: 'B1' }] }
      : { messages: [{ ts: '6.0', user: 'U_DAWN', text: 'top' }, { ts: '5.0', user: 'U_DAWN', text: 'root' }] }));
    a.noteInboundThread('C_ROOM', '5.0');
    const got = await a.recentConversationMessages('C_ROOM');
    expect(got.map((m) => m.text)).toEqual(['root', 'top', 'answer in thread']);
  });

  it('a thread key reads the thread replies; a channel key reads the channel', async () => {
    const { a, calls } = adapter((m) => (m === 'conversations.replies'
      ? { messages: [{ ts: '1.0', user: 'U_DAWN', text: 'root' }, { ts: '1.1', user: 'U_DAWN', text: 'DAWN-ONE', thread_ts: '1.0' }] }
      : { messages: [{ ts: '2.0', user: 'U_DAWN', text: 'newest' }, { ts: '1.0', user: 'U_DAWN', text: 'older' }] }));
    const thread = await a.recentConversationMessages('C_ROOM:1.0');
    expect(thread.map((m) => m.text)).toEqual(['root', 'DAWN-ONE']);
    expect(calls[0]).toEqual(['conversations.replies', { channel: 'C_ROOM', ts: '1.0', limit: 200 }]);
    const channel = await a.recentConversationMessages('C_ROOM');
    expect(channel.map((m) => m.text)).toEqual(['older', 'newest']);
  });
});

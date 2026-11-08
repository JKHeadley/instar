import { describe, expect, it, vi } from 'vitest';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';
import { ChannelManager } from '../../src/messaging/slack/ChannelManager.js';

describe('Slack recovery history routing', () => {
  const messages = [
    { ts: '100.0', channel: 'C1', user: 'person', text: 'channel turn' },
    { ts: '101.0', channel: 'C1', user: 'person', text: 'thread root', thread_ts: '101.0' },
    { ts: '102.0', channel: 'C1', user: 'person', text: 'thread reply', thread_ts: '101.0' },
    { ts: '103.0', channel: 'C1', user: 'bot', text: 'thread answer', thread_ts: '101.0' },
  ];

  function adapter(cached: typeof messages) {
    const a = Object.create(SlackAdapter.prototype) as SlackAdapter;
    (a as any).isThreadRoutingEnabled = () => true;
    (a as any).getChannelMessages = () => cached;
    return a;
  }

  it('excludes unrelated thread replies from the channel conversation', async () => {
    const a = adapter(messages);
    expect((await a.getConversationMessagesWithFallback('C1')).map(m => m.text))
      .toEqual(['channel turn', 'thread root']);
  });

  it('uses conversations.replies after restart when no thread messages are cached', async () => {
    const api = { call: vi.fn(async () => ({ messages: messages.slice(1) })) };
    const a = adapter(messages.slice(0, 2));
    (a as any).channelManager = new ChannelManager(api as any, 'test');
    expect((await a.getConversationMessagesWithFallback('C1:101.0')).map(m => m.text))
      .toEqual(['thread root', 'thread reply', 'thread answer']);
    expect(api.call).toHaveBeenCalledWith('conversations.replies', { channel: 'C1', ts: '101.0', limit: 30 });
  });

  it('fetches earlier thread context even when the new inbound reply is cached', async () => {
    const api = { call: vi.fn(async () => ({ messages: messages.slice(1) })) };
    const a = adapter(messages.slice(2, 3));
    (a as any).channelManager = new ChannelManager(api as any, 'test');
    expect((await a.getConversationMessagesWithFallback('C1:101.0')).map(m => m.text))
      .toEqual(['thread root', 'thread reply', 'thread answer']);
    expect(api.call).toHaveBeenCalledOnce();
  });
});

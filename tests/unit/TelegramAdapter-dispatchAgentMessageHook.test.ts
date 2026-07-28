/**
 * Tier-1 unit tests for `TelegramAdapter.dispatchAgentMessageHook` —
 * the public dispatcher that lets external callers (notably the
 * /internal/telegram-forward handler in send-only mode, where the adapter
 * doesn't poll) invoke the same a2a-hook gate the polling path uses.
 *
 * Covers:
 *   - returns false when no hook is installed (no-op safe)
 *   - returns true and invokes the hook when one is installed + handled
 *   - returns false when the hook errors (fail-OPEN to user routing, never
 *     crashes the dispatch pipeline)
 *   - derives senderBotId correctly per spec §Recipient side (sender_chat
 *     wins; falls back to rawFromId iff senderIsBot)
 *   - omits senderBotId for human users (rawFromId without senderIsBot)
 */
import { describe, it, expect, vi } from 'vitest';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';

function adapter(): TelegramAdapter {
  return new TelegramAdapter(
    { token: 'fake-token', chatId: '-1001234567890' } as never,
    '/tmp/fake-state-dir-' + Math.random().toString(36).slice(2, 10),
  );
}

describe('TelegramAdapter.dispatchAgentMessageHook', () => {
  it('returns false (no-op) when no hook is installed', async () => {
    const a = adapter();
    const handled = await a.dispatchAgentMessageHook({
      text: 'hi', topicId: 1, senderIsBot: true, rawFromId: '123',
    });
    expect(handled).toBe(false);
  });

  it('returns true when hook returns handled:true', async () => {
    const a = adapter();
    const hook = vi.fn().mockResolvedValue({ handled: true });
    a.setAgentMessageHook(hook);
    const handled = await a.dispatchAgentMessageHook({
      text: 'hi', topicId: 1, senderIsBot: true, rawFromId: '123',
    });
    expect(handled).toBe(true);
    expect(hook).toHaveBeenCalledOnce();
  });

  it('returns false when hook returns handled:false (fall through to user routing)', async () => {
    const a = adapter();
    a.setAgentMessageHook(vi.fn().mockResolvedValue({ handled: false }));
    const handled = await a.dispatchAgentMessageHook({
      text: 'no marker here', topicId: 1, senderIsBot: false, rawFromId: '7',
    });
    expect(handled).toBe(false);
  });

  it('FAIL-OPEN: hook throw → returns false + does not propagate (a broken hook never freezes the pipeline)', async () => {
    const a = adapter();
    a.setAgentMessageHook(vi.fn().mockRejectedValue(new Error('hook is broken')));
    const handled = await a.dispatchAgentMessageHook({
      text: 'hi', topicId: 1, senderIsBot: true, rawFromId: '123',
    });
    expect(handled).toBe(false);
  });

  it('derives senderBotId from sender_chat.id when present (group bot-as-channel relay)', async () => {
    const a = adapter();
    let received: Record<string, unknown> | undefined;
    a.setAgentMessageHook(async (ctx) => { received = ctx; return { handled: true }; });
    await a.dispatchAgentMessageHook({
      text: 'x', topicId: 1, senderIsBot: true,
      senderChatId: '-1001', rawFromId: '999',
    });
    expect(received?.senderBotId).toBe('-1001');
  });

  it('derives senderBotId from rawFromId when senderIsBot AND no sender_chat (DM / topic post by a bot)', async () => {
    const a = adapter();
    let received: Record<string, unknown> | undefined;
    a.setAgentMessageHook(async (ctx) => { received = ctx; return { handled: true }; });
    await a.dispatchAgentMessageHook({
      text: 'x', topicId: 1, senderIsBot: true,
      rawFromId: '8781020500',
    });
    expect(received?.senderBotId).toBe('8781020500');
  });

  it('OMITS senderBotId when senderIsBot is false AND no sender_chat (real user — spoof-defense input)', async () => {
    const a = adapter();
    let received: Record<string, unknown> | undefined;
    a.setAgentMessageHook(async (ctx) => { received = ctx; return { handled: true }; });
    await a.dispatchAgentMessageHook({
      text: '[a2a:from=echo to=instar-codey role=mentor id=x corr=x ts=1 v=1]\nspoofed body',
      topicId: 1, senderIsBot: false,
      rawFromId: '7812716706', // human Justin
    });
    expect(received?.senderBotId).toBeUndefined();
    expect(received?.senderIsBot).toBe(false);
    // The downstream a2a hook will then drop as `agent-marker-spoofed-by-user`
    // because senderIsBot===false AND senderChatId===undefined — covered by the
    // existing buildAgentMessageHook tests, not re-tested here.
  });

  it('honors an explicit senderBotId override from the caller (forward-forward chain)', async () => {
    const a = adapter();
    let received: Record<string, unknown> | undefined;
    a.setAgentMessageHook(async (ctx) => { received = ctx; return { handled: true }; });
    await a.dispatchAgentMessageHook({
      text: 'x', topicId: 1, senderIsBot: true,
      senderBotId: 'explicit-override', senderChatId: '-1001', rawFromId: '999',
    });
    expect(received?.senderBotId).toBe('explicit-override');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { wireTelegramRouting } from '../../src/commands/server.js';
import { ChiefOfStaffPriorWorkObservation } from '../../src/core/ChiefOfStaffPriorWorkObservation.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import type { SessionManager } from '../../src/core/SessionManager.js';
import type { Message } from '../../src/core/types.js';

function wired() {
  const inject = vi.fn(() => true);
  const report = vi.fn();
  const lookup = vi.fn(async () => { throw new Error('test provider unavailable'); });
  const adapter = {
    onTopicMessage: null as null | ((m: Message) => Promise<void>),
    isAuthorizedSender: () => true, handleCommand: async () => false, getTopicName: () => 'Chief of Staff',
    resolveTopicName: async () => 'Chief of Staff', getSessionForTopic: () => 'live-session',
    getTopicHistory: () => [], getLifelineTopicId: () => 1, registerTopicSession: vi.fn(),
    sendToTopic: vi.fn(async () => ({ ok: true })), sendMessageThroughFunnel: vi.fn(),
    trackMessageInjection: vi.fn(), isPolling: false,
  };
  const sessionManager = {
    isSessionAlive: () => true, requiresCodexGenerationRespawn: () => false, captureOutput: () => '',
    clearSessionFrameworkCache: vi.fn(), injectTelegramMessage: inject,
  };
  const observer = new ChiefOfStaffPriorWorkObservation({
    enabled: () => true, chiefOfStaffTopic: () => 42, owner: () => 9, lookup: { search: lookup }, report,
  });
  wireTelegramRouting(adapter as unknown as TelegramAdapter, sessionManager as unknown as SessionManager,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, observer);
  const say = (id: number, metadata: Record<string, unknown> = {}) => adapter.onTopicMessage!({
    id: `tg-${id}`, userId: '9', content: 'Where is the design for instar.sh addresses?',
    channel: { type: 'telegram', identifier: '42' }, receivedAt: new Date().toISOString(),
    metadata: { messageThreadId: 42, telegramMessageId: String(id), telegramUserId: 9, firstName: 'Owner',
      media: [], telegramDirectPlainText: true, ...metadata },
  });
  return { say, inject, report, lookup, adapter };
}

describe('prior-work observation in the actual Telegram routing hook', () => {
  it('keeps successful owner delivery unchanged and observes after inject', async () => {
    const f = wired();
    await f.say(801);
    expect(f.inject).toHaveBeenCalledTimes(1);
    expect(f.inject.mock.calls[0]).toContain('Where is the design for instar.sh addresses?');
    await vi.waitFor(() => expect(f.lookup.mock.calls).toEqual([['instar.sh']]));
    expect(f.inject.mock.invocationCallOrder[0]).toBeLessThan(f.lookup.mock.invocationCallOrder[0]!);
    expect(f.adapter.sendToTopic).not.toHaveBeenCalled();
    expect(f.report.mock.calls).toEqual([['unavailable']]);
  });

  it('does not query for unverified, mobile, forwarded-copy, other-topic or replay inputs', async () => {
    const f = wired();
    await f.say(802, { senderUnverified: true });
    await f.say(803, { viaMobileDevice: true });
    await f.say(804, { forwarded: true });
    await f.say(805, { messageThreadId: 43 });
    await f.say(806, { replay: true });
    // The actual Telegram voice callback carries a transcript, voice metadata,
    // and empty media without an explicit forwarded boolean or text proof.
    await f.say(807, { telegramDirectPlainText: undefined, voiceFile: '/fixture/forwarded.ogg', voiceDuration: 11 });
    await f.say(808, { telegramDirectPlainText: undefined, viaLifeline: true, forwarded: false });
    await f.say(809, { telegramDirectPlainText: false, forwarded: true });
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(f.inject).toHaveBeenCalledTimes(8);
    expect(f.lookup).not.toHaveBeenCalled();
  });
});

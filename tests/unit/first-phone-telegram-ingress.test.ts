import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';

it('forwards only firsthand private owner taps to the first-phone nomination handler', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-phone-ingress-'));
  const adapter = new TelegramAdapter({ token: 'test-token', chatId: '-100999' }, stateDir);
  vi.spyOn(adapter, 'getVerifiedOwner').mockReturnValue(7001);
  const answer = vi.spyOn(adapter, 'answerCallback').mockResolvedValue();
  const handle = vi.fn<NonNullable<TelegramAdapter['onFirstPhonePrivateAccept']>>().mockResolvedValue(true);
  const tap = {
    id: 'fixture-receipt-1',
    from: { id: 7001, first_name: 'Owner', is_bot: false },
    message: { message_id: 15, date: 1, chat: { id: 7001, type: 'private' } },
    data: 'first-phone:synthetic_fixture_token_123',
  };
  const direct = (query: unknown) => (adapter as unknown as {
    processUpdate(update: unknown): Promise<void>;
  }).processUpdate({ update_id: 1, callback_query: query });

  try {
    await direct(tap);
    expect(answer).toHaveBeenLastCalledWith(tap.id, 'This enrollment is unavailable.');
    adapter.onFirstPhonePrivateAccept = handle;

    await adapter.handleForwardedCallback(tap);
    for (const change of [
      { from: { ...tap.from, id: 7002 } },
      { from: { ...tap.from, is_bot: true } },
      { message: { ...tap.message, chat: { id: 7001, type: 'supergroup' } } },
      { message: { ...tap.message, chat: { id: 7002, type: 'private' } } },
      { message: { ...tap.message, date: 0 } },
      { message: { ...tap.message, date: 1.5 } },
      { message: { ...tap.message, forward_date: 1 } },
      { message: { ...tap.message, is_automatic_forward: true } },
      { message: { ...tap.message, forward_origin: { type: 'user' } } },
      { data: 'first-phone:bad' },
    ]) {
      await direct({ ...tap, ...change });
      expect(answer).toHaveBeenLastCalledWith(tap.id, 'This enrollment is unavailable.');
    }
    expect(handle).not.toHaveBeenCalled();

    await direct(tap);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith(tap.id, {
      callbackData: tap.data, senderId: '7001', senderIsBot: false,
      chatId: '7001', chatType: 'private', messageId: 15, receivedAt: expect.any(Number),
    });
    expect(answer).toHaveBeenLastCalledWith(tap.id, 'Continue in Instar on the nominated iPhone.');
  } finally {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'test first-phone ingress' });
  }
});

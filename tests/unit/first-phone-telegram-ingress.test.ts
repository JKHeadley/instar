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

it('accepts only acknowledgement of the exact disclosure in the verified private owner chat', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-phone-send-'));
  const adapter = new TelegramAdapter({ token: 'test-token', chatId: '-100999' }, stateDir);
  const owner = vi.spyOn(adapter, 'getVerifiedOwner').mockReturnValue(7001);
  const api = vi.spyOn(adapter as unknown as {
    apiCall(method: string, payload: unknown): Promise<unknown>;
  }, 'apiCall');
  const disclosure = 'Accept to nominate this iPhone to approve changes in Instar.';
  const callbackData = 'first-phone:synthetic_fixture_token_123';
  const replyMarkup = { inline_keyboard: [[{ text: 'Accept', callback_data: callbackData }]] };
  const ack = {
    chat: { id: 7001, type: 'private' }, message_id: 15, text: disclosure, reply_markup: replyMarkup,
  };
  const send = (chatId = '7001') => adapter.sendFirstPhonePrivateOffer(chatId, disclosure, callbackData);
  try {
    await expect(send('7002')).resolves.toBeNull();
    expect(api).not.toHaveBeenCalled();
    api.mockResolvedValueOnce(ack);
    await expect(send()).resolves.toEqual({ chatId: '7001', messageId: 15 });
    expect(api).toHaveBeenCalledWith('sendMessage', {
      chat_id: 7001,
      text: disclosure,
      _formatMode: 'legacy-passthrough',
      reply_markup: replyMarkup,
    });
    for (const change of [
      { chat: { id: 7002, type: 'private' } },
      { chat: { id: 7001, type: 'group' } },
      { text: 'Changed disclosure' },
      { message_id: 0 },
      { reply_markup: undefined },
      { reply_markup: { inline_keyboard: [[{ text: 'Accept', callback_data: 'changed' }]] } },
    ]) {
      api.mockResolvedValueOnce({ ...ack, ...change });
      await expect(send()).resolves.toBeNull();
    }
    api.mockRejectedValueOnce(new Error('unavailable'));
    await expect(send()).resolves.toBeNull();
    api.mockImplementationOnce(async () => {
      owner.mockReturnValue(7002);
      return ack;
    });
    await expect(send()).resolves.toBeNull();
  } finally {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'test first-phone sender' });
  }
});

it('keeps reserved first-phone Start messages private and forwards only direct owner evidence', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-phone-start-'));
  const adapter = new TelegramAdapter({ token: 'test-token', chatId: '-100999' }, stateDir);
  vi.spyOn(adapter, 'getVerifiedOwner').mockReturnValue(7001);
  const privateStart = vi.fn<NonNullable<TelegramAdapter['onFirstPhonePrivateStart']>>().mockResolvedValue();
  const ordinary = vi.spyOn(adapter as unknown as {
    processUpdateDelivered(update: unknown): Promise<void>;
  }, 'processUpdateDelivered').mockResolvedValue();
  const text = '/start fp1_synthetic_No-live-link_123';
  const message = { text, message_id: 15, date: 1, from: { id: 7001, is_bot: false }, chat: { id: 7001, type: 'private' } };
  const direct = (patch: Partial<typeof message> = {}) => (adapter as unknown as {
    processUpdate(update: unknown): Promise<void>;
  }).processUpdate({ update_id: 12, message: { ...message, ...patch } });
  try {
    await direct();
    expect(ordinary).not.toHaveBeenCalled();
    adapter.onFirstPhonePrivateStart = privateStart;
    for (const patch of [
      { from: { id: 8001, is_bot: false } }, { chat: { id: 7001, type: 'group' } },
      { via_bot: { id: 8001 } }, { forward_date: 1 },
      { text: text + ' extra' },
    ]) await direct(patch as Partial<typeof message>);
    expect(privateStart).not.toHaveBeenCalled();
    expect(ordinary).not.toHaveBeenCalled();
    await direct();
    expect(privateStart).toHaveBeenCalledWith({
      receiptId: 'tg-12', uniqueKey: 'tg-update:12', adapter: 'telegram', senderId: '7001',
      chatId: '7001', chatType: 'private', messageId: '15', text, senderIsBot: false,
      forwarded: false, receivedAt: expect.any(String),
    });
    await direct({ text: '/start unrelated' });
    expect(ordinary).toHaveBeenCalledTimes(1);
  } finally {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'test first-phone Start ingress' });
  }
});

import { expect, it } from 'vitest';
import { exactDirectTelegramPollingSend, exactDirectTelegramSend } from '../../src/threadline/directTelegramSendEvidence.js';

const recipient = 'a'.repeat(32);
const header = `Send via Threadline to ${recipient}:\n`;
const source = {
  botScope: 'fixture-bot', chatId: -10001, topicId: 42, messageId: 15,
  senderId: 75, sentAt: 1795586730000, text: header + 'First line\nSecond line. ',
  forwarded: false, automaticForward: false, botOrChannelAuthor: false, quoteOrReply: false, hasMedia: false,
};

it('uses the authenticated coordinates and preserves every payload byte', () => {
  const result = exactDirectTelegramSend(source, 75);
  expect(result).toEqual({
    ownerMessageRef: 'telegram:fixture-bot:-10001:42:15',
    ownerEvidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    recipientFingerprint: recipient,
    message: 'First line\nSecond line. ',
  });
  expect(exactDirectTelegramSend({ ...source, text: source.text.trimEnd() }, 75)?.ownerEvidenceDigest)
    .not.toBe(result?.ownerEvidenceDigest);
});

it('refuses nonowners, uncertain source facts, quoted requests and ambiguous syntax', () => {
  expect(exactDirectTelegramSend(source, 76)).toBeNull();
  for (const patch of [
    { botScope: undefined }, { botScope: null }, { forwarded: true }, { forwarded: undefined }, { automaticForward: true },
    { botOrChannelAuthor: true }, { quoteOrReply: true }, { hasMedia: true },
    { text: 'Please consider this example:\n' + source.text }, { text: header + ' ' },
    { text: header + '\ud800' }, { topicId: 0 },
  ]) {
    expect(exactDirectTelegramSend({ ...source, ...patch } as typeof source, 75)).toBeNull();
  }
});

const raw = {
  from: { id: 75, is_bot: false },
  chat: { id: -10001, type: 'supergroup' },
  date: 1795586730, is_topic_message: true,
  message_thread_id: 42, message_id: 15, text: source.text,
};

it('extracts the original forum coordinates under a numeric bot account', () => {
  expect(exactDirectTelegramPollingSend(raw, 248, 75)).toEqual(
    exactDirectTelegramSend({ ...source, botScope: '248' }, 75),
  );
});

it('refuses insufficient raw source evidence before request parsing', () => {
  expect(exactDirectTelegramPollingSend(raw, 0, 75)).toBeNull();
  expect(exactDirectTelegramPollingSend(raw, 248, 76)).toBeNull();
  for (const patch of [
    { from: { id: 75 } }, { message_thread_id: undefined }, { is_topic_message: undefined },
    { forward_origin: {} }, { is_automatic_forward: true }, { sender_chat: {} },
    { external_reply: {} }, { reply_to_message: {} }, { quote: {} }, { photo: [] },
    { entities: [] }, { unexpected_field: true }, { date: raw.date + 0.1 },
  ]) {
    expect(exactDirectTelegramPollingSend({ ...raw, ...patch }, 248, 75)).toBeNull();
  }
});

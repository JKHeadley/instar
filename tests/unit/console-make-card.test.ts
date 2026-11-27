import { describe, it, expect } from 'vitest';
import { sourceKeyFor, messageIdFor, makeCardDraft, makeCardBody } from '../../dashboard/console/make-card.js';

const tg = { kind: 'conversation', platform: 'telegram', chatId: '-1001', topicId: 87 };
const app = { kind: 'conversation', platform: 'app', conversationKey: 'a930b2a4-5276-4540-b0a0-59fbbb3606ac' };
const slack = { kind: 'conversation', platform: 'slack', channelId: 'C1' };

describe('Make a card from a message (work-front-doors stage 2b)', () => {
  it('the source key matches the Chief of Staff keys; Slack and efforts are not offered', () => {
    expect(sourceKeyFor(tg)).toBe('telegram:87');
    expect(sourceKeyFor(app)).toBe('app:a930b2a4-5276-4540-b0a0-59fbbb3606ac');
    expect(sourceKeyFor(slack)).toBeNull();
    expect(sourceKeyFor({ kind: 'effort', id: 'x' })).toBeNull();
  });

  it('the message id is the Telegram id, else the history row key', () => {
    expect(messageIdFor({ messageId: 4521, key: 'k' })).toBe('4521');
    expect(messageIdFor({ messageId: null, key: 'evt-abc' })).toBe('evt-abc');
    expect(messageIdFor({ messageId: null, key: '' })).toBeNull();
  });

  it('prefills a title from the first line and the need from the whole message', () => {
    const d = makeCardDraft({ text: '\n  Can you pick the launch date?\nFriday or Monday works.' });
    expect(d.title).toBe('Can you pick the launch date?');
    expect(d.need).toBe('Can you pick the launch date?\nFriday or Monday works.');
    expect(makeCardDraft({ text: 'x'.repeat(120) }).title.length).toBe(80);
  });

  it('builds the owner card body with its source, and says plainly what is missing', () => {
    const msg = { messageId: 4521, key: 'k', text: 'Pick the date' };
    const ok = makeCardBody({ title: 'Pick the date', need: 'Choose Friday or Monday.', doneWhen: 'The date is chosen' }, tg, msg);
    expect(ok).toEqual({ ok: true, body: { title: 'Pick the date', need: 'Choose Friday or Monday.', doneWhen: [{ id: 'd1', text: 'The date is chosen' }], outward: false, source: { conversationKey: 'telegram:87', messageId: '4521' } } });
    expect(makeCardBody({ title: '', need: 'n', doneWhen: 'd' }, tg, msg)).toEqual({ ok: false, reason: 'Give the card a title.' });
    expect(makeCardBody({ title: 't', need: ' ', doneWhen: 'd' }, tg, msg)).toEqual({ ok: false, reason: 'Say what is needed.' });
    expect(makeCardBody({ title: 't', need: 'n', doneWhen: '' }, tg, msg)).toEqual({ ok: false, reason: 'Say when it is done.' });
    expect(makeCardBody({ title: 't', need: 'n', doneWhen: 'd' }, slack, msg).ok).toBe(false);
  });
});

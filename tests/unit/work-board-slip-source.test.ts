import { describe, expect, it } from 'vitest';
import { resolveTelegramWorkBoardSlipSource } from '../../src/core/workBoardSlipSource.js';

const ref = 'telegram:4242:777';
const card = 'wc_6248a51921c41ca0';
const other = 'wc_8ef2f314f32acff4';
const source = {
  topicId: 4242, messageId: 777, telegramUserId: 1001, text: `Approve Work Board cards: ${card}, ${other}`,
  fromUser: true, forwarded: false, provenance: 'user', authorship: 'human',
};

function resolve(patch: Record<string, unknown> = {}, coordinate = ref) {
  return resolveTelegramWorkBoardSlipSource(coordinate, {
    ownerUid: () => 1001,
    ownerPersonKey: () => 'owner',
    findRecordedMessage: () => ({ ...source, ...patch }),
  });
}

describe('Telegram owner approval source', () => {
  it('retains exact authenticated source identity and ordered card list', () => {
    expect(resolve()).toMatchObject({ sourceId: ref, ownerPersonKey: 'owner', cardIds: [card, other], sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const reordered = resolve({ text: `Approve Work Board cards: ${other}, ${card}` });
    expect(reordered?.sourceId).toBe(ref);
    expect(reordered?.sourceDigest).not.toBe(resolve()?.sourceDigest);
  });

  it.each([
    { forwarded: undefined }, { forwarded: true }, { telegramUserId: 1002 }, { provenance: 'automation' },
    { authorship: 'agent-verified' }, { rowOrigin: 'relay' }, { via: 'mobile-device' },
    { topicId: 4243 }, { messageId: 778 }, { teamPhone: true },
    { text: `Do not approve Work Board cards: ${card}` },
    { text: `Approve Work Board cards: ${card}\n` },
    { text: `Approve Work Board cards: ${card}, ${card}` },
  ])('refuses ambiguous, transplanted, or unverified input %#', (patch) => {
    expect(resolve(patch)).toBeNull();
  });

  it('refuses a noncanonical source locator', () => {
    expect(resolve({}, `${ref}\n`)).toBeNull();
  });
});

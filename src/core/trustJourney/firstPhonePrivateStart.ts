import type { Receipt } from './accountPath.js';

export const FIRST_PHONE_PRIVATE_START = /^\/start fp1_[A-Za-z0-9_-]{22,60}$/;

interface FirstPhoneStart {
  token: string;
  ownerAccountId: string;
  holderEpoch: string;
  holderMachineId: string;
  issuedAt: number;
  expiresAt: number;
}

/** The holder calls this only on a receipt from authenticated Telegram ingress.
 * A matching Start can show the disclosure. It carries no approval authority.
 */
export function matchesFirstPhonePrivateStart(
  start: FirstPhoneStart,
  receipt: Receipt,
  currentOwnerAccountId: string,
  currentHolderEpoch: string,
  now: number,
): boolean {
  const receivedAt = Date.parse(receipt.receivedAt);
  return FIRST_PHONE_PRIVATE_START.test(`/start ${start.token}`)
    && start.ownerAccountId === currentOwnerAccountId
    && start.holderEpoch === currentHolderEpoch
    && receipt.receivedBy === start.holderMachineId
    && receipt.adapter === 'telegram' && receipt.chatType === 'private'
    && receipt.senderId === currentOwnerAccountId && receipt.chatId === receipt.senderId
    && receipt.senderIsBot === false && receipt.forwarded === false
    && receipt.text === `/start ${start.token}`
    && [start.issuedAt, start.expiresAt, now, receivedAt].every(Number.isSafeInteger)
    && start.issuedAt <= receivedAt && receivedAt <= now && now < start.expiresAt;
}

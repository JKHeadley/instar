import { canonicalJson, isCardId, sha256Hex } from './WorkCardStore.js';

export interface WorkBoardSlipOwnerSource {
  sourceId: string;
  sourceDigest: string;
  ownerPersonKey: string;
  cardIds: readonly string[];
}

interface TelegramApprovalMessage {
  topicId: number | null;
  messageId: number;
  telegramUserId?: number;
  text: string;
  fromUser: boolean;
  forwarded?: boolean;
  provenance?: string;
  authorship?: string;
  rowOrigin?: string;
  via?: string;
  teamPhone?: boolean;
}

interface TelegramSlipSourcePorts {
  ownerUid: () => number | null;
  ownerPersonKey: () => string | null;
  findRecordedMessage: (topicId: number, messageId: number) => TelegramApprovalMessage | null;
}

/** Resolve only the explicit approval grammar in an authenticated, recorded owner message. */
export function resolveTelegramWorkBoardSlipSource(sourceRef: string, ports: TelegramSlipSourcePorts): WorkBoardSlipOwnerSource | null {
  const coordinate = /^telegram:([1-9][0-9]*):([1-9][0-9]*)$/.exec(sourceRef);
  if (!coordinate || coordinate[0] !== sourceRef) return null;
  const topicId = Number(coordinate[1]);
  const messageId = Number(coordinate[2]);
  if (!Number.isSafeInteger(topicId) || !Number.isSafeInteger(messageId)) return null;
  const ownerUid = ports.ownerUid();
  const ownerPersonKey = ports.ownerPersonKey();
  if (!ownerPersonKey || ownerUid === null || !Number.isSafeInteger(ownerUid) || ownerUid <= 0) return null;
  const row = ports.findRecordedMessage(topicId, messageId);
  if (!row || row.topicId !== topicId || row.messageId !== messageId || row.telegramUserId !== ownerUid
    || row.fromUser !== true || row.forwarded !== false || row.provenance !== 'user' || row.authorship !== 'human'
    || row.rowOrigin !== undefined || row.via !== undefined || row.teamPhone) return null;

  const prefix = 'Approve Work Board cards: ';
  if (!row.text.startsWith(prefix)) return null;
  const cardIds = row.text.slice(prefix.length).split(', ');
  if (!cardIds.every((id) => id.length === 19 && isCardId(id)) || new Set(cardIds).size !== cardIds.length) return null;
  return {
    sourceId: sourceRef,
    sourceDigest: sha256Hex(canonicalJson([sourceRef, ownerUid, row.text])),
    ownerPersonKey,
    cardIds,
  };
}

/**
 * Are these the OWNER's own words? Only then may a message teach the agent the owner's
 * preferences (correction capture, learned preferences, the Jev correction shadow).
 *
 * An allowlist on the owner (SEC-069), not a list of who to exclude:
 *  - never forwarded text (someone else's words relayed by the owner);
 *  - never a team member (team phone or role `team`) or another person's paired phone (`msp`);
 *  - an app message with role `owner`, or from a paired app device with no role (the owner's
 *    own phone, paired before roles existed), is the owner's;
 *  - a Telegram row is the owner's only when its verified sender id is the owner's id. With no
 *    owner known, nobody's words count (SEC-105): callers pass `learningOwnerId`, which treats the
 *    one allowed sender of a single-person agent as the owner. A row whose sender could not be
 *    verified (no id) never counts.
 */
export interface MaybeOwnerWords {
  fromUser?: boolean;
  teamPhone?: boolean;
  senderRole?: string;
  forwarded?: boolean;
  via?: string;
  telegramUserId?: number;
}

export function isOwnersOwnWords(entry: MaybeOwnerWords, ownerUserId?: number): boolean {
  if (entry.fromUser !== true || entry.forwarded === true || entry.teamPhone === true) return false;
  if (entry.senderRole !== undefined) return entry.senderRole === 'owner';
  if (entry.via === 'mobile-device') return true;
  if (typeof entry.telegramUserId !== 'number') return false;
  return ownerUserId !== undefined && entry.telegramUserId === ownerUserId;
}

/**
 * Whose Telegram words may teach the agent: the verified owner, else the agent's ONE allowed
 * sender (a single-person agent with no owner configured). Several allowed senders, or none
 * (every sender accepted), and no verified owner means nobody: undefined, never "anybody".
 */
export function learningOwnerId(verifiedOwner: number | undefined, authorizedUserIds: ReadonlyArray<unknown> | undefined): number | undefined {
  if (verifiedOwner !== undefined) return verifiedOwner;
  if (!Array.isArray(authorizedUserIds)) return undefined;
  // Compared as exact strings, the way TelegramAdapter.isAuthorized matches a sender, so the id
  // named here is always one that sender check accepts. Duplicates count once.
  const distinct = [...new Set(authorizedUserIds.map((raw) => String(raw)))];
  if (distinct.length !== 1 || !/^[1-9]\d*$/.test(distinct[0]!)) return undefined;
  const id = Number(distinct[0]);
  return Number.isSafeInteger(id) ? id : undefined;
}

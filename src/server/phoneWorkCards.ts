/**
 * Work cards from the owner's phone (docs/specs/phone-work-cards.md): "Make a card" from a message.
 *
 * The phone sends the card it showed the owner plus a client request id; the owner confirms with Face ID
 * over `work-card-create <requestId> <draftHash>` through the phone permission write gate
 * (mobilePermissionsRoutes.ts). This module holds the parts that do not depend on Express: the draft's
 * shape check, its hash, the card id derived from the owner and the request id, and the create itself
 * (idempotent on that id). The console's "Make a card" stores the same `source` keys
 * (dashboard/console/make-card.js).
 */
import { canonicalJson, sha256Hex, isCardId, ITEM_ID_RE } from '../core/WorkCardStore.js';
import { isAppConversationKey } from '../core/appConversationText.js';
import type { WorkBoardService } from '../core/WorkBoardService.js';
import { cardJson } from '../core/workBoardViews.js';
import { afterCardCreate, type WorkBoardRouteDeps } from './workBoardRoutes.js';

/** A client request id: lowercase, so it fits the signed line's target alphabet (a lowercase UUID fits). */
export const PHONE_CARD_REQUEST_ID = /^[a-z0-9][a-z0-9-]{7,63}$/;
/** The bound the console's `messageIdFor` already stores (it slices to 200). */
export const MAX_SOURCE_MESSAGE_ID_CHARS = 200;
const TELEGRAM_SOURCE = /^telegram:[1-9][0-9]{0,14}$/; // 15 digits: a safe integer, so Number() is exact
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

/** A done item as the phone sends it (the console sends the same two fields; the store fills the rest). */
export interface PhoneDoneItem { id: string; text: string }
export interface PhoneCardSource { conversationKey: string; messageId: string }
/** Plain words for each shape refusal (the app shows `message`). */
export const PHONE_CARD_SHAPE_WORDS: Readonly<Record<string, string>> = {
  'bad-request-id': 'The app sent this card without a valid request number. Update the app and try again.',
  'title-required': 'Give the card a title.',
  'need-required': 'Say what is needed.',
  'done-item-required': 'Say when it is done.',
  'bad-done-item': 'One of the "done when" lines is empty or repeated.',
  'bad-source': 'This message cannot be turned into a card here.',
  'bad-message-id': 'This message cannot be turned into a card here.',
};

/** The source conversation is unknown here, or this phone's person may not read it (one answer for both). */
export const SOURCE_NOT_FOUND = { error: 'source-conversation-not-found', message: 'That conversation is not on the machine you are connected to, so no card was made.' } as const;

export interface PhoneCardDraft { title: string; need: string; doneWhen: PhoneDoneItem[]; source: PhoneCardSource }

/** The shape check (types and presence only; every length limit is the board's own, applied by the service). */
export function parsePhoneCardDraft(body: Record<string, unknown>): { ok: true; requestId: string; draft: PhoneCardDraft } | { ok: false; error: string } {
  const requestId = body.requestId;
  if (typeof requestId !== 'string' || !PHONE_CARD_REQUEST_ID.test(requestId)) return { ok: false, error: 'bad-request-id' };
  const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
  if (!text(body.title)) return { ok: false, error: 'title-required' };
  if (!text(body.need)) return { ok: false, error: 'need-required' };
  if (!Array.isArray(body.doneWhen) || body.doneWhen.length === 0) return { ok: false, error: 'done-item-required' };
  const doneWhen: PhoneDoneItem[] = [];
  const ids = new Set<string>();
  for (const d of body.doneWhen as unknown[]) {
    const item = d && typeof d === 'object' && !Array.isArray(d) ? d as Record<string, unknown> : null;
    if (!item || typeof item.id !== 'string' || !ITEM_ID_RE.test(item.id) || ids.has(item.id) || !text(item.text)) return { ok: false, error: 'bad-done-item' };
    ids.add(item.id);
    doneWhen.push({ id: item.id, text: item.text });
  }
  const src = body.source && typeof body.source === 'object' && !Array.isArray(body.source) ? body.source as Record<string, unknown> : null;
  const key = src?.conversationKey;
  if (typeof key !== 'string' || !(TELEGRAM_SOURCE.test(key) || (key.startsWith('app:') && isAppConversationKey(key.slice(4))))) return { ok: false, error: 'bad-source' };
  const messageId = src?.messageId;
  if (typeof messageId !== 'string' || messageId.length === 0 || messageId.length > MAX_SOURCE_MESSAGE_ID_CHARS || CONTROL_CHARS.test(messageId)) return { ok: false, error: 'bad-message-id' };
  return { ok: true, requestId, draft: { title: body.title, need: body.need, doneWhen, source: { conversationKey: key, messageId } } };
}

/** What the owner's Face ID covers: everything the card stores from the request. */
export function phoneCardDraftHash(d: PhoneCardDraft): string {
  return sha256Hex(canonicalJson({ v: 1, title: d.title, need: d.need, doneWhen: d.doneWhen.map((x) => ({ id: x.id, text: x.text })), source: { conversationKey: d.source.conversationKey, messageId: d.source.messageId } }));
}

/**
 * The card id for one owner's request, so a retry finds the card it made. Phone writes are proven only on the
 * machine the phone paired with (the device record and presence key are machine-local), so retries reach the
 * one machine that made the card.
 */
export function phoneCardId(ownerPersonKey: string, requestId: string): string {
  return `wc_${sha256Hex(`work-card-create\n${ownerPersonKey}\n${requestId}`).slice(0, 16)}`;
}

/** The signed action line. */
export function phoneCardCreateLine(requestId: string, draftHash: string): string {
  return `work-card-create ${requestId} ${draftHash}`;
}

const OWNER_BY_PHONE = (personKey: string) => ({ kind: 'person' as const, personKey, proof: 'presence' as const, isOwner: true });
/** The card's fields from the draft: exactly the signed ones, `outward` false (as the console's "Make a card"). */
const cardFields = (d: PhoneCardDraft): Record<string, unknown> => ({ title: d.title, need: d.need, doneWhen: d.doneWhen.map((x) => ({ id: x.id, text: x.text })), outward: false, source: { conversationKey: d.source.conversationKey, messageId: d.source.messageId } });
const NO_OWNER = { error: 'no-team-owner', message: 'This agent has no owner set, so no card was made.' } as const;

/** The draft as the card's own `created` record stored it (null when unreadable). */
function storedDraftHash(svc: WorkBoardService, cardId: string, ownerPersonKey: string): string | null {
  const created = svc.recordsOf(cardId).find((r) => r.d.recordType === 'created');
  if (!created) return null;
  const d = created.d;
  const by = d.by as { kind?: unknown; personKey?: unknown } | undefined;
  if (by?.kind !== 'person' || by.personKey !== ownerPersonKey) return null;
  const src = d.source as { conversationKey?: unknown; messageId?: unknown } | undefined;
  if (typeof d.title !== 'string' || typeof d.need !== 'string' || !Array.isArray(d.doneWhen) || typeof src?.conversationKey !== 'string' || typeof src.messageId !== 'string') return null;
  return phoneCardDraftHash({ title: d.title, need: d.need, doneWhen: d.doneWhen as PhoneDoneItem[], source: { conversationKey: src.conversationKey, messageId: src.messageId } });
}

/** For a card that already exists under this request: removed, or a different draft (null = a true replay). */
function existingRefusal(svc: WorkBoardService, cardId: string, ownerPersonKey: string, draftHash: string): { kind: 'refused'; status: number; body: Record<string, unknown> } | null {
  const v = svc.view(cardId);
  if (v?.card.redacted) return { kind: 'refused', status: 409, body: { error: 'card-removed', message: 'This card was made and then removed. Make a new one.' } };
  if (storedDraftHash(svc, cardId, ownerPersonKey) !== draftHash) return { kind: 'refused', status: 409, body: { error: 'request-id-reused', message: 'A different card was already made with this request. Make the card again.' } };
  return null;
}

export type PhoneCardCreateOutcome =
  | { kind: 'created'; cardId: string; conversationKey: string; overSoftBudget?: { waiting: number; softOpenCards: number } }
  | { kind: 'replayed'; cardId: string; conversationKey: string }
  | { kind: 'refused'; status: number; body: Record<string, unknown> };

/**
 * The idempotent create. The existence check and the write run in one synchronous step (no await), so two
 * requests in one process with the same id make one card. A matching card is a replay (nothing written); a
 * card with a different draft under the same id is refused.
 */
export function createPhoneCard(svc: WorkBoardService, ownerPersonKey: string, requestId: string, draft: PhoneCardDraft, draftHash: string): PhoneCardCreateOutcome {
  const cardId = phoneCardId(ownerPersonKey, requestId);
  if (!isCardId(cardId)) return { kind: 'refused', status: 500, body: { error: 'bad-card-id' } };
  const existing = svc.view(cardId);
  if (existing?.card.created) {
    const known = existingRefusal(svc, cardId, ownerPersonKey, draftHash);
    if (known) return known;
    return { kind: 'replayed', cardId, conversationKey: existing.card.conversationKey };
  }
  const r = svc.createCard(OWNER_BY_PHONE(ownerPersonKey), cardFields(draft), { cardId });
  if (!r.ok) return { kind: 'refused', status: r.status, body: { error: r.error, ...(r.detail ?? {}) } };
  return { kind: 'created', cardId: r.cardId, conversationKey: r.conversationKey, ...(r.overSoftBudget ? { overSoftBudget: r.overSoftBudget } : {}) };
}

/** What the phone create needs from the work board's route dependencies. */
export type PhoneCardDeps = Pick<WorkBoardRouteDeps, 'enabled' | 'svc' | 'ownerPersonKey' | 'ensureConversation' | 'controller' | 'log' | 'displayName'>;

/** The work board is on and started here, or the refusal the phone shows (checked before Face ID is spent). */
export function phoneCardBoardRefusal(deps: Pick<WorkBoardRouteDeps, 'enabled' | 'svc'>): { status: number; body: Record<string, unknown> } | null {
  if (!deps.enabled()) return { status: 503, body: { error: 'work-board-disabled', message: 'The work board is not switched on for this agent.' } };
  if (!deps.svc()) return { status: 503, body: { error: 'work-board-starting', message: 'The work board is still starting. Try again in a moment.' } };
  return null;
}

/**
 * Everything knowable before Face ID (docs/specs/phone-work-cards.md, check 4): the board is on, an owner
 * resolves, and either the card for this request already exists (a replay; the create step decides it, even if
 * the source conversation is gone since) or the source conversation is known here and readable by this phone's
 * person, and the card passes every check the write would run (limits, credential check, record shape) as a dry
 * run. Null means go on to the proof.
 */
export function phoneCardPrecheck(deps: Pick<WorkBoardRouteDeps, 'enabled' | 'svc' | 'ownerPersonKey'>, requestId: string, draft: PhoneCardDraft, sourceReadable: () => boolean): { status: number; body: Record<string, unknown> } | null {
  const off = phoneCardBoardRefusal(deps); if (off) return off;
  const svc = deps.svc()!;
  const owner = deps.ownerPersonKey();
  if (!owner) return { status: 409, body: { ...NO_OWNER } };
  const cardId = phoneCardId(owner, requestId);
  if (svc.view(cardId)?.card.created) {
    // A card already made for this request: a removed card or a different draft is refused here, before Face ID
    // (the owner's phone can read the card anyway, so nothing leaks); a true replay goes on to the proof.
    const known = existingRefusal(svc, cardId, owner, phoneCardDraftHash(draft));
    return known ? { status: known.status, body: known.body } : null;
  }
  if (!sourceReadable()) return { status: 404, body: { ...SOURCE_NOT_FOUND } };
  const dry = svc.createCard(OWNER_BY_PHONE(owner), cardFields(draft), { cardId }, { dryRun: true });
  if (!dry.ok) return { status: dry.status, body: { error: dry.error, ...(dry.detail ?? {}) } };
  return null;
}

/**
 * The create after the write gate proved the owner's phone and Face ID over this exact draft. Answers the
 * console create's body (201), or the same card with `replayed: true` (200). The after-create steps run on a
 * replay too: they are idempotent, so an interrupted create finishes when the phone retries.
 */
export async function answerPhoneCardCreate(deps: PhoneCardDeps, requestId: string, draft: PhoneCardDraft, draftHash: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const off = phoneCardBoardRefusal(deps); if (off) return off;
  const svc = deps.svc()!;
  const owner = deps.ownerPersonKey();
  if (!owner) return { status: 409, body: { ...NO_OWNER } };
  const out = createPhoneCard(svc, owner, requestId, draft, draftHash);
  if (out.kind === 'refused') return { status: out.status, body: out.body };
  await afterCardCreate(deps, out.cardId, out.conversationKey, draft.title);
  const v = svc.view(out.cardId);
  if (!v) return { status: 500, body: { error: 'card-not-readable' } };
  const card = cardJson(svc, v, { personKey: owner, isOwner: true, isAgent: false }, deps.displayName);
  if (out.kind === 'replayed') return { status: 200, body: { cardId: out.cardId, conversationKey: out.conversationKey, card, replayed: true } };
  return { status: 201, body: { cardId: out.cardId, conversationKey: out.conversationKey, card, ...(out.overSoftBudget ? { overSoftBudget: out.overSoftBudget } : {}) } };
}

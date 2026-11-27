/**
 * Pinned messages in conversations (docs/specs/conversation-pinned-messages.md).
 *
 * A pin is a `pin` event in the app conversation store under the conversation's store key (the app
 * conversation UUID, `telegram:<topicId>`, or the Slack registry key), so it replicates with the
 * store to every machine. This module holds the parts shared by the routes and the Telegram hand-off:
 * the switch, the preview, writing a pin only when it changes the state, and the rows a reader gets.
 */
import type { InstarConfig } from './types.js';
import {
  MAX_PINS_PER_CONVERSATION, PIN_MESSAGE_ID_RE, PIN_PREVIEW_CHARS,
  type AppConversationStore, type PinEvent, type PinnedByRole, type PinnedMessage,
} from './AppConversationStore.js';
import { derivedEventId } from './appConversationText.js';

/** `mobilePairing.native.pins.enabled`: omitted ⇒ on wherever native conversations are on. Read live. */
export function isConversationPinsEnabled(config: InstarConfig): boolean {
  return (config.mobilePairing as { native?: { pins?: { enabled?: unknown } } } | undefined)?.native?.pins?.enabled !== false;
}

export function isPinMessageId(v: unknown): v is string {
  return typeof v === 'string' && PIN_MESSAGE_ID_RE.test(v);
}

/** A stored preview: one line, control characters removed, at most PIN_PREVIEW_CHARS. Empty ⇒ undefined. */
export function pinPreview(text: string | null | undefined): string | undefined {
  if (typeof text !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const one = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!one) return undefined;
  return one.length > PIN_PREVIEW_CHARS ? `${one.slice(0, PIN_PREVIEW_CHARS - 1)}…` : one;
}

/** One pinned message as the app and the dashboard receive it. */
export interface PinRow {
  messageId: string;
  pinnedAt: string;
  pinnedBy: { name: string; role: PinnedByRole };
  preview: string | null;
  source: 'app' | 'telegram';
}

/**
 * The pins a reader gets: newest pin first, with the message's text only when `mayRead` allows the
 * pinned message (a pin of a message held from the reader is left out). Never throws.
 */
export function pinRowsFor(
  store: Pick<AppConversationStore, 'listPins'>, conversationKey: string, mayRead: (messageId: string) => boolean = () => true,
  /** A preview built at read time when none is stored (Slack text stays on the machine holding it). */
  previewOf?: (messageId: string) => string | null,
): PinRow[] {
  let pins: PinnedMessage[] = [];
  try { pins = store.listPins(conversationKey); } catch { pins = []; } // @silent-fallback-ok — an unreadable index shows no pins rather than failing the read
  const out: PinRow[] = [];
  for (const p of pins) {
    let ok = false;
    try { ok = mayRead(p.messageId); } catch { ok = false; } // @silent-fallback-ok — fail closed: an unanswerable check hides that pin
    if (!ok) continue;
    let preview = p.preview;
    if (preview === null && previewOf) { try { preview = pinPreview(previewOf(p.messageId)) ?? null; } catch { preview = null; } } // @silent-fallback-ok — no preview rather than a failed read
    out.push({ messageId: p.messageId, pinnedAt: p.pinnedAt, pinnedBy: p.pinnedBy, preview, source: p.source });
  }
  return out;
}

export interface ApplyPinInput {
  conversationKey: string;
  messageId: string;
  pinned: boolean;
  by: { name: string; role: PinnedByRole };
  preview?: string;
  source: 'app' | 'telegram';
  machineId: string;
  at: string;
  /** The event id: derived from the request (app) or the platform update (Telegram), so a retry never writes twice. */
  eventId: string;
}

export type ApplyPinResult =
  | { ok: true; changed: boolean; duplicate: boolean }
  | { ok: false; error: 'too-many-pins' };

/**
 * Write a pin event only when it changes the message's state. A retry of the same request (its
 * event already stored) is `duplicate`; a request for the state the message already has is
 * `changed: false` and writes nothing. A new pin past MAX_PINS_PER_CONVERSATION is refused.
 */
export function applyPin(store: Pick<AppConversationStore, 'append' | 'hasEvent' | 'pinRecord' | 'pinCount'>, input: ApplyPinInput): ApplyPinResult {
  if (store.hasEvent(input.conversationKey, input.eventId)) return { ok: true, changed: false, duplicate: true };
  const cur = store.pinRecord(input.conversationKey, input.messageId);
  const want = input.pinned ? 'pinned' : 'unpinned';
  if ((cur?.state ?? 'unpinned') === want) return { ok: true, changed: false, duplicate: false };
  if (input.pinned && store.pinCount(input.conversationKey) >= MAX_PINS_PER_CONVERSATION) return { ok: false, error: 'too-many-pins' };
  const name = input.by.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 128) || 'Someone';
  // Never behind the event it replaces: a machine whose clock is behind still wins with its newer choice.
  const wall = Date.parse(input.at);
  const after = cur ? Date.parse(cur.at) + 1 : -Infinity;
  const at = new Date(Math.max(Number.isFinite(wall) ? wall : Date.now(), after)).toISOString();
  const ev: PinEvent = {
    eventId: input.eventId, kind: 'pin', conversationKey: input.conversationKey, at, machineId: input.machineId,
    pinnedMessageId: input.messageId, pinState: want, pinnedBy: { name, role: input.by.role }, source: input.source,
    ...(input.preview ? { preview: input.preview } : {}),
  };
  store.append(ev);
  return { ok: true, changed: true, duplicate: false };
}

/** The pin event id for an app or dashboard request: one per device request. */
export function pinRequestEventId(deviceId: string, requestId: string): string {
  return derivedEventId('pin', deviceId, requestId);
}

/** The pin event id for a pin seen in Telegram: one per pin service message. */
export function telegramPinEventId(topicId: number, messageId: number, serviceMessageId: number): string {
  return derivedEventId('tgpin', String(topicId), String(messageId), String(serviceMessageId));
}

/** A Telegram message id the Bot API can pin: digits below 2^52 (ids from 2^52 stand for messages typed in the app). */
export function isRealTelegramMessageId(messageId: string): boolean {
  if (!/^[1-9][0-9]{0,15}$/.test(messageId)) return false;
  const n = Number(messageId);
  return Number.isSafeInteger(n) && n < 2 ** 52;
}

/** A Slack message timestamp (`1700000000.123456`). */
export function isSlackTs(messageId: string): boolean {
  return /^[0-9]{9,12}\.[0-9]{1,8}$/.test(messageId);
}

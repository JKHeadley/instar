/**
 * Telegram and Slack media in the app's history (docs/specs/mobile-native-chat-media.md
 * §4.9, third bullet): a file that arrived in a platform conversation is copied into the app media
 * blob store and recorded as one durable, replicated `platform-media` event under the platform
 * conversation's canonical key. That event — not the rotating platform log — is the reference that
 * authorizes the app's downloads and drives pulls on every machine.
 *
 * Admission is the agent-reply path's (§4.6 steps 2-4, §4.7): one checked open, the size limits, a
 * reservation (disk floor and store cap) before any byte is copied, a hashed snapshot, the sniffed
 * media type, and the blob published BEFORE its event. Idempotent: the event id derives from the
 * platform message id, so the same platform message appends once.
 *
 * Also here: the device's view of a Telegram history row's text. A device never sees a server path:
 * `[image:<path>]` reads `[photo]`, `[document:<path>]` reads `[file: <display name>]`.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AppConversationService } from './AppConversationService.js';
import { platformMediaMessageId, PLATFORM_CONVERSATION_KEY_RE, type PlatformMediaEvent } from './AppConversationStore.js';
import { admitFileSnapshots, discardPrepared } from './appMediaReplyFiles.js';
import { attachmentIdFor, CONTROL_CHARS, displayName, effectiveKind, sniffMediaType, type AppAttachment, type MediaKind } from './appMediaTypes.js';
import { canonicalConversationKey } from './appConversationText.js';

export interface PlatformMediaInput {
  /** `telegram:<topicId>` or a canonical Slack key. */
  conversationKey: string;
  platformMessageId: string;
  /** The platform handler's own download (absolute; it may delete it after this returns). */
  filePath: string;
  declaredKind: Extract<MediaKind, 'photo' | 'file' | 'voice'>;
  filename: string;
  declaredType: string;
  /** When the platform says the message was sent (ISO). */
  at: string;
  durationMs?: number;
  width?: number;
  height?: number;
}

export type PlatformMediaResult =
  | { recorded: true; eventId: string; sha256: string }
  | { recorded: false; reason: 'duplicate'; eventId: string }
  | { recorded: false; reason: string; status?: number; detail: string };

function cleanName(raw: string, fallback: string): string {
  const s = raw.replace(new RegExp(CONTROL_CHARS.source, 'g'), '_').trim().slice(-255);
  return s || fallback;
}

function cleanType(raw: string, fallback: string): string {
  return raw && raw.length <= 128 && !CONTROL_CHARS.test(raw) ? raw : fallback;
}

/**
 * Copy one platform file into the blob store and append its `platform-media` event. Never throws:
 * a refusal (store full, disk floor, too large) or an error comes back as `recorded: false` with a
 * reason, and anything taken (snapshot, reservation) is released.
 */
export async function recordPlatformMedia(svc: AppConversationService, input: PlatformMediaInput): Promise<PlatformMediaResult> {
  const conversationKey = canonicalConversationKey(input.conversationKey);
  if (!PLATFORM_CONVERSATION_KEY_RE.test(conversationKey)) return { recorded: false, reason: 'bad-conversation', detail: `not a platform conversation key: ${conversationKey}` };
  if (!/^[0-9A-Za-z._:-]{1,64}$/.test(input.platformMessageId)) return { recorded: false, reason: 'bad-message-id', detail: 'the platform message id is not usable' };
  const messageId = platformMediaMessageId(conversationKey, input.platformMessageId);
  try {
    if (svc.store.hasEvent(conversationKey, messageId)) return { recorded: false, reason: 'duplicate', eventId: messageId };
  } catch (err) {
    return { recorded: false, reason: 'store-unreadable', detail: err instanceof Error ? err.message : String(err) };
  }
  const resolve = (requested: string) => {
    if (!path.isAbsolute(requested)) return { status: 403, error: 'path-not-allowed', detail: 'The platform download path is not absolute.' };
    try { return { real: fs.realpathSync(requested) }; } catch { return { status: 404, error: 'file-not-found', detail: 'The platform download is gone.' }; } // @silent-fallback-ok — reported as recorded:false
  };
  let admitted: Awaited<ReturnType<typeof admitFileSnapshots>>;
  try {
    admitted = await admitFileSnapshots(svc.media, [input.filePath], resolve);
  } catch (err) {
    return { recorded: false, reason: 'copy-failed', detail: err instanceof Error ? err.message : String(err) };
  }
  if ('status' in admitted) return { recorded: false, reason: admitted.error, status: admitted.status, detail: admitted.detail };
  const snap = admitted.snapshots[0]!;
  try {
    const mediaType = sniffMediaType(Buffer.from(snap.hashed.headB64, 'base64'));
    const fallbackName = input.declaredKind === 'photo' ? 'photo.jpg' : input.declaredKind === 'voice' ? 'voice.ogg' : 'file';
    const attachment: AppAttachment = {
      attachmentId: attachmentIdFor(messageId, 0), index: 0, sha256: snap.hashed.sha256, size: snap.hashed.size,
      declaredKind: input.declaredKind, kind: effectiveKind(input.declaredKind, mediaType), mediaType,
      declaredType: cleanType(input.declaredType, mediaType), filename: cleanName(input.filename, fallbackName),
    };
    for (const k of ['durationMs', 'width', 'height'] as const) {
      const v = input[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) attachment[k] = v;
    }
    const at = Number.isNaN(Date.parse(input.at)) ? new Date().toISOString() : new Date(input.at).toISOString();
    const event: PlatformMediaEvent = {
      eventId: messageId, kind: 'platform-media', conversationKey, messageId, platformMessageId: input.platformMessageId,
      attachments: [attachment], at, machineId: svc.deps.machineId(),
    };
    // Publish the blob first, then the event: never an event without its blob (§4.7).
    svc.media.publishSnapshot(snap.snapshotPath, snap.hashed.sha256);
    svc.store.append(event);
    for (const id of admitted.reservationIds) svc.media.releaseReply(id);
    return { recorded: true, eventId: messageId, sha256: snap.hashed.sha256 };
  } catch (err) {
    // A blob published without its event is an orphan the hourly sweep reclaims after 7 days.
    discardPrepared(svc.media, admitted);
    return { recorded: false, reason: 'record-failed', detail: err instanceof Error ? err.message : String(err) };
  }
}

const IMAGE_TAG = /\[image:[^\]\n]*\]/g;
const DOCUMENT_TAG = /\[document:([^\]\n]*)\]/g;
const VIDEO_TAG = /\[video:[^\]\n]*\]/g;
const VOICE_PATH_TAG = /\[voice:[^\]\n]*\]/g;

/**
 * A Telegram history row's text as a device may see it: every server path replaced (§4.9). The
 * document's display name comes from the recorded attachment when there is one, else from the
 * file name in the path (without the download's time prefix).
 */
export function deviceTextForRow(text: string, attachments?: ReadonlyArray<AppAttachment> | null): string {
  const docs = (attachments ?? []).filter((a) => a.declaredKind === 'file');
  let docIdx = 0;
  return text
    .replace(IMAGE_TAG, '[photo]')
    .replace(VIDEO_TAG, '[video]')
    .replace(VOICE_PATH_TAG, '[voice note]')
    .replace(DOCUMENT_TAG, (_m, p: string) => {
      const a = docs[docIdx++];
      const fromPath = path.basename(p).replace(/^\d{10,}-/, '');
      return `[file: ${displayName(a ? a.filename : fromPath || 'file')}]`;
    });
}

// ── Slack (§4.9, the Slack half) ─────────────────────────────────────────────────────────────

/** A Slack message carries at most this many files (Slack's own limit). */
export const SLACK_MAX_FILES_PER_MESSAGE = 10;

/**
 * The platform message id of one Slack file: the message ts for the message's first recorded
 * file position, `<ts>:<i>` for the file at position `i` > 0, so every file of a message gets its
 * own event and a re-delivered message appends nothing new.
 */
export function slackPlatformMessageId(ts: string, fileIndex: number): string {
  return fileIndex > 0 ? `${ts}:${fileIndex}` : ts;
}

/**
 * The keys a Slack conversation's media may be recorded under: its current canonical key, and,
 * for a concrete workspace, the same conversation under the registry's `_` placeholder (a file
 * recorded before the registry learned the workspace keeps its first key).
 */
export function slackMediaKeys(canonicalKey: string): string[] {
  const m = /^slack:([^:]+):(.+)$/.exec(canonicalKey);
  if (!m || m[1] === '_') return [canonicalKey];
  return [canonicalKey, `slack:_:${m[2]}`];
}

/** The slice of the conversation registry the Slack media path uses. */
export interface SlackMediaRegistry {
  mintForInbound(routingKey: string): { id: number | null };
  resolve(id: number): unknown;
  resolveByKey(key: string): unknown;
}

/**
 * The canonical key of the conversation a Slack inbound message belongs to: the same
 * get-or-create mint the Slack inbound dispatch performs for its routing key, then the
 * registry's canonical key for that id — the key the app store already uses for app-sent Slack
 * messages. Null when the registry has no durable id for it. Never throws.
 */
export function slackMediaConversationKey(registry: SlackMediaRegistry, routingKey: string): string | null {
  try {
    const id = registry.mintForInbound(routingKey).id;
    if (id === null) return null;
    const d = registry.resolve(id) as { platform?: string; key?: unknown } | null;
    return d && d.platform === 'slack' && typeof d.key === 'string' && PLATFORM_CONVERSATION_KEY_RE.test(d.key) ? d.key : null;
  } catch { return null; } // @silent-fallback-ok — reported by the caller as recorded:false (no conversation)
}

/**
 * Whether this machine holds the Slack conversation a download names: the ref is the CURRENT
 * canonical key of a conversation this machine's registry minted itself (never a replicated
 * entry, never a stale placeholder key). Never throws.
 */
export function slackConversationHeldLocally(registry: Pick<SlackMediaRegistry, 'resolveByKey'>, ref: string): boolean {
  if (!/^slack:/.test(ref) || !PLATFORM_CONVERSATION_KEY_RE.test(ref)) return false;
  try {
    const d = registry.resolveByKey(ref) as { platform?: string; key?: unknown; origin?: unknown } | null;
    return !!d && d.platform === 'slack' && d.key === ref && d.origin !== 'replicated';
  } catch { return false; } // @silent-fallback-ok — an unreadable registry holds nothing (404)
}

/**
 * Every file recorded for one Slack message in a conversation, in the message's file order
 * (for `deviceTextForRow`'s `[document:]` naming). Null when none. Never throws.
 */
export function slackPlatformMediaFor(store: Pick<AppConversationService['store'], 'getPlatformMedia'>, canonicalKey: string, ts: string): AppAttachment[] | null {
  const out: AppAttachment[] = [];
  const keys = slackMediaKeys(canonicalKey);
  for (let i = 0; i < SLACK_MAX_FILES_PER_MESSAGE; i++) {
    const pmid = slackPlatformMessageId(ts, i);
    for (const k of keys) {
      let ev: ReturnType<typeof store.getPlatformMedia> = null;
      try { ev = store.getPlatformMedia(k, pmid); } catch { ev = null; } // @silent-fallback-ok — the row is still returned, path-free
      if (ev) { out.push(...ev.attachments); break; }
    }
  }
  return out.length ? out : null;
}

const SLACK_REVIEW_PATH = /(manual review) at [^\]\n]*\]/g;
const SLACK_SAVED_PATH = /(full content saved) to [^\]\n]*\]/g;

/**
 * A Slack history row's text as a device may see it: the paths the Slack adapter writes into a
 * shared text file's note replaced too, then `deviceTextForRow`.
 */
export function slackDeviceText(text: string, attachments?: ReadonlyArray<AppAttachment> | null): string {
  return deviceTextForRow(
    text.replace(SLACK_REVIEW_PATH, "$1 on the agent's machine]").replace(SLACK_SAVED_PATH, "$1 on the agent's machine]"),
    attachments,
  );
}

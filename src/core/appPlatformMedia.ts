/**
 * Telegram (and later Slack) media in the app's history (docs/specs/mobile-native-chat-media.md
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

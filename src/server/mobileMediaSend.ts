import { isQuietReceipt, QuietRecordedError, type QuietReceipt } from '../messaging/NotificationSelectivityGate.js';
import { deviceIcon, mirrorPrefix, openItHint, type DeviceClient } from '../core/deviceClientWording.js';
import { notificationStamper, withNotificationEnvelope } from '../messaging/notificationStampers.js';
const stampNotification = notificationStamper('src/server/mobileMediaSend.ts');
/**
 * The media half of an app send, shared by every send route that accepts files
 * (docs/specs/mobile-native-chat-media.md §4.3, §4.9): a native app conversation
 * (`POST /mobile/chat/app/:key`), a Telegram topic (`POST /mobile/chat/:topicId`) and a Slack
 * conversation (`POST /mobile/chat/slack/:id`). One implementation of the preflight, the
 * idempotency hash parts, the record-size ceiling, and the claim → verify → publish → append
 * order, so the three targets cannot drift apart:
 *
 *   preflight   every named upload is this device's finished upload for THIS conversation,
 *               with exactly the signed fields; filenames and transcripts get the caption's
 *               treatment (scanInbound, exact-token removal).
 *   claim       one transaction claims every upload, then each is re-hashed into the blob store.
 *   publish     blobs published and the event appended with no await between them, so a blob
 *               is never removable before the event that references it is stored.
 *
 * Also the mirror planning for Telegram (§4.9): which files go up as which Bot API method, and
 * which are too large for Telegram and become a text line instead.
 */
import fs from 'node:fs';
import type { AppConversationService } from '../core/AppConversationService.js';
import type { DeviceSignedOrigin, MediaMessageEvent } from '../core/AppConversationStore.js';
import { buildAppConversationRecordData } from '../core/AppConversationsReplicatedStore.js';
import { sha256Hex } from '../core/AppRecordSignatures.js';
import {
  MAX_ATTACHMENTS, MAX_MESSAGE_BYTES, MAX_TRANSCRIPT_CHARS, attachmentIdFor, displayName, effectiveKind, type AppAttachment, type MediaKind,
} from '../core/appMediaTypes.js';
import { removeAuthorityTokens } from '../core/appConversationText.js';
export { telegramGroupTypes, telegramMethodFor, multipartFileName } from '../messaging/telegramMedia.js';

/** One attachment of a send body, as signed by the phone. */
export interface SignedAttachment { uploadId: string; sha256: string; size: number; declaredKind: string; declaredType: string; filename: string; transcript?: string; durationMs?: number; width?: number; height?: number }

export function parseSignedAttachments(raw: unknown): SignedAttachment[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SignedAttachment[] = [];
  for (const r of raw) {
    const a = r as Record<string, unknown> | null;
    if (!a || typeof a.uploadId !== 'string' || typeof a.sha256 !== 'string' || typeof a.size !== 'number' || typeof a.declaredKind !== 'string'
      || typeof a.declaredType !== 'string' || typeof a.filename !== 'string') return null;
    if (a.transcript !== undefined && typeof a.transcript !== 'string') return null;
    const hint = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
    out.push({
      uploadId: a.uploadId, sha256: a.sha256, size: a.size, declaredKind: a.declaredKind, declaredType: a.declaredType, filename: a.filename,
      ...(typeof a.transcript === 'string' ? { transcript: a.transcript } : {}),
      ...(hint(a.durationMs) !== undefined ? { durationMs: hint(a.durationMs) } : {}), ...(hint(a.width) !== undefined ? { width: hint(a.width) } : {}), ...(hint(a.height) !== undefined ? { height: hint(a.height) } : {}),
    });
  }
  return out;
}

/** The per-file parts of the idempotency hash (§4.3): `sha256:size:declaredKind:declaredType:filename:transcript-hash`. */
export function signedFileHashParts(files: ReadonlyArray<SignedAttachment>): string[] {
  return files.map((a) => `${a.sha256}:${a.size}:${a.declaredKind}:${a.declaredType}:${a.filename}:${sha256Hex(a.transcript ?? '')}`);
}

export type RouteRefusal = { status: number; body: Record<string, unknown> };

/**
 * The shape checks every media send makes before anything else: files parsed, at least one,
 * at most MAX_ATTACHMENTS. Null when the body names no files.
 */
export function checkSignedFiles(raw: unknown): { files: SignedAttachment[] } | RouteRefusal {
  const files = parseSignedAttachments(raw);
  if (!files || files.length < 1) return { status: 400, body: { error: 'bad-attachments' } };
  if (files.length > MAX_ATTACHMENTS) return { status: 413, body: { error: 'too-many-attachments', detail: `A message can carry at most ${MAX_ATTACHMENTS} files.` } };
  return { files };
}

export interface MediaPreflightOk { ok: true; uploadIds: string[]; stored: AppAttachment[]; removedKinds: string[] }

/**
 * Preflight (§4.3): no effect on any session or store, except that scanInbound may decline a
 * leaked pending pairing code found in a filename or a transcript (its one, intended effect).
 */
export function preflightMediaAttachments(s: AppConversationService, input: {
  deviceId: string; conversationRef: string; messageId: string; files: ReadonlyArray<SignedAttachment>; scanInbound: (text: string) => void;
}): MediaPreflightOk | ({ ok: false } & RouteRefusal) {
  const media = s.media;
  const uploadIds: string[] = [];
  const stored: AppAttachment[] = [];
  const removedKinds = new Set<string>();
  let total = 0;
  for (let i = 0; i < input.files.length; i++) {
    const a = input.files[i]!;
    const u = media.getUpload(a.uploadId);
    const mismatch = { ok: false as const, status: 409, body: { error: 'attachment-mismatch', index: i, detail: `Attachment ${i + 1} does not match its upload.` } };
    if (!u || u.deviceId !== input.deviceId || u.conversationRef !== input.conversationRef) return mismatch;
    if (u.state === 'claimed' || u.state === 'sent') return { ok: false, status: 409, body: { error: 'upload-already-sent', index: i, detail: 'This file was already sent.' } };
    if (u.sha256 !== a.sha256 || u.size !== a.size || u.declaredKind !== a.declaredKind || u.declaredType !== a.declaredType || u.filename !== a.filename) return mismatch;
    if (u.state !== 'complete' || !u.mediaType) return mismatch;
    if ((a.transcript?.length ?? 0) > MAX_TRANSCRIPT_CHARS) return { ok: false, status: 413, body: { error: 'message-too-large', detail: 'A transcript can be at most 4000 characters.' } };
    total += a.size;
    uploadIds.push(u.uploadId);
    input.scanInbound(a.filename);
    if (a.transcript) input.scanInbound(a.transcript);
    const f = removeAuthorityTokens(a.filename);
    const tr = a.transcript !== undefined ? removeAuthorityTokens(a.transcript) : null;
    for (const k of [...f.kinds, ...(tr?.kinds ?? [])]) removedKinds.add(k);
    stored.push({
      attachmentId: attachmentIdFor(input.messageId, i), index: i, sha256: a.sha256, size: a.size,
      declaredKind: u.declaredKind, kind: effectiveKind(u.declaredKind, u.mediaType), mediaType: u.mediaType, declaredType: a.declaredType,
      filename: f.text.slice(0, 255), ...(tr ? { transcript: tr.text } : {}),
      ...(a.durationMs !== undefined ? { durationMs: a.durationMs } : {}), ...(a.width !== undefined ? { width: a.width } : {}), ...(a.height !== undefined ? { height: a.height } : {}),
    });
  }
  if (total > MAX_MESSAGE_BYTES) return { ok: false, status: 413, body: { error: 'message-too-large', detail: 'A message can carry at most 64 MiB.' } };
  return { ok: true, uploadIds, stored, removedKinds: [...removedKinds] };
}

/** The serialized-record ceiling of §4.1 (fits the 80 KiB journal entry and the 256 KiB line). */
export const MAX_RECORD_BYTES = 72 * 1024;
export const MAX_ORIGIN_BODY_B64 = 64 * 1024;

/** §4.1: the record exactly as stored and as journaled must fit, before any upload is claimed. */
export function mediaRecordTooLarge(msg: MediaMessageEvent, origin: DeviceSignedOrigin | undefined, machineId: string): boolean {
  const asStored = Buffer.byteLength(JSON.stringify({ ...msg, ingestSeq: 0 }));
  const asJournaled = Buffer.byteLength(JSON.stringify(buildAppConversationRecordData(msg)({ physical: 0, logical: 0, node: machineId } as never, machineId)));
  return Math.max(asStored, asJournaled) > MAX_RECORD_BYTES || (origin?.bodyB64?.length ?? 0) > MAX_ORIGIN_BODY_B64;
}

/**
 * Claim every upload at once (§4.3), then make the bytes durable. On failure the claim is
 * released and the refusal returned; the caller releases its own request reservation.
 */
export async function claimMediaUploads(s: AppConversationService, uploadIds: string[], messageId: string, report: (detail: string) => void): Promise<RouteRefusal | null> {
  if (!s.media.claimUploads(uploadIds, messageId)) {
    return { status: 409, body: { error: 'upload-already-sent', detail: 'One of these files was already sent.' } };
  }
  try { await s.media.verifyClaimed(uploadIds); } catch (err) {
    s.media.releaseClaim(uploadIds, messageId);
    report(err instanceof Error ? err.message : String(err));
    return { status: 503, body: { error: 'chat-unavailable', detail: 'The files could not be saved, so the message was not sent. Try again.' } };
  }
  return null;
}

/**
 * Publish the claimed blobs and append the event with no await between them (media review
 * finding 1). Throws (claim released) when the append fails; the caller releases its request.
 */
export function publishMediaMessage(s: AppConversationService, uploadIds: string[], msg: MediaMessageEvent): void {
  try {
    s.media.publishVerified(uploadIds);
    s.store.append(msg);
  } catch (err) {
    s.media.releaseClaim(uploadIds, msg.messageId);
    throw err;
  }
  s.media.markSent(uploadIds, msg.messageId);
}

// ── Mirroring app-sent files into Telegram (§4.9) ─────────────────────────────────────

/** Telegram's Bot API upload limit (§4.9): a larger file is mirrored as a text line. */
export const TELEGRAM_MIRROR_MAX_BYTES = 50_000_000;
/** A media caption is at most 1024 characters, and the origin footer shares it. */
export const TELEGRAM_MIRROR_CAPTION_MAX = 700;

export interface TelegramMirrorFile { path: string; filename: string; mediaType: string; kind: MediaKind; size: number }

export interface TelegramMirrorPlan {
  /** Files to upload (each ≤ 50,000,000 bytes, with a blob on this machine). */
  upload: TelegramMirrorFile[];
  /** The caption for the upload, or null when it is too long and goes as `textLines` instead. */
  caption: string | null;
  /** Text lines sent as ordinary messages: an over-long caption, and one line per oversized file. */
  textLines: string[];
}

/**
 * Plan the Telegram mirror of an app-sent media message (§4.9): files above 50,000,000 bytes
 * become "📱 <owner> sent <display name> (too large for Telegram; open it in the app)"; the rest
 * upload with the caption "📱 <owner> (from the app): <caption>" (💻 … (from the dashboard) for a browser, §4.7). `locate` returns the blob path
 * on this machine; a file with no local blob is treated like an oversized one (a text line), so a
 * mirror never waits on a copy.
 */
export function planTelegramMirror(
  ownerName: string, attachments: ReadonlyArray<AppAttachment>, caption: string, locate: (sha256: string) => string | null,
  client: DeviceClient = 'phone',
): TelegramMirrorPlan {
  const prefix = mirrorPrefix(client, ownerName);
  const upload: TelegramMirrorFile[] = [];
  const tooLarge: string[] = [];
  for (const a of attachments) {
    const p = a.size <= TELEGRAM_MIRROR_MAX_BYTES ? locate(a.sha256) : null;
    if (p) upload.push({ path: p, filename: displayName(a.filename), mediaType: a.mediaType, kind: a.kind, size: a.size });
    else tooLarge.push(`${deviceIcon(client)} ${ownerName} sent ${displayName(a.filename)} (too large for Telegram; ${openItHint(client)})`);
  }
  const line = caption ? `${prefix}: ${caption}` : prefix;
  const textLines: string[] = [];
  let uploadCaption: string | null = line;
  if (upload.length === 0) {
    uploadCaption = null;
    if (caption) textLines.push(line);
  } else if (line.length > TELEGRAM_MIRROR_CAPTION_MAX) {
    uploadCaption = prefix;
    textLines.push(line);
  }
  return { upload, caption: uploadCaption, textLines: [...textLines, ...tooLarge] };
}

/** The slice of TelegramAdapter the mirror uses (a stub satisfies it in tests). */
export interface TelegramMediaMirrorTarget {
  sendMediaToTopic(topicId: number, files: ReadonlyArray<{ data: Uint8Array; filename: string; mediaType: string; kind: MediaKind }>, caption: string | null, options?: { silent?: boolean }): Promise<unknown>;
  sendToTopic(topicId: number, text: string, options?: { silent?: boolean; skipStallClear?: boolean; operatorMirror?: boolean }): Promise<unknown>;
}

export type TelegramMirrorDelivery = { outcome: 'delivered'; deliveredParts: number }
  | { outcome: 'recorded'; deliveredParts: number; receipt: QuietReceipt };
export type TelegramMirrorResult = TelegramMirrorPlan & { delivery: TelegramMirrorDelivery };

/**
 * Mirror an app-sent media message into its Telegram topic (§4.9): the files that fit go up in
 * one request (a media group for several), then any text lines (an over-long caption, and one
 * line per file above Telegram's 50,000,000-byte limit). Throws on the first failure; the route
 * reports `mirror: "failed"` and never repeats the dispatch. `caption` is the operator's text with
 * credential-shaped spans already hidden.
 */
export async function mirrorMediaToTelegram(
  tg: TelegramMediaMirrorTarget, topicId: number, ownerName: string, attachments: ReadonlyArray<AppAttachment>, caption: string,
  locate: (sha256: string) => string | null, client: DeviceClient = 'phone',
): Promise<TelegramMirrorResult> {
  if (typeof tg.sendMediaToTopic !== 'function') throw new Error('this Telegram adapter cannot send files');
  const plan = planTelegramMirror(ownerName, attachments, caption, locate, client);
  let deliveredParts = 0;
  const recorded = (receipt: QuietReceipt): TelegramMirrorResult => ({ ...plan, delivery: { outcome: 'recorded', deliveredParts, receipt } });
  try {
    if (plan.upload.length > 0) {
      const files = await Promise.all(plan.upload.map(async (f) => ({
        data: new Uint8Array(await fs.promises.readFile(f.path)), filename: f.filename, mediaType: f.mediaType, kind: f.kind,
      })));
      const result = await withNotificationEnvelope(stampNotification(), () => tg.sendMediaToTopic(topicId, files, plan.caption, { silent: true }));
      if (isQuietReceipt(result)) return recorded(result);
      deliveredParts++;
    }
    for (const line of plan.textLines) {
      const result = await withNotificationEnvelope(stampNotification(), () => tg.sendToTopic(topicId, line, { silent: true, skipStallClear: true, operatorMirror: true }));
      if (isQuietReceipt(result)) return recorded(result);
      deliveredParts++;
    }
    return { ...plan, delivery: { outcome: 'delivered', deliveredParts } };
  } catch (error) {
    if (error instanceof QuietRecordedError) return recorded(error.receipt);
    throw error;
  }
}

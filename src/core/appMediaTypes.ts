/**
 * Pure helpers for media in app conversations (docs/specs/mobile-native-chat-media.md §4.1, §4.4,
 * §4.5): the attachment record and its validator, the fixed magic-byte table, display and safe
 * names, the session line forms. No I/O.
 */
import crypto from 'node:crypto';

export type MediaKind = 'photo' | 'video' | 'voice' | 'file';
export const MEDIA_KINDS: ReadonlySet<string> = new Set(['photo', 'video', 'voice', 'file']);

export interface AppAttachment {
  attachmentId: string;
  index: number;
  sha256: string;
  size: number;
  declaredKind: MediaKind;
  kind: MediaKind;
  mediaType: string;
  declaredType: string;
  filename: string;
  durationMs?: number;
  width?: number;
  height?: number;
  transcript?: string;
}

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
export const MAX_TRANSCRIPT_CHARS = 4000;
export const MAX_PURGE_BATCH = 500;
export const CHUNK_BYTES = 1024 * 1024;
export const OCTET_STREAM = 'application/octet-stream';
const SHA_RE = /^[0-9a-f]{64}$/;

export function isSha256Hex(v: unknown): v is string { return typeof v === 'string' && SHA_RE.test(v); }

export function attachmentIdFor(messageId: string, index: number): string {
  return crypto.createHash('sha256').update(`${messageId}\u0000${index}`).digest('hex');
}

/** Validate an untrusted attachment list; the whole event is refused on any bad entry. */
export function validateAttachments(raw: unknown, messageId: string): AppAttachment[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ATTACHMENTS) return null;
  const out: AppAttachment[] = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i] as Record<string, unknown> | null;
    if (!a || typeof a !== 'object' || a.index !== i) return null;
    const str = (v: unknown, max: number) => (typeof v === 'string' && v.length >= 1 && v.length <= max && !CONTROL_CHARS.test(v) ? v : null);
    const mediaType = str(a.mediaType, 128);
    const declaredType = str(a.declaredType, 128);
    const filename = str(a.filename, 255);
    if (a.attachmentId !== attachmentIdFor(messageId, i) || !isSha256Hex(a.sha256)) return null;
    if (typeof a.size !== 'number' || !Number.isSafeInteger(a.size) || a.size < 1 || a.size > MAX_FILE_BYTES) return null;
    if (typeof a.kind !== 'string' || !MEDIA_KINDS.has(a.kind) || typeof a.declaredKind !== 'string' || !MEDIA_KINDS.has(a.declaredKind)) return null;
    if (!mediaType || !declaredType || !filename) return null;
    const e: AppAttachment = {
      attachmentId: a.attachmentId as string, index: i, sha256: a.sha256, size: a.size,
      declaredKind: a.declaredKind as MediaKind, kind: a.kind as MediaKind, mediaType, declaredType, filename,
    };
    for (const k of ['durationMs', 'width', 'height'] as const) {
      const v = a[k];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
      e[k] = v;
    }
    if (a.transcript !== undefined) {
      if (typeof a.transcript !== 'string' || a.transcript.length > MAX_TRANSCRIPT_CHARS) return null;
      e.transcript = a.transcript;
    }
    out.push(e);
  }
  return out;
}

// ── Sniffing (§4.4): the bytes decide, never the name or the declaration ──

const FTYP_BRANDS: ReadonlyArray<[string, string]> = [
  ['heic', 'image/heic'], ['heix', 'image/heic'], ['mif1', 'image/heif'], ['msf1', 'image/heif'],
  ['isom', 'video/mp4'], ['mp41', 'video/mp4'], ['mp42', 'video/mp4'], ['qt  ', 'video/quicktime'], ['M4V ', 'video/x-m4v'],
  ['M4A ', 'audio/mp4'],
];

export function sniffMediaType(head: Buffer): string {
  const has = (sig: number[], at = 0) => head.length >= at + sig.length && sig.every((b, i) => head[at + i] === b);
  const ascii = (at: number, len: number) => (head.length >= at + len ? head.toString('latin1', at, at + len) : '');
  if (has([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (has([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav';
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    const hit = FTYP_BRANDS.find(([b]) => b === brand);
    if (hit) return hit[1];
  }
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 3) === 'ID3' || (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (ascii(0, 5) === '%PDF-') return 'application/pdf';
  return OCTET_STREAM;
}

/** The effective kind: a declaration holds only when the bytes agree (a mismatch becomes `file`). */
export function effectiveKind(declared: MediaKind, mediaType: string): MediaKind {
  if (declared === 'photo' && mediaType.startsWith('image/')) return 'photo';
  if (declared === 'video' && mediaType.startsWith('video/')) return 'video';
  if (declared === 'voice' && mediaType.startsWith('audio/')) return 'voice';
  return 'file';
}

/** An agent reply file's kind comes from its bytes alone (§4.6 step 6). */
export function kindFromBytes(mediaType: string): MediaKind {
  if (mediaType.startsWith('image/')) return 'photo';
  if (mediaType.startsWith('video/')) return 'video';
  if (mediaType.startsWith('audio/')) return 'voice';
  return 'file';
}

/** Exactly the types the sniff table can produce, except the fallback (§4.8). Nothing else is inline. */
export const INLINE_SAFE_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
  'video/mp4', 'video/quicktime', 'video/x-m4v', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/wav', 'application/pdf',
]);

export function isInlineSafe(mediaType: string): boolean {
  return INLINE_SAFE_TYPES.has(mediaType);
}

/** Control characters (CR and LF included) are never allowed in a stored type or file name. */
export const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/x-m4v': 'm4v', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3',
  'audio/wav': 'wav', 'application/pdf': 'pdf',
};

/**
 * A server-chosen file name: `[A-Za-z0-9._-]` only, ≤ 100 characters, and only the sniffed
 * type's extension (the sender's extension is always dropped, so `x.html` never keeps `.html`).
 */
export function safeFileName(filename: string, mediaType: string): string {
  const ext = EXTENSIONS[mediaType];
  const stem = filename.replace(/\.[^.]*$/, '').replace(/\./g, '_').replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[_-]+/, '').slice(0, ext ? 92 : 100) || 'file';
  return ext ? `${stem}.${ext}` : stem;
}

/** A name safe to put in a session line or a notification: it cannot forge a tag (§4.5). */
export function displayName(filename: string): string {
  const cleaned = filename
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/["[\]()]/g, '')
    .replace(/\u{1F4F1}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, 60).join('').trim() || 'file';
}

function formatSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KiB`;
  return `${n} bytes`;
}

/** The session line for one attachment, in Telegram's forms (§4.5). */
export function sessionLine(a: AppAttachment, filePath: string): string {
  switch (a.kind) {
    case 'photo': return `[image:${filePath}]`;
    case 'video': return `[video:${filePath}]${a.durationMs !== undefined ? ` (${Math.round(a.durationMs / 1000)} s)` : ''}`;
    case 'voice': return `[voice:${filePath}] ${a.transcript ? a.transcript : '(no transcript)'}`;
    default: return `[document:${filePath}] (${displayName(a.filename)}, ${a.mediaType}, ${formatSize(a.size)})`;
  }
}

/** The context-file line for an earlier attachment: no path, and how to get one (§4.5). */
export function historyLine(a: AppAttachment): string {
  const tag = a.kind === 'photo' ? 'image' : a.kind === 'file' ? 'document' : a.kind;
  return `[${tag}] ${displayName(a.filename)} (attachment ${a.attachmentId})`;
}

/** The conversation list's preview of a media message. */
/** Longest caption or reply text a push preview carries (chat-media spec §4.11). */
export const PUSH_PREVIEW_CHARS = 100;

/**
 * The body of a reply notification (chat-media spec §4.11): the reply's first 100 characters,
 * or a fixed phrase for files followed by the caption's first 100 characters.
 */
export function pushPreviewBody(attachments: ReadonlyArray<AppAttachment>, text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const clip = flat.length > PUSH_PREVIEW_CHARS ? `${flat.slice(0, PUSH_PREVIEW_CHARS - 1)}…` : flat;
  if (attachments.length === 0) return clip || 'New reply';
  const first = attachments[0]!;
  const label = attachments.length > 1 ? `sent ${attachments.length} files`
    : first.kind === 'photo' ? 'sent a photo' : first.kind === 'video' ? 'sent a video'
      : first.kind === 'voice' ? 'sent a voice message' : `sent a file: ${displayName(first.filename)}`;
  return clip ? `${label}: ${clip}` : label;
}

export function mediaPreview(attachments: ReadonlyArray<AppAttachment>, text: string): string {
  const caption = text.replace(/\s+/g, ' ').trim();
  const first = attachments[0];
  const label = attachments.length > 1 ? `${attachments.length} files`
    : first?.kind === 'photo' ? 'Photo' : first?.kind === 'video' ? 'Video' : first?.kind === 'voice' ? 'Voice message' : `File: ${displayName(first?.filename ?? 'file')}`;
  return caption ? `${label}: ${caption}` : label;
}

/** RFC 8785 for the flat string/number objects this feature signs: sorted keys, ES6 number form. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The per-attachment fields a redacted media record signs and a verifier compares (§4.13). */
export interface AttachmentProjection { sha256: string; size: number; declaredKind: string; declaredType: string; filename: string; transcript?: string }
export function attachmentProjection(a: AttachmentProjection): AttachmentProjection {
  return { sha256: a.sha256, size: a.size, declaredKind: a.declaredKind, declaredType: a.declaredType, filename: a.filename, ...(a.transcript !== undefined ? { transcript: a.transcript } : {}) };
}

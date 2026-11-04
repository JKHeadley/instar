/**
 * Pure helpers for sending files into a Telegram topic (docs/specs/mobile-native-chat-media.md
 * §4.9: the mirror of a photo or file the operator sent from the Instar app). Which Bot API
 * method carries each kind, how a group of files is typed, and a filename the origin outbox's
 * multipart rules accept.
 */
export type TelegramMediaKind = 'photo' | 'video' | 'voice' | 'file';

/** The Bot API method and its file field for one file of a given kind. */
export function telegramMethodFor(kind: TelegramMediaKind): { method: 'sendPhoto' | 'sendVideo' | 'sendVoice' | 'sendDocument'; field: 'photo' | 'video' | 'voice' | 'document' } {
  switch (kind) {
    case 'photo': return { method: 'sendPhoto', field: 'photo' };
    case 'video': return { method: 'sendVideo', field: 'video' };
    case 'voice': return { method: 'sendVoice', field: 'voice' };
    default: return { method: 'sendDocument', field: 'document' };
  }
}

/**
 * The kind Telegram will actually accept for this file. `sendPhoto` takes only JPEG, PNG and WebP,
 * and `sendVideo` only MP4; anything else (an iPhone HEIC screenshot, a QuickTime clip) is refused
 * with a 400, so it goes up as a document instead. A voice note keeps its kind.
 */
export function telegramKindFor(kind: TelegramMediaKind, mediaType: string): TelegramMediaKind {
  const t = mediaType.toLowerCase().split(';')[0]!.trim();
  if (kind === 'photo') return t === 'image/jpeg' || t === 'image/png' || t === 'image/webp' ? 'photo' : 'file';
  if (kind === 'video') return t === 'video/mp4' ? 'video' : 'file';
  return kind;
}

/**
 * The `sendMediaGroup` item type for each file: photos and videos group together; any other
 * mix goes up as a group of documents (Telegram refuses a group mixing documents with photos,
 * and a voice note cannot be in a group at all).
 */
export function telegramGroupTypes(kinds: ReadonlyArray<TelegramMediaKind>): Array<'photo' | 'video' | 'document'> {
  const visual = kinds.every((k) => k === 'photo' || k === 'video');
  return kinds.map((k) => (visual ? (k === 'photo' ? 'photo' : 'video') : 'document'));
}

/** A filename safe for a multipart header (the origin outbox refuses quotes, backslashes and line breaks). */
export function multipartFileName(name: string): string {
  const cleaned = name.replace(/[\x00-\x1f\x7f"\\]/g, '').trim().slice(0, 200);
  return cleaned || 'file';
}

/** A media type the origin outbox accepts in a multipart header, else application/octet-stream. */
export function multipartMediaType(mediaType: string): string {
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mediaType) ? mediaType : 'application/octet-stream';
}

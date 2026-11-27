/**
 * Media by attachment id, never by a path in text (docs/specs/native-conversation-base.md §3c).
 *
 * A file a person sends travels as a structured `media[]` field set by server code. The text beside
 * it is person text: every path-tag form in it is made inert here, and the only file lines a session
 * ever sees are built by server code from the field (`platformMediaForSession.ts`).
 *
 * Pure: no I/O. Shared by the Telegram adapter, the lifeline, the forward route, the mesh carrier,
 * the durable inbound queue and the Slack / iMessage adapters.
 */
import { displayName } from './appMediaTypes.js';

export type InboundMediaKind = 'photo' | 'document' | 'video' | 'voice';

/** The wire form: what crosses a machine boundary or sits in the inbound queue. No path, ever. */
export interface InboundMediaRef {
  kind: InboundMediaKind;
  /** The platform's own message id (Telegram `message_id`, as a string). */
  platformMessageId?: string;
  /** An attachment already in the app media store (a file sent from the app into a topic). */
  attachmentId?: string;
  /** A display name (already passed through `displayName`). */
  filename: string;
  /** `pending`: the poller is copying it into the media store. `off`: native media is off on the poller. */
  capture?: 'pending' | 'off';
}

/** The in-process form on the machine that downloaded the file. `localPath` never leaves the process. */
export interface InboundMediaLocal extends InboundMediaRef {
  localPath?: string;
}

/** A message carries at most this many files. */
export const MAX_INBOUND_MEDIA = 10;

const KINDS: ReadonlySet<string> = new Set<InboundMediaKind>(['photo', 'document', 'video', 'voice']);
const PLATFORM_ID_RE = /^[0-9A-Za-z._:-]{1,64}$/;
const ATTACHMENT_ID_RE = /^[0-9A-Za-z._:-]{1,128}$/;

/**
 * Every path-tag form a session injector has ever read: `[image:`, `[document:`, `[video:`,
 * `[voice:`, `[file:`, in any case, with stray spaces. The escaped form `[typed image:` is matched by
 * none of the injector patterns, old or new, and by this pattern neither, so escaping twice changes
 * nothing.
 */
const TYPED_PATH_TAG_RE = /\[(\s*)(image|document|video|voice|file)(\s*):/gi;

/** Make every path-tag form in person-supplied text inert. Idempotent. */
export function escapeTypedPathTags(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text.replace(TYPED_PATH_TAG_RE, (_m, _lead: string, kind: string) => `[typed ${kind}:`);
}

/** True when the text still holds a live path tag (a test and diagnostic aid). */
export function hasLivePathTag(text: string): boolean {
  TYPED_PATH_TAG_RE.lastIndex = 0;
  const hit = TYPED_PATH_TAG_RE.test(text);
  TYPED_PATH_TAG_RE.lastIndex = 0;
  return hit;
}

const NOUN: Readonly<Record<InboundMediaKind, string>> = {
  photo: 'a photo', document: 'a file', video: 'a video', voice: 'a voice note',
};

function lineSafe(name: string): string {
  return displayName(name).replace(/`/g, '');
}

/** The id a session and the fetch route use for this file. */
export function mediaIdOf(m: InboundMediaRef): string {
  return m.platformMessageId ?? m.attachmentId ?? 'unknown';
}

/**
 * The fixed, path-free sentence carried in the text for each file (§3c item 3). An older receiver
 * ignores `media[]` and injects this, so its session knows a file was sent, and which one.
 */
export function fallbackSentence(m: InboundMediaRef): string {
  return `[The user sent ${NOUN[m.kind]} (attachment \`${mediaIdOf(m)}\`, \`${lineSafe(m.filename)}\`). It is stored on another machine and cannot be opened here.]`;
}

/** The line a session gets when the file cannot be opened on its machine (§3c item 4, last bullet). */
export const STORED_ELSEWHERE_LINE = 'The user sent a file that is stored on another machine and cannot be opened here.';

/** The wire form of a list: drops anything in-process. */
export function toWireMedia(media: ReadonlyArray<InboundMediaLocal>): InboundMediaRef[] {
  return media.map((m) => {
    const out: InboundMediaRef = { kind: m.kind, filename: m.filename };
    if (m.platformMessageId !== undefined) out.platformMessageId = m.platformMessageId;
    if (m.attachmentId !== undefined) out.attachmentId = m.attachmentId;
    if (m.capture !== undefined) out.capture = m.capture;
    return out;
  });
}

/**
 * The text that travels: one fallback sentence per file, then the person's text, escaped.
 * Built by server code only.
 */
export function composeInboundPayload(personText: string, media: ReadonlyArray<InboundMediaRef>): string {
  const escaped = escapeTypedPathTags(personText ?? '');
  const sentences = media.map(fallbackSentence);
  return [...sentences, ...(escaped ? [escaped] : [])].join('\n');
}

/** Remove exactly the fallback sentences this message's own `media[]` produces (§3c item 3). */
export function stripFallbackSentences(payload: string, media: ReadonlyArray<InboundMediaRef>): string {
  let out = payload;
  for (const m of media) {
    const s = fallbackSentence(m);
    const at = out.indexOf(s);
    if (at < 0) continue;
    const end = at + s.length;
    out = out.slice(0, at) + out.slice(out[end] === '\n' ? end + 1 : end);
  }
  return out;
}

/**
 * Read a `media` field off the wire. `null` means the field was absent (an older sender); `[]` means
 * a newer sender with no file. Unknown kinds and malformed ids are dropped, never trusted; a
 * `localPath` is never read here (see `parseLifelineMedia`).
 */
export function parseInboundMediaField(raw: unknown): InboundMediaRef[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return null;
  const out: InboundMediaRef[] = [];
  for (const e of raw.slice(0, MAX_INBOUND_MEDIA)) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    if (typeof r.kind !== 'string' || !KINDS.has(r.kind)) continue;
    const platformMessageId = typeof r.platformMessageId === 'string' && PLATFORM_ID_RE.test(r.platformMessageId) ? r.platformMessageId
      : typeof r.platformMessageId === 'number' && Number.isSafeInteger(r.platformMessageId) && r.platformMessageId > 0 ? String(r.platformMessageId)
        : undefined;
    const attachmentId = typeof r.attachmentId === 'string' && ATTACHMENT_ID_RE.test(r.attachmentId) ? r.attachmentId : undefined;
    if (!platformMessageId && !attachmentId) continue;
    const ref: InboundMediaRef = { kind: r.kind as InboundMediaKind, filename: lineSafe(typeof r.filename === 'string' ? r.filename : 'file') };
    if (platformMessageId) ref.platformMessageId = platformMessageId;
    if (attachmentId) ref.attachmentId = attachmentId;
    if (r.capture === 'pending' || r.capture === 'off') ref.capture = r.capture;
    out.push(ref);
  }
  return out;
}

/**
 * Read a `media` cell from THIS machine's own inbound queue. Same checks as the wire parse, and a
 * `localPath` string is kept: it was written by this machine's ingress, and the resolver accepts it
 * only after a realpath check inside this machine's download directories. Never used on wire input.
 */
export function parseQueuedMediaCell(raw: unknown): InboundMediaLocal[] | null {
  const refs = parseInboundMediaField(raw);
  if (!refs || !Array.isArray(raw)) return refs;
  const out: InboundMediaLocal[] = [];
  for (const e of raw.slice(0, MAX_INBOUND_MEDIA)) {
    const ref: InboundMediaLocal | undefined = parseInboundMediaField([e])?.[0];
    if (!ref) continue;
    const lp = (e as Record<string, unknown>).localPath;
    if (typeof lp === 'string' && lp.startsWith('/') && lp.length <= 4096) ref.localPath = lp;
    out.push(ref);
  }
  return out;
}

/** A tag at position 0 of a text, in the form an older poller or lifeline writes (`[image:<path>] caption`). */
const LEADING_LEGACY_TAG_RE = /^\[(image|document):([^\]\n]+)\]\s?/;

export interface LeadingLegacyTag { kind: 'photo' | 'document'; path: string; rest: string }

/**
 * The one tag an older poller or lifeline puts at the front of a photo or document message.
 * Everything after it is person text. `download-failed` is not a path.
 */
export function takeLeadingLegacyTag(text: string): LeadingLegacyTag | null {
  const m = LEADING_LEGACY_TAG_RE.exec(text ?? '');
  if (!m) return null;
  const p = m[2]!.trim();
  return { kind: m[1] === 'image' ? 'photo' : 'document', path: p, rest: text.slice(m[0].length) };
}

/** The topic-history form of a message with files: never a path (§3c item 3). */
export function historyTextFor(personText: string, media: ReadonlyArray<InboundMediaRef>): string {
  const marks = media.map((m) => m.kind === 'photo' ? '[photo]'
    : m.kind === 'video' ? '[video]'
      : m.kind === 'voice' ? '[voice note]'
        : `[file: ${lineSafe(m.filename)}]`);
  const escaped = escapeTypedPathTags(personText ?? '');
  return [...marks, ...(escaped ? [escaped] : [])].join(' ');
}

/** The message type the pipeline records, from the field, never from the text. */
export function messageTypeOf(media: ReadonlyArray<InboundMediaRef> | null | undefined, content: string): 'voice' | 'photo' | 'document' | 'text' {
  const first = media?.[0];
  if (first) return first.kind === 'photo' ? 'photo' : first.kind === 'voice' ? 'voice' : 'document';
  return content.startsWith('[voice]') ? 'voice' : 'text';
}

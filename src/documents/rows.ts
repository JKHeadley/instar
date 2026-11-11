/**
 * Instar Documents — the replicated row format (spec docs/specs/instar-document-viewer.md §3.4).
 *
 * A document is an append-only stream of immutable rows. Rows carry only small metadata and
 * hashes; every piece of text lives in a salted content blob (blobs.ts), so a purge can delete
 * text while every row still verifies. These constants are the replicated FORMAT (formatVersion
 * 1): every machine validates with exactly the same bounds, and changing one is a format version,
 * never config (§6, "Accept-side format constants").
 */

export const DOC_FORMAT_VERSION = 1 as const;

/** Format constants, identical on every machine. Write-side limits may only tighten these. */
export const FORMAT = Object.freeze({
  /** A content blob, measured on the serialized bytes. */
  blobBytes: 48 * 1024,
  /** A row, measured on the serialized bytes. */
  rowBytes: 4 * 1024,
  /** The selected quote (`exact`) of an anchor. */
  quoteBytes: 2 * 1024,
  /** Prefix and suffix context of an anchor, in characters. */
  contextChars: 48,
  /** A title or a link reason, in characters. */
  titleChars: 512,
  reasonChars: 512,
  /** Version chunks per version. */
  chunksPerVersion: 1024,
  /** A sync page, in bytes. */
  pageBytes: 4 * 1024 * 1024,
});

/** Write-side defaults (§6 judgment-candidate rows). The owner's config may only tighten them. */
export const WRITE_DEFAULTS = Object.freeze({
  titleChars: 120,
  reasonChars: 200,
  commentBytes: 256 * 1024,
  commentsPerHourPerDoc: 120,
  textBytesPerPersonPerDay: 20 * 1024 * 1024,
});

export type Vector = Readonly<Record<string, number>>;

/** A row's identity: `${origin}/${incarnation}#${seq}`. */
export type RowKey = string;
export const rowKeyOf = (r: { origin: string; incarnation: string; seq: number }): RowKey => `${r.origin}/${r.incarnation}#${r.seq}`;
export const streamOf = (r: { origin: string; incarnation: string }): string => `${r.origin}/${r.incarnation}`;

/** A conversation ref as the team model writes it, or another graph node. */
export type ConversationRef = string; // telegram:<id> | app:<uuid>
export type NodeRef = string; // doc:<uuid> | ConversationRef | slack:… | project:<id> | initiative:<id> | spec:<path>

export interface SignedOrigin {
  /** The device (phone or browser) key hash and id. */
  keyHash: string;
  deviceId: string;
  /** The signing domain the request was signed under. */
  domain: 'instar-device-v1' | 'instar-docpage-v1';
  /** The canonical, operation-specific payload, base64url JSON (hashes only, never text). */
  payloadB64: string;
  host: string;
  timeMs: string;
  sig: string;
  /** The device-minted request id (docpage), or the single-use Face ID challenge (a move's device-signed request). */
  requestId?: string;
}

export interface MachineSig { machineId: string; signerKeyHash: string; sig: string }

export type Actor =
  | { type: 'owner-phone'; deviceId: string; signedOrigin: SignedOrigin }
  | { type: 'person'; personKey: string; deviceId: string; client: 'phone' | 'browser'; signedOrigin: SignedOrigin }
  | { type: 'agent'; placeKey: string }
  | { type: 'machine' };

export type CommentKey = string; // `${authorKey}:${commentId}`
export const commentKeyOf = (authorKey: string, commentId: string): CommentKey => `${authorKey}:${commentId}`;

export interface AnchorRef {
  /** Hash of the salted anchor blob (exact, prefix, suffix; long selections as head + tail). */
  anchorHash: string;
  start: number;
  end: number;
  blockHint: string;
}

/** The row kinds and their small, hash-only fields. */
export type RowBody =
  | { eventKind: 'created'; titleHash: string; ownerPerson: string; primary: ConversationRef; createdFrom: NodeRef; docSaltHash: string }
  | { eventKind: 'version'; versionId: string; label: number; parents: string[]; contentHash: string; projectionVersion: number; chunks: number; noteHash?: string; addressesHash?: string }
  | { eventKind: 'version-chunk'; versionId: string; index: number; payloadHash: string }
  | { eventKind: 'comment'; commentId: string; anchor: AnchorRef; bodyHash: string; onVersion: string }
  | { eventKind: 'comment-edit'; commentKey: CommentKey; bodyHash: string }
  | { eventKind: 'comment-reanchor'; commentKey: CommentKey; anchor: AnchorRef; onVersion: string }
  | { eventKind: 'reply'; commentKey: CommentKey; replyId: string; bodyHash: string }
  | { eventKind: 'resolve' | 'reopen'; commentKey: CommentKey }
  | { eventKind: 'addressed'; commentKeysHash: string; versionId: string }
  | { eventKind: 'send'; batchId: string; coveredHash: string; primaryRow: RowKey; messageRequestId: string }
  | { eventKind: 'link' | 'unlink'; to: NodeRef; kind: LinkKind; reasonHash?: string }
  | { eventKind: 'primary-set'; primary: ConversationRef; docDepsSigned: Vector }
  | { eventKind: 'title'; titleHash: string }
  | { eventKind: 'tombstone' | 'purge' }
  | { eventKind: 'prune'; versionIds: string[] }
  | { eventKind: 'place-disclosure'; grantRow: string; heads: Vector }
  | { eventKind: 'device-seen'; deviceId: string };

export type EventKind = RowBody['eventKind'];
export type LinkKind = 'discusses' | 'derived-from' | 'supersedes' | 'references' | 'about-project';
export const LINK_KINDS: readonly LinkKind[] = ['discusses', 'derived-from', 'supersedes', 'references', 'about-project'];

export interface DocRowHeader {
  formatVersion: typeof DOC_FORMAT_VERSION;
  docId: string;
  origin: string;
  incarnation: string;
  seq: number;
  /** Hash of this origin's previous row (across all documents), or null for its first. */
  prevHash: string | null;
  eventId: string;
  /** Display only; never used for ordering. */
  receivedAt: string;
  actor: Actor;
  /** The team-log vector the accepting machine decided standing under. */
  access: Vector;
  /** For agent rows: the session's launch-time team vector (server-stamped, ≤ access). */
  sessionAccess?: Vector;
  /** This document's rows the writer had seen. */
  docDeps: Vector;
  /** The primary-set (or created) row in force when standing was decided. */
  primaryRow: RowKey | null;
}

export type DocRow = DocRowHeader & RowBody & { machineSig: MachineSig };
export type UnsignedDocRow = DocRowHeader & RowBody;

/** The reserved device stream (§4.1). */
export const DEVICES_DOC_ID = '_devices';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const CONV_REF = /^(telegram:-?[1-9]\d{0,19}|app:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const NODE_REF = /^(doc:[0-9a-f-]{36}|telegram:-?[1-9]\d{0,19}|app:[0-9a-f-]{36}|slack:[A-Za-z0-9:._-]{1,128}|project:[A-Za-z0-9._-]{1,128}|initiative:[A-Za-z0-9._-]{1,128}|spec:[A-Za-z0-9._/-]{1,240})$/;

export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);
export const isHash = (s: unknown): s is string => typeof s === 'string' && HEX64.test(s);
export const isConversationRef = (s: unknown): s is ConversationRef => typeof s === 'string' && CONV_REF.test(s);
export const isNodeRef = (s: unknown): s is NodeRef => typeof s === 'string' && NODE_REF.test(s);

function isVector(v: unknown): v is Vector {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.entries(v as Record<string, unknown>).every(([k, n]) => k.length <= 200 && Number.isSafeInteger(n) && (n as number) >= 0);
}
const isRowKey = (s: unknown): s is RowKey => typeof s === 'string' && /^[^#\s]{1,200}#\d{1,15}$/.test(s);
const isCommentKey = (s: unknown): boolean => typeof s === 'string' && /^[A-Za-z0-9._:-]{1,200}:[0-9a-f-]{36}$/.test(s);

function validActor(a: unknown): boolean {
  if (!a || typeof a !== 'object') return false;
  const x = a as Record<string, unknown>;
  switch (x.type) {
    case 'agent': return typeof x.placeKey === 'string' && x.placeKey.length > 0 && x.placeKey.length <= 300;
    case 'machine': return true;
    case 'owner-phone': return typeof x.deviceId === 'string' && validSignedOrigin(x.signedOrigin);
    case 'person': return typeof x.personKey === 'string' && typeof x.deviceId === 'string'
      && (x.client === 'phone' || x.client === 'browser') && validSignedOrigin(x.signedOrigin);
    default: return false;
  }
}

function validSignedOrigin(o: unknown): boolean {
  if (!o || typeof o !== 'object') return false;
  const x = o as Record<string, unknown>;
  return typeof x.keyHash === 'string' && typeof x.deviceId === 'string'
    && (x.domain === 'instar-device-v1' || x.domain === 'instar-docpage-v1')
    && (x.requestId === undefined || (typeof x.requestId === 'string' && x.requestId.length <= 128))
    && typeof x.payloadB64 === 'string' && x.payloadB64.length <= 2048
    && typeof x.host === 'string' && typeof x.timeMs === 'string' && typeof x.sig === 'string';
}

function validAnchor(a: unknown): boolean {
  if (!a || typeof a !== 'object') return false;
  const x = a as Record<string, unknown>;
  return isHash(x.anchorHash) && Number.isSafeInteger(x.start) && Number.isSafeInteger(x.end)
    && (x.start as number) >= 0 && (x.end as number) >= (x.start as number) && typeof x.blockHint === 'string' && x.blockHint.length <= 128;
}

/** The body checks, by kind. Pure and total: anything unrecognised is invalid. */
function validBody(r: Record<string, unknown>): boolean {
  switch (r.eventKind) {
    case 'created': return isHash(r.titleHash) && typeof r.ownerPerson === 'string' && isConversationRef(r.primary) && isNodeRef(r.createdFrom) && isHash(r.docSaltHash);
    case 'version': return isUuid(r.versionId) && Number.isSafeInteger(r.label) && (r.label as number) >= 1
      && Array.isArray(r.parents) && r.parents.length <= 8 && r.parents.every(isUuid) && isHash(r.contentHash)
      && Number.isSafeInteger(r.projectionVersion) && Number.isSafeInteger(r.chunks) && (r.chunks as number) >= 0 && (r.chunks as number) <= FORMAT.chunksPerVersion
      && (r.noteHash === undefined || isHash(r.noteHash)) && (r.addressesHash === undefined || isHash(r.addressesHash));
    case 'version-chunk': return isUuid(r.versionId) && Number.isSafeInteger(r.index) && (r.index as number) >= 0 && (r.index as number) < FORMAT.chunksPerVersion && isHash(r.payloadHash);
    case 'comment': return isUuid(r.commentId) && validAnchor(r.anchor) && isHash(r.bodyHash) && isUuid(r.onVersion);
    case 'comment-edit': return isCommentKey(r.commentKey) && isHash(r.bodyHash);
    case 'comment-reanchor': return isCommentKey(r.commentKey) && validAnchor(r.anchor) && isUuid(r.onVersion);
    case 'reply': return isCommentKey(r.commentKey) && isUuid(r.replyId) && isHash(r.bodyHash);
    case 'resolve': case 'reopen': return isCommentKey(r.commentKey);
    case 'addressed': return isHash(r.commentKeysHash) && isUuid(r.versionId);
    case 'send': return typeof r.batchId === 'string' && /^\d{13}-[0-9a-f-]{36}$/.test(r.batchId) && isHash(r.coveredHash) && isRowKey(r.primaryRow) && typeof r.messageRequestId === 'string';
    case 'link': case 'unlink': return isNodeRef(r.to) && LINK_KINDS.includes(r.kind as LinkKind) && (r.reasonHash === undefined || isHash(r.reasonHash));
    case 'primary-set': return isConversationRef(r.primary) && isVector(r.docDepsSigned);
    case 'title': return isHash(r.titleHash);
    case 'tombstone': case 'purge': return true;
    case 'prune': return Array.isArray(r.versionIds) && r.versionIds.length > 0 && r.versionIds.length <= 256 && r.versionIds.every(isUuid);
    case 'place-disclosure': return typeof r.grantRow === 'string' && r.grantRow.length <= 300 && isVector(r.heads);
    case 'device-seen': return typeof r.deviceId === 'string' && r.deviceId.length <= 200;
    default: return false;
  }
}

/** Which actor types may write each kind (spec §3.4 table). Standing is checked separately (access.ts). */
const WRITERS: Record<EventKind, ReadonlyArray<Actor['type']>> = {
  'created': ['agent', 'owner-phone', 'person'],
  'version': ['agent', 'owner-phone', 'person'],
  'version-chunk': ['agent', 'owner-phone', 'person'],
  'comment': ['owner-phone', 'person', 'agent'],
  'comment-edit': ['owner-phone', 'person'],
  'comment-reanchor': ['owner-phone', 'person'],
  'reply': ['owner-phone', 'person', 'agent'],
  'resolve': ['owner-phone', 'person'],
  'reopen': ['owner-phone', 'person'],
  'addressed': ['agent'],
  'send': ['owner-phone', 'person'],
  'link': ['agent', 'owner-phone'],
  'unlink': ['agent', 'owner-phone'],
  'primary-set': ['owner-phone'],
  'title': ['agent', 'owner-phone', 'person'],
  'tombstone': ['owner-phone', 'person'],
  'purge': ['owner-phone'],
  'prune': ['owner-phone'],
  'place-disclosure': ['machine'],
  'device-seen': ['machine'],
};

export type RowCheck = { ok: true } | { ok: false; reason: string };

/**
 * Structural validation of a row, identical on every machine. Signature and standing are checked
 * elsewhere (chain.ts, access.ts). Never throws.
 */
export function validateRow(input: unknown): RowCheck {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'not-an-object' };
  const r = input as Record<string, unknown>;
  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(r), 'utf8'); } catch { return { ok: false, reason: 'unserializable' }; }
  if (size > FORMAT.rowBytes) return { ok: false, reason: 'row-too-large' };
  if (r.formatVersion !== DOC_FORMAT_VERSION) return { ok: false, reason: 'format-version' };
  if (!(isUuid(r.docId) || r.docId === DEVICES_DOC_ID)) return { ok: false, reason: 'doc-id' };
  if (typeof r.origin !== 'string' || !r.origin || r.origin.length > 120) return { ok: false, reason: 'origin' };
  if (typeof r.incarnation !== 'string' || !r.incarnation || r.incarnation.length > 64) return { ok: false, reason: 'incarnation' };
  if (!Number.isSafeInteger(r.seq) || (r.seq as number) < 1) return { ok: false, reason: 'seq' };
  if (!(r.prevHash === null || isHash(r.prevHash))) return { ok: false, reason: 'prev-hash' };
  if (!isUuid(r.eventId)) return { ok: false, reason: 'event-id' };
  if (typeof r.receivedAt !== 'string' || r.receivedAt.length > 40) return { ok: false, reason: 'received-at' };
  if (!validActor(r.actor)) return { ok: false, reason: 'actor' };
  if (!isVector(r.access) || !isVector(r.docDeps)) return { ok: false, reason: 'vectors' };
  if (r.sessionAccess !== undefined && !isVector(r.sessionAccess)) return { ok: false, reason: 'session-access' };
  if (!(r.primaryRow === null || isRowKey(r.primaryRow))) return { ok: false, reason: 'primary-row' };
  if (!validBody(r)) return { ok: false, reason: `body:${String(r.eventKind)}` };
  const actorType = (r.actor as { type: Actor['type'] }).type;
  if (!WRITERS[r.eventKind as EventKind].includes(actorType)) return { ok: false, reason: 'writer-not-allowed' };
  if (r.eventKind === 'device-seen' && r.docId !== DEVICES_DOC_ID) return { ok: false, reason: 'device-stream' };
  if (r.eventKind !== 'device-seen' && r.docId === DEVICES_DOC_ID) return { ok: false, reason: 'device-stream' };
  if (actorType === 'agent' && r.sessionAccess !== undefined && !vectorLeq(r.sessionAccess as Vector, r.access as Vector)) {
    return { ok: false, reason: 'session-access-exceeds-access' };
  }
  return { ok: true };
}

/** a ≤ b pointwise. */
export function vectorLeq(a: Vector, b: Vector): boolean {
  return Object.entries(a).every(([k, n]) => (b[k] ?? 0) >= n);
}

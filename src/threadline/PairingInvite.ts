/**
 * Pairing invites — the pure core of verified pairing by invite link
 * (docs/specs/a2a-pairing-invite-link.md §4.1–§4.2, §7).
 *
 * An invite carries the inviter's identity key and a one-time secret S. The person carries
 * it to the other agent through a channel the relay never sees; nothing here is read or
 * compared by a human. This module has no I/O: encode/decode with a checksum, expiry, the
 * transcript both sides authenticate, the MAC key derived from S, the tag, and the optional
 * check code two operators on a call can read to each other.
 *
 * Consumers: PairingInviteFlow (the protocol, §4.3–§4.4), PairingInviteStore (the inviter's
 * record), and the places that must recognise an invite without decoding it to keep its secret
 * out of logs and sessions: PairingInviteTelegram, TelegramAdapter, MessageQueue and the
 * dashboard (all via INVITE_PREFIX / findInviteToken).
 */

import crypto from 'node:crypto';

export const INVITE_PREFIX = 'tlinv1:';
export const INVITE_VERSION = 1;
/** Default validity (spec §4.1). */
export const INVITE_DEFAULT_TTL_MS = 60 * 60_000;
/** The longest an inviter may choose. */
export const INVITE_MAX_TTL_MS = 24 * 60 * 60_000;
const MAX_LABEL = 64;
const CHECKSUM_BYTES = 4;
const TRANSCRIPT_CONTEXT = 'threadline-invite-v1';
const MAC_INFO = 'threadline-invite-mac-v1';

export type InviteDirection = 'accept' | 'finish' | 'ack' | 'used';

export interface PairingInvite {
  v: 1;
  /** Non-secret invite id, 16 bytes hex. */
  iid: string;
  /** Inviter's routing fingerprint (first 16 bytes of `key`), hex. */
  fp: string;
  /** Inviter's Ed25519 identity key, 32 bytes hex. */
  key: string;
  /** Self-described names. Shown to operators as CLAIMED, never trusted. */
  owner: string;
  agent: string;
  /** One-time secret S, 32 bytes hex. A bearer secret until used. */
  secret: string;
  /** ISO expiry. */
  exp: string;
  /** Optional: the fingerprint of the only agent allowed to accept. */
  bind?: string;
}

export type DecodeResult = { ok: true; invite: PairingInvite } | { ok: false; reason: string };

const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n * 2}}$`);

/** Self-described labels: trimmed, control characters removed, capped. */
export function cleanLabel(s: unknown): string {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_LABEL);
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function checksum(payload: Buffer): Buffer {
  return crypto.createHash('sha256').update(payload).digest().subarray(0, CHECKSUM_BYTES);
}

/** Make a new invite. `now` and `random` are injectable for tests. */
export function createInvite(opts: {
  identityPubHex: string;
  owner: string;
  agent: string;
  ttlMs?: number;
  bindFp?: string;
  now?: Date;
  random?: (n: number) => Buffer;
}): PairingInvite {
  const key = opts.identityPubHex.toLowerCase();
  if (!HEX(32).test(key)) throw new TypeError('identityPubHex must be 32 bytes of hex');
  const ttl = Math.min(Math.max(opts.ttlMs ?? INVITE_DEFAULT_TTL_MS, 60_000), INVITE_MAX_TTL_MS);
  const now = opts.now ?? new Date();
  const rnd = opts.random ?? ((n: number) => crypto.randomBytes(n));
  const bind = opts.bindFp?.toLowerCase();
  if (bind !== undefined && !HEX(16).test(bind)) throw new TypeError('bindFp must be a 16-byte fingerprint');
  return {
    v: INVITE_VERSION,
    iid: rnd(16).toString('hex'),
    fp: key.slice(0, 32),
    key,
    owner: cleanLabel(opts.owner),
    agent: cleanLabel(opts.agent),
    secret: rnd(32).toString('hex'),
    exp: new Date(now.getTime() + ttl).toISOString(),
    ...(bind ? { bind } : {}),
  };
}

/** One line: `tlinv1:<payload>.<checksum>`, both base64url. */
export function encodeInvite(inv: PairingInvite): string {
  const payload = Buffer.from(JSON.stringify(inv), 'utf8');
  return `${INVITE_PREFIX}${b64url(payload)}.${b64url(checksum(payload))}`;
}

/** The first `tlinv1:` token in a piece of text (a forwarded message may carry prose around it). */
export function findInviteToken(text: string): string | null {
  const m = /tlinv1:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.exec(String(text ?? ''));
  return m ? m[0] : null;
}

/** Decode and validate an invite. Never throws. Expiry is checked separately (isExpired). */
export function decodeInvite(text: string): DecodeResult {
  const token = findInviteToken(text);
  if (!token) return { ok: false, reason: 'no invite code found' };
  const [payloadPart, sumPart] = token.slice(INVITE_PREFIX.length).split('.');
  const payload = fromB64url(payloadPart ?? '');
  const sum = fromB64url(sumPart ?? '');
  if (!payload || !sum || sum.length !== CHECKSUM_BYTES) return { ok: false, reason: 'invite code is damaged' };
  if (!crypto.timingSafeEqual(checksum(payload), sum)) {
    return { ok: false, reason: 'invite code is damaged or incomplete (checksum mismatch)' };
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(payload.toString('utf8'));
  } catch {
    return { ok: false, reason: 'invite code is damaged' };
  }
  if (raw.v !== INVITE_VERSION) return { ok: false, reason: `unsupported invite version ${String(raw.v)}` };
  const str = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string).toLowerCase() : '');
  const iid = str('iid');
  const key = str('key');
  const fp = str('fp');
  const secret = str('secret');
  const bind = raw.bind === undefined ? undefined : str('bind');
  if (!HEX(16).test(iid)) return { ok: false, reason: 'invite id malformed' };
  if (!HEX(32).test(key)) return { ok: false, reason: 'inviter key malformed' };
  if (fp !== key.slice(0, 32)) return { ok: false, reason: 'inviter fingerprint does not match its key' };
  if (!HEX(32).test(secret)) return { ok: false, reason: 'invite secret malformed' };
  if (bind !== undefined && !HEX(16).test(bind)) return { ok: false, reason: 'invite binding malformed' };
  const exp = typeof raw.exp === 'string' ? raw.exp : '';
  if (Number.isNaN(Date.parse(exp))) return { ok: false, reason: 'invite expiry malformed' };
  return {
    ok: true,
    invite: {
      v: INVITE_VERSION, iid, fp, key, secret, exp,
      owner: cleanLabel(raw.owner), agent: cleanLabel(raw.agent),
      ...(bind !== undefined ? { bind } : {}),
    },
  };
}

export function isExpired(inv: Pick<PairingInvite, 'exp'>, now: Date = new Date()): boolean {
  return now.getTime() >= Date.parse(inv.exp);
}

/** Fields both sides authenticate (spec §4.2). Hex strings except `exp` (ISO) and `direction`. */
export interface TranscriptFields {
  iid: string;
  fpA: string;
  idA: string;
  fpB: string;
  idB: string;
  exp: string;
  nonce: string;
  direction: InviteDirection;
}

/** Length-prefixed (u32 BE) so no two different field splits encode the same bytes. */
export function transcript(t: TranscriptFields): Buffer {
  // Hex fields are lowercased so the two sides cannot disagree on case.
  const hex = (s: string) => String(s).toLowerCase();
  const parts = [TRANSCRIPT_CONTEXT, hex(t.iid), hex(t.fpA), hex(t.idA), hex(t.fpB), hex(t.idB), t.exp, hex(t.nonce), t.direction]
    .map((s) => Buffer.from(s, 'utf8'));
  return Buffer.concat(parts.flatMap((p) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(p.length, 0);
    return [len, p];
  }));
}

/** K = HKDF-SHA256(ikm = S, salt = iid, info = "threadline-invite-mac-v1", L = 32). */
export function macKey(secretHex: string, iidHex: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secretHex, 'hex'), Buffer.from(iidHex, 'hex'), MAC_INFO, 32));
}

export function inviteTag(K: Buffer, T: Buffer): string {
  return crypto.createHmac('sha256', K).update(T).digest('hex');
}

/** Constant-time tag check. Never throws. */
export function verifyInviteTag(K: Buffer, T: Buffer, tagHex: unknown): boolean {
  if (typeof tagHex !== 'string' || !/^[0-9a-f]{64}$/i.test(tagHex)) return false;
  return crypto.timingSafeEqual(Buffer.from(inviteTag(K, T), 'hex'), Buffer.from(tagHex, 'hex'));
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Optional 4-character check code (20 bits) both confirm screens show, for two operators who
 * are on a call together (spec §7). Never required by the flow.
 */
export function checkCode(K: Buffer, idAHex: string, idBHex: string): string {
  const h = crypto.createHmac('sha256', K).update('check').update(Buffer.from(idAHex, 'hex')).update(Buffer.from(idBHex, 'hex')).digest();
  const bits = (h[0] << 12) | (h[1] << 4) | (h[2] >> 4); // first 20 bits
  let out = '';
  for (let i = 3; i >= 0; i--) out += CROCKFORD[(bits >> (i * 5)) & 31];
  return out;
}

/** The message the inviter sends (spec §5): a code, never an http(s) URL. */
export function inviteMessage(inv: PairingInvite): string {
  const mins = Math.max(1, Math.round((Date.parse(inv.exp) - Date.now()) / 60_000));
  const when = mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`;
  return `${inv.agent || 'An agent'} (${inv.owner || 'unknown owner'}'s agent) invites your agent to pair. ` +
    `Forward this to your agent's Telegram, or paste it in its dashboard. Keep it private; it expires in ${when}.\n\n${encodeInvite(inv)}`;
}

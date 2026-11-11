/**
 * Instar Documents — the `instar-docpage-v1` signing domain (spec §3.6; app contract answer 2).
 *
 * A person's page writes (comments, replies, resolve, edits, re-anchors, Send) are signed by THEIR
 * device key under this separate domain, bound to one document, one operation and one request id.
 * No device-signed route accepts this domain, and these routes accept nothing else, so the page
 * bridge can never be used to sign a grant, a conversation or a chat message.
 *
 * Signed string:
 *   instar-docpage-v1\n{deviceId}\n{host}\n{docId}\n{op}\n{requestId}\n{timeMs}\n{sha256hex(canonicalPayload)}
 */
import crypto from 'node:crypto';
import { DEVICE_TIME_WINDOW_MS, isStrictLowSDer, parseDevicePublicKey } from '../core/MobileDeviceKeys.js';
import { canonicalJson } from './chain.js';

export const DOCPAGE_DOMAIN = 'instar-docpage-v1' as const;
export const DOCPAGE_OPS = ['comment', 'reply', 'resolve', 'reopen', 'edit', 'reanchor', 'send', 'open'] as const;
export type DocpageOp = (typeof DOCPAGE_OPS)[number];

/** The fields each operation's payload must carry, exactly (§3.6). */
const PAYLOAD_FIELDS: Record<DocpageOp, readonly string[]> = {
  // The quote is cut by the server from the signed version and position (deterministic projection),
  // so the phone signs the position, never quote text it might have read differently.
  comment: ['docId', 'commentId', 'onVersion', 'start', 'end', 'bodyHash'],
  reply: ['docId', 'commentKey', 'replyId', 'bodyHash'],
  resolve: ['docId', 'commentKey'],
  reopen: ['docId', 'commentKey'],
  edit: ['docId', 'commentKey', 'bodyHash'],
  reanchor: ['docId', 'commentKey', 'onVersion', 'start', 'end'],
  send: ['docId', 'batchId', 'commentKeysHash', 'primaryRow', 'messageRequestId'],
  open: ['docId'],
};

export function docpageString(deviceId: string, host: string, docId: string, op: DocpageOp, requestId: string, timeMs: string, payload: Record<string, unknown>): string {
  const h = crypto.createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
  return `${DOCPAGE_DOMAIN}\n${deviceId}\n${host.toLowerCase()}\n${docId}\n${op}\n${requestId}\n${timeMs}\n${h}`;
}

export interface DocpageRequest {
  deviceId: string;
  host: string;
  docId: string;
  op: string;
  requestId: string;
  timeMs: string;
  payload: unknown;
  sigB64url: string;
}

export type DocpageVerdict =
  | { ok: true; op: DocpageOp; payload: Record<string, unknown> }
  | { ok: false; reason: 'bad-op' | 'bad-payload' | 'doc-mismatch' | 'bad-request-id' | 'stale' | 'bad-key' | 'bad-signature' | 'replay' | 'host-not-own' };

/**
 * Verify one docpage request. `devicePublicKey` is the person's device key (phone or linked
 * browser, base64url raw P-256 point), resolved by the caller from the device record or the
 * replicated binding. `isOwnHost` is this machine's own-names check. `seen` records used request ids.
 */
export function verifyDocpage(req: DocpageRequest, devicePublicKey: string, isOwnHost: (host: string) => boolean, seen: { has(id: string): boolean; add(id: string): void }, now: number = Date.now()): DocpageVerdict {
  if (!(DOCPAGE_OPS as readonly string[]).includes(req.op)) return { ok: false, reason: 'bad-op' };
  const op = req.op as DocpageOp;
  if (!req.payload || typeof req.payload !== 'object' || Array.isArray(req.payload)) return { ok: false, reason: 'bad-payload' };
  const payload = req.payload as Record<string, unknown>;
  const keys = Object.keys(payload).sort();
  const want = [...PAYLOAD_FIELDS[op]].sort();
  if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) return { ok: false, reason: 'bad-payload' };
  if (payload.docId !== req.docId) return { ok: false, reason: 'doc-mismatch' };
  if (!/^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(req.requestId)) return { ok: false, reason: 'bad-request-id' };
  const t = Number(req.timeMs);
  if (!Number.isFinite(t) || Math.abs(now - t) > DEVICE_TIME_WINDOW_MS) return { ok: false, reason: 'stale' };
  if (!isOwnHost(req.host)) return { ok: false, reason: 'host-not-own' };
  const key = parseDevicePublicKey(devicePublicKey);
  if (!key) return { ok: false, reason: 'bad-key' };
  let sig: Buffer;
  try { sig = Buffer.from(req.sigB64url, 'base64url'); } catch { return { ok: false, reason: 'bad-signature' }; }
  if (!isStrictLowSDer(sig)) return { ok: false, reason: 'bad-signature' };
  const message = docpageString(req.deviceId, req.host, req.docId, op, req.requestId, req.timeMs, payload);
  let valid = false;
  try { valid = crypto.verify('sha256', Buffer.from(message), { key, dsaEncoding: 'der' }, sig); } catch { valid = false; } // @silent-fallback-ok — a malformed signature is invalid
  if (!valid) return { ok: false, reason: 'bad-signature' };
  const replayKey = `${req.deviceId}|${req.requestId}`;
  if (seen.has(replayKey)) return { ok: false, reason: 'replay' };
  seen.add(replayKey);
  return { ok: true, op, payload };
}

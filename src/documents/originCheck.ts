/**
 * Instar Documents — every machine re-checks who wrote a person or owner row (spec §3.6: "Peers
 * reject any `person` row without a valid `signedOrigin`").
 *
 * A row written for a person carries the device's whole signed request (`signedOrigin`). A
 * receiving machine re-verifies it against that device's key (from the replicated device-key
 * ledger and team bindings), checks the row says exactly what was signed, and checks the request
 * id was never used before in this document. So a machine (or a process holding the machine key)
 * can never write a comment, reply, resolve, edit or Send as a person, or a move as the owner,
 * that the person's own device did not sign.
 *
 * A move (`primary-set`) carries the owner phone's device-signed request (`instar-device-v1`),
 * whose body names the conversation, the exact history disclosed and the Face ID challenge. The
 * Face ID (presence) signature itself is checked by the machine that took the request; presence
 * keys are not replicated, so peers verify the device signature, that the device is the owner's
 * phone, and that the disclosed history equals the row's own `docDeps`.
 *
 * Verdicts: `ok`; `denied` (refused, keeps its chain position); `pending` (the device key, its
 * binding, or a list blob is not here yet: the row is kept out of every read and re-checked).
 */
import crypto from 'node:crypto';
import { canonicalJson } from './chain.js';
import { docpageSignatureValid, type DocpageOp } from './docpageAuth.js';
import { canonicalString, isStrictLowSDer, parseDevicePublicKey } from '../core/MobileDeviceKeys.js';
import type { DocRow } from './rows.js';

export type OriginVerdict = 'ok' | 'denied' | 'pending';

/**
 * The device behind a key hash. `role` comes only from records that say so (a replicated team
 * binding, or this machine's own device record); `unknown` while neither has arrived.
 */
export type DeviceKeyLookup = (deviceId: string, keyHash: string) =>
  | { status: 'ok'; publicKey: string; role: 'owner' | 'person' | 'unknown'; personKey: string | null; client: 'phone' | 'browser'; mayWrite: boolean }
  | { status: 'unknown' }
  | { status: 'revoked' };

/** A list blob's items (a Send's covered comments), or null when the blob is not here yet. */
export type ListLookup = (docId: string, hash: string) => string[] | null;

const OP_OF: Partial<Record<DocRow['eventKind'], DocpageOp>> = {
  comment: 'comment', reply: 'reply', resolve: 'resolve', reopen: 'reopen', 'comment-edit': 'edit', 'comment-reanchor': 'reanchor', send: 'send',
};

/** Does the row say exactly what the device signed? */
function rowMatchesPayload(row: DocRow, p: Record<string, unknown>): boolean {
  const r = row as unknown as Record<string, unknown> & { anchor?: { start: number; end: number } };
  switch (row.eventKind) {
    case 'comment': return p.commentId === r.commentId && p.onVersion === r.onVersion && p.bodyHash === r.bodyHash
      && p.start === r.anchor?.start && p.end === r.anchor?.end;
    case 'reply': return p.commentKey === r.commentKey && p.replyId === r.replyId && p.bodyHash === r.bodyHash;
    case 'resolve': case 'reopen': return p.commentKey === r.commentKey;
    case 'comment-edit': return p.commentKey === r.commentKey && p.bodyHash === r.bodyHash;
    case 'comment-reanchor': return p.commentKey === r.commentKey && p.onVersion === r.onVersion
      && p.start === r.anchor?.start && p.end === r.anchor?.end;
    case 'send': return p.batchId === r.batchId && p.messageRequestId === r.messageRequestId && p.primaryRow === r.primaryRow;
    default: return false;
  }
}

/** sha256(canonicalJson(sorted comment keys)): what a signed Send names (app contract item 2). */
export function commentKeysHashOf(keys: string[]): string {
  return crypto.createHash('sha256').update(canonicalJson([...keys].sort()), 'utf8').digest('hex');
}

/**
 * Check one row's origin. `usedRequestIds` is the set of `deviceId|requestId` already held in
 * this document (a replayed request under a new machine event id is refused).
 */
export function checkRowOrigin(row: DocRow, devices: DeviceKeyLookup, usedRequestIds: ReadonlySet<string>, listOf?: ListLookup): OriginVerdict {
  const a = row.actor;
  if (a.type !== 'person' && a.type !== 'owner-phone') return 'ok';
  const so = a.signedOrigin;
  if (!so || so.deviceId !== a.deviceId || !so.sig || !so.requestId) return 'denied';
  if (usedRequestIds.has(`${so.deviceId}|${so.requestId}`)) return 'denied';
  const d = devices(so.deviceId, so.keyHash);
  if (d.status === 'unknown') return 'pending';
  if (d.status === 'revoked' || !d.mayWrite) return 'denied';
  // The device belongs to the row's author; a role not known here yet waits for its binding.
  if (d.role === 'unknown') return 'pending';
  if (a.type === 'owner-phone' && d.role !== 'owner') return 'denied';
  if (a.type === 'person' && (d.role !== 'person' || d.personKey !== a.personKey || d.client !== a.client)) return 'denied';

  if (so.domain === 'instar-device-v1') return checkMove(row, so, d.publicKey, d.client);
  if (so.domain !== 'instar-docpage-v1') return 'denied';
  const op = OP_OF[row.eventKind];
  if (!op) return 'denied';
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(so.payloadB64, 'base64url').toString('utf8')); } catch { return 'denied'; } // @silent-fallback-ok — an unreadable payload is unsigned
  const v = docpageSignatureValid({ deviceId: so.deviceId, host: so.host, docId: row.docId, op, requestId: so.requestId, timeMs: so.timeMs, payload, sigB64url: so.sig }, d.publicKey);
  if (!v.ok || !rowMatchesPayload(row, v.payload)) return 'denied';
  if (row.eventKind === 'send') {
    // The covered list is exactly the comments the person signed for (keys without revisions).
    const items = listOf?.(row.docId, row.coveredHash) ?? null;
    if (!items) return 'pending';
    const keys = items.map((k) => (k.lastIndexOf('@') > 0 ? k.slice(0, k.lastIndexOf('@')) : k));
    if (commentKeysHashOf(keys) !== v.payload.commentKeysHash) return 'denied';
  }
  return 'ok';
}

/** A Face ID move: the owner phone's device-signed `POST /mobile/docs/<id>/primary`, naming exactly this move. */
function checkMove(row: DocRow, so: { deviceId: string; host: string; timeMs: string; sig: string; payloadB64: string; requestId?: string }, publicKey: string, client: 'phone' | 'browser'): OriginVerdict {
  if (row.eventKind !== 'primary-set' || row.actor.type !== 'owner-phone' || client !== 'phone') return 'denied';
  const raw = Buffer.from(so.payloadB64, 'base64url');
  let body: { primary?: unknown; docDeps?: unknown; challenge?: unknown; presenceSig?: unknown };
  try { body = JSON.parse(raw.toString('utf8')); } catch { return 'denied'; } // @silent-fallback-ok — an unreadable body is unsigned
  if (!body || body.primary !== row.primary || typeof body.presenceSig !== 'string' || body.challenge !== so.requestId) return 'denied';
  // The history the owner saw is exactly the history this row stands on.
  if (canonicalJson(body.docDeps ?? null) !== canonicalJson(row.docDepsSigned) || canonicalJson(row.docDepsSigned) !== canonicalJson(row.docDeps)) return 'denied';
  const key = parseDevicePublicKey(publicKey);
  if (!key) return 'denied';
  let sig: Buffer;
  try { sig = Buffer.from(so.sig, 'base64url'); } catch { return 'denied'; } // @silent-fallback-ok — malformed is invalid
  if (!isStrictLowSDer(sig)) return 'denied';
  const message = canonicalString(so.deviceId, so.host, 'POST', `/mobile/docs/${row.docId}/primary`, so.timeMs, raw);
  try { return crypto.verify('sha256', Buffer.from(message), { key, dsaEncoding: 'der' }, sig) ? 'ok' : 'denied'; } catch { return 'denied'; } // @silent-fallback-ok — malformed is invalid
}

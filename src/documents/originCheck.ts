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
 * binding, or a list blob is not here yet: the row is kept out of every read and re-checked);
 * `held` (a decision signed by the owner's phone, waiting for that phone's own machine).
 */
import crypto from 'node:crypto';
import { canonicalJson } from './chain.js';
import { docpageSignatureValid, type DocpageOp } from './docpageAuth.js';
import { canonicalString, isStrictLowSDer, parseDevicePublicKey } from '../core/MobileDeviceKeys.js';
import type { DocRow, Vector } from './rows.js';
import type { TeamAccessState } from '../core/TeamAccessLog.js';
import { DECIDE_APPROVALS } from './access.js';

/**
 * `held`: a decision whose device signature and contents this machine verified, waiting for the
 * machine holding the phone's own enrollment to check its Face ID (SEC-088 interim). Read like
 * `pending` (kept out of every read), except that it alone may show "answered on the phone".
 */
export type OriginVerdict = 'ok' | 'denied' | 'pending' | 'held';

/**
 * The device behind a key hash. `role` comes only from records that say so (a replicated team
 * binding, or this machine's own device record); `unknown` while neither has arrived.
 */
export type DeviceKeyLookup = (deviceId: string, keyHash: string, at?: { access: Vector; personKey: string | null }) =>
  | { status: 'ok'; publicKey: string; role: 'owner' | 'person' | 'unknown'; personKey: string | null; client: 'phone' | 'browser'; mayWrite: boolean; approvedVia?: string | null;
      /**
       * Set only from THIS machine's own enrollment of the device (an active owner phone whose key
       * matches, not revoked): its Face ID key. Never from replicated activation fields (SEC-088).
       */
      localPresenceKey?: string }
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

/**
 * Did a person's device stand when its row was accepted, although it is revoked now? (§3.4:
 * "Revocation is effective from the revoke row onward; rows accepted before it stand".)
 *
 * The order comes from the team log, never from a time a row claims: `at` is the team state folded
 * from exactly the prefix the row's own `access` vector names (stamped and signed by the accepting
 * machine), and `now` is this machine's current team state. The device stood when, in `at`, the
 * person is present and the key is bound to them (for a linked computer: its `browser-bind` is in
 * force, names this device, and was signed by a phone key also bound to them in `at`). Its
 * revocation must also be witnessed by a team row outside that prefix: the person's removal, or
 * the computer's `browser-unbind`. A revocation recorded only in the device-key ledger has no
 * team-log position, so it can't be ordered against the row and the row stays refused. A row
 * accepted after the revoke row carries an `access` that includes it, so `at` already shows the
 * device gone and the row is refused on every machine.
 */
export function deviceStoodAt(
  at: TeamAccessState, now: TeamAccessState,
  d: { keyHash: string; deviceId: string; personKey: string; client: 'phone' | 'browser' },
  linkSigned: (link: NonNullable<ReturnType<TeamAccessState['browserLinks']['get']>>) => boolean,
  /** member-browser-any-computer §3.5: has this joined computer ended now (its end passed, by the folded rows)? */
  joinedEndedNow?: (keyHash: string) => boolean,
): boolean {
  if (!at.on || !at.people.has(d.personKey) || at.bindings.get(d.keyHash) !== d.personKey) return false;
  const removedSince = !now.people.has(d.personKey);
  if (d.client === 'phone') return !at.browserLinks.has(d.keyHash) && !at.computerLinks?.has(d.keyHash) && removedSince;
  // A joined computer stood when its binding was in force under that prefix; it is witnessed gone by a
  // removal, a Forget (unbind), or its end passing. Expiry writes no row, so the end is read from the
  // folded rows rather than from an unbind (member-browser-any-computer §3.4, §3.5).
  const joined = at.computerLinks?.get(d.keyHash);
  if (joined) {
    if (joined.unbound || joined.deviceId !== d.deviceId || joined.boundTo !== d.personKey) return false;
    return removedSince || !!now.computerLinks?.get(d.keyHash)?.unbound || (joinedEndedNow?.(d.keyHash) ?? false);
  }
  const link = at.browserLinks.get(d.keyHash);
  if (!link || link.unbound || link.deviceId !== d.deviceId || link.boundTo !== d.personKey) return false;
  if (at.bindings.get(link.linkedByKeyHash) !== d.personKey || !linkSigned(link)) return false;
  return removedSince || !!now.browserLinks.get(d.keyHash)?.unbound;
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
  // `at`: the team-log position the row was accepted under, so a device revoked by a later team row
  // still stands for the rows its origin accepted before that row (deviceStoodAt).
  const d = devices(so.deviceId, so.keyHash, { access: row.access, personKey: a.type === 'person' ? a.personKey : null });
  if (d.status === 'unknown') return 'pending';
  if (d.status === 'revoked' || !d.mayWrite) return 'denied';
  // The device belongs to the row's author; a role not known here yet waits for its binding.
  if (d.role === 'unknown') return 'pending';
  if (a.type === 'owner-phone' && d.role !== 'owner') return 'denied';
  if (a.type === 'person' && (d.role !== 'person' || d.personKey !== a.personKey || d.client !== a.client)) return 'denied';

  if (so.domain === 'instar-device-v1') {
    if (row.eventKind === 'decision') {
      // Interim (SEC-088): a decision counts only on the machine holding the phone's own enrollment,
      // which re-checks its Face ID signature too. Elsewhere it stays held ('held'): the page
      // shows "waiting", Needs-you stays, and no session is told. Replicated activation fields
      // (approvedVia, keys) never qualify as proof that an owner decided. The device signature and
      // the row's contents are still checked here first, so a row with an invalid or altered device
      // signature is refused. A machine that can write activation and binding rows can still produce
      // a 'held' row (SEC-088), so 'held' is advisory only: it never hides the owner's buttons.
      return checkDecision(row, so, d.publicKey, d.client, d.approvedVia ?? null, d.localPresenceKey ?? null);
    }
    return checkMove(row, so, d.publicKey, d.client);
  }
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

/** The path a decision's device-signed request is posted to (docs/specs/document-decisions.md §3.2). */
export const decisionPath = (docId: string): string => `/mobile/docs/${docId}/decision`;
/** The note hash meaning "no note" in a signed decision body. */
export const NO_NOTE = '0'.repeat(64);

/**
 * A decision: the owner phone's device-signed `POST /mobile/docs/<id>/decision`, naming exactly this
 * answer, its Face ID challenge and presence signature. The presence signature itself is checked by
 * the machine that took the request (presence keys are not replicated, as for the move).
 */
function checkDecision(row: DocRow, so: { deviceId: string; host: string; timeMs: string; sig: string; payloadB64: string; requestId?: string }, publicKey: string, client: 'phone' | 'browser', approvedVia: string | null, presenceKey: string | null): OriginVerdict {
  if (row.eventKind !== 'decision' || row.actor.type !== 'owner-phone' || client !== 'phone') return 'denied';
  const raw = Buffer.from(so.payloadB64, 'base64url');
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>; } catch { return 'denied'; } // @silent-fallback-ok — an unreadable body is unsigned
  if (!body || typeof body !== 'object') return 'denied';
  const noteOk = row.noteHash === undefined ? body.noteHash === NO_NOTE : body.noteHash === row.noteHash;
  const supOk = row.supersedes === undefined ? body.supersedes === null || body.supersedes === undefined : body.supersedes === row.supersedes;
  if (body.askId !== row.askId || body.onVersion !== row.onVersion || body.verdict !== row.verdict || body.questionHash !== row.questionHash || !noteOk || !supOk) return 'denied';
  if (typeof body.presenceSig !== 'string' || typeof body.challenge !== 'string' || body.challenge !== so.requestId) return 'denied';
  const key = parseDevicePublicKey(publicKey);
  if (!key) return 'denied';
  let sig: Buffer;
  try { sig = Buffer.from(so.sig, 'base64url'); } catch { return 'denied'; } // @silent-fallback-ok — malformed is invalid
  if (!isStrictLowSDer(sig)) return 'denied';
  const message = canonicalString(so.deviceId, so.host, 'POST', decisionPath(row.docId), so.timeMs, raw);
  try { if (!crypto.verify('sha256', Buffer.from(message), { key, dsaEncoding: 'der' }, sig)) return 'denied'; } catch { return 'denied'; } // @silent-fallback-ok — malformed is invalid
  // Device-signed and matching: only the phone's own machine can check the Face ID signature.
  // Replicated approval fields prove nothing here (SEC-088), so they are not read before this point.
  if (!presenceKey) return 'held';
  if (!approvedVia || !DECIDE_APPROVALS.has(approvedVia)) return 'denied';
  // The row's proof label must match the device's own approval (a PIN device never reads as Telegram).
  if (approvedVia === 'dashboard-pin' && row.proof !== 'pin') return 'denied';
  if (approvedVia === 'telegram-dm' && row.proof !== 'telegram') return 'denied';
  // The Face ID signature over exactly this answer, with this machine's own copy of the presence key.
  const line = decisionLine(row.docId, { askId: row.askId, onVersion: row.onVersion, verdict: row.verdict, questionHash: row.questionHash, noteHash: row.noteHash ?? NO_NOTE, supersedes: row.supersedes ?? null });
  return presenceValid(presenceKey, decisionPresenceMessage(so.deviceId, so.host, so.requestId ?? '', line), body.presenceSig) ? 'ok' : 'denied';
}

/** The line a decision's Face ID signs (docs/specs/document-decisions.md §3.2). */
export function decisionLine(docId: string, b: { askId: string; onVersion: string; verdict: string; questionHash: string; noteHash: string; supersedes: string | null }): string {
  return `docs-decision ${docId} ${b.askId} ${b.onVersion} ${b.verdict} ${b.questionHash} ${b.noteHash} ${b.supersedes ?? '-'}`;
}

/**
 * The presence message, byte-for-byte `permissionPresenceMessage` (server/mobilePermissionsRoutes.ts,
 * `instar-permission-action-v1`); kept here so this module stays free of server imports. A unit test
 * pins the two together.
 */
export function decisionPresenceMessage(deviceId: string, host: string, challenge: string, line: string): string {
  return `instar-permission-action-v1\n${deviceId}\n${host.toLowerCase()}\n${challenge}\n${line}`;
}

function presenceValid(presenceKeyB64: string, message: string, sigB64: unknown): boolean {
  if (typeof sigB64 !== 'string' || sigB64.length > 128 || !/^[A-Za-z0-9_-]+$/.test(sigB64)) return false;
  const key = parseDevicePublicKey(presenceKeyB64);
  if (!key) return false;
  const sig = Buffer.from(sigB64, 'base64url');
  if (!isStrictLowSDer(sig)) return false;
  try { return crypto.verify('sha256', Buffer.from(message), { key, dsaEncoding: 'der' }, sig); } catch { return false; } // @silent-fallback-ok — malformed is invalid
}

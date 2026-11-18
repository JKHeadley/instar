/** Document decisions (docs/specs/document-decisions.md): rows, access, the derived state, peer origin checks, the service. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateSigningKeyPair, sign as edSign } from '../../src/core/MachineIdentity.js';
import { signerKeyHashOf, deviceKeyHashOf, type MachineSigner } from '../../src/core/AppRecordSignatures.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { DocumentStore } from '../../src/documents/store.js';
import { DocumentService, type Caller } from '../../src/documents/service.js';
import { mayDoDocument, type TeamView, type DocFacts, type Principal } from '../../src/documents/access.js';
import { validateRow, type DocRow } from '../../src/documents/rows.js';
import { checkRowOrigin, decisionPath, decisionLine, decisionPresenceMessage, NO_NOTE, type DeviceKeyLookup } from '../../src/documents/originCheck.js';
import { permissionPresenceMessage } from '../../src/server/mobilePermissionsRoutes.js';
import { decisionView, decisionMessageRequestId, chatRecordDelivered } from '../../src/documents/decisions.js';
import { REQUEST_ID_PATTERN } from '../../src/core/MobileChatRequests.js';
import { blobHash, newSalt } from '../../src/documents/blobs.js';

const tmp: string[] = [];
afterEach(() => { for (const d of tmp.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/documents-decisions.test.ts' }); });

const OWN = 'app:44444444-4444-4444-8444-444444444444';
const SHARED = 'telegram:500';
const so = { keyHash: 'k', deviceId: 'od', domain: 'instar-device-v1' as const, payloadB64: 'e30', host: 'h', timeMs: '1', sig: 's', requestId: 'c' };

function setup() {
  const kp = generateSigningKeyPair();
  const signer: MachineSigner = { machineId: () => 'A', signerKeyHash: () => signerKeyHashOf(kp.publicKey), sign: (p) => ({ machineId: 'A', signerKeyHash: signerKeyHashOf(kp.publicKey), sig: edSign(p, kp.privateKey) }) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docdec-')); tmp.push(dir);
  const store = new DocumentStore(dir, { signer, keyLookup: () => ({ status: 'ok', publicKeyPem: kp.publicKey }), standing: () => 'ok' });
  const team: TeamView = {
    personMay: (k, ref) => ref === SHARED && k === 'mara', ownerOnly: (ref) => ref === OWN,
    sessionInPlace: (k, ref) => k === `place:${ref}`, teamRefusal: () => null, sendReachesOwner: () => false,
  };
  return { store, svc: new DocumentService(store, team) };
}
const agent: Caller = { principal: { kind: 'agent', placeKey: `place:${OWN}`, ownerReach: false }, actor: { type: 'agent', placeKey: `place:${OWN}` }, access: {}, reader: { kind: 'place' } };
// Each decision is its own device request (a fresh Face ID challenge), so each gets its own request id.
const ownerPhone = (via = 'telegram-dm'): Caller => ({ principal: { kind: 'owner-device', client: 'phone', approvedVia: via }, actor: { type: 'owner-phone', deviceId: 'od', signedOrigin: { ...so, requestId: crypto.randomUUID() } }, access: {}, reader: { kind: 'owner' } });
const codeOf = (f: () => unknown): string => { try { f(); return 'no-error'; } catch (e) { return (e as { code?: string }).code ?? String(e); } };
const MD = '# Ship it?\n\nThe hardening closes the door.\n';

describe('decision rows', () => {
  const base = { formatVersion: 1, docId: crypto.randomUUID(), origin: 'A', incarnation: 'i', seq: 1, prevHash: null, eventId: crypto.randomUUID(), receivedAt: 'now', access: {}, docDeps: {}, primaryRow: null };
  it('only the agent asks, only the owner phone decides, only the machine records delivery', () => {
    const ask = { ...base, eventKind: 'decision-ask', askId: crypto.randomUUID(), questionHash: 'a'.repeat(64) };
    expect(validateRow({ ...ask, actor: { type: 'agent', placeKey: 'p' } }).ok).toBe(true);
    expect(validateRow({ ...ask, actor: { type: 'owner-phone', deviceId: 'd', signedOrigin: so } })).toEqual({ ok: false, reason: 'writer-not-allowed' });
    const dec = { ...base, eventKind: 'decision', askId: crypto.randomUUID(), onVersion: crypto.randomUUID(), verdict: 'approve', questionHash: 'a'.repeat(64), proof: 'telegram' };
    expect(validateRow({ ...dec, actor: { type: 'owner-phone', deviceId: 'd', signedOrigin: so } }).ok).toBe(true);
    expect(validateRow({ ...dec, actor: { type: 'agent', placeKey: 'p' } })).toEqual({ ok: false, reason: 'writer-not-allowed' });
    expect(validateRow({ ...dec, actor: { type: 'person', personKey: 'mara', deviceId: 'd', client: 'phone', signedOrigin: so } })).toEqual({ ok: false, reason: 'writer-not-allowed' });
    expect(validateRow({ ...dec, verdict: 'maybe', actor: { type: 'owner-phone', deviceId: 'd', signedOrigin: so } }).ok).toBe(false);
    expect(validateRow({ ...dec, proof: undefined, actor: { type: 'owner-phone', deviceId: 'd', signedOrigin: so } }).ok).toBe(false);
    const del = { ...base, eventKind: 'decision-delivered', decisionRow: 'A/i#3', messageRequestId: `${Date.now()}-${crypto.randomUUID()}` };
    expect(validateRow({ ...del, actor: { type: 'machine' } }).ok).toBe(true);
    expect(validateRow({ ...del, actor: { type: 'agent', placeKey: 'p' } }).ok).toBe(false);
  });
});

describe('who may decide (mayDoDocument decide)', () => {
  const facts: DocFacts = { primary: SHARED, ownerPerson: 'owner', everShared: true, tombstoned: false, purged: false };
  const team: TeamView = { personMay: () => true, ownerOnly: () => false, sessionInPlace: () => true, teamRefusal: () => null, sendReachesOwner: () => false };
  const may = (p: Principal) => mayDoDocument(p, facts, 'decide', team).ok;
  it('the owner phone approved in Telegram, by an owner phone, or by PIN (root checked by the accepting machine)', () => {
    expect(may({ kind: 'owner-device', client: 'phone', approvedVia: 'telegram-dm' })).toBe(true);
    expect(may({ kind: 'owner-device', client: 'phone', approvedVia: 'owner-phone' })).toBe(true);
    expect(may({ kind: 'owner-device', client: 'phone', approvedVia: 'dashboard-pin' })).toBe(true);
  });
  it('never a browser, an agent-introduced or local-install device, a person of any tier, the agent or the bearer', () => {
    expect(may({ kind: 'owner-device', client: 'browser', approvedVia: 'owner-phone' })).toBe(false);
    expect(may({ kind: 'owner-device', client: 'phone', approvedVia: 'owner-agent' })).toBe(false);
    expect(may({ kind: 'owner-device', client: 'phone', approvedVia: 'local-install' })).toBe(false);
    expect(may({ kind: 'person', personKey: 'mara', tier: 'admin', client: 'phone' })).toBe(false);
    expect(may({ kind: 'agent', placeKey: 'p', ownerReach: true })).toBe(false);
    expect(may({ kind: 'bearer' })).toBe(false);
    expect(may({ kind: 'pin-session' })).toBe(false);
  });
});

describe('the service: ask, decide, change, revise, withdraw', () => {
  function opened() {
    const { svc, store } = setup();
    const { id, versionId } = svc.create(agent, { title: 'Hardening', markdown: MD, primary: OWN });
    const { askId } = svc.setAsk(id, agent, 'Ship the hardening?');
    const q = svc.decision(id, agent).ask!;
    return { svc, store, id, versionId, askId, questionHash: q.questionHash };
  }
  it('an open ask waits on the owner; an Approve on the latest version ends the asking', () => {
    const { svc, id, versionId, askId, questionHash } = opened();
    expect(svc.decision(id, agent)).toMatchObject({ needsOwner: true, current: null, ask: { askId, question: 'Ship the hardening?' } });
    const { rowKey } = svc.decide(id, ownerPhone(), { askId, onVersion: versionId, verdict: 'approve', questionHash, noteHash: NO_NOTE, supersedes: null, proof: 'telegram' });
    const d = svc.decision(id, agent);
    expect(d.needsOwner).toBe(false);
    expect(d.current).toMatchObject({ verdict: 'approve', versionLabel: 1, latest: true, rowKey, proof: 'telegram', delivered: null });
    expect(svc.waitingOnOwner()).toEqual([]);
    // A later revision does not prompt again after an approval.
    svc.revise(id, agent, { markdown: MD + '\nTypo fixed.\n' });
    expect(svc.decision(id, agent)).toMatchObject({ needsOwner: false, current: { verdict: 'approve', latest: false } });
  });
  it('a Decline keeps the ask; the next version asks the owner again', () => {
    const { svc, id, versionId, askId, questionHash } = opened();
    const salt = newSalt(); const note = 'Not yet: add the rollback test.';
    svc.decide(id, ownerPhone(), { askId, onVersion: versionId, verdict: 'decline', questionHash, noteHash: blobHash(salt, note), supersedes: null, proof: 'telegram', note: { salt, text: note } });
    expect(svc.decision(id, agent)).toMatchObject({ needsOwner: false, current: { verdict: 'decline', note } });
    svc.revise(id, agent, { markdown: MD + '\nRollback test added.\n' });
    expect(svc.decision(id, agent).needsOwner).toBe(true);
    expect(svc.waitingOnOwner().map((x) => x.id)).toEqual([id]);
  });
  it('refuses an older version, another question, a stale supersedes, and a note that does not match its hash', () => {
    const { svc, id, versionId, askId, questionHash } = opened();
    const { versionId: v2 } = svc.revise(id, agent, { markdown: MD + '\nMore.\n' });
    const base = { askId, verdict: 'approve' as const, questionHash, noteHash: NO_NOTE, supersedes: null, proof: 'telegram' as const };
    expect(codeOf(() => svc.decide(id, ownerPhone(), { ...base, onVersion: versionId }))).toBe('version-changed');
    expect(codeOf(() => svc.decide(id, ownerPhone(), { ...base, onVersion: v2, questionHash: 'f'.repeat(64) }))).toBe('ask-changed');
    expect(codeOf(() => svc.decide(id, ownerPhone(), { ...base, onVersion: v2, supersedes: 'A/x#9' }))).toBe('answer-changed');
    expect(codeOf(() => svc.decide(id, ownerPhone(), { ...base, onVersion: v2, noteHash: 'e'.repeat(64), note: { salt: newSalt(), text: 'x' } }))).toBe('note-mismatch');
    expect(codeOf(() => svc.decide(id, agent, { ...base, onVersion: v2 }))).toBe('unknown-document');
  });
  it('the owner can change an answer on the same version (supersedes the current one)', () => {
    const { svc, id, versionId, askId, questionHash } = opened();
    const first = svc.decide(id, ownerPhone(), { askId, onVersion: versionId, verdict: 'approve', questionHash, noteHash: NO_NOTE, supersedes: null, proof: 'telegram' });
    svc.decide(id, ownerPhone(), { askId, onVersion: versionId, verdict: 'decline', questionHash, noteHash: NO_NOTE, supersedes: first.rowKey, proof: 'telegram' });
    expect(svc.decision(id, agent)).toMatchObject({ current: { verdict: 'decline', supersedes: first.rowKey }, crossed: false });
  });
  it('a new ask replaces the old one for good; withdrawing it leaves no open ask', () => {
    const { svc, id, askId } = opened();
    const { askId: second } = svc.setAsk(id, agent, 'Ship it this week?');
    expect(svc.decision(id, agent).ask?.askId).toBe(second);
    svc.closeAsk(id, agent);
    const d = svc.decision(id, agent);
    expect(d.ask).toBeNull();
    expect(d.ask?.askId).not.toBe(askId);
    expect(codeOf(() => svc.setAsk(id, ownerPhone(), 'x'))).toBe('agent-only');
  });
  it('records delivery once (machine row) and the documents block words follow the state', () => {
    const { svc, id, versionId, askId, questionHash } = opened();
    expect(svc.decisionWords(id)).toBe("waiting for the owner's decision");
    const { rowKey } = svc.decide(id, ownerPhone(), { askId, onVersion: versionId, verdict: 'approve', questionHash, noteHash: NO_NOTE, supersedes: null, proof: 'telegram' });
    const machine: Caller = { principal: { kind: 'bearer' }, actor: { type: 'machine' }, access: {}, reader: { kind: 'owner' } };
    const rid = `${Date.now()}-${crypto.randomUUID()}`;
    svc.recordDelivered(id, rowKey, rid, machine);
    svc.recordDelivered(id, rowKey, rid, machine);
    expect(svc.decision(id, agent).current?.delivered).toBe(rid);
    expect(svc.decisionWords(id)).toBe('approved by the owner (version 1)');
  });
});

describe('decisionView: crossed answers', () => {
  it('two answers that did not see each other are crossed and need the owner; an answer that saw both clears it', () => {
    const { svc, store } = setup();
    const { id, versionId } = svc.create(agent, { title: 'X', markdown: MD, primary: OWN });
    const { askId } = svc.setAsk(id, agent, 'Ship?');
    const qh = svc.decision(id, agent).ask!.questionHash;
    const s = (svc as unknown as { ownerState(id: string): Parameters<typeof decisionView>[0] }).ownerState(id);
    const mk = (rowKey: string, verdict: 'approve' | 'decline', stream: string, seq: number, docDeps: Record<string, number>, supersedes?: string) =>
      ({ rowKey, askId, onVersion: versionId, verdict, questionHash: qh, proof: 'telegram' as const, docDeps, stream, seq, receivedAt: '', ...(supersedes ? { supersedes } : {}) });
    s.decisions.push(mk('B/i#1', 'approve', 'B/i', 1, {}), mk('C/i#1', 'decline', 'C/i', 1, {}));
    const v = decisionView(s);
    expect(v.crossed).toBe(true);
    expect(v.needsOwner).toBe(true);
    s.decisions.push(mk('B/i#2', 'approve', 'B/i', 2, { 'C/i': 1 }, 'C/i#1'));
    expect(decisionView(s).crossed).toBe(false);
    void store;
  });
});

describe('peer origin check for a decision row', () => {
  function pkey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    return { raw: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url'), privateKey };
  }
  const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  function lowS(der: Buffer): Buffer {
    const rLen = der[3]; const r = der.subarray(4, 4 + rLen); const sLen = der[5 + rLen]; let s = BigInt('0x' + der.subarray(6 + rLen, 6 + rLen + sLen).toString('hex'));
    if (s > N / 2n) s = N - s;
    let sHex = s.toString(16); if (sHex.length % 2) sHex = '0' + sHex; let sb = Buffer.from(sHex, 'hex'); if (sb[0] & 0x80) sb = Buffer.concat([Buffer.from([0]), sb]);
    const body = Buffer.concat([Buffer.from([2, r.length]), r, Buffer.from([2, sb.length]), sb]);
    return Buffer.concat([Buffer.from([0x30, body.length]), body]);
  }
  const owner = pkey();
  const presence = pkey();
  const DOC = '77777777-7777-4777-8777-777777777777';
  const lookup = (over: Partial<{ role: 'owner' | 'person'; client: 'phone' | 'browser'; approvedVia: string; local: boolean }> = {}): DeviceKeyLookup => (id, kh) =>
    id === 'owner-phone' && kh === deviceKeyHashOf(owner.raw)
      ? { status: 'ok', publicKey: owner.raw, role: over.role ?? 'owner', personKey: over.role === 'person' ? 'mara' : null, client: over.client ?? 'phone', mayWrite: true, approvedVia: over.approvedVia ?? 'telegram-dm', ...(over.local === false ? {} : { localPresenceKey: presence.raw }) }
      : { status: 'unknown' };
  function decisionRow(rowOver: Record<string, unknown> = {}, bodyOver: Record<string, unknown> = {}) {
    const askId = '11111111-1111-4111-8111-111111111111'; const onVersion = '22222222-2222-4222-8222-222222222222';
    const challenge = 'ch' + crypto.randomBytes(8).toString('hex');
    const line = decisionLine(DOC, { askId, onVersion, verdict: 'approve', questionHash: 'a'.repeat(64), noteHash: NO_NOTE, supersedes: null });
    const presenceSig = lowS(crypto.sign('sha256', Buffer.from(decisionPresenceMessage('owner-phone', 'echo.example.dev', challenge, line)), { key: presence.privateKey, dsaEncoding: 'der' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ askId, onVersion, verdict: 'approve', questionHash: 'a'.repeat(64), noteHash: NO_NOTE, supersedes: null, challenge, presenceSig, ...bodyOver }));
    const timeMs = String(Date.now() - 86_400_000);
    const sig = lowS(crypto.sign('sha256', Buffer.from(canonicalString('owner-phone', 'echo.example.dev', 'POST', decisionPath(DOC), timeMs, body)), { key: owner.privateKey, dsaEncoding: 'der' })).toString('base64url');
    return {
      docId: DOC, eventKind: 'decision', askId, onVersion, verdict: 'approve', questionHash: 'a'.repeat(64), proof: 'telegram', access: {}, docDeps: {},
      actor: { type: 'owner-phone', deviceId: 'owner-phone', signedOrigin: { keyHash: deviceKeyHashOf(owner.raw), deviceId: 'owner-phone', domain: 'instar-device-v1', payloadB64: body.toString('base64url'), host: 'echo.example.dev', timeMs, sig, requestId: challenge } },
      ...rowOver,
    } as unknown as DocRow;
  }
  it('accepts the owner phone signature over exactly this answer on the phone\'s own machine, days later', () => {
    expect(checkRowOrigin(decisionRow(), lookup(), new Set())).toBe('ok');
    expect(checkRowOrigin(decisionRow({ proof: 'pin' }), lookup({ approvedVia: 'dashboard-pin' }), new Set())).toBe('ok');
    // The proof label must match the device's approval on every machine.
    expect(checkRowOrigin(decisionRow({ proof: 'telegram' }), lookup({ approvedVia: 'dashboard-pin' }), new Set())).toBe('denied');
    expect(checkRowOrigin(decisionRow({ proof: 'pin' }), lookup({ approvedVia: 'telegram-dm' }), new Set())).toBe('denied');
  });
  it('refuses a row that says another verdict, version or question than was signed', () => {
    expect(checkRowOrigin(decisionRow({ verdict: 'decline' }), lookup(), new Set())).toBe('denied');
    expect(checkRowOrigin(decisionRow({ onVersion: '33333333-3333-4333-8333-333333333333' }), lookup(), new Set())).toBe('denied');
    expect(checkRowOrigin(decisionRow({ questionHash: 'b'.repeat(64) }), lookup(), new Set())).toBe('denied');
    expect(checkRowOrigin(decisionRow({}, { presenceSig: undefined }), lookup(), new Set())).toBe('denied');
  });
  it('SEC-088 interim: holds a decision on a machine without the phone\'s own enrollment, whatever the replicated fields say', () => {
    // A peer that knows the phone only from replicated activation: waits, never applies.
    expect(checkRowOrigin(decisionRow(), lookup({ local: false }), new Set())).toBe('held');
    expect(checkRowOrigin(decisionRow({ proof: 'pin' }), lookup({ local: false, approvedVia: 'dashboard-pin' }), new Set())).toBe('held');
    // Replicated approval fields are not read there at all (neither proof nor refusal).
    expect(checkRowOrigin(decisionRow(), lookup({ local: false, approvedVia: 'owner-agent' }), new Set())).toBe('held');
  });
  it('SEC-088 interim: a row the phone did not sign is refused on the other machines, never held as "answered"', () => {
    const peer = lookup({ local: false });
    // Unsigned, or with a device signature that does not verify.
    const unsigned = decisionRow();
    (unsigned.actor as unknown as { signedOrigin: { sig: string } }).signedOrigin.sig = lowS(crypto.sign('sha256', Buffer.from('x'), { key: pkey().privateKey, dsaEncoding: 'der' })).toString('base64url');
    expect(checkRowOrigin(unsigned, peer, new Set())).toBe('denied');
    // Signed, but the row says another verdict, version or question than was signed.
    expect(checkRowOrigin(decisionRow({ verdict: 'decline' }), peer, new Set())).toBe('denied');
    expect(checkRowOrigin(decisionRow({ onVersion: '33333333-3333-4333-8333-333333333333' }), peer, new Set())).toBe('denied');
    expect(checkRowOrigin(decisionRow({}, { presenceSig: undefined }), peer, new Set())).toBe('denied');
    // A device this machine does not know yet waits (pending), which is not "held".
    const stranger = decisionRow();
    (stranger.actor as unknown as { signedOrigin: { keyHash: string } }).signedOrigin.keyHash = 'f'.repeat(64);
    expect(checkRowOrigin(stranger, peer, new Set())).toBe('pending');
  });
  it('re-checks the Face ID signature with this machine\'s own presence key', () => {
    // A valid device signature with a presence signature from some other key is refused.
    const other = pkey();
    const forged = lowS(crypto.sign('sha256', Buffer.from('x'), { key: other.privateKey, dsaEncoding: 'der' })).toString('base64url');
    expect(checkRowOrigin(decisionRow({}, { presenceSig: forged }), lookup(), new Set())).toBe('denied');
  });
  it('signs the same presence message as the route checks', () => {
    expect(decisionPresenceMessage('d', 'Echo.Example.dev', 'c', 'l')).toBe(permissionPresenceMessage('d', 'Echo.Example.dev', 'c', 'l'));
  });
  it('refuses a person device, a browser, and agent-introduced or local-install approvals', () => {
    expect(checkRowOrigin(decisionRow(), lookup({ role: 'person' }), new Set())).toBe('denied');
    expect(checkRowOrigin(decisionRow(), lookup({ client: 'browser' }), new Set())).toBe('denied');
    expect(checkRowOrigin(decisionRow(), lookup({ approvedVia: 'owner-agent' }), new Set())).toBe('denied');
    expect(checkRowOrigin(decisionRow(), lookup({ approvedVia: 'local-install' }), new Set())).toBe('denied');
  });
});

describe('the first delivery request id', () => {
  it('is derived from the decision row, in the only form both chat routes accept', () => {
    const a = decisionMessageRequestId('A/i#7', '2026-11-17T18:00:00.000Z')!;
    expect(a).toMatch(REQUEST_ID_PATTERN);
    expect(decisionMessageRequestId('A/i#7', '2026-11-17T18:00:00.000Z')).toBe(a);
    expect(decisionMessageRequestId('A/i#8', '2026-11-17T18:00:00.000Z')).not.toBe(a);
    expect(a.slice(0, 13)).toBe(String(Date.parse('2026-11-17T18:00:00.000Z')));
  });
});

describe('a chat record counts as delivered only when it says so', () => {
  it('delivered, forwarded and deduped count; refusals, stop-check interceptions and unknown do not', () => {
    expect(chatRecordDelivered(200, { ok: true, outcome: 'delivered' })).toBe(true);
    expect(chatRecordDelivered(200, { ok: true, outcome: 'forwarded', deliveryState: 'pending' })).toBe(true);
    expect(chatRecordDelivered(200, { ok: true, outcome: 'deduped' })).toBe(true);
    expect(chatRecordDelivered(200, { ok: true, outcome: 'delivered', deliveryState: 'delivered' })).toBe(true);
    expect(chatRecordDelivered(200, { ok: true, outcome: 'sentinel-kill' })).toBe(false);
    expect(chatRecordDelivered(200, { ok: true, outcome: 'sentinel-pause' })).toBe(false);
    expect(chatRecordDelivered(200, { ok: true, outcome: 'refused', deliveryState: 'refused' })).toBe(false);
    expect(chatRecordDelivered(200, { ok: true, outcome: 'intercepted', deliveryState: 'intercepted' })).toBe(false);
    expect(chatRecordDelivered(200, { ok: true, outcome: 'unknown', deliveryState: 'unknown' })).toBe(false);
    expect(chatRecordDelivered(202, { ok: true, outcome: 'waiting' })).toBe(false);
    expect(chatRecordDelivered(200, { ok: false, outcome: 'delivered' })).toBe(false);
  });
});

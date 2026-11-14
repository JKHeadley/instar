/** Every machine re-checks a person or owner row against the device that signed it (§3.6). */
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { docpageString } from '../../src/documents/docpageAuth.js';
import { checkRowOrigin, commentKeysHashOf, deviceStoodAt, type DeviceKeyLookup } from '../../src/documents/originCheck.js';
import { emptyState, type TeamAccessState } from '../../src/core/TeamAccessLog.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { deviceKeyHashOf } from '../../src/core/AppRecordSignatures.js';
import type { DocRow } from '../../src/documents/rows.js';

const DOC = '77777777-7777-4777-8777-777777777777';
const VER = '88888888-8888-4888-8888-888888888888';
const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
function lowS(der: Buffer): Buffer {
  const rLen = der[3]; const r = der.subarray(4, 4 + rLen); const sLen = der[5 + rLen]; let s = BigInt('0x' + der.subarray(6 + rLen, 6 + rLen + sLen).toString('hex'));
  if (s > N / 2n) s = N - s;
  let sHex = s.toString(16); if (sHex.length % 2) sHex = '0' + sHex; let sb = Buffer.from(sHex, 'hex'); if (sb[0] & 0x80) sb = Buffer.concat([Buffer.from([0]), sb]);
  const body = Buffer.concat([Buffer.from([2, r.length]), r, Buffer.from([2, sb.length]), sb]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}
function key() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  return { raw: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url'), privateKey };
}
const sign = (k: ReturnType<typeof key>, msg: string) => lowS(crypto.sign('sha256', Buffer.from(msg), { key: k.privateKey, dsaEncoding: 'der' })).toString('base64url');

const mara = key();
const owner = key();
const devices: DeviceKeyLookup = (id, kh) => {
  if (id === 'mara-phone' && kh === deviceKeyHashOf(mara.raw)) return { status: 'ok', publicKey: mara.raw, role: 'person', personKey: 'mara', client: 'phone', mayWrite: true };
  if (id === 'owner-phone' && kh === deviceKeyHashOf(owner.raw)) return { status: 'ok', publicKey: owner.raw, role: 'owner', personKey: null, client: 'phone', mayWrite: true };
  return { status: 'unknown' };
};

function maraComment(over: Partial<Record<string, unknown>> = {}, signer = mara) {
  const commentId = crypto.randomUUID();
  const payload = { docId: DOC, commentId, onVersion: VER, start: 3, end: 13, bodyHash: 'a'.repeat(64) };
  const requestId = `${Date.now()}-${crypto.randomUUID()}`;
  const timeMs = String(Date.now() - 3 * 86_400_000); // days old: peers have no clock window
  const sig = sign(signer, docpageString('mara-phone', 'echo.example.dev', DOC, 'comment', requestId, timeMs, payload));
  return {
    docId: DOC, eventKind: 'comment', commentId, onVersion: VER, bodyHash: payload.bodyHash, anchor: { anchorHash: 'b'.repeat(64), start: 3, end: 13, blockHint: '' },
    actor: { type: 'person', personKey: 'mara', deviceId: 'mara-phone', client: 'phone', signedOrigin: { keyHash: deviceKeyHashOf(mara.raw), deviceId: 'mara-phone', domain: 'instar-docpage-v1', payloadB64: Buffer.from(JSON.stringify(payload)).toString('base64url'), host: 'echo.example.dev', timeMs, sig, requestId } },
    ...over,
  } as unknown as DocRow;
}

describe('document row origins', () => {
  it('accepts a person comment their own phone signed, even days later on another machine', () => {
    expect(checkRowOrigin(maraComment(), devices, new Set())).toBe('ok');
  });

  it('refuses a row that says something other than what was signed', () => {
    expect(checkRowOrigin(maraComment({ bodyHash: 'c'.repeat(64) }), devices, new Set())).toBe('denied');
    expect(checkRowOrigin(maraComment({ anchor: { anchorHash: 'b'.repeat(64), start: 0, end: 13, blockHint: '' } }), devices, new Set())).toBe('denied');
  });

  it('refuses a replayed request under a new event, and a signature by another key', () => {
    const r = maraComment();
    const so = (r.actor as { signedOrigin: { deviceId: string; requestId: string } }).signedOrigin;
    expect(checkRowOrigin(r, devices, new Set([`${so.deviceId}|${so.requestId}`]))).toBe('denied');
    expect(checkRowOrigin(maraComment({}, owner), devices, new Set())).toBe('denied');
  });

  it('refuses a person row the machine wrote without a device signature, and one claiming another person', () => {
    const forged = maraComment();
    (forged.actor as { signedOrigin: { sig: string } }).signedOrigin.sig = '';
    expect(checkRowOrigin(forged, devices, new Set())).toBe('denied');
    const other = maraComment();
    (other.actor as { personKey: string }).personKey = 'sam';
    expect(checkRowOrigin(other, devices, new Set())).toBe('denied');
  });

  it('holds a row whose device key has not arrived yet', () => {
    const r = maraComment();
    expect(checkRowOrigin(r, () => ({ status: 'unknown' }), new Set())).toBe('pending');
  });

  it('accepts a move only as the owner phone signed it, for exactly the history the row stands on', () => {
    const docDeps = { 'A/inc1': 3 };
    const challenge = crypto.randomBytes(32).toString('base64url');
    const body = Buffer.from(JSON.stringify({ primary: 'telegram:500', docDeps, challenge, presenceSig: 'x' }));
    const timeMs = String(Date.now());
    const sig = sign(owner, canonicalString('owner-phone', 'echo.example.dev', 'POST', `/mobile/docs/${DOC}/primary`, timeMs, body));
    const row = (signedDeps: Record<string, number>, rowDeps: Record<string, number>, signer = owner) => ({
      docId: DOC, eventKind: 'primary-set', primary: 'telegram:500', docDepsSigned: signedDeps, docDeps: rowDeps,
      actor: { type: 'owner-phone', deviceId: 'owner-phone', signedOrigin: { keyHash: deviceKeyHashOf(signer.raw), deviceId: 'owner-phone', domain: 'instar-device-v1', payloadB64: body.toString('base64url'), host: 'echo.example.dev', timeMs, sig, requestId: challenge } },
    }) as unknown as DocRow;
    expect(checkRowOrigin(row(docDeps, docDeps), devices, new Set())).toBe('ok');
    // A row standing on more history than the owner saw, or claiming different history, is refused.
    expect(checkRowOrigin(row(docDeps, { 'A/inc1': 4 }), devices, new Set())).toBe('denied');
    expect(checkRowOrigin(row({ 'A/inc1': 2 }, { 'A/inc1': 2 }), devices, new Set())).toBe('denied');
    // Mara's phone can never move a document, even with a request it really signed.
    const maraSig = sign(mara, canonicalString('mara-phone', 'echo.example.dev', 'POST', `/mobile/docs/${DOC}/primary`, timeMs, body));
    const byMara = row(docDeps, docDeps, mara) as unknown as { actor: { deviceId: string; signedOrigin: { deviceId: string; sig: string } } };
    byMara.actor.deviceId = 'mara-phone'; byMara.actor.signedOrigin.deviceId = 'mara-phone'; byMara.actor.signedOrigin.sig = maraSig;
    expect(checkRowOrigin(byMara as unknown as DocRow, devices, new Set())).toBe('denied');
  });

  it('a Send must cover exactly the comments it signed for', () => {
    const keys = ['mara:11111111-1111-4111-8111-111111111111'];
    const payload = { docId: DOC, batchId: `${Date.now()}-${crypto.randomUUID()}`, commentKeysHash: commentKeysHashOf(keys), primaryRow: 'A/inc1#1', messageRequestId: `${Date.now()}-${crypto.randomUUID()}` };
    const requestId = `${Date.now()}-${crypto.randomUUID()}`;
    const timeMs = String(Date.now());
    const sig = sign(mara, docpageString('mara-phone', 'echo.example.dev', DOC, 'send', requestId, timeMs, payload));
    const row = { docId: DOC, eventKind: 'send', batchId: payload.batchId, coveredHash: 'c'.repeat(64), primaryRow: payload.primaryRow, messageRequestId: payload.messageRequestId,
      actor: { type: 'person', personKey: 'mara', deviceId: 'mara-phone', client: 'phone', signedOrigin: { keyHash: deviceKeyHashOf(mara.raw), deviceId: 'mara-phone', domain: 'instar-docpage-v1', payloadB64: Buffer.from(JSON.stringify(payload)).toString('base64url'), host: 'echo.example.dev', timeMs, sig, requestId } } } as unknown as DocRow;
    expect(checkRowOrigin(row, devices, new Set(), () => [`${keys[0]}@A/inc1#2`])).toBe('ok');
    expect(checkRowOrigin(row, devices, new Set(), () => [`${keys[0]}@A/inc1#2`, 'mara:22222222-2222-4222-8222-222222222222@A/inc1#3'])).toBe('denied');
    expect(checkRowOrigin(row, devices, new Set(), () => null)).toBe('pending');
  });

  it('a device whose owner is not known here yet waits; it is never taken for the owner', () => {
    const unknownRole: DeviceKeyLookup = () => ({ status: 'ok', publicKey: mara.raw, role: 'unknown', personKey: null, client: 'phone', mayWrite: true });
    expect(checkRowOrigin(maraComment(), unknownRole, new Set())).toBe('pending');
    const asOwner = maraComment();
    (asOwner as unknown as { actor: Record<string, unknown> }).actor = { ...(asOwner.actor as object), type: 'owner-phone' };
    expect(checkRowOrigin(asOwner, unknownRole, new Set())).toBe('pending');
    expect(checkRowOrigin(asOwner, devices, new Set())).toBe('denied');
  });

  it('agent and machine rows need no device signature', () => {
    expect(checkRowOrigin({ docId: DOC, eventKind: 'reply', actor: { type: 'agent', placeKey: 'telegram:topic:7' } } as unknown as DocRow, devices, new Set())).toBe('ok');
  });
});

describe('a device revoked after its rows were accepted (bug 4: machines diverged)', () => {
  /** A team state: Mara present (unless removed), her phone bound, and optionally her linked computer. */
  function team(o: { present?: boolean; link?: 'bound' | 'unbound' | 'none'; linkDevice?: string } = {}): TeamAccessState {
    const s = emptyState();
    s.on = true;
    if (o.present !== false) s.people.set('mara', { personKey: 'mara', name: 'Mara', role: 'member', links: {} });
    s.bindings.set('phone-kh', 'mara');
    if ((o.link ?? 'none') !== 'none') {
      const link = { type: 'browser-bind', keyHash: 'comp-kh', deviceId: o.linkDevice ?? 'comp-1', boundTo: 'mara', linkedByDeviceId: 'mara-phone', linkedByKeyHash: 'phone-kh', linkedAt: '2026-11-01T00:00:00.000Z', expiresAt: '2026-12-01T00:00:00.000Z', scope: 'documents', signed: { host: 'h', timeMs: '1', sig: 's', bodyB64: 'e30' } } as never;
      s.browserLinks.set('comp-kh', o.link === 'unbound' ? { ...(link as object), unbound: true } as never : link);
      if (o.link === 'bound') s.bindings.set('comp-kh', 'mara');
    }
    return s;
  }
  const signed = () => true;
  const comp = { keyHash: 'comp-kh', deviceId: 'comp-1', personKey: 'mara', client: 'browser' as const };
  const phone = { keyHash: 'phone-kh', deviceId: 'mara-phone', personKey: 'mara', client: 'phone' as const };

  it('a forgotten computer stands for rows accepted before its unbind row, never after it', () => {
    expect(deviceStoodAt(team({ link: 'bound' }), team({ link: 'unbound' }), comp, signed)).toBe(true);
    // The row's own team position already includes the unbind: refused.
    expect(deviceStoodAt(team({ link: 'unbound' }), team({ link: 'unbound' }), comp, signed)).toBe(false);
  });

  it('a removed person\'s phone and computer stand for rows accepted before the removal, never after it', () => {
    expect(deviceStoodAt(team(), team({ present: false }), phone, signed)).toBe(true);
    expect(deviceStoodAt(team({ link: 'bound' }), team({ present: false, link: 'bound' }), comp, signed)).toBe(true);
    expect(deviceStoodAt(team({ present: false }), team({ present: false }), phone, signed)).toBe(false);
  });

  it('a revocation with no team row (ledger only) cannot be ordered against the row: refused', () => {
    expect(deviceStoodAt(team(), team(), phone, signed)).toBe(false);
    expect(deviceStoodAt(team({ link: 'bound' }), team({ link: 'bound' }), comp, signed)).toBe(false);
  });

  it('the link must be in force at that position, name this device, and carry the phone\'s signature', () => {
    expect(deviceStoodAt(team({ link: 'bound' }), team({ link: 'unbound' }), comp, () => false)).toBe(false);
    expect(deviceStoodAt(team({ link: 'bound', linkDevice: 'comp-2' }), team({ link: 'unbound' }), comp, signed)).toBe(false);
    expect(deviceStoodAt(team({ link: 'none' }), team({ link: 'unbound' }), comp, signed)).toBe(false);
    // A computer key is never taken for a phone.
    expect(deviceStoodAt(team({ link: 'bound' }), team({ present: false }), { ...comp, client: 'phone' }, signed)).toBe(false);
  });

  it('the device lookup is asked at the row\'s own team position and author', () => {
    const seen: unknown[] = [];
    const lookup: DeviceKeyLookup = (id, kh, at) => { seen.push(at); return devices(id, kh); };
    const row = maraComment();
    (row as unknown as { access: Record<string, number> }).access = { 'm_a/1': 4 };
    expect(checkRowOrigin(row, lookup, new Set())).toBe('ok');
    expect(seen).toEqual([{ access: { 'm_a/1': 4 }, personKey: 'mara' }]);
  });
});

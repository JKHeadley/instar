/** Every machine re-checks a person or owner row against the device that signed it (§3.6). */
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { docpageString } from '../../src/documents/docpageAuth.js';
import { checkRowOrigin, commentKeysHashOf, type DeviceKeyLookup } from '../../src/documents/originCheck.js';
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

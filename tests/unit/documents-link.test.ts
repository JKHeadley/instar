/** Linking a computer from the document page: pure helpers (dashboard/docs/doc-page-model.js; spec §3.6a). */
import { describe, expect, it } from 'vitest';
import * as m from '../../dashboard/docs/doc-page-model.js';
import { qrMatrix } from '../../dashboard/docs/qr-code.js';

const KEY = 'BL' + 'a'.repeat(85); // 87 chars, the length of a base64url raw P-256 point
const decode = (payload: string) => JSON.parse(Buffer.from(payload.slice(m.LINK_PREFIX.length), 'base64url').toString('utf8'));

describe('linkPayload', () => {
  const parts = { browserPublicKey: KEY, nonce: 'n0nce-_x', machineId: 'm_7f3a', host: 'Echo.Example.COM:4062' };
  it('is instar-link:1: + base64url JSON {k, n, m, h}', () => {
    const p = m.linkPayload(parts);
    expect(p.startsWith('instar-link:1:')).toBe(true);
    expect(p.slice(14)).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
    expect(decode(p)).toEqual({ k: KEY, n: 'n0nce-_x', m: 'm_7f3a', h: 'echo.example.com:4062' });
    expect(Object.keys(decode(p))).toEqual(['k', 'n', 'm', 'h']);
  });
  it('round-trips non-ASCII through UTF-8', () => {
    expect(decode(m.linkPayload({ ...parts, machineId: 'mac-é€' })).m).toBe('mac-é€');
    expect(m.b64urlText('é')).toBe(Buffer.from('é', 'utf8').toString('base64url'));
  });
  it('refuses a missing part', () => {
    for (const k of Object.keys(parts)) {
      expect(() => m.linkPayload({ ...parts, [k]: '' })).toThrow();
      expect(() => m.linkPayload({ ...parts, [k]: undefined })).toThrow();
    }
  });
  it('fits in a QR code of a scannable size', () => {
    const p = m.linkPayload({ ...parts, nonce: 'N'.repeat(43), machineId: 'm'.repeat(40), host: `${'h'.repeat(40)}.trycloudflare.com` });
    const size = qrMatrix(p, 'M').length;
    expect(size).toBeLessThanOrEqual(4 * 14 + 17);
  });
});

describe('timeMsOf / linkDeadline', () => {
  it('reads ms numbers, digit strings and ISO strings', () => {
    expect(m.timeMsOf(1_800_000_000_000)).toBe(1_800_000_000_000);
    expect(m.timeMsOf('1800000000000')).toBe(1_800_000_000_000);
    expect(m.timeMsOf('2027-01-15T10:00:00.000Z')).toBe(Date.parse('2027-01-15T10:00:00.000Z'));
    expect(m.timeMsOf('soon')).toBe(null);
    expect(m.timeMsOf(null)).toBe(null);
    expect(m.timeMsOf(-1)).toBe(null);
  });
  it('corrects the expiry by the server clock', () => {
    const server = Date.parse('2026-11-10T12:00:00Z');
    const expiresAt = new Date(server + 600_000).toISOString();
    const receivedAt = server - 3 * 3_600_000; // this computer is three hours behind
    expect(m.linkDeadline({ expiresAt, serverDate: new Date(server).toUTCString(), receivedAt })).toBe(receivedAt + 600_000);
  });
  it('uses the expiry as is without a Date header, and 10 minutes when unreadable', () => {
    expect(m.linkDeadline({ expiresAt: 5_000_000, serverDate: null, receivedAt: 1 })).toBe(5_000_000);
    expect(m.linkDeadline({ expiresAt: 'x', serverDate: null, receivedAt: 1000 })).toBe(1000 + 600_000);
  });
});

describe('linkPollDecision', () => {
  const base = { nowMs: 1000, deadlineMs: 5000 };
  it('linked only with a device id', () => {
    expect(m.linkPollDecision({ ...base, httpStatus: 200, answer: { state: 'linked', deviceId: 'dev-1' } })).toEqual({ next: 'linked', deviceId: 'dev-1' });
    expect(m.linkPollDecision({ ...base, httpStatus: 200, answer: { state: 'linked' } }).next).toBe('retry');
  });
  it('a link that lands just after the local deadline still counts', () => {
    expect(m.linkPollDecision({ httpStatus: 200, answer: { state: 'linked', deviceId: 'd' }, nowMs: 9000, deadlineMs: 5000 }).next).toBe('linked');
  });
  it('waiting keeps polling until the deadline', () => {
    expect(m.linkPollDecision({ ...base, httpStatus: 200, answer: { state: 'waiting' } }).next).toBe('wait');
    expect(m.linkPollDecision({ httpStatus: 200, answer: { state: 'waiting' }, nowMs: 5000, deadlineMs: 5000 }).next).toBe('expired');
  });
  it('expired from the server, or an unknown nonce, ends it', () => {
    expect(m.linkPollDecision({ ...base, httpStatus: 200, answer: { state: 'expired' } }).next).toBe('expired');
    expect(m.linkPollDecision({ ...base, httpStatus: 404, answer: null }).next).toBe('expired');
  });
  it('a busy or unreachable server is not an answer', () => {
    for (const httpStatus of [0, 429, 500, 503]) expect(m.linkPollDecision({ ...base, httpStatus, answer: null }).next).toBe('retry');
    expect(m.linkPollDecision({ ...base, httpStatus: 200, answer: { state: 'weird' } }).next).toBe('retry');
    expect(m.linkPollDecision({ httpStatus: 0, answer: null, nowMs: 6000, deadlineMs: 5000 }).next).toBe('expired');
  });
});

describe('linkSlot / linkedRecord', () => {
  const ours = { machineId: 'm1', keyPair: {}, publicKey: KEY, linkedFor: 'documents', status: 'linking', linkNonce: 'n', linkDeadline: 9 };
  it('never takes the console\'s own record', () => {
    expect(m.linkSlot(null)).toBe('free');
    expect(m.linkSlot({ machineId: 'm1', status: 'active', deviceId: 'd', keyPair: {} })).toBe('taken');
    expect(m.linkSlot({ machineId: 'm1', status: 'enrolling', keyPair: {} })).toBe('taken');
  });
  it('reuses an unfinished link and replaces an earlier one', () => {
    expect(m.linkSlot(ours)).toBe('reuse');
    expect(m.linkSlot({ ...ours, status: 'active', deviceId: 'd' })).toBe('replace');
    expect(m.linkSlot({ ...ours, keyPair: undefined })).toBe('replace');
  });
  it('the linked record has the active console shape and no nonce', () => {
    const r = m.linkedRecord(ours, { deviceId: 'dev-9', host: 'Echo.Example.com' });
    expect(r).toMatchObject({ machineId: 'm1', deviceId: 'dev-9', host: 'echo.example.com', status: 'active', publicKey: KEY, linkedFor: 'documents' });
    expect(r).not.toHaveProperty('linkNonce');
    expect(r).not.toHaveProperty('linkDeadline');
    expect(typeof r.linkedAt).toBe('string');
  });
});

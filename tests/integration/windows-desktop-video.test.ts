/**
 * Windows Remote Desktop video through the real session authority: the
 * DirectDesktopAccess grant and AEAD stream drive a real WindowsDesktopHost,
 * whose companion stand-in checks every HMAC like the Windows companion. What
 * the viewer would receive is decrypted and checked.
 */
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { DirectDesktopAccess } from '../../src/core/DirectDesktopAccess.js';
import { WindowsDesktopHost } from '../../src/core/WindowsDesktopHost.js';
import type { RemoteStepUpLockoutPort } from '../../src/core/RemoteStepUpLockouts.js';

const secret = Buffer.alloc(32, 5);
const endpoint = 'http://172.22.96.1:44818/';
const JPEG = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
const KEY_UNIT = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0x00, 0x28, 0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80, 0, 0, 0, 1, 0x65, 0x88, 0x84]);
const DELTA_UNIT = Buffer.from([0, 0, 0, 1, 0x41, 0x9a, 0x02]);

function packet(keyframe: boolean): Buffer {
  const header = Buffer.from([keyframe ? 1 : 0, 0, 0, 0, 0]);
  header.writeUInt16BE(1728, 1); header.writeUInt16BE(1080, 3);
  return Buffer.concat([header, keyframe ? KEY_UNIT : DELTA_UNIT]);
}

function companion(videoSupported: boolean, videoEmpty = false) {
  const ops: string[] = [];
  const send = (async (url: string, init: RequestInit) => {
    const op = url.slice(endpoint.length);
    const headers = init.headers as Record<string, string>;
    const digest = crypto.createHash('sha256').update(String(init.body)).digest('hex');
    const mac = crypto.createHmac('sha256', secret)
      .update(`instar-windows-desktop-v1\n${op}\n${headers['X-Instar-Desktop-Time']}\n${headers['X-Instar-Desktop-Nonce']}\n${digest}`)
      .digest('base64url');
    if (mac !== headers['X-Instar-Desktop-Mac']) return new Response('{}', { status: 403, headers: { 'Content-Type': 'application/json' } });
    ops.push(op);
    const body = JSON.parse(String(init.body)) as { keyframe?: boolean };
    if (op === 'probe') return Response.json({ screenPermission: true, inputPermission: true, sessionActive: true, displayCount: 1 });
    if (op === 'capture') return new Response(JPEG, { headers: { 'Content-Type': 'image/jpeg' } });
    if (op === 'capture-h264') {
      // An older companion has no such operation: it answers 400.
      if (!videoSupported) return new Response('{"error":"desktop-unavailable"}', { status: 400, headers: { 'Content-Type': 'application/json' } });
      if (videoEmpty) return new Response(new Uint8Array(0), { headers: { 'Content-Type': 'video/h264' } });
      return new Response(packet(body.keyframe === true), { headers: { 'Content-Type': 'video/h264' } });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
  return { send, ops };
}

async function openStream(host: WindowsDesktopHost) {
  const now = 1_800_000_000_000;
  const locks: RemoteStepUpLockoutPort = { get: () => 0, set: () => {}, recordFailure: () => ({ attempts: 1, lockedUntilMs: 0 }) };
  const targetKey = crypto.generateKeyPairSync('ed25519');
  const authority = new DirectDesktopAccess('machine-win', 'Mama PC', host, locks,
    { publicKey: targetKey.publicKey.export({ format: 'der', type: 'spki' }),
      sign: payload => crypto.sign(null, payload, targetKey.privateKey) },
    (topic, uid) => topic === 131439 && uid === '7812716706',
    token => token === 'dashboard-proof', async () => {}, () => {}, () => now, undefined, 'pin');
  const browser = crypto.generateKeyPairSync('ed25519');
  const browserEcdh = crypto.createECDH('prime256v1'); browserEcdh.generateKeys();
  const { requestId } = await authority.begin({ machineId: 'machine-win', topicId: 131439,
    operatorUid: '7812716706', operatorSessionToken: 'dashboard-proof',
    browserPublicKey: browser.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    browserEcdhPublicKey: browserEcdh.getPublicKey().toString('base64'),
    browserNonce: '0123456789abcdef', scopeConfirmed: true, videoCodec: 'h264' });
  const state = authority.status(requestId, 'dashboard-proof');
  expect(state.videoCodec).toBe('h264');
  const key = Buffer.from(crypto.hkdfSync('sha256', browserEcdh.computeSecret(Buffer.from(state.targetEcdhPublicKey!, 'base64')),
    Buffer.from(state.salt!, 'base64'), Buffer.from(`instar-desktop-aead-v1:${requestId}:machine-win`), 32));
  const proof = crypto.sign(null, Buffer.from(JSON.stringify(['desktop-browser-possession-v1',
    requestId, state.connectionNonce])), browser.privateKey).toString('base64');
  const ticket = authority.ticket(requestId, 'dashboard-proof', state.connectionNonce!, proof);
  const stream = await authority.admit({ headers: { origin: 'https://instar.example', host: 'instar.example',
    'x-forwarded-proto': 'https', 'sec-websocket-protocol': `instar-desktop-v1, ticket.${ticket}` },
  url: '/desktop-stream', socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage);
  const decrypt = (record: Buffer): Buffer => {
    const iv = Buffer.alloc(12); iv.writeUInt32BE(1); iv.writeBigUInt64BE(record.readBigUInt64BE(0), 4);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(JSON.stringify(['instar-desktop-aead-v1', requestId, 'frame'])));
    decipher.setAuthTag(record.subarray(record.length - 16));
    return Buffer.concat([decipher.update(record.subarray(8, -16)), decipher.final()]);
  };
  return { stream, decrypt };
}

describe('Windows Remote Desktop video through the session authority', () => {
  it('delivers an H.264 keyframe, then deltas, then a fresh keyframe after a drop', async () => {
    const fake = companion(true);
    const host = new WindowsDesktopHost(endpoint, secret, fake.send, 2_000, { video: true });
    const { stream, decrypt } = await openStream(host);
    expect(stream.frameIntervalMs?.()).toBe(50); // video asks for up to 20 pictures a second
    const first = decrypt((await stream.captureEncrypted())!);
    expect(first.subarray(0, 6)).toEqual(Buffer.from('IDV1\x01\x01', 'latin1')); // AVC, keyframe
    expect([first.readUInt16BE(6), first.readUInt16BE(8)]).toEqual([1728, 1080]);
    expect(first.subarray(18)).toEqual(KEY_UNIT);
    stream.frameQueued?.();
    const second = decrypt((await stream.captureEncrypted())!);
    expect(second[5]).toBe(0);
    expect(second.subarray(18)).toEqual(DELTA_UNIT);
    stream.frameQueued?.();
    stream.frameDropped?.();
    const third = decrypt((await stream.captureEncrypted())!);
    expect(third[5]).toBe(1);
    expect(fake.ops.filter(op => op === 'capture')).toHaveLength(0);
    stream.release('terminal');
  });

  it('falls back to pictures for the session when the companion has no video', async () => {
    const fake = companion(false);
    const host = new WindowsDesktopHost(endpoint, secret, fake.send, 2_000, { video: true });
    const { stream, decrypt } = await openStream(host);
    expect(decrypt((await stream.captureEncrypted())!)).toEqual(JPEG);
    stream.frameQueued?.();
    await stream.captureEncrypted();
    expect(stream.frameIntervalMs?.()).toBeUndefined(); // pictures keep the default pace
    // One video attempt, then pictures only: no retry storm against an old companion.
    expect(fake.ops.filter(op => op === 'capture-h264')).toHaveLength(1);
    expect(fake.ops.filter(op => op === 'capture').length).toBeGreaterThanOrEqual(1);
    stream.release('terminal');
  });

  it('switches a stalled video session to pictures', async () => {
    let now = 5_000;
    const fake = companion(true, true); // the encoder answers "nothing yet" forever
    const host = new WindowsDesktopHost(endpoint, secret, fake.send, 2_000, { video: true, now: () => now });
    const { stream, decrypt } = await openStream(host);
    expect(await stream.captureEncrypted()).toBeNull();
    now += 5_000;
    expect(decrypt((await stream.captureEncrypted())!)).toEqual(JPEG);
    stream.frameQueued?.();
    await stream.captureEncrypted();
    expect(fake.ops.filter(op => op === 'capture-h264')).toHaveLength(2);
    expect(stream.frameIntervalMs?.()).toBeUndefined();
    stream.release('terminal');
  });

  it('keeps pictures when the switch is off, even if the viewer asked for video', async () => {
    const fake = companion(true);
    const host = new WindowsDesktopHost(endpoint, secret, fake.send, 2_000, { video: false });
    const { stream, decrypt } = await openStream(host);
    expect(decrypt((await stream.captureEncrypted())!)).toEqual(JPEG);
    expect(fake.ops).not.toContain('capture-h264');
    expect(stream.frameIntervalMs?.()).toBeUndefined();
    stream.release('terminal');
  });
});

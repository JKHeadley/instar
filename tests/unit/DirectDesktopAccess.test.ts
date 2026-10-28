import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { DirectDesktopAccess } from '../../src/core/DirectDesktopAccess.js';
import type { MacDesktopHost } from '../../src/core/MacDesktopHost.js';
import type { RemoteStepUpLockoutPort } from '../../src/core/RemoteStepUpLockouts.js';

function fixture(mode: 'telegram' | 'pin' = 'telegram') {
  let now = 1_800_000_000_000;
  let binding = true;
  let sessionValid = true;
  let challenge = '';
  let cancelled = 0;
  let indicatorExit: (() => void) | null = null;
  let indicatorStops = 0;
  const closed: string[] = [];
  const failures = new Map<string, number>();
  const locks: RemoteStepUpLockoutPort = {
    get: key => (failures.get(key) ?? 0) >= 3 ? now + 900_000 : 0,
    set: () => {},
    recordFailure: key => {
      const attempts = (failures.get(key) ?? 0) + 1;
      failures.set(key, attempts);
      return { attempts, lockedUntilMs: attempts >= 3 ? now + 900_000 : 0 };
    },
  };
  const host = {
    probe: async () => ({ screenPermission: true, inputPermission: true, displayCount: 1, sessionActive: true }),
    capture: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    cursor: async () => ({ x: 0.25, y: 0.75 }),
    input: async () => {},
    cancelInput: () => { cancelled++; },
    startIndicator: async (onExit: () => void) => { indicatorExit = onExit; },
    stopIndicator: () => { indicatorStops++; },
  } as unknown as MacDesktopHost;
  const targetKey = crypto.generateKeyPairSync('ed25519');
  const targetIdentity = { publicKey: targetKey.publicKey.export({ format: 'der', type: 'spki' }),
    sign: (payload: Buffer) => crypto.sign(null, payload, targetKey.privateKey) };
  const authority = new DirectDesktopAccess('machine-1', 'Echo Mac', host, locks, targetIdentity,
    (topic, uid) => binding && topic === 131439 && uid === '7812716706',
    token => sessionValid && token === 'dashboard-proof',
    async (_topic, text) => { challenge = text; },
    id => { closed.push(id); }, () => now, undefined, mode);
  const browser = crypto.generateKeyPairSync('ed25519');
  const browserEcdh = crypto.createECDH('prime256v1');
  browserEcdh.generateKeys();
  const browserPublicKey = browser.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const begin = () => authority.begin({ machineId: 'machine-1', topicId: 131439,
    operatorUid: '7812716706', operatorSessionToken: 'dashboard-proof',
    browserPublicKey, browserEcdhPublicKey: browserEcdh.getPublicKey().toString('base64'),
    browserNonce: '0123456789abcdef', scopeConfirmed: true });
  const code = () => /\/desktop [0-9a-f-]{36} (\d{6})/.exec(challenge)?.[1] ?? '';
  return { authority, begin, code, browser, browserEcdh, closed, failures,
    setNow: (value: number) => { now = value; }, setBinding: (value: boolean) => { binding = value; },
    setSessionValid: (value: boolean) => { sessionValid = value; },
    cancelled: () => cancelled, indicatorStops: () => indicatorStops,
    crashIndicator: () => indicatorExit?.() };
}

describe('DirectDesktopAccess', () => {
  it('reads the current pointer only for an active grant and its PIN session', async () => {
    const f = fixture('pin');
    const { requestId } = await f.begin();
    await expect(f.authority.cursor(requestId, 'wrong-proof')).rejects.toThrow('dashboard operator session');
    await expect(f.authority.cursor(requestId, 'dashboard-proof')).resolves.toEqual({ x: 0.25, y: 0.75 });
    f.authority.revoke(requestId, 'dashboard-proof');
    await expect(f.authority.cursor(requestId, 'dashboard-proof')).rejects.toThrow('cursor unavailable');
  });
  it('opens from a fresh dashboard PIN session without Telegram and revokes when that session ends', async () => {
    const f = fixture('pin');
    f.setBinding(false);
    const { requestId } = await f.begin();
    const state = f.authority.status(requestId, 'dashboard-proof');
    expect(state.status).toBe('approved');
    const payload = Buffer.from(JSON.stringify(['desktop-browser-possession-v1', requestId, state.connectionNonce]));
    const ticket = f.authority.ticket(requestId, 'dashboard-proof', state.connectionNonce!,
      crypto.sign(null, payload, f.browser.privateKey).toString('base64'));
    const stream = await f.authority.admit({ headers: { origin: 'https://instar.example', host: 'instar.example',
      'x-forwarded-proto': 'https', 'sec-websocket-protocol': `instar-desktop-v1, ticket.${ticket}` },
    url: '/desktop-stream', socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage);
    f.setSessionValid(false);
    await expect(stream.assertActive()).rejects.toThrow('grant');
    expect(f.closed).toEqual([stream.grantId]);
  });
  it('needs dashboard proof, verified Telegram binding and full-desktop confirmation', async () => {
    const f = fixture();
    await expect(f.authority.begin({ machineId: 'machine-1', topicId: 131439,
      operatorUid: '7812716706', operatorSessionToken: 'dashboard-proof',
      browserPublicKey: 'invalid', browserEcdhPublicKey: 'invalid',
      browserNonce: '0123456789abcdef', scopeConfirmed: true })).rejects.toThrow('browser key');
    f.setBinding(false);
    await expect(f.begin()).rejects.toThrow('verified operator');
  });

  it('uses authenticated Telegram approval and a one-use browser ticket for display/input', async () => {
    const f = fixture();
    const { requestId } = await f.begin();
    expect(f.authority.acceptAuthenticatedTelegramReply({ requestId, code: f.code(), topicId: 131439,
      senderUid: 'other' })).toBe(false);
    expect(f.authority.acceptAuthenticatedTelegramReply({ requestId, code: f.code(), topicId: 131439,
      senderUid: '7812716706' })).toBe(true);
    expect(f.authority.acceptAuthenticatedTelegramReply({ requestId, code: f.code(), topicId: 131439,
      senderUid: '7812716706' })).toBe(false);
    const state = f.authority.status(requestId, 'dashboard-proof');
    const payload = Buffer.from(JSON.stringify(['desktop-browser-possession-v1', requestId, state.connectionNonce]));
    const signature = crypto.sign(null, payload, f.browser.privateKey).toString('base64');
    expect(() => f.authority.ticket(requestId, 'dashboard-proof', state.connectionNonce!, 'bad')).toThrow('browser possession');
    const ticket = f.authority.ticket(requestId, 'dashboard-proof', state.connectionNonce!, signature);
    const request = { headers: { origin: 'https://instar.example', host: 'instar.example',
      'x-forwarded-proto': 'https',
      'sec-websocket-protocol': `instar-desktop-v1, ticket.${ticket}` },
      url: '/desktop-stream', socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage;
    const remoteRequest = { ...request, socket: { remoteAddress: '192.0.2.1' } } as unknown as IncomingMessage;
    await expect(f.authority.admit(remoteRequest)).rejects.toThrow('transport');
    const stream = await f.authority.admit(request);
    await expect(f.authority.admit(request)).rejects.toThrow('ticket');
    const encrypted = await stream.captureEncrypted();
    expect(encrypted.readBigUInt64BE(0)).toBe(1n);
    expect(encrypted.length).toBe(8 + 4 + 16);
    await stream.revoke();
    await expect(stream.assertActive()).rejects.toThrow('grant');
    expect(f.closed).toEqual([stream.grantId]);
    expect(f.cancelled()).toBeGreaterThan(0);
    expect(f.authority.status(requestId, 'dashboard-proof')).toEqual({ status: 'revoked' });
  });

  it('locks after three wrong codes and expires an approved grant', async () => {
    const f = fixture();
    const { requestId } = await f.begin();
    for (let i = 0; i < 3; i++) expect(f.authority.acceptAuthenticatedTelegramReply({ requestId,
      code: '999999' === f.code() ? '000000' : '999999', topicId: 131439, senderUid: '7812716706' })).toBe(false);
    expect(f.authority.status(requestId, 'dashboard-proof')).toEqual({ status: 'revoked' });
    const second = fixture();
    const issued = await second.begin();
    second.authority.acceptAuthenticatedTelegramReply({ requestId: issued.requestId,
      code: second.code(), topicId: 131439, senderUid: '7812716706' });
    second.setNow(1_800_000_000_000 + 600_001);
    expect(second.authority.status(issued.requestId, 'dashboard-proof')).toEqual({ status: 'revoked' });
  });

  it('revokes display and input if the local indicator exits', async () => {
    const f = fixture();
    const { requestId } = await f.begin();
    expect(f.authority.acceptAuthenticatedTelegramReply({ requestId,
      code: f.code(), topicId: 131439, senderUid: '7812716706' })).toBe(true);
    const state = f.authority.status(requestId, 'dashboard-proof');
    const payload = Buffer.from(JSON.stringify(['desktop-browser-possession-v1', requestId, state.connectionNonce]));
    const ticket = f.authority.ticket(requestId, 'dashboard-proof', state.connectionNonce!,
      crypto.sign(null, payload, f.browser.privateKey).toString('base64'));
    const stream = await f.authority.admit({ headers: { origin: 'https://instar.example', host: 'instar.example',
      'x-forwarded-proto': 'https',
      'sec-websocket-protocol': `instar-desktop-v1, ticket.${ticket}` },
      url: '/desktop-stream', socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage);
    f.crashIndicator();
    await expect(stream.assertActive()).rejects.toThrow('grant');
    expect(f.indicatorStops()).toBe(1);
    expect(f.closed).toEqual([stream.grantId]);
  });
});

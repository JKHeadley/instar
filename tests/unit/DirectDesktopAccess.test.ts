import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { DirectDesktopAccess } from '../../src/core/DirectDesktopAccess.js';
import type { MacDesktopHost } from '../../src/core/MacDesktopHost.js';
import type { DesktopInput } from '../../src/core/DesktopHost.js';
import type { RemoteStepUpLockoutPort } from '../../src/core/RemoteStepUpLockouts.js';

function resumeProof(browser: crypto.KeyPairKeyObjectResult, requestId: string,
  previousConnectionNonce: string, attemptId: string,
  input: { browserPublicKey: string; browserEcdhPublicKey: string; browserNonce: string }): string {
  return crypto.sign(null, Buffer.from(JSON.stringify(['desktop-resume-v1', requestId,
    previousConnectionNonce, attemptId, input.browserPublicKey, input.browserEcdhPublicKey,
    input.browserNonce])), browser.privateKey).toString('base64');
}

function fixture(mode: 'telegram' | 'pin' = 'telegram') {
  let now = 1_800_000_000_000;
  let binding = true;
  let sessionValid = true;
  let challenge = '';
  let cancelled = 0;
  let heldButton: string | null = null;
  const heldKeys = new Set<string>();
  let indicatorExit: (() => void) | null = null;
  let indicatorStops = 0;
  let probes = 0;
  let probeGate: Promise<void> | null = null;
  let indicatorGate: Promise<void> | null = null;
  let image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
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
    probe: async () => { probes++; await probeGate; return { screenPermission: true, inputPermission: true, displayCount: 1, sessionActive: true }; },
    capture: async () => image,
    cursor: async () => ({ x: 0.25, y: 0.75 }),
    input: async (action: DesktopInput) => {
      if (action.kind === 'buttonDown') heldButton = action.button;
      if (action.kind === 'buttonUp') heldButton = null;
      if (action.kind === 'keyDown') heldKeys.add(action.key);
      if (action.kind === 'keyUp') heldKeys.delete(action.key);
    },
    cancelInput: () => { cancelled++; heldButton = null; heldKeys.clear(); },
    startIndicator: async (onExit: () => void) => { await indicatorGate; indicatorExit = onExit; },
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
    setFrame: (value: Buffer) => { image = value; },
    cancelled: () => cancelled, heldButton: () => heldButton, heldKeys: () => [...heldKeys], indicatorStops: () => indicatorStops,
    probes: () => probes,
    setProbeGate: (gate: Promise<void> | null) => { probeGate = gate; },
    setIndicatorGate: (gate: Promise<void> | null) => { indicatorGate = gate; },
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
  it('resumes only a transport loss under the original deadline and stable revocation identity', async () => {
    const f = fixture('pin');
    const start = 1_800_000_000_000;
    const { requestId } = await f.begin();
    const connect = async (browser: crypto.KeyPairKeyObjectResult) => {
      const state = f.authority.status(requestId, 'dashboard-proof');
      const proof = crypto.sign(null, Buffer.from(JSON.stringify([
        'desktop-browser-possession-v1', requestId, state.connectionNonce])), browser.privateKey).toString('base64');
      const ticket = f.authority.ticket(requestId, 'dashboard-proof', state.connectionNonce!, proof);
      return f.authority.admit({ headers: { origin: 'https://instar.example', host: 'instar.example',
        'x-forwarded-proto': 'https', 'sec-websocket-protocol': `instar-desktop-v1, ticket.${ticket}` },
      url: '/desktop-stream', socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage);
    };
    const old = await connect(f.browser);
    await old.input({ kind: 'buttonDown', x: 0.3, y: 0.4, button: 'left' });
    await old.input({ kind: 'keyDown', key: 'Meta' });
    expect(f.heldButton()).toBe('left');
    expect(f.heldKeys()).toEqual(['Meta']);
    const previousNonce = f.authority.status(requestId, 'dashboard-proof').connectionNonce!;
    old.release('transport-lost');
    expect(f.heldButton()).toBeNull();
    expect(f.heldKeys()).toEqual([]);
    expect(f.authority.status(requestId, 'dashboard-proof')).toEqual({ status: 'interrupted' });
    await expect(old.assertActive()).rejects.toThrow('grant');
    const browser = crypto.generateKeyPairSync('ed25519');
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
    const input = { browserPublicKey: browser.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      browserEcdhPublicKey: ecdh.getPublicKey().toString('base64'), browserNonce: 'fedcba9876543210' };
    const [first, duplicate] = await Promise.all([
      f.authority.resume(requestId, 'dashboard-proof', input, 'attempt-1234567890', previousNonce,
        resumeProof(f.browser, requestId, previousNonce, 'attempt-1234567890', input)),
      f.authority.resume(requestId, 'dashboard-proof', input, 'attempt-1234567890', previousNonce,
        resumeProof(f.browser, requestId, previousNonce, 'attempt-1234567890', input)),
    ]);
    expect(first).toEqual(duplicate);
    expect(first.expiresAt).toBe(start + 600_000);
    const replacement = await connect(browser);
    expect(replacement.grantId).not.toBe(old.grantId);
    await replacement.input({ kind: 'buttonDown', x: 0.4, y: 0.5, button: 'left' });
    await replacement.input({ kind: 'keyDown', key: 'Shift' });
    f.authority.revoke(requestId, 'dashboard-proof');
    expect(f.heldButton()).toBeNull();
    expect(f.heldKeys()).toEqual([]);
    await expect(replacement.assertActive()).rejects.toThrow('grant');
    await expect(f.authority.resume(requestId, 'dashboard-proof', input, 'attempt-other-123456', previousNonce,
      resumeProof(f.browser, requestId, previousNonce, 'attempt-other-123456', input))).rejects.toThrow('resume unavailable');
  });

  it('replaces a half-open transport only with proof from its current browser generation', async () => {
    const f = fixture('pin');
    const { requestId } = await f.begin();
    const initial = f.authority.status(requestId, 'dashboard-proof');
    const ticket = f.authority.ticket(requestId, 'dashboard-proof', initial.connectionNonce!,
      crypto.sign(null, Buffer.from(JSON.stringify(['desktop-browser-possession-v1', requestId,
        initial.connectionNonce])), f.browser.privateKey).toString('base64'));
    const old = await f.authority.admit({ headers: { origin: 'https://instar.example', host: 'instar.example',
      'x-forwarded-proto': 'https', 'sec-websocket-protocol': `instar-desktop-v1, ticket.${ticket}` },
    url: '/desktop-stream', socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage);
    await old.input({ kind: 'buttonDown', x: 0.2, y: 0.3, button: 'left' });
    await old.input({ kind: 'keyDown', key: 'Alt' });
    expect(f.heldButton()).toBe('left');
    const newBrowser = crypto.generateKeyPairSync('ed25519');
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
    const input = { browserPublicKey: newBrowser.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      browserEcdhPublicKey: ecdh.getPublicKey().toString('base64'), browserNonce: 'fedcba9876543210' };
    const attempt = 'half-open-attempt-123456';
    const proof = resumeProof(f.browser, requestId, initial.connectionNonce!, attempt, input);
    await expect(f.authority.resume(requestId, 'dashboard-proof', input, attempt,
      initial.connectionNonce!, 'bad')).rejects.toThrow('previous browser proof');
    const replacement = await f.authority.resume(requestId, 'dashboard-proof', input, attempt,
      initial.connectionNonce!, proof);
    expect(f.heldButton()).toBeNull();
    expect(f.heldKeys()).toEqual([]);
    expect(replacement.connectionNonce).not.toBe(initial.connectionNonce);
    expect(f.closed).toContain(old.grantId);
    await expect(old.assertActive()).rejects.toThrow('grant');
    old.release('transport-lost');
    expect(f.authority.status(requestId, 'dashboard-proof').status).toBe('approved');
    await expect(f.authority.resume(requestId, 'dashboard-proof', input, 'another-attempt-123456',
      initial.connectionNonce!, resumeProof(f.browser, requestId, initial.connectionNonce!,
        'another-attempt-123456', input))).rejects.toThrow('resume unavailable');
    await expect(f.authority.resume(requestId, 'dashboard-proof', { ...input, browserNonce: 'another-nonce-123456' },
      attempt, initial.connectionNonce!, proof)).rejects.toThrow('attempt changed');
  });

  it('waits for an in-flight admission before replacing its grant', async () => {
    const f = fixture('pin');
    const { requestId } = await f.begin();
    const initial = f.authority.status(requestId, 'dashboard-proof');
    const ticket = f.authority.ticket(requestId, 'dashboard-proof', initial.connectionNonce!,
      crypto.sign(null, Buffer.from(JSON.stringify(['desktop-browser-possession-v1', requestId,
        initial.connectionNonce])), f.browser.privateKey).toString('base64'));
    let releaseIndicator!: () => void;
    f.setIndicatorGate(new Promise<void>(resolve => { releaseIndicator = resolve; }));
    const pendingAdmission = f.authority.admit({ headers: { origin: 'https://instar.example', host: 'instar.example',
      'x-forwarded-proto': 'https', 'sec-websocket-protocol': `instar-desktop-v1, ticket.${ticket}` },
    url: '/desktop-stream', socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage);
    const newBrowser = crypto.generateKeyPairSync('ed25519');
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
    const input = { browserPublicKey: newBrowser.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      browserEcdhPublicKey: ecdh.getPublicKey().toString('base64'), browserNonce: 'fedcba9876543210' };
    const attempt = 'pending-admit-attempt-123456';
    const replacementPromise = f.authority.resume(requestId, 'dashboard-proof', input, attempt,
      initial.connectionNonce!, resumeProof(f.browser, requestId, initial.connectionNonce!, attempt, input));
    expect(f.closed).toEqual([]);
    releaseIndicator();
    const old = await pendingAdmission;
    const replacement = await replacementPromise;
    expect(f.closed).toContain(old.grantId);
    expect(replacement.connectionNonce).not.toBe(initial.connectionNonce);
    await expect(old.assertActive()).rejects.toThrow('grant');
  });

  it('keeps explicit Stop and expiry terminal after a broken transport', async () => {
    const f = fixture('pin');
    const { requestId } = await f.begin();
    const input = { browserPublicKey: f.browser.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      browserEcdhPublicKey: f.browserEcdh.getPublicKey().toString('base64'), browserNonce: 'fedcba9876543210' };
    f.authority.revoke(requestId, 'dashboard-proof');
    await expect(f.authority.resume(requestId, 'dashboard-proof', input, 'attempt-1234567890', '', '')).rejects.toThrow('resume unavailable');
    const second = fixture('pin');
    const granted = await second.begin();
    const state = second.authority.status(granted.requestId, 'dashboard-proof');
    const ticket = second.authority.ticket(granted.requestId, 'dashboard-proof', state.connectionNonce!,
      crypto.sign(null, Buffer.from(JSON.stringify(['desktop-browser-possession-v1', granted.requestId,
        state.connectionNonce])), second.browser.privateKey).toString('base64'));
    const stream = await second.authority.admit({ headers: { origin: 'https://instar.example', host: 'instar.example',
      'x-forwarded-proto': 'https', 'sec-websocket-protocol': `instar-desktop-v1, ticket.${ticket}` },
    url: '/desktop-stream', socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage);
    stream.release('transport-lost');
    second.setNow(1_800_000_000_000 + 600_001);
    await expect(second.authority.resume(granted.requestId, 'dashboard-proof', input,
      'attempt-1234567890', state.connectionNonce!, '')).rejects.toThrow('resume unavailable');
    expect(second.authority.status(granted.requestId, 'dashboard-proof')).toEqual({ status: 'revoked' });
  });

  it('refuses a resume when Stop or expiry wins during the host readiness probe', async () => {
    for (const end of ['stop', 'expiry'] as const) {
      const f = fixture('pin');
      const { requestId } = await f.begin();
      const state = f.authority.status(requestId, 'dashboard-proof');
      const ticket = f.authority.ticket(requestId, 'dashboard-proof', state.connectionNonce!,
        crypto.sign(null, Buffer.from(JSON.stringify(['desktop-browser-possession-v1', requestId,
          state.connectionNonce])), f.browser.privateKey).toString('base64'));
      const stream = await f.authority.admit({ headers: { origin: 'https://instar.example', host: 'instar.example',
        'x-forwarded-proto': 'https', 'sec-websocket-protocol': `instar-desktop-v1, ticket.${ticket}` },
      url: '/desktop-stream', socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage);
      stream.release('transport-lost');
      let releaseProbe!: () => void;
      f.setProbeGate(new Promise<void>(resolve => { releaseProbe = resolve; }));
      const input = { browserPublicKey: f.browser.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
        browserEcdhPublicKey: f.browserEcdh.getPublicKey().toString('base64'), browserNonce: 'fedcba9876543210' };
      const pending = f.authority.resume(requestId, 'dashboard-proof', input, 'race-attempt-12345678',
        state.connectionNonce!, resumeProof(f.browser, requestId, state.connectionNonce!, 'race-attempt-12345678', input));
      if (end === 'stop') f.authority.revoke(requestId, 'dashboard-proof');
      else f.setNow(1_800_000_000_000 + 600_001);
      releaseProbe();
      await expect(pending).rejects.toThrow('resume unavailable');
      expect(f.authority.status(requestId, 'dashboard-proof')).toEqual({ status: 'revoked' });
    }
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
    expect(f.authority.ticket(requestId, 'dashboard-proof', state.connectionNonce!, signature)).toBe(ticket);
    const request = { headers: { origin: 'https://instar.example', host: 'instar.example',
      'x-forwarded-proto': 'https',
      'sec-websocket-protocol': `instar-desktop-v1, ticket.${ticket}` },
      url: '/desktop-stream', socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage;
    const remoteRequest = { ...request, socket: { remoteAddress: '192.0.2.1' } } as unknown as IncomingMessage;
    await expect(f.authority.admit(remoteRequest)).rejects.toThrow('transport');
    const stream = await f.authority.admit(request);
    expect(() => f.authority.ticket(requestId, 'dashboard-proof', state.connectionNonce!, signature)).toThrow('unavailable');
    await expect(f.authority.admit(request)).rejects.toThrow('ticket');
    const probesBeforeFrames = f.probes();
    const encrypted = (await stream.captureEncrypted())!;
    expect(encrypted.readBigUInt64BE(0)).toBe(1n);
    expect(encrypted.length).toBe(8 + 4 + 16);
    // The transport drops this frame before enqueueing it. A static desktop
    // must still offer it again on the next capture tick.
    const retry = (await stream.captureEncrypted())!;
    expect(retry.readBigUInt64BE(0)).toBe(2n);
    stream.frameQueued?.();
    expect(await stream.captureEncrypted()).toBeNull();
    f.setFrame(Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]));
    const nextFrame = (await stream.captureEncrypted())!;
    expect(nextFrame.readBigUInt64BE(0)).toBe(3n);
    stream.frameQueued?.();
    expect(await stream.captureEncrypted()).toBeNull();
    expect(f.probes() - probesBeforeFrames).toBe(1);
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

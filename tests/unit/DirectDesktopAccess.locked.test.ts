import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { DirectDesktopAccess } from '../../src/core/DirectDesktopAccess.js';
import { DesktopLockedController, type DesktopRelockMarker } from '../../src/core/DesktopLockedController.js';
import type { DesktopHost, DesktopInput, DesktopProbe } from '../../src/core/DesktopHost.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface World {
  flag: boolean; shield: boolean; asleep: boolean; console: string;
  active: number; online: number; own: boolean; retained: boolean;
}

function fixture(lockedOn: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-locked-access-'));
  let now = Date.now();
  let perf = 1_000_000;
  vi.spyOn(performance, 'now').mockImplementation(() => perf);
  const world: World = { flag: true, shield: true, asleep: false, console: 'echo', active: 1, online: 1, own: true, retained: true };
  const markers: Record<string, DesktopRelockMarker> = {};
  const inputs: DesktopInput[] = [];
  const secrets: unknown[] = [];
  let probeFails = false;
  let captureFails = false;
  let secretReply: void | { refused: string };
  let enterAt: number | undefined;
  let failHandler: (() => void) | null = null;
  const lockedHost = {
    setLockedMode: () => {},
    startRelockGuard: async (key: string) => { fs.writeFileSync(path.join(root, `hb-${key}`), ''); },
    lockedOp: async (op: Record<string, any>) => {
      fs.writeFileSync(path.join(root, 'locked-state.json'), '{}');
      if (op.op === 'read') return { state: { markers }, attempts: { count: 0 } };
      if (op.op === 'marker-create') { markers[op.key] ??= { ...op.marker, state: 'owed' }; return { marker: markers[op.key] }; }
      if (op.op === 'relock-now') { if (markers[op.key]) markers[op.key].relockNow = true; return {}; }
      if (op.op === 'leave-unlocked') { markers[op.key].state = 'left-unlocked'; return { ok: true }; }
      return { ok: true };
    },
  };
  const controller = new DesktopLockedController({ host: lockedHost, agentId: 'echo', root,
    settings: () => ({ enabled: lockedOn, browserBox: false, chime: true }), saveSettings: () => {},
    readPolicy: async () => 'on', tunnelFirstTierActive: () => true, raiseSecurity: () => {}, now: () => now,
    provenVersions: [{ osMajor: 26, p12: 'e', p15: 'e', refuse: [] }] });
  const host = {
    probe: async (): Promise<DesktopProbe> => {
      if (probeFails) throw new Error('mac-desktop-host-timeout');
      return { screenPermission: true, inputPermission: true, displayCount: world.active,
        sessionActive: !world.flag, consoleSessionPresent: true, onConsole: world.console === 'echo', loginDone: true,
        screenLocked: world.flag, osMajor: 26, inputGrant: world.own ? 'own' : 'inherited',
        helperSource: world.retained ? 'retained' : 'packaged',
        lockInputs: { shieldWindow: world.shield, secureInputOwner: 'loginwindow', displayAsleep: world.asleep,
          screensaver: false, onlineDisplays: world.online, thisUser: 'echo', consoleUser: world.console, osMajor: 26, sampledAtMs: now } };
    },
    capture: async () => { if (captureFails) throw new Error('mac-desktop-host-capture-unavailable'); return Buffer.from([0xff, 0xd8, 0, 0, 0xff, 0xd9]); },
    captureH264: async () => { if (captureFails) throw new Error('mac-desktop-host-capture-unavailable'); return null; },
    input: async (action: DesktopInput) => { inputs.push(action); },
    secretType: async (input: unknown) => {
      secrets.push(input);
      if (!secretReply && enterAt !== undefined) markers[`${(input as { requestId: string }).requestId}.0`].enterPendingAt = enterAt;
      return secretReply;
    },
    abortInput: () => {}, ensureInputStream: () => {}, setSealKeyHandler: () => {},
    cancelInput: () => {}, setInputFailureHandler: (handler: () => void) => { failHandler = handler; },
    startIndicator: async () => {}, stopIndicator: () => {},
  } as unknown as DesktopHost;
  const targetKey = crypto.generateKeyPairSync('ed25519');
  const closed: string[] = [];
  const authority = new DirectDesktopAccess('machine-1', 'Echo Mac', host,
    { get: () => 0, recordFailure: () => ({ attempts: 0, lockedUntilMs: 0 }) } as never,
    { publicKey: targetKey.publicKey.export({ format: 'der', type: 'spki' }) as Buffer,
      sign: payload => crypto.sign(null, payload, targetKey.privateKey) },
    () => true, () => true, async () => {}, id => { closed.push(id); }, () => now, undefined, 'pin', undefined,
    controller);
  const browser = crypto.generateKeyPairSync('ed25519');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const open = async (client: 'app' | 'browser' = 'app') => {
    const { requestId } = await authority.begin({ machineId: 'machine-1', topicId: 0, operatorUid: 'x',
      operatorSessionToken: 'proof', browserPublicKey: browser.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      browserEcdhPublicKey: ecdh.getPublicKey().toString('base64'), browserNonce: '0123456789abcdef',
      scopeConfirmed: true, videoCodec: 'h264', client, controlRecords: true });
    const state = authority.status(requestId, 'proof');
    const proof = crypto.sign(null, Buffer.from(JSON.stringify(['desktop-browser-possession-v1', requestId, state.connectionNonce])),
      browser.privateKey).toString('base64');
    const ticket = authority.ticket(requestId, 'proof', state.connectionNonce!, proof);
    const stream = await authority.admit({ headers: { origin: 'https://i.example', host: 'i.example', 'x-forwarded-proto': 'https',
      'sec-websocket-protocol': `instar-desktop-v1, ticket.${ticket}` }, url: '/desktop-stream',
    socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage);
    return { requestId, stream };
  };
  return { authority, controller, world, markers, inputs, secrets, closed, open, root,
    setProbeFails: (v: boolean) => { probeFails = v; }, setCaptureFails: (v: boolean) => { captureFails = v; },
    setSecretReply: (v: void | { refused: string }) => { secretReply = v; }, setEnterAt: (v: number) => { enterAt = v; },
    advance: (ms: number) => { now += ms; perf += ms; }, tickProbe: () => { perf += 600; }, failInput: () => failHandler?.() };
}

describe('DirectDesktopAccess at the lock', () => {
  let cleanup: string[] = [];
  const make = (on = true) => { const f = fixture(on); cleanup.push(f.root); return f; };
  beforeEach(() => { cleanup = []; });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of cleanup) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'test cleanup' });
  });

  it('with the feature off a locked Mac stays not ready, exactly as today', async () => {
    expect((await make(false).authority.probe()).ready).toBe(false);
  });

  it('with the feature on and proven, the shield is ready, with no active display', async () => {
    const f = make();
    f.world.active = 0;
    f.world.asleep = true;
    expect((await f.authority.probe()).ready).toBe(true);
    f.world.online = 0;
    expect((await f.authority.probe()).ready).toBe(false);
  });

  it('keeps a grant at the shield and refuses all input at unknown except releases', async () => {
    const f = make();
    const { stream } = await f.open();
    await stream.assertActive();
    f.world.shield = false;
    f.tickProbe();
    await stream.assertActive();
    await expect(stream.input({ kind: 'keyDown', key: 'Enter' })).resolves.toEqual({ refused: 'state-unknown' });
    await expect(stream.input({ kind: 'keyUp', key: 'Enter' })).resolves.toBeUndefined();
    expect(f.inputs).toHaveLength(1);
  });

  it('ends a grant when a person unlocks with no recent Enter from it', async () => {
    const f = make();
    const { stream } = await f.open();
    f.world.flag = false;
    f.world.shield = false;
    f.tickProbe();
    await expect(stream.assertActive()).rejects.toThrow('desktop grant unavailable');
  });

  it('keeps the grant when its own reserved attempt posted Enter within 15 s', async () => {
    const f = make();
    const { stream } = await f.open();
    f.setEnterAt(Date.now() + 1_000);
    await stream.secret!({ ephemeral: 'e', iv: 'i', ct: 'c', seq: 1 });
    f.advance(2_000);
    f.world.flag = false;
    f.world.shield = false;
    f.tickProbe();
    await expect(stream.assertActive()).resolves.toBeUndefined();
  });

  it('a refused secret never counts as the unlock cause', async () => {
    const f = make();
    const { stream } = await f.open();
    f.setSecretReply({ refused: 'field-dirty' });
    await stream.secret!({ ephemeral: 'e', iv: 'i', ct: 'c', seq: 1 });
    f.world.flag = false;
    f.world.shield = false;
    f.tickProbe();
    await expect(stream.assertActive()).rejects.toThrow('desktop grant unavailable');
  });

  it('refuses the browser while its box is off, before any marker exists', async () => {
    const f = make();
    const { stream } = await f.open('browser');
    const sent: Buffer[] = [];
    stream.attachControl!(record => { sent.push(record); });
    await stream.secret!({ ephemeral: 'e', iv: 'i', ct: 'c', seq: 1 });
    expect(f.secrets).toHaveLength(0);
    expect(Object.keys(f.markers)).toHaveLength(0);
    expect(sent.length).toBeGreaterThan(0);
  });

  it('refuses a password without the retained helper or its own grant', async () => {
    const f = make();
    f.world.retained = false;
    const { stream } = await f.open();
    await stream.secret!({ ephemeral: 'e', iv: 'i', ct: 'c', seq: 1 });
    expect(f.secrets).toHaveLength(0);
  });

  it('off does not read the policy or spawn anything extra on the probe path', async () => {
    const f = make(false);
    const read = vi.spyOn(f.controller, 'readState');
    await f.authority.probe();
    expect(read).not.toHaveBeenCalled();
  });

  it('a password sent after Stop is refused and leaves no marker', async () => {
    const f = make();
    const { stream } = await f.open();
    await stream.revoke();
    await expect(stream.secret!({ ephemeral: 'e', iv: 'i', ct: 'c', seq: 1 })).rejects.toThrow();
    expect(Object.keys(f.markers)).toHaveLength(0);
  });

  it('a Mac-wide disable stops another agent\'s live grant at the next probe', async () => {
    const f = make();
    const { requestId } = await f.open();
    vi.spyOn(f.controller, 'isDisabled').mockResolvedValue(true);
    await f.authority.probe();
    expect(f.authority.status(requestId, 'proof').status).toBe('revoked');
  });

  it('asks for a relock when the grant ends after a password', async () => {
    const f = make();
    const { requestId, stream } = await f.open();
    await stream.secret!({ ephemeral: 'e', iv: 'i', ct: 'c', seq: 1 });
    await stream.revoke();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(f.markers[`${requestId}.0`].relockNow).toBe(true);
  });

  it('treats a failed probe as unknown, not a revoke, within the bound', async () => {
    const f = make();
    const { stream } = await f.open();
    f.setProbeFails(true);
    for (let i = 0; i < 3; i++) { f.tickProbe(); await stream.assertActive(); }
    f.tickProbe();
    await expect(stream.assertActive()).rejects.toThrow();
  });

  it('a lock-caused capture exit is a bounded respawn, never a codec downgrade', async () => {
    const f = make();
    const { stream } = await f.open();
    f.setCaptureFails(true);
    await expect(stream.captureEncrypted()).resolves.toBeNull();
    for (let i = 0; i < 2; i++) { f.advance(5_000); await expect(stream.captureEncrypted()).resolves.toBeNull(); }
    f.advance(5_000);
    await expect(stream.captureEncrypted()).rejects.toThrow();
  });

  it('input-helper loss at the lock respawns instead of revoking', async () => {
    const f = make();
    const { requestId } = await f.open();
    f.failInput();
    expect(f.authority.status(requestId, 'proof').status).toBe('approved');
  });

  it('disable ends a grant that began locked even after it unlocked, and leaves ordinary grants', async () => {
    const f = make();
    const { requestId } = await f.open();
    f.authority.endLockedGrants();
    expect(f.authority.status(requestId, 'proof').status).toBe('revoked');
    const g = make();
    g.world.flag = false;
    g.world.shield = false;
    const ordinary = await g.open();
    g.authority.endLockedGrants();
    expect(g.authority.status(ordinary.requestId, 'proof').status).toBe('approved');
  });

  it('a duty in progress refuses a new request', async () => {
    const f = make();
    const { requestId, stream } = await f.open();
    await stream.secret!({ ephemeral: 'e', iv: 'i', ct: 'c', seq: 1 });
    await stream.revoke();
    fs.writeFileSync(path.join(f.root, `hb-${requestId}.0`), '');
    f.advance(11_000);
    await expect(f.open()).rejects.toThrow('relock-pending');
  });
});

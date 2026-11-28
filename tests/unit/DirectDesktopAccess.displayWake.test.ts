import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { DirectDesktopAccess } from '../../src/core/DirectDesktopAccess.js';
import type { DesktopHost } from '../../src/core/DesktopHost.js';
import type { DesktopAuditEvent, DesktopAccessAudit } from '../../src/core/DesktopAccessAudit.js';
import type { DisplayWakeResult } from '../../src/core/MacDisplayWake.js';
import type { RemoteStepUpLockoutPort } from '../../src/core/RemoteStepUpLockouts.js';

/** A Mac whose session flag reads set (not ready) until its display is woken. */
function fixture(o: { wake?: DisplayWakeResult | 'throws' | 'absent'; flagClearsAfterWake?: boolean; permissions?: boolean; ready?: boolean } = {}) {
  let sessionActive = o.ready ?? false;
  let wakes = 0;
  let probes = 0;
  const events: DesktopAuditEvent[] = [];
  const host = {
    probe: async () => {
      probes++;
      return { screenPermission: o.permissions ?? true, inputPermission: o.permissions ?? true, displayCount: sessionActive ? 1 : 0, sessionActive };
    },
    ...(o.wake === 'absent' ? {} : {
      wakeDisplay: async () => {
        wakes++;
        if (o.wake === 'throws') throw new Error('wake broke');
        const result = o.wake ?? 'woke';
        if (result === 'woke' && (o.flagClearsAfterWake ?? true)) sessionActive = true;
        return result;
      },
    }),
    capture: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    input: async () => {},
    cancelInput: () => {},
    startIndicator: async () => {},
    stopIndicator: () => {},
  } as unknown as DesktopHost;
  const locks: RemoteStepUpLockoutPort = { get: () => 0, set: () => {}, recordFailure: () => ({ attempts: 1, lockedUntilMs: 0 }) };
  const targetKey = crypto.generateKeyPairSync('ed25519');
  const targetIdentity = { publicKey: targetKey.publicKey.export({ format: 'der', type: 'spki' }),
    sign: (payload: Buffer) => crypto.sign(null, payload, targetKey.privateKey) };
  const audit = { record: (event: DesktopAuditEvent) => { events.push(event); } } as unknown as DesktopAccessAudit;
  const authority = new DirectDesktopAccess('machine-1', 'Echo Mac', host, locks, targetIdentity,
    (topic, uid) => topic === 131439 && uid === '7812716706',
    token => token === 'dashboard-proof',
    async () => {}, () => {}, Date.now, audit, 'telegram');
  const browser = crypto.generateKeyPairSync('ed25519');
  const browserEcdh = crypto.createECDH('prime256v1');
  browserEcdh.generateKeys();
  const begin = () => authority.begin({ machineId: 'machine-1', topicId: 131439,
    operatorUid: '7812716706', operatorSessionToken: 'dashboard-proof',
    browserPublicKey: browser.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    browserEcdhPublicKey: browserEcdh.getPublicKey().toString('base64'),
    browserNonce: '0123456789abcdef', scopeConfirmed: true });
  return { begin, wakes: () => wakes, probes: () => probes, events, sleep: () => { sessionActive = false; } };
}

describe('DirectDesktopAccess admission wakes a display that is only asleep', () => {
  it('a Mac whose display is asleep, not locked, is admitted after one wake', async () => {
    const f = fixture();
    await expect(f.begin()).resolves.toMatchObject({ requestId: expect.any(String) });
    expect(f.wakes()).toBe(1);
    expect(f.events).toEqual([expect.objectContaining({ kind: 'display-wake', reason: 'woke-ready', operatorUid: '7812716706', machineId: 'machine-1' })]);
  });

  it('a locked console is refused as before, and nothing more is probed', async () => {
    const f = fixture({ wake: 'console-locked' });
    await expect(f.begin()).rejects.toThrow('desktop host is not ready');
    expect(f.wakes()).toBe(1);
    expect(f.probes()).toBe(1);
    expect(f.events.map(e => e.reason)).toEqual(['console-locked']);
  });

  it('an unreadable console lock, or a wake that throws, is refused as before', async () => {
    for (const wake of ['unknown', 'throws'] as const) {
      const f = fixture({ wake });
      await expect(f.begin()).rejects.toThrow('desktop host is not ready');
      expect(f.probes()).toBe(1);
      expect(f.events.map(e => e.reason)).toEqual(['unknown']);
    }
  });

  it('a display that does not wake is refused after at most 3 s of rereads', async () => {
    const f = fixture({ flagClearsAfterWake: false });
    const started = Date.now();
    await expect(f.begin()).rejects.toThrow('desktop host is not ready');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(f.wakes()).toBe(1);
    expect(f.probes()).toBeLessThanOrEqual(1 + 6);
    expect(f.events.map(e => e.reason)).toEqual(['woke-not-ready']);
  }, 10_000);

  it('a second request inside 10 s is refused before any wake', async () => {
    const f = fixture({ flagClearsAfterWake: true });
    await f.begin();
    f.sleep();
    await expect(f.begin()).rejects.toThrow('wait before requesting another desktop session');
    expect(f.wakes()).toBe(1);
  });

  it('never wakes a ready Mac, a Mac missing its permissions, or a host without the wake', async () => {
    for (const o of [{ ready: true }, { permissions: false }, { wake: 'absent' as const }]) {
      const f = fixture(o);
      if (o.ready) await expect(f.begin()).resolves.toMatchObject({ requestId: expect.any(String) });
      else await expect(f.begin()).rejects.toThrow('desktop host is not ready');
      expect(f.wakes()).toBe(0);
      expect(f.events).toEqual([]);
    }
  });
});

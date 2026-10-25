import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PhysicalEffectLock,
  PhysicalEffectLockError,
  UnixFlockProvider,
  type PhysicalEffectLockProvider,
} from '../../src/core/PhysicalEffectLock.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const unix = process.platform === 'darwin' || process.platform === 'linux';
const describeUnix = unix ? describe : describe.skip;
const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'physical-effect-lock-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, {
    recursive: true, force: true,
    operation: 'tests/unit/PhysicalEffectLock.test.ts:cleanup',
  });
});

describe('PhysicalEffectLock', () => {
  it('fails typed-dark when its provider is unavailable', async () => {
    const provider: PhysicalEffectLockProvider = {
      name: 'missing-native-provider', available: false, unavailableReason: 'not installed',
      acquire: async () => { throw new Error('must not call'); },
    };
    const lock = new PhysicalEffectLock(provider);
    expect(lock.status()).toEqual({ provider: 'missing-native-provider', available: false, reason: 'not installed' });
    await expect(lock.acquire('conversation', Date.now() + 1_000)).rejects.toMatchObject({
      name: 'PhysicalEffectLockError', code: 'provider-unavailable',
    });
  });

  it('rejects an elapsed deadline before consulting the provider', async () => {
    const provider: PhysicalEffectLockProvider = {
      name: 'available', available: true,
      acquire: async () => { throw new Error('must not call'); },
    };
    await expect(new PhysicalEffectLock(provider).acquire('c', Date.now() - 1)).rejects.toBeInstanceOf(PhysicalEffectLockError);
  });
});

describeUnix('UnixFlockProvider', () => {
  it('provides owner identity and a durable monotonic epoch', async () => {
    const provider = new UnixFlockProvider(tempDir());
    expect(provider.available).toBe(true);
    const first = await provider.acquire('topic:1', Date.now() + 2_000);
    expect(first.ownerId).toContain(`:${process.pid}:`);
    expect(first.epoch).toBe(1);
    expect(first.requiresReconciliation).toBe(false);
    first.assertHeld();
    await first.release();
    expect(() => first.assertHeld()).toThrow(PhysicalEffectLockError);

    const second = await provider.acquire('topic:1', Date.now() + 2_000);
    expect(second.epoch).toBe(2);
    expect(second.requiresReconciliation).toBe(false);
    await second.release();
  });

  it('uses deadline-aware nonblocking contention', async () => {
    const provider = new UnixFlockProvider(tempDir());
    const holder = await provider.acquire('same-scope', Date.now() + 2_000);
    const before = Date.now();
    await expect(provider.acquire('same-scope', Date.now() + 120)).rejects.toMatchObject({ code: 'deadline-exceeded' });
    expect(Date.now() - before).toBeLessThan(1_000);
    holder.assertHeld();
    await holder.release();
  });

  it('offers a synchronous kernel-backed lease for synchronous tmux effects', () => {
    const lock = new PhysicalEffectLock(new UnixFlockProvider(tempDir()));
    const lease = lock.acquireSync('sync-scope', Date.now() + 2_000);
    lease.assertHeld();
    expect(lease.epoch).toBe(1);
    lease.release();
    expect(() => lease.assertHeld()).toThrow(PhysicalEffectLockError);
  });

  it('does not serialize unrelated scopes', async () => {
    const provider = new UnixFlockProvider(tempDir());
    const [a, b] = await Promise.all([
      provider.acquire('scope-a', Date.now() + 2_000),
      provider.acquire('scope-b', Date.now() + 2_000),
    ]);
    a.assertHeld();
    b.assertHeld();
    await Promise.all([a.release(), b.release()]);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UnixFlockProvider } from '../../src/core/PhysicalEffectLock.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const unix = process.platform === 'darwin' || process.platform === 'linux';
const describeUnix = unix ? describe : describe.skip;
const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'physical-effect-lock-process-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, {
    recursive: true, force: true,
    operation: 'tests/integration/physical-effect-lock-provider.test.ts:cleanup',
  });
});

describeUnix('PhysicalEffectLock provider process conformance', () => {
  it('kernel-releases a crashed holder and requires reconciliation on reacquire', async () => {
    const provider = new UnixFlockProvider(tempDir());
    const crashed = await provider.acquire('conversation:59199', Date.now() + 2_000);
    const helperPid = Number(crashed.ownerId.split(':')[2]);
    expect(Number.isInteger(helperPid)).toBe(true);

    process.kill(helperPid, 'SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(() => crashed.assertHeld()).toThrow();

    const recovered = await provider.acquire('conversation:59199', Date.now() + 2_000);
    expect(recovered.epoch).toBe(crashed.epoch + 1);
    expect(recovered.requiresReconciliation).toBe(true);
    recovered.assertHeld();
    await recovered.release();
  });

  it('two independent provider instances cannot hold the same scope', async () => {
    const stateDir = tempDir();
    const firstProvider = new UnixFlockProvider(stateDir);
    const secondProvider = new UnixFlockProvider(stateDir);
    const first = await firstProvider.acquire('shared', Date.now() + 2_000);
    await expect(secondProvider.acquire('shared', Date.now() + 100)).rejects.toMatchObject({ code: 'deadline-exceeded' });
    await first.release();
    const second = await secondProvider.acquire('shared', Date.now() + 2_000);
    expect(second.epoch).toBe(first.epoch + 1);
    await second.release();
  });
});

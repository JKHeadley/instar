import { expect, it, vi } from 'vitest';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { MasterKeyManager } from '../../src/core/SecretStore.js';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: run,
}));

it.each(['darwin', 'linux'] as const)('reports a failed %s keychain write without child-process details', platform => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
  const report = vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => {});
  const syntheticKey = Buffer.alloc(32, 7);
  const syntheticOutput = 'SYNTHETIC_KEYCHAIN_OUTPUT';
  run.mockReset().mockImplementation((_binary, args: string[]) => {
    if (args[0] === 'delete-generic-password') return Buffer.alloc(0);
    throw new Error(`Synthetic failure: ${syntheticKey.toString('base64')}: ${syntheticOutput}`);
  });
  try {
    const manager = new MasterKeyManager('fixture-state') as unknown as {
      writeOsKeychain(service: string, account: string, key: Buffer): boolean;
    };
    expect(manager.writeOsKeychain('fixture-service', 'fixture-account', syntheticKey)).toBe(false);
    expect(report).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(report.mock.calls[0][0]);
    expect(serialized.includes(syntheticKey.toString('base64'))).toBe(false);
    expect(serialized.includes(syntheticOutput)).toBe(false);
  } finally {
    report.mockRestore();
    Object.defineProperty(process, 'platform', platformDescriptor);
  }
});

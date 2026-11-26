/** Bind only the real setup-lock API to an owned fixture's module graph. */
import os from 'node:os';
import { vi } from 'vitest';

export async function loadPrivateDiscoverySetupLock(home: string) {
  vi.resetModules();
  const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
  try {
    const { readSetupLock, writeSetupLock, deleteSetupLock } = await import('../../src/commands/discovery.js');
    return { readSetupLock, writeSetupLock, deleteSetupLock };
  } finally {
    homedirSpy.mockRestore();
    // The returned functions alone retain their captured private LOCK_PATH.
    // Subsequent imports cannot inherit this fixture's module cache.
    vi.resetModules();
  }
}

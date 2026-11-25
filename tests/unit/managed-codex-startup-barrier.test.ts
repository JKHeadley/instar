import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { createManagedCodexStartupBarrier } from '../../src/core/ManagedCodexStartupBarrier.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

it.skipIf(process.platform === 'win32')('holds a native startup receipt and accepts only its exact release once', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "managed-start-'$()-"));
  const nativeId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const launchId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  try {
    const barrier = createManagedCodexStartupBarrier(home, launchId);
    expect(barrier.readReceipt()).toBeUndefined();
    expect(() => barrier.release(nativeId)).toThrow(/does not match/);
    const child = spawn('/bin/sh', ['-c', barrier.hookCommand], {
      env: { INSTAR_SESSION_ID: launchId }, stdio: ['pipe', 'ignore', 'ignore'],
    });
    const closed = once(child, 'close');
    child.stdin.end(JSON.stringify({ session_id: nativeId }));
    try {
      await vi.waitFor(() => expect(barrier.readReceipt()).toBe(nativeId));
      expect(child.exitCode).toBeNull();
      expect(() => barrier.release(launchId)).toThrow(/does not match/);
      barrier.release(nativeId);
      expect(await closed).toEqual([0, null]);
      expect(() => barrier.release(nativeId)).toThrow();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await closed;
      }
    }
  } finally {
    SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'managed-start-barrier-fixture' });
  }
});

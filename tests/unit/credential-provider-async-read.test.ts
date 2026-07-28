/**
 * Unit test for the NON-BLOCKING keychain read in `KeychainCredentialProvider.readCredentials`.
 *
 * Root cause this guards: `readCredentials()` was declared `async` but its body called
 * `execFileSync('security', …)` — a SYNCHRONOUS keychain spawn that blocked the event loop for the
 * whole spawn duration (10s timeout) every QuotaCollector poll cycle. Under multi-agent `securityd`
 * contention that was the residual dashboard-flap / false-sleep freeze (timer-driven, ~30–65s).
 * The fix routes the read through the PROMISIFIED `execFile` so the loop yields instead of freezing.
 *
 * Fully hermetic: `node:child_process` is module-mocked so NO real `security` is ever spawned.
 * The test asserts the ASYNC `execFile` is used and the SYNC `execFileSync` is NOT touched on the
 * read path — i.e. the `async` is no longer a lie.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Module mock: replace the keychain spawn primitives. execFile (async) invokes its callback with a
// fake credential blob; execFileSync (sync, the loop-freezing one) throws if ever called on the read.
const execFileMock = vi.fn(
  (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, res: { stdout: string; stderr: string }) => void,
  ) => {
    cb(null, {
      stdout: JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat0-ASYNC',
          refreshToken: 'sk-ant-ort0-ASYNC',
          expiresAt: 4242,
          email: 'a@example.com',
        },
      }),
      stderr: '',
    });
  },
);
const execFileSyncMock = vi.fn(() => {
  throw new Error('execFileSync (sync keychain spawn) must NOT be used on the read hot path');
});

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));

// Imported AFTER the mock is registered so the provider binds the mocked spawns.
const { KeychainCredentialProvider } = await import('../../src/monitoring/CredentialProvider.js');

describe('KeychainCredentialProvider.readCredentials — async keychain spawn', () => {
  beforeEach(() => {
    execFileMock.mockClear();
    execFileSyncMock.mockClear();
  });

  it('reads via the ASYNC execFile (never the sync execFileSync)', async () => {
    const provider = new KeychainCredentialProvider();
    const creds = await provider.readCredentials();
    expect(creds).not.toBeNull();
    expect(creds?.accessToken).toBe('sk-ant-oat0-ASYNC');
    expect(creds?.email).toBe('a@example.com');
    // The async spawn is used; the loop-freezing sync spawn is NOT.
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock).not.toHaveBeenCalled();
    // Confirm it spawned the keychain read with the expected args.
    expect(execFileMock.mock.calls[0][0]).toBe('security');
    expect(execFileMock.mock.calls[0][1]).toEqual([
      'find-generic-password',
      '-s',
      'Claude Code-credentials',
      '-w',
    ]);
  });

  it('returns null on a keychain miss without ever calling the sync spawn', async () => {
    execFileMock.mockImplementationOnce(
      (_cmd, _args, _opts, cb: (err: Error | null) => void) => {
        cb(new Error('SecKeychainSearchCopyNext: not found'));
      },
    );
    const provider = new KeychainCredentialProvider();
    expect(await provider.readCredentials()).toBeNull();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});

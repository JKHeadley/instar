/**
 * Unit tests for NativeModuleHealer.invokeFromRemediator() — W-1.
 *
 * Covers SELF-HEALING-REMEDIATOR-V2-SPEC §A28 (supply-chain hygiene with
 * a scoped single-package rebuild + sha256 record), §A45 (prebuilt-first heal
 * with an --ignore-scripts from-source fallback — relaxed from the original
 * from-source-only stance so a node-ABI bump heals on a box without a C++
 * toolchain), §A57 (Tier-1 W-1 NativeModuleHealer wrapper).
 *
 * Strategy: real `NativeModuleHealer` singleton, mocked `spawnSync` (so we
 * never shell out to `npm rebuild`), mocked install-prefix / npm-path /
 * sha256 helpers (private methods accessed via `as unknown as` casts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import child_process from 'node:child_process';

import {
  NativeModuleHealer,
  type RemediatorInvocationContext,
} from '../../src/memory/NativeModuleHealer.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<RemediatorInvocationContext>): RemediatorInvocationContext {
  const ac = new AbortController();
  return {
    attemptId: overrides?.attemptId ?? 'test-attempt-id',
    runbookId: overrides?.runbookId ?? 'node-abi-mismatch',
    abortSignal: overrides?.abortSignal ?? ac.signal,
    monotonicDeadline:
      overrides?.monotonicDeadline ??
      process.hrtime.bigint() + 120_000_000_000n,
  };
}

/**
 * Stub the private helpers on the healer that touch the real disk / npm.
 * We do this by spying on the prototype-bag method names; since the healer
 * is a singleton with the class hidden behind `NativeModuleHealerImpl`, we
 * monkey-patch the instance directly.
 */
type HealerPrivate = {
  findBetterSqlite3InstallPrefix: () => string | null;
  findNpmPath: () => string | null;
  readPackageLockIntegrity: (
    prefix: string
  ) => { resolved: string; integrity: string } | null;
  computeBetterSqlite3BinarySha256: (prefix: string) => string | null;
  clearBetterSqlite3Cache: () => void;
  logHealEvent: (event: unknown) => void;
};

function stubHealer(opts: {
  installPrefix?: string | null;
  npmPath?: string | null;
  sha256?: string | null;
  integrity?: { resolved: string; integrity: string } | null;
}): { restore: () => void } {
  const h = NativeModuleHealer as unknown as HealerPrivate;
  const orig = {
    findBetterSqlite3InstallPrefix: h.findBetterSqlite3InstallPrefix,
    findNpmPath: h.findNpmPath,
    readPackageLockIntegrity: h.readPackageLockIntegrity,
    computeBetterSqlite3BinarySha256: h.computeBetterSqlite3BinarySha256,
    clearBetterSqlite3Cache: h.clearBetterSqlite3Cache,
    logHealEvent: h.logHealEvent,
  };
  h.findBetterSqlite3InstallPrefix = () =>
    opts.installPrefix === undefined ? '/fake/prefix' : opts.installPrefix;
  h.findNpmPath = () => (opts.npmPath === undefined ? '/fake/bin/npm' : opts.npmPath);
  h.readPackageLockIntegrity = () =>
    opts.integrity === undefined
      ? { resolved: 'https://example/better-sqlite3.tgz', integrity: 'sha512-abc' }
      : opts.integrity;
  h.computeBetterSqlite3BinarySha256 = () =>
    opts.sha256 === undefined ? 'deadbeef' : opts.sha256;
  h.clearBetterSqlite3Cache = () => {
    /* no-op for tests */
  };
  h.logHealEvent = () => {
    /* no-op — observability is not on the unit-test happy path */
  };
  return {
    restore: () => {
      Object.assign(h, orig);
    },
  };
}

describe('NativeModuleHealer.invokeFromRemediator', () => {
  let tmpDir: string;
  let stub: { restore: () => void };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoke-remediator-'));
    NativeModuleHealer.resetForTesting();
    NativeModuleHealer.configure({ stateDir: tmpDir });
  });

  afterEach(() => {
    stub?.restore();
    NativeModuleHealer.resetForTesting();
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/NativeModuleHealer-invokeFromRemediator.test.ts:cleanup',
    });
    vi.restoreAllMocks();
  });

  it('returns failure when ctx.abortSignal is already aborted', async () => {
    stub = stubHealer({});
    const ac = new AbortController();
    ac.abort();
    const result = await NativeModuleHealer.invokeFromRemediator(
      makeCtx({ abortSignal: ac.signal })
    );
    expect(result.outcome).toBe('failure');
    expect(result.details.reason).toBe('aborted-before-start');
  });

  it('returns failure when monotonicDeadline is already in the past', async () => {
    stub = stubHealer({});
    const ctx = makeCtx({
      monotonicDeadline: process.hrtime.bigint() - 1_000_000n,
    });
    const result = await NativeModuleHealer.invokeFromRemediator(ctx);
    expect(result.outcome).toBe('failure');
    expect(result.details.reason).toBe('deadline-already-elapsed');
  });

  it('returns failure when remaining budget is below 1s', async () => {
    stub = stubHealer({});
    const ctx = makeCtx({
      // 500 ms remaining — below the 1s floor.
      monotonicDeadline: process.hrtime.bigint() + 500_000_000n,
    });
    const result = await NativeModuleHealer.invokeFromRemediator(ctx);
    expect(result.outcome).toBe('failure');
    expect(result.details.reason).toBe('insufficient-deadline-budget');
  });

  it('prebuilt-first: a successful `npm install` heals without the from-source fallback (§A45 relaxed for healability)', async () => {
    stub = stubHealer({});
    const spawnSpy = vi.spyOn(child_process, 'spawnSync').mockReturnValue({
      status: 0,
      stdout: 'added 1 package',
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    } as never);

    const result = await NativeModuleHealer.invokeFromRemediator(makeCtx());
    expect(result.outcome).toBe('success');
    // First attempt is the PREBUILT install; it succeeded, so the from-source
    // fallback is never reached.
    expect(spawnSpy).toHaveBeenCalledOnce();

    const args = spawnSpy.mock.calls[0]![1] as string[];
    expect(args).toContain('install');
    expect(args).toContain('--no-save');
    expect(args.some((a) => a === 'better-sqlite3' || a.startsWith('better-sqlite3@'))).toBe(true);
    // The prebuilt attempt MUST run scripts — that is how prebuild-install
    // fetches the binary — so it is NOT --ignore-scripts.
    expect(args).not.toContain('--ignore-scripts');
    expect(args).not.toContain('--build-from-source');
  });

  it('falls back to from-source `--build-from-source --ignore-scripts` when the prebuilt install fails (§A28, §A45)', async () => {
    stub = stubHealer({});
    let call = 0;
    const spawnSpy = vi.spyOn(child_process, 'spawnSync').mockImplementation(() => {
      call += 1;
      // attempt 1 (prebuilt npm install) fails; attempt 2 (from-source rebuild) succeeds.
      return {
        status: call === 1 ? 1 : 0,
        stdout: '',
        stderr: call === 1 ? 'prebuild-install WARN install HTTP 404' : '',
        pid: 1,
        output: [],
        signal: null,
      } as never;
    });

    const result = await NativeModuleHealer.invokeFromRemediator(makeCtx());
    expect(result.outcome).toBe('success');
    expect(spawnSpy).toHaveBeenCalledTimes(2);

    // Attempt 1 = prebuilt install.
    const first = spawnSpy.mock.calls[0]![1] as string[];
    expect(first).toContain('install');
    // Attempt 2 = scoped from-source rebuild (§A28 single package, §A45 --ignore-scripts).
    const second = spawnSpy.mock.calls[1]![1] as string[];
    expect(second).toContain('rebuild');
    expect(second).toContain('--build-from-source');
    expect(second).toContain('--ignore-scripts');
    expect(second).toContain('better-sqlite3');
    // Never bare `npm rebuild` without the package name.
    expect(second.indexOf('better-sqlite3')).toBeGreaterThan(second.indexOf('rebuild'));
  });

  it('records sha256 of rebuilt binary in details (§A28)', async () => {
    stub = stubHealer({ sha256: 'cafebabe1234' });
    vi.spyOn(child_process, 'spawnSync').mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    } as never);

    const result = await NativeModuleHealer.invokeFromRemediator(makeCtx());
    expect(result.outcome).toBe('success');
    expect(result.details.rebuiltBinarySha256).toBe('cafebabe1234');
    expect(result.details.installPrefix).toBe('/fake/prefix');
  });

  it('returns failure with npmStatus on non-zero exit', async () => {
    stub = stubHealer({});
    vi.spyOn(child_process, 'spawnSync').mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'node-gyp error: missing python',
      pid: 1,
      output: [],
      signal: null,
    } as never);

    const result = await NativeModuleHealer.invokeFromRemediator(makeCtx());
    expect(result.outcome).toBe('failure');
    expect(result.details.npmStatus).toBe(1);
    expect(String(result.details.reason)).toMatch(/python/);
  });

  it('returns failure when better-sqlite3 install prefix is not found', async () => {
    stub = stubHealer({ installPrefix: null });
    const result = await NativeModuleHealer.invokeFromRemediator(makeCtx());
    expect(result.outcome).toBe('failure');
    expect(String(result.details.reason)).toMatch(/install prefix/);
  });

  it('returns failure when npm is not on PATH', async () => {
    stub = stubHealer({ npmPath: null });
    const result = await NativeModuleHealer.invokeFromRemediator(makeCtx());
    expect(result.outcome).toBe('failure');
    expect(String(result.details.reason)).toMatch(/npm not found/);
  });

  it('reports aborted when spawnSync throws an abort error', async () => {
    stub = stubHealer({});
    vi.spyOn(child_process, 'spawnSync').mockImplementation(() => {
      const err = new Error('AbortError') as Error & { name: string };
      err.name = 'AbortError';
      throw err;
    });
    const result = await NativeModuleHealer.invokeFromRemediator(makeCtx());
    expect(result.outcome).toBe('failure');
    expect(String(result.details.reason)).toMatch(/spawn failed/);
  });

  it('respects once-per-process guard — second invocation returns previousOutcome', async () => {
    stub = stubHealer({});
    vi.spyOn(child_process, 'spawnSync').mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    } as never);

    const first = await NativeModuleHealer.invokeFromRemediator(makeCtx());
    expect(first.outcome).toBe('success');

    const second = await NativeModuleHealer.invokeFromRemediator(makeCtx());
    expect(second.outcome).toBe('success');
    expect(second.details.reason).toBe('heal-already-attempted-this-process');
  });

  it('after a failed heal, second invocation surfaces previousOutcome.success=false', async () => {
    stub = stubHealer({ installPrefix: null });
    const first = await NativeModuleHealer.invokeFromRemediator(makeCtx());
    expect(first.outcome).toBe('failure');

    const second = await NativeModuleHealer.invokeFromRemediator(makeCtx());
    expect(second.outcome).toBe('failure');
    expect(second.details.reason).toBe('heal-already-attempted-this-process');
  });

  it('legacy openWithHeal entry point is unaffected (still callable)', async () => {
    // The legacy path is preserved per W-1's contract — passing a non-ABI
    // error rethrows immediately without touching the Remediator path.
    await expect(
      NativeModuleHealer.openWithHeal('legacy-component', () => {
        throw new Error('ENOENT: unrelated');
      })
    ).rejects.toThrow(/ENOENT/);
  });
});

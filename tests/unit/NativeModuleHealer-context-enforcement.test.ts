/**
 * Unit tests for NativeModuleHealer.invokeFromRemediator() §A3 capability-
 * token enforcement — F-8 rest of Tier-2.
 *
 * Covers SELF-HEALING-REMEDIATOR-V2-SPEC §A3 / §A23: surfaces that expose
 * `invokeFromRemediator(ctx)` MUST verify the `RemediationContext` HMAC at
 * entry. Invalid ctx → fall back to the in-line legacy path with a warning;
 * the legacy `openWithHeal` path stays working in either case.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import child_process from 'node:child_process';

import {
  NativeModuleHealer,
  type RemediatorInvocationContext,
  type InvocationContextKeyVault,
} from '../../src/memory/NativeModuleHealer.js';
import { signRemediationContext } from '../../src/remediation/RemediationContext.js';
import type { RemediationContext } from '../../src/remediation/Remediator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

class FakeKeyVault implements InvocationContextKeyVault {
  private readonly master = crypto.randomBytes(32);
  private readonly nonce = crypto.randomBytes(32);
  deriveLeafKey(context: 'capability', scopeId: string): Buffer {
    const info = Buffer.from(`${context}:${scopeId}`);
    return Buffer.from(crypto.hkdfSync('sha256', this.master, this.nonce, info, 32));
  }
}

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

function stubHealer(): { restore: () => void } {
  const h = NativeModuleHealer as unknown as HealerPrivate;
  const orig = {
    findBetterSqlite3InstallPrefix: h.findBetterSqlite3InstallPrefix,
    findNpmPath: h.findNpmPath,
    readPackageLockIntegrity: h.readPackageLockIntegrity,
    computeBetterSqlite3BinarySha256: h.computeBetterSqlite3BinarySha256,
    clearBetterSqlite3Cache: h.clearBetterSqlite3Cache,
    logHealEvent: h.logHealEvent,
  };
  h.findBetterSqlite3InstallPrefix = () => '/fake/prefix';
  h.findNpmPath = () => '/fake/bin/npm';
  h.readPackageLockIntegrity = () => null;
  h.computeBetterSqlite3BinarySha256 = () => 'fake-sha';
  h.clearBetterSqlite3Cache = () => {};
  h.logHealEvent = () => {};
  return {
    restore: () => {
      Object.assign(h, orig);
    },
  };
}

function makeSignedCtx(
  vault: FakeKeyVault,
  overrides?: Partial<RemediatorInvocationContext>,
): RemediatorInvocationContext {
  const runbookId = overrides?.runbookId ?? 'node-abi-mismatch';
  const attemptId = overrides?.attemptId ?? crypto.randomUUID();
  const expiresAt = Date.now() + 60_000;
  const monotonicDeadline =
    overrides?.monotonicDeadline ??
    process.hrtime.bigint() + 60_000_000_000n;
  const hmac = signRemediationContext(
    {
      attemptId,
      runbookId,
      expiresAt,
      monotonicDeadline,
    } as Pick<
      RemediationContext,
      'attemptId' | 'runbookId' | 'expiresAt' | 'monotonicDeadline'
    >,
    vault,
  );
  const ac = new AbortController();
  return {
    attemptId,
    runbookId,
    abortSignal: overrides?.abortSignal ?? ac.signal,
    monotonicDeadline,
    expiresAt,
    hmac,
  };
}

describe('NativeModuleHealer.invokeFromRemediator §A3 enforcement', () => {
  let tmpDir: string;
  let stub: { restore: () => void };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healer-ctx-'));
    NativeModuleHealer.resetForTesting();
    NativeModuleHealer.configure({ stateDir: tmpDir });
    stub = stubHealer();
  });

  afterEach(() => {
    stub.restore();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/NativeModuleHealer-context-enforcement.test.ts:cleanup',
    });
  });

  it('valid hmac → runs the Remediator path', async () => {
    const spawnSpy = vi
      .spyOn(child_process, 'spawnSync')
      .mockReturnValue({
        status: 0,
        stdout: '',
        stderr: '',
        pid: 1,
        output: [],
        signal: null,
      } as unknown as ReturnType<typeof child_process.spawnSync>);

    const vault = new FakeKeyVault();
    const ctx = makeSignedCtx(vault);
    const result = await NativeModuleHealer.invokeFromRemediator(ctx, vault);

    expect(result.outcome).toBe('success');
    expect(result.details.invalidContext).toBeUndefined();
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it('forged hmac → falls back to in-line heal + flags invalidContext', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Suppress noisy stderr logs from the legacy heal path.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const vault = new FakeKeyVault();
    const ctx = makeSignedCtx(vault);
    // Tamper the hmac AFTER signing.
    ctx.hmac = crypto.randomBytes(32);

    const result = await NativeModuleHealer.invokeFromRemediator(ctx, vault);

    // Fallback path runs the legacy heal, which uses the bound `spawnSync`
    // import (not `child_process.spawnSync`) — tests can't easily mock that
    // without rewriting the module. What we DO assert:
    //   1. `invalidContext: true` shows the §A3 verification rejected the ctx,
    //   2. `fallbackPath` confirms the fall-back route was taken,
    //   3. The §A3 warning fires.
    // The rebuild's outcome (success/failure depending on test environment)
    // is asserted by the legacy-path tests in NativeModuleHealer.test.ts.
    expect(result.details.invalidContext).toBe(true);
    expect(result.details.fallbackPath).toBe('in-line-openWithHeal-heal-step');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('remediation.surface.invalid-context'),
    );
  });

  it('forged hmac + aborted signal → fallback short-circuits with aborted reason', async () => {
    const ac = new AbortController();
    ac.abort();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const vault = new FakeKeyVault();
    const ctx = makeSignedCtx(vault, { abortSignal: ac.signal });
    ctx.hmac = crypto.randomBytes(32);

    const result = await NativeModuleHealer.invokeFromRemediator(ctx, vault);

    expect(result.outcome).toBe('failure');
    expect(result.details.invalidContext).toBe(true);
    expect(result.details.reason).toBe('aborted-before-fallback');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('no keyVault wired → §A3 verification skipped (legacy backward-compat)', async () => {
    vi.spyOn(child_process, 'spawnSync').mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    } as unknown as ReturnType<typeof child_process.spawnSync>);

    // The keyVault arg is optional; existing W-1 callers don't pass it.
    const ac = new AbortController();
    const result = await NativeModuleHealer.invokeFromRemediator({
      attemptId: 'legacy-no-vault',
      runbookId: 'node-abi-mismatch',
      abortSignal: ac.signal,
      monotonicDeadline: process.hrtime.bigint() + 60_000_000_000n,
    });

    expect(result.outcome).toBe('success');
    expect(result.details.invalidContext).toBeUndefined();
  });
});

/**
 * Unit tests for `ServerSupervisor.invokeFromRemediator` (W-2).
 *
 * Covers SELF-HEALING-REMEDIATOR-V2-SPEC §A3 (capability-token verify at
 * surface entry), §A4 (deadline / abort-signal behavior), §A23 (replay
 * defense), §A34 (single-runbook composition of the six in-line heal
 * steps).
 *
 * Strategy: mock node:child_process so the preflightSelfHeal body is
 * cheap and deterministic. We don't need to exercise every heal step
 * here — that's covered by `server-supervisor-preflight.test.ts`. We
 * verify the entry-point wrapper: invalid ctx is fail-closed (no
 * preflight side-effect), valid ctx runs the body, aborted signal is
 * honoured.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawnSync: vi.fn(() => ({
      stdout: '',
      stderr: '',
      status: 0,
      signal: null,
      pid: 0,
      output: [],
    })),
    execFileSync: vi.fn(() => ''),
  };
});

vi.mock('../../src/core/Config.js', () => ({
  detectTmuxPath: () => '/usr/bin/tmux',
}));

vi.mock('../../src/core/SleepWakeDetector.js', () => ({
  SleepWakeDetector: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    on: vi.fn(),
  })),
}));

import { ServerSupervisor } from '../../src/lifeline/ServerSupervisor.js';
import type { SupervisorRemediatorInvocationContext } from '../../src/lifeline/ServerSupervisor.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function createTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2-supervisor-'));
  fs.mkdirSync(path.join(dir, '.instar', 'state'), { recursive: true });
  return dir;
}

interface CapabilityKeyVault {
  deriveLeafKey(context: 'capability', scopeId: string): Buffer;
}

function makeKeyVault(): CapabilityKeyVault {
  const master = crypto.randomBytes(32);
  return {
    deriveLeafKey(context: 'capability', scopeId: string): Buffer {
      const info = Buffer.from(`${context}:${scopeId ?? ''}`);
      return Buffer.from(
        crypto.hkdfSync(
          'sha256',
          master,
          Buffer.alloc(0),
          info,
          32,
        ),
      );
    },
  };
}

function signCtx(
  runbookId: string,
  attemptId: string,
  expiresAt: number,
  monotonicDeadline: bigint,
  keyVault: CapabilityKeyVault,
): Buffer {
  const HMAC_TAG = Buffer.from('instar-f8-ctx-v1\x00', 'utf-8');
  const writeStr = (s: string): Buffer => {
    const body = Buffer.from(s, 'utf-8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    return Buffer.concat([len, body]);
  };
  const expiresAtBuf = Buffer.alloc(8);
  expiresAtBuf.writeBigUInt64BE(
    BigInt(Math.max(0, Math.floor(expiresAt))),
    0,
  );
  const monoBuf = Buffer.alloc(8);
  const mono = monotonicDeadline >= 0n ? monotonicDeadline : 0n;
  monoBuf.writeBigUInt64BE(mono, 0);
  const body = Buffer.concat([
    HMAC_TAG,
    writeStr(attemptId),
    writeStr(runbookId),
    expiresAtBuf,
    monoBuf,
  ]);
  const leaf = keyVault.deriveLeafKey('capability', runbookId);
  return crypto.createHmac('sha256', leaf).update(body).digest();
}

function makeCtx(opts: {
  runbookId?: string;
  attemptId?: string;
  hmac?: Buffer;
  abortSignal?: AbortSignal;
  monotonicDeadline?: bigint;
  expiresAt?: number;
}): SupervisorRemediatorInvocationContext {
  return {
    attemptId: opts.attemptId ?? 'test-attempt',
    runbookId: opts.runbookId ?? 'supervisor-preflight',
    abortSignal: opts.abortSignal ?? new AbortController().signal,
    monotonicDeadline:
      opts.monotonicDeadline ?? process.hrtime.bigint() + 180_000_000_000n,
    expiresAt: opts.expiresAt ?? Date.now() + 180_000,
    hmac: opts.hmac,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('ServerSupervisor.invokeFromRemediator (W-2)', () => {
  let tmpDir: string;
  let supervisor: ServerSupervisor;

  beforeEach(() => {
    tmpDir = createTmpDir();
    supervisor = new ServerSupervisor({
      projectDir: tmpDir,
      projectName: 'test-agent',
      port: 9999,
      stateDir: path.join(tmpDir, '.instar'),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      SafeFsExecutor.safeRmSync(tmpDir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/ServerSupervisor-invokeFromRemediator.test.ts:after',
      });
    } catch {
      /* best-effort */
    }
  });

  it('valid ctx → preflightSelfHeal logic runs and returns success result', async () => {
    // No keyVault → no HMAC verification, ctx valid by default.
    const preflightSpy = vi.spyOn(supervisor as never, 'preflightSelfHeal')
      .mockReturnValue('node symlink repaired, stuck git rebase aborted' as never);

    const ctx = makeCtx({});
    const result = await supervisor.invokeFromRemediator(ctx);

    expect(result.outcome).toBe('success');
    expect(preflightSpy).toHaveBeenCalledOnce();
    expect(result.details.anyHealed).toBe(true);
    expect(result.details.healed).toMatch(/node symlink|git rebase/);
    expect(result.details.attemptId).toBe(ctx.attemptId);
  });

  it('valid ctx with no actual healing needed → success + anyHealed=false', async () => {
    const preflightSpy = vi.spyOn(supervisor as never, 'preflightSelfHeal')
      .mockReturnValue('' as never);

    const ctx = makeCtx({});
    const result = await supervisor.invokeFromRemediator(ctx);

    expect(result.outcome).toBe('success');
    expect(preflightSpy).toHaveBeenCalledOnce();
    expect(result.details.anyHealed).toBe(false);
    expect(result.details.healed).toBe('');
  });

  it('forged ctx → returns error, falls back (no preflight side-effect)', async () => {
    const preflightSpy = vi.spyOn(supervisor as never, 'preflightSelfHeal');

    const keyVault = makeKeyVault();
    // Provide a ctx with a forged HMAC (random bytes instead of real signature).
    const ctx = makeCtx({
      hmac: crypto.randomBytes(32),
    });

    const result = await supervisor.invokeFromRemediator(ctx, keyVault);

    expect(result.outcome).toBe('failure');
    expect(result.details.invalidContext).toBe(true);
    expect(result.details.reason).toBe('invalid-context');
    // CRITICAL: preflightSelfHeal MUST NOT have been called.
    expect(preflightSpy).not.toHaveBeenCalled();
  });

  it('valid HMAC ctx with keyVault → preflightSelfHeal runs', async () => {
    const preflightSpy = vi.spyOn(supervisor as never, 'preflightSelfHeal')
      .mockReturnValue('shadow install restored' as never);

    const keyVault = makeKeyVault();
    const runbookId = 'supervisor-preflight';
    const attemptId = 'attempt-123';
    const expiresAt = Date.now() + 180_000;
    const monotonicDeadline = process.hrtime.bigint() + 180_000_000_000n;
    const hmac = signCtx(
      runbookId,
      attemptId,
      expiresAt,
      monotonicDeadline,
      keyVault,
    );
    const ctx = makeCtx({
      runbookId,
      attemptId,
      expiresAt,
      monotonicDeadline,
      hmac,
    });

    const result = await supervisor.invokeFromRemediator(ctx, keyVault);

    expect(result.outcome).toBe('success');
    expect(preflightSpy).toHaveBeenCalledOnce();
  });

  it('aborted signal at entry stops mid-step before any side-effect', async () => {
    const preflightSpy = vi.spyOn(supervisor as never, 'preflightSelfHeal');

    const controller = new AbortController();
    controller.abort();
    const ctx = makeCtx({ abortSignal: controller.signal });

    const result = await supervisor.invokeFromRemediator(ctx);

    expect(result.outcome).toBe('failure');
    expect(result.details.reason).toBe('aborted-before-start');
    expect(preflightSpy).not.toHaveBeenCalled();
  });

  it('deadline already elapsed → failure (no preflight)', async () => {
    const preflightSpy = vi.spyOn(supervisor as never, 'preflightSelfHeal');

    const ctx = makeCtx({
      monotonicDeadline: 1n, // far in the past
    });

    const result = await supervisor.invokeFromRemediator(ctx);

    expect(result.outcome).toBe('failure');
    expect(result.details.reason).toBe('deadline-already-elapsed');
    expect(preflightSpy).not.toHaveBeenCalled();
  });

  it('mid-step abort surfaces as aborted-mid-step with partial summary', async () => {
    const controller = new AbortController();
    vi.spyOn(supervisor as never, 'preflightSelfHeal').mockImplementation(
      (() => {
        controller.abort();
        return 'shadow install restored';
      }) as never,
    );

    const ctx = makeCtx({ abortSignal: controller.signal });
    const result = await supervisor.invokeFromRemediator(ctx);

    expect(result.outcome).toBe('failure');
    expect(result.details.reason).toBe('aborted-mid-step');
    expect(result.details.partialSummary).toBe('shadow install restored');
  });

  it('preflight throws → failure with preflight-threw reason', async () => {
    vi.spyOn(supervisor as never, 'preflightSelfHeal').mockImplementation(
      (() => {
        throw new Error('synthetic preflight crash');
      }) as never,
    );

    const ctx = makeCtx({});
    const result = await supervisor.invokeFromRemediator(ctx);

    expect(result.outcome).toBe('failure');
    expect((result.details.reason as string)).toMatch(
      /preflight-threw.*synthetic preflight crash/,
    );
  });

  it('keyVault provided but ctx.hmac absent → skips verification (legacy compatible)', async () => {
    const preflightSpy = vi.spyOn(supervisor as never, 'preflightSelfHeal')
      .mockReturnValue('' as never);

    const keyVault = makeKeyVault();
    // No hmac on the ctx — verification is skipped per the contract
    // (matches NativeModuleHealer.invokeFromRemediator behavior).
    const ctx = makeCtx({});

    const result = await supervisor.invokeFromRemediator(ctx, keyVault);

    expect(result.outcome).toBe('success');
    expect(preflightSpy).toHaveBeenCalledOnce();
  });

  it('keyVault derivation throws → fail-closed (invalid-context, no preflight)', async () => {
    const preflightSpy = vi.spyOn(supervisor as never, 'preflightSelfHeal');

    const throwingVault = {
      deriveLeafKey() {
        throw new Error('keyVault unavailable');
      },
    };
    const ctx = makeCtx({
      hmac: crypto.randomBytes(32),
    });

    const result = await supervisor.invokeFromRemediator(
      ctx,
      throwingVault as never,
    );

    expect(result.outcome).toBe('failure');
    expect(result.details.reason).toBe('invalid-context');
    expect(preflightSpy).not.toHaveBeenCalled();
  });

  it('no stateDir → failure (the supervisor cannot heal without it)', async () => {
    const noStateSupervisor = new ServerSupervisor({
      projectDir: tmpDir,
      projectName: 'test-no-state',
      port: 9998,
      // stateDir omitted
    });
    const preflightSpy = vi.spyOn(noStateSupervisor as never, 'preflightSelfHeal');

    const ctx = makeCtx({});
    const result = await noStateSupervisor.invokeFromRemediator(ctx);

    expect(result.outcome).toBe('failure');
    expect(result.details.reason).toBe('no-state-dir');
    expect(preflightSpy).not.toHaveBeenCalled();
  });
});

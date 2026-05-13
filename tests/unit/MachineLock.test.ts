/**
 * Unit tests for MachineLock — in-flight lock primitive for the Remediator.
 *
 * Covers SELF-HEALING-REMEDIATOR-V2-SPEC §A2 / A24 / A29 / A43 / A46 / A63.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MachineLock } from '../../src/remediation/MachineLock.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function makeSignerPair(): {
  signer: (payload: Buffer) => Buffer;
  verifier: (payload: Buffer, signature: Buffer) => boolean;
} {
  const key = crypto.randomBytes(32);
  return {
    signer: (payload) => {
      const h = crypto.createHmac('sha256', key);
      h.update(payload);
      return h.digest();
    },
    verifier: (payload, signature) => {
      const h = crypto.createHmac('sha256', key);
      h.update(payload);
      const expected = h.digest();
      if (expected.length !== signature.length) return false;
      return crypto.timingSafeEqual(expected, signature);
    },
  };
}

describe('MachineLock', () => {
  let tmpDir: string;
  let lock: MachineLock;
  let signerPair: ReturnType<typeof makeSignerPair>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-lock-'));
    lock = new MachineLock(tmpDir);
    signerPair = makeSignerPair();
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/MachineLock.test.ts:afterEach',
    });
  });

  it('acquireInFlight writes a verifiable lock file', async () => {
    const handle = await lock.acquireInFlight({
      surfaceId: 'memory-healer',
      attemptId: 'attempt-001',
      tupleHash: 'tuple-aaa',
      expectedRuntimeMs: 30_000,
      signer: signerPair.signer,
      verifier: signerPair.verifier,
    });
    expect(handle.attemptId).toBe('attempt-001');
    const lockPath = path.join(tmpDir, 'machine-locks', 'in-flight', 'tuple-aaa.lock');
    expect(fs.existsSync(lockPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    expect(parsed.surfaceId).toBe('memory-healer');
    expect(parsed.heartbeatSeq).toBe(0);
    expect(typeof parsed.hmac).toBe('string');
    expect(parsed.hmac.length).toBeGreaterThan(0);

    // listInFlight should return it.
    const listed = await lock.listInFlight(signerPair.verifier);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.attemptId).toBe('attempt-001');

    await handle.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('throws when re-acquiring an active tupleHash', async () => {
    await lock.acquireInFlight({
      surfaceId: 'memory-healer',
      attemptId: 'attempt-001',
      tupleHash: 'tuple-aaa',
      expectedRuntimeMs: 60_000,
      signer: signerPair.signer,
      verifier: signerPair.verifier,
    });
    await expect(
      lock.acquireInFlight({
        surfaceId: 'memory-healer',
        attemptId: 'attempt-002',
        tupleHash: 'tuple-aaa',
        expectedRuntimeMs: 60_000,
        signer: signerPair.signer,
        verifier: signerPair.verifier,
      })
    ).rejects.toThrow(/already in-flight/);
  });

  it('listInFlight silently ignores forged (bad-HMAC) lockfiles', async () => {
    const lockDir = path.join(tmpDir, 'machine-locks', 'in-flight');
    fs.mkdirSync(lockDir, { recursive: true });
    const forged = {
      surfaceId: 'attacker',
      attemptId: 'forged-001',
      tupleHash: 'forged-tuple',
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
      heartbeatSeq: 0,
      expectedRuntimeMs: 30_000,
      heartbeatIntervalMs: 5_000,
      hmac: Buffer.from('not-a-real-hmac').toString('base64'),
    };
    fs.writeFileSync(path.join(lockDir, 'forged-tuple.lock'), JSON.stringify(forged));
    const listed = await lock.listInFlight(signerPair.verifier);
    expect(listed).toHaveLength(0);
  });

  it('heartbeat advances heartbeatSeq and heartbeatAt', async () => {
    const handle = await lock.acquireInFlight({
      surfaceId: 'memory-healer',
      attemptId: 'attempt-001',
      tupleHash: 'tuple-bbb',
      expectedRuntimeMs: 30_000,
      heartbeatIntervalMs: 100,
      signer: signerPair.signer,
      verifier: signerPair.verifier,
    });
    const lockPath = path.join(tmpDir, 'machine-locks', 'in-flight', 'tuple-bbb.lock');
    const before = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    await new Promise((r) => setTimeout(r, 10));
    await handle.heartbeat();
    const after = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    expect(after.heartbeatSeq).toBe(before.heartbeatSeq + 1);
    expect(after.heartbeatAt).toBeGreaterThanOrEqual(before.heartbeatAt);
    // HMAC must still verify after re-sign.
    const listed = await lock.listInFlight(signerPair.verifier);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.heartbeatSeq).toBe(1);
  });

  it('reclaims stale locks (heartbeat + runtime grace, A63) into orphaned/', async () => {
    // Hand-craft a stale lockfile directly.
    const lockDir = path.join(tmpDir, 'machine-locks', 'in-flight');
    const orphanedDir = path.join(tmpDir, 'machine-locks', 'orphaned');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.mkdirSync(orphanedDir, { recursive: true });
    const long = 10_000;
    const env = {
      surfaceId: 'memory-healer',
      attemptId: 'dead-attempt',
      tupleHash: 'tuple-ccc',
      startedAt: Date.now() - long * 10, // way over expectedRuntimeMs × 1.5
      heartbeatAt: Date.now() - long * 10, // way over heartbeatIntervalMs × 3
      heartbeatSeq: 5,
      expectedRuntimeMs: long,
      heartbeatIntervalMs: 100,
    };
    // Sign the envelope correctly so the verifier accepts it.
    const canonical = canonicalJsonForTest(env);
    const sig = signerPair.signer(Buffer.from(canonical, 'utf8'));
    fs.writeFileSync(
      path.join(lockDir, 'tuple-ccc.lock'),
      JSON.stringify({ ...env, hmac: sig.toString('base64') })
    );

    // Stale should be reported by listInFlight.
    const listed = await lock.listInFlight(signerPair.verifier);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.isStale).toBe(true);

    // Acquiring the same tuple should reclaim the stale lock into orphaned/.
    await lock.acquireInFlight({
      surfaceId: 'memory-healer',
      attemptId: 'fresh-attempt',
      tupleHash: 'tuple-ccc',
      expectedRuntimeMs: long,
      heartbeatIntervalMs: 100,
      signer: signerPair.signer,
      verifier: signerPair.verifier,
    });

    const orphans = fs.readdirSync(orphanedDir);
    expect(orphans.length).toBeGreaterThanOrEqual(1);
    expect(orphans.some((f) => f.startsWith('tuple-ccc-'))).toBe(true);

    const stillInFlight = fs.readFileSync(
      path.join(lockDir, 'tuple-ccc.lock'),
      'utf8'
    );
    const parsed = JSON.parse(stillInFlight);
    expect(parsed.attemptId).toBe('fresh-attempt');
  });

  it('cache invalidates on mtime/inode divergence (A46)', async () => {
    const handle = await lock.acquireInFlight({
      surfaceId: 'memory-healer',
      attemptId: 'attempt-aaa',
      tupleHash: 'tuple-ddd',
      expectedRuntimeMs: 60_000,
      heartbeatIntervalMs: 100,
      signer: signerPair.signer,
      verifier: signerPair.verifier,
    });
    const lockPath = path.join(tmpDir, 'machine-locks', 'in-flight', 'tuple-ddd.lock');

    // First read populates cache.
    let listed = await lock.listInFlight(signerPair.verifier);
    expect(listed[0]?.attemptId).toBe('attempt-aaa');

    // Out-of-band rewrite: replace lockfile with a different (signed) envelope.
    const newEnv = {
      surfaceId: 'memory-healer',
      attemptId: 'attempt-bbb',
      tupleHash: 'tuple-ddd',
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
      heartbeatSeq: 99,
      expectedRuntimeMs: 60_000,
      heartbeatIntervalMs: 100,
    };
    const canonical = canonicalJsonForTest(newEnv);
    const sig = signerPair.signer(Buffer.from(canonical, 'utf8'));
    // Wait long enough that mtimeMs definitively changes on all filesystems.
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ ...newEnv, hmac: sig.toString('base64') })
    );

    listed = await lock.listInFlight(signerPair.verifier);
    expect(listed[0]?.attemptId).toBe('attempt-bbb');
    expect(listed[0]?.heartbeatSeq).toBe(99);
    await handle.release();
  });
});

/** Mirror of MachineLock's canonicalJson — sorted keys, no whitespace. */
function canonicalJsonForTest(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    parts.push(`${JSON.stringify(k)}:${JSON.stringify(v)}`);
  }
  return `{${parts.join(',')}}`;
}

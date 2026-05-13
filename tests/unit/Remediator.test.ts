/**
 * Unit tests for Remediator — Tier-1 orchestrator skeleton.
 *
 * Covers SELF-HEALING-REMEDIATOR-V2-SPEC §A2, §A4, §A6, §A21, §A36, §A57.
 *
 * Strategy: use real tmpdir-backed `MachineLock`, `IntentJournal`, and
 * `AuditWriter` instances for integration realism (F-4 primitives are cheap
 * to instantiate and the cleanup is bounded by tmpdir).
 *
 * `RemediationKeyVault` is mocked via a minimal interface-compatible stub so
 * the tests don't hit the OS keychain. The mock derives deterministic leaf
 * keys via HKDF over a fixed in-memory master, mirroring F-1's contract.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  Remediator,
  type ApprovedRunbook,
  type RemediationContext,
  type VerifyOutcome,
} from '../../src/remediation/Remediator.js';
import type { NormalizedDegradationEvent } from '../../src/monitoring/DegradationReporter.js';
import { MachineLock } from '../../src/remediation/MachineLock.js';
import { IntentJournal } from '../../src/remediation/IntentJournal.js';
import {
  AuditWriter,
  deserializeAuditEntry,
  type AuditEntry,
} from '../../src/remediation/audit/AuditWriter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// ── Mocks / fakes ────────────────────────────────────────────────────────

/**
 * Minimal RemediationKeyVault stub. Derives one leaf per (context, scopeId)
 * via HKDF over a fixed in-memory master + nonce. Same shape as F-1's
 * `deriveLeafKey` but no keychain dependency.
 */
class FakeKeyVault {
  private readonly master = crypto.randomBytes(32);
  private readonly nonce = crypto.randomBytes(32);
  deriveLeafKey(context: string, scopeId: string | null): Buffer {
    const info = Buffer.from(`${context}:${scopeId ?? ''}`);
    return Buffer.from(crypto.hkdfSync('sha256', this.master, this.nonce, info, 32));
  }
}

function makeSignerPair(): {
  signer: (payload: Buffer) => Buffer;
  verifier: (payload: Buffer, signature: Buffer) => boolean;
} {
  const key = crypto.randomBytes(32);
  return {
    signer: (payload) =>
      crypto.createHmac('sha256', key).update(payload).digest(),
    verifier: (payload, signature) => {
      const expected = crypto
        .createHmac('sha256', key)
        .update(payload)
        .digest();
      if (expected.length !== signature.length) return false;
      return crypto.timingSafeEqual(expected, signature);
    },
  };
}

/**
 * AuditWriter token-verifier that accepts any non-empty buffer. Forged-token
 * tests inject a strict verifier that requires a specific magic prefix.
 */
function permissiveTokenVerifier(): (e: AuditEntry) => boolean {
  return (e) => e.auditToken.length > 0;
}

function makeEvent(
  overrides?: Partial<NormalizedDegradationEvent>
): NormalizedDegradationEvent {
  return {
    subsystem: overrides?.subsystem ?? 'memory',
    errorCode: overrides?.errorCode ?? 'NATIVE_MODULE_ABI_MISMATCH',
    provenance: overrides?.provenance ?? 'native-binding',
    reason: overrides?.reason ?? {
      redacted: 'native module ABI mismatch (redacted)',
      full: 'native module ABI mismatch for better-sqlite3 against Node 127',
    },
    timestamp: overrides?.timestamp ?? new Date().toISOString(),
    monotonicTs: overrides?.monotonicTs ?? performance.now(),
  };
}

function makeRunbook(overrides?: Partial<ApprovedRunbook>): ApprovedRunbook {
  return {
    id: overrides?.id ?? 'node-abi-mismatch',
    priority: overrides?.priority ?? 10,
    surface: overrides?.surface ?? 'native-module-healer',
    eventPrefilter: overrides?.eventPrefilter ?? {
      errorCode: ['NATIVE_MODULE_ABI_MISMATCH'],
      provenance: ['native-binding'],
    },
    match: overrides?.match ?? (() => true),
    preconditions: overrides?.preconditions ?? (async () => true),
    surfaceCallable:
      overrides?.surfaceCallable ??
      (async () => ({ outcome: 'success', details: {} })),
    verify:
      overrides?.verify ??
      (async () => ({
        outcome: 'verified-healthy',
        reason: 'health check returned ok',
      })),
    blastRadius: overrides?.blastRadius ?? 'process',
    reversibility: overrides?.reversibility ?? 'reversible',
    expectedRuntimeMs: overrides?.expectedRuntimeMs ?? 1_000,
    essential: overrides?.essential,
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────

interface Fixture {
  tmpDir: string;
  remediator: Remediator;
  machineLock: MachineLock;
  intentJournal: IntentJournal;
  auditWriter: AuditWriter;
  keyVault: FakeKeyVault;
  signerPair: ReturnType<typeof makeSignerPair>;
  machineId: string;
}

function makeFixture(opts?: {
  tokenVerifier?: (e: AuditEntry) => boolean;
}): Fixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remediator-'));
  const machineId = 'm-test';
  const machineLock = new MachineLock(tmpDir);
  const intentJournal = new IntentJournal(tmpDir, { machineId });
  const auditWriter = new AuditWriter(tmpDir, {
    machineId,
    tokenVerifier: opts?.tokenVerifier ?? permissiveTokenVerifier(),
  });
  const keyVault = new FakeKeyVault();
  const signerPair = makeSignerPair();
  const remediator = new Remediator({
    stateDir: tmpDir,
    // FakeKeyVault duck-types RemediationKeyVault's deriveLeafKey.
    keyVault: keyVault as unknown as Parameters<
      typeof Remediator.prototype.constructor
    >[0]['keyVault'],
    machineLock,
    intentJournal,
    auditWriter,
    lockSigner: signerPair.signer,
    lockVerifier: signerPair.verifier,
  });
  return {
    tmpDir,
    remediator,
    machineLock,
    intentJournal,
    auditWriter,
    keyVault,
    signerPair,
    machineId,
  };
}

function cleanup(fx: Fixture): void {
  SafeFsExecutor.safeRmSync(fx.tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/Remediator.test.ts:cleanup',
  });
}

function readProjection(tmpDir: string, machineId: string): AuditEntry[] {
  const p = path.join(
    tmpDir,
    'remediation',
    `audit-projection-${machineId}.jsonl`
  );
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(deserializeAuditEntry);
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Remediator', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    cleanup(fx);
  });

  it('registers a valid runbook', () => {
    expect(() => fx.remediator.registerRunbook(makeRunbook())).not.toThrow();
  });

  it('rejects a runbook whose prefilter includes provenance "free-text" (§A6)', () => {
    expect(() =>
      fx.remediator.registerRunbook(
        makeRunbook({
          id: 'bad-freetext',
          eventPrefilter: {
            errorCode: [],
            provenance: ['free-text'],
          },
        })
      )
    ).toThrow(/free-text/);
  });

  it('rejects essential=true when blastRadius !== "machine" (§A36)', () => {
    expect(() =>
      fx.remediator.registerRunbook(
        makeRunbook({
          id: 'bad-essential',
          essential: true,
          blastRadius: 'process',
        })
      )
    ).toThrow(/essential/);
    // essential + machine OK
    expect(() =>
      fx.remediator.registerRunbook(
        makeRunbook({
          id: 'ok-essential',
          essential: true,
          blastRadius: 'machine',
        })
      )
    ).not.toThrow();
  });

  it('dispatch with no matching runbook → "no-matching-runbook" + audit entry', async () => {
    // No runbooks registered.
    const result = await fx.remediator.dispatch(makeEvent());
    expect(result).toEqual({ outcome: 'no-matching-runbook' });

    const entries = readProjection(fx.tmpDir, fx.machineId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.outcome).toBe('no-matching-runbook');
  });

  it('dispatch with matching runbook → lock + intent + surfaceCallable + verify + release', async () => {
    let surfaceCalled = false;
    let verifyCalled = false;
    let ctxSeen: RemediationContext | null = null;
    fx.remediator.registerRunbook(
      makeRunbook({
        surfaceCallable: async (ctx) => {
          surfaceCalled = true;
          ctxSeen = ctx;
          return { outcome: 'success', details: {} };
        },
        verify: async () => {
          verifyCalled = true;
          return { outcome: 'verified-healthy', reason: 'ok' };
        },
      })
    );

    const result = await fx.remediator.dispatch(makeEvent());
    expect(result.outcome).toBe('verified-healthy');
    expect(surfaceCalled).toBe(true);
    expect(verifyCalled).toBe(true);
    expect(ctxSeen).not.toBeNull();
    expect(ctxSeen!.attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ctxSeen!.runbookId).toBe('node-abi-mismatch');
    expect(ctxSeen!.auditToken.length).toBeGreaterThan(0);

    // Lock should be released by now.
    const lockDir = path.join(fx.tmpDir, 'machine-locks', 'in-flight');
    expect(
      fs.existsSync(lockDir) ? fs.readdirSync(lockDir) : []
    ).toEqual([]);

    // Intent journal contains one entry.
    const intents = await fx.intentJournal.readSince(0);
    expect(intents).toHaveLength(1);
    expect(intents[0]!.intent).toBe('dispatch');
    expect(intents[0]!.runbookId).toBe('node-abi-mismatch');

    // Audit projection contains started + verified-healthy.
    const entries = readProjection(fx.tmpDir, fx.machineId);
    expect(entries.map((e) => e.outcome)).toEqual([
      'started',
      'verified-healthy',
    ]);
  });

  it('dispatch with existing in-flight lock for same tuple → "covered-by-inline" (§A2)', async () => {
    fx.remediator.registerRunbook(makeRunbook());

    // Pre-seed an in-flight lock with the same tupleHash the dispatcher
    // will compute. tupleHash = sha256(`${runbookId}:${signatureHash}`)
    // where signatureHash = sha256(JSON.stringify([subsystem, errorCode, provenance])).
    const ev = makeEvent();
    const signatureHash = crypto
      .createHash('sha256')
      .update(JSON.stringify([ev.subsystem, ev.errorCode, ev.provenance]))
      .digest('hex');
    const tupleHash = crypto
      .createHash('sha256')
      .update(`node-abi-mismatch:${signatureHash}`)
      .digest('hex');

    const preHandle = await fx.machineLock.acquireInFlight({
      surfaceId: 'native-module-healer',
      attemptId: 'pre-existing-attempt-xyz',
      tupleHash,
      expectedRuntimeMs: 60_000,
      signer: fx.signerPair.signer,
      verifier: fx.signerPair.verifier,
    });

    const result = await fx.remediator.dispatch(ev);
    expect(result.outcome).toBe('covered-by-inline');
    if (result.outcome === 'covered-by-inline') {
      expect(result.existingAttemptId).toBe('pre-existing-attempt-xyz');
    }

    await preHandle.release();
  });

  it('surfaceCallable that hangs past expectedRuntimeMs → "aborted-deadline" + lock released (§A4)', async () => {
    fx.remediator.registerRunbook(
      makeRunbook({
        expectedRuntimeMs: 50,
        surfaceCallable: (ctx) =>
          new Promise((resolve, reject) => {
            ctx.abortSignal.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
            // Otherwise never resolves.
          }),
      })
    );

    const result = await fx.remediator.dispatch(makeEvent());
    expect(result.outcome).toBe('aborted-deadline');

    // Lock released.
    const lockDir = path.join(fx.tmpDir, 'machine-locks', 'in-flight');
    expect(
      fs.existsSync(lockDir) ? fs.readdirSync(lockDir) : []
    ).toEqual([]);

    const entries = readProjection(fx.tmpDir, fx.machineId);
    const outcomes = entries.map((e) => e.outcome);
    expect(outcomes).toContain('started');
    expect(outcomes).toContain('aborted-deadline');
  });

  it('surfaceCallable failure → verify NEVER called + audit shows verify-failed', async () => {
    let verifyCalled = false;
    fx.remediator.registerRunbook(
      makeRunbook({
        surfaceCallable: async () => ({
          outcome: 'failure',
          details: { reason: 'rebuild exited 1' },
        }),
        verify: async () => {
          verifyCalled = true;
          return { outcome: 'verified-healthy', reason: 'should not be reached' };
        },
      })
    );

    const result = await fx.remediator.dispatch(makeEvent());
    expect(result.outcome).toBe('verify-failed');
    expect(verifyCalled).toBe(false);

    const entries = readProjection(fx.tmpDir, fx.machineId);
    const outcomes = entries.map((e) => e.outcome);
    expect(outcomes).toEqual(['started', 'verify-failed']);
  });

  it('verify-inconclusive (probe error per §A21) is distinct from verify-failed', async () => {
    fx.remediator.registerRunbook(
      makeRunbook({
        id: 'inconclusive-rb',
        eventPrefilter: {
          errorCode: ['NATIVE_MODULE_ABI_MISMATCH'],
          provenance: ['native-binding'],
        },
        verify: async (): Promise<VerifyOutcome> => ({
          outcome: 'verify-inconclusive',
          reason: 'probe returned ambiguous payload',
        }),
      })
    );

    const result = await fx.remediator.dispatch(makeEvent());
    expect(result.outcome).toBe('verify-inconclusive');

    const entries = readProjection(fx.tmpDir, fx.machineId);
    const last = entries[entries.length - 1]!;
    expect(last.outcome).toBe('verify-inconclusive');
    expect(last.outcome).not.toBe('verify-failed');
  });

  it('verify that THROWS (probe error) → verify-inconclusive (§A21)', async () => {
    fx.remediator.registerRunbook(
      makeRunbook({
        id: 'throws-rb',
        verify: async () => {
          throw new Error('probe timed out');
        },
      })
    );

    const result = await fx.remediator.dispatch(makeEvent());
    expect(result.outcome).toBe('verify-inconclusive');
  });

  it('audit entries land in audit-projection-<machineId>.jsonl', async () => {
    fx.remediator.registerRunbook(makeRunbook());
    await fx.remediator.dispatch(makeEvent());

    const projPath = path.join(
      fx.tmpDir,
      'remediation',
      `audit-projection-${fx.machineId}.jsonl`
    );
    expect(fs.existsSync(projPath)).toBe(true);
    const lines = fs
      .readFileSync(projPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2); // started + verify outcome
  });

  it('forged audit-token entries route to audit-rejected.jsonl', async () => {
    // Strict token verifier: only accept tokens whose first byte is 0x42.
    const strictFx = makeFixture({
      tokenVerifier: (e) =>
        e.auditToken.length > 0 && e.auditToken[0] === 0x42,
    });
    try {
      // FakeKeyVault produces random HKDF output; the leaf almost certainly
      // does not start with 0x42, so every dispatch will be rejected.
      strictFx.remediator.registerRunbook(makeRunbook());
      await strictFx.remediator.dispatch(makeEvent());

      const rejPath = path.join(
        strictFx.tmpDir,
        'remediation',
        'audit-rejected.jsonl'
      );
      expect(fs.existsSync(rejPath)).toBe(true);
      const rejLines = fs
        .readFileSync(rejPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean);
      expect(rejLines.length).toBeGreaterThan(0);
      const parsed = JSON.parse(rejLines[0]!);
      expect(parsed.reason).toBe('token-verify-failed');

      // Projection should be empty (or absent) — every entry was rejected.
      const projection = readProjection(strictFx.tmpDir, strictFx.machineId);
      expect(projection).toHaveLength(0);
    } finally {
      cleanup(strictFx);
    }
  });
});

/**
 * Unit tests for the node-abi-mismatch runbook (W-1).
 *
 * Covers SELF-HEALING-REMEDIATOR-V2-SPEC §A6, §A9, §A21, §A28, §A36, §A45.
 *
 * Strategy: real `Remediator` + real F-4 primitives (cheap to instantiate
 * with tmpdir), stubbed `NativeModuleHealer.invokeFromRemediator` and
 * stubbed verify impl so we don't actually shell out to `npm rebuild` or
 * touch the on-disk better-sqlite3 binding.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { Remediator } from '../../../src/remediation/Remediator.js';
import {
  nodeAbiMismatchRunbook,
  _setVerifyImplForTesting,
} from '../../../src/remediation/runbooks/node-abi-mismatch.js';
import { NativeModuleHealer } from '../../../src/memory/NativeModuleHealer.js';
import { MachineLock } from '../../../src/remediation/MachineLock.js';
import { IntentJournal } from '../../../src/remediation/IntentJournal.js';
import {
  AuditWriter,
  deserializeAuditEntry,
  type AuditEntry,
} from '../../../src/remediation/audit/AuditWriter.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import type { NormalizedDegradationEvent } from '../../../src/monitoring/DegradationReporter.js';

// ── Fakes ────────────────────────────────────────────────────────────────

class FakeKeyVault {
  private readonly master = crypto.randomBytes(32);
  private readonly nonce = crypto.randomBytes(32);
  deriveLeafKey(context: string, scopeId: string | null): Buffer {
    const info = Buffer.from(`${context}:${scopeId ?? ''}`);
    return Buffer.from(
      crypto.hkdfSync('sha256', this.master, this.nonce, info, 32)
    );
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

function makeEvent(
  overrides?: Partial<NormalizedDegradationEvent>
): NormalizedDegradationEvent {
  return {
    subsystem: overrides?.subsystem ?? 'better-sqlite3',
    errorCode: overrides?.errorCode ?? 'NATIVE_MODULE_ABI_MISMATCH',
    provenance: overrides?.provenance ?? 'native-binding',
    reason: overrides?.reason ?? {
      redacted: 'better-sqlite3 ABI mismatch (redacted)',
      full: 'NODE_MODULE_VERSION mismatch for better-sqlite3 against Node 127',
    },
    timestamp: overrides?.timestamp ?? new Date().toISOString(),
    monotonicTs: overrides?.monotonicTs ?? performance.now(),
  };
}

interface Fixture {
  tmpDir: string;
  remediator: Remediator;
  machineLock: MachineLock;
  intentJournal: IntentJournal;
  auditWriter: AuditWriter;
  machineId: string;
}

function makeFixture(): Fixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w1-runbook-'));
  const machineId = 'm-test';
  const machineLock = new MachineLock(tmpDir);
  const intentJournal = new IntentJournal(tmpDir, { machineId });
  const auditWriter = new AuditWriter(tmpDir, {
    machineId,
    tokenVerifier: (e: AuditEntry) => e.auditToken.length > 0,
  });
  const keyVault = new FakeKeyVault();
  const signerPair = makeSignerPair();
  const remediator = new Remediator({
    stateDir: tmpDir,
    keyVault: keyVault as unknown as Parameters<
      typeof Remediator.prototype.constructor
    >[0]['keyVault'],
    machineLock,
    intentJournal,
    auditWriter,
    lockSigner: signerPair.signer,
    lockVerifier: signerPair.verifier,
  });
  return { tmpDir, remediator, machineLock, intentJournal, auditWriter, machineId };
}

function cleanup(fx: Fixture): void {
  SafeFsExecutor.safeRmSync(fx.tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/runbooks/node-abi-mismatch.test.ts:cleanup',
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

describe('node-abi-mismatch runbook (W-1)', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
    NativeModuleHealer.resetForTesting();
    _setVerifyImplForTesting(null); // reset to real impl by default
  });

  afterEach(() => {
    cleanup(fx);
    _setVerifyImplForTesting(null);
    vi.restoreAllMocks();
  });

  it('matches NATIVE_MODULE_ABI_MISMATCH errorCode with native-binding provenance', () => {
    expect(() => fx.remediator.registerRunbook(nodeAbiMismatchRunbook)).not.toThrow();

    const ev = makeEvent({
      provenance: 'native-binding',
      errorCode: 'NATIVE_MODULE_ABI_MISMATCH',
    });

    // The match() callback narrows to better-sqlite3; the prefilter is the
    // dispatcher's responsibility, but we can verify match() returns true
    // for a clear better-sqlite3 event.
    expect(nodeAbiMismatchRunbook.match(ev)).toBe(true);
  });

  it('also matches subsystem-explicit provenance', () => {
    const ev = makeEvent({ provenance: 'subsystem-explicit' });
    expect(nodeAbiMismatchRunbook.eventPrefilter.provenance).toContain(
      'subsystem-explicit'
    );
    expect(nodeAbiMismatchRunbook.match(ev)).toBe(true);
  });

  it('does NOT include free-text in eventPrefilter.provenance (§A6)', () => {
    expect(nodeAbiMismatchRunbook.eventPrefilter.provenance).not.toContain(
      'free-text'
    );
  });

  it('Remediator.registerRunbook ACCEPTS this runbook (essential+machine, no free-text)', () => {
    // The runbook sets essential=true with blastRadius='machine' (§A36 OK)
    // and prefilter.provenance excludes 'free-text' (§A6 OK).
    expect(() => fx.remediator.registerRunbook(nodeAbiMismatchRunbook)).not.toThrow();
  });

  it('match() rejects events about other native modules', () => {
    const ev = makeEvent({
      subsystem: 'sqlite3', // not better-sqlite3
      reason: {
        redacted: 'sqlite3 ABI mismatch',
        full: 'NODE_MODULE_VERSION mismatch for sqlite3 against Node 127',
      },
    });
    expect(nodeAbiMismatchRunbook.match(ev)).toBe(false);
  });

  it('surfaceCallable invokes NativeModuleHealer.invokeFromRemediator with ctx', async () => {
    const spy = vi
      .spyOn(NativeModuleHealer, 'invokeFromRemediator')
      .mockResolvedValue({
        outcome: 'success',
        details: { rebuiltBinarySha256: 'abcd' },
      });

    // Use a dispatch-shaped context. We don't need full Remediator round-trip
    // here; surfaceCallable is a pure function of ctx.
    const ctx = {
      attemptId: 'test-attempt',
      runbookId: 'node-abi-mismatch',
      lockHandle: {} as never,
      auditToken: Buffer.from('test'),
      abortSignal: new AbortController().signal,
      expiresAt: Date.now() + 120_000,
      monotonicDeadline: process.hrtime.bigint() + 120_000_000_000n,
    };

    const result = await nodeAbiMismatchRunbook.surfaceCallable(ctx);
    expect(result.outcome).toBe('success');
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0]).toBe(ctx);
  });

  it('verify() returns verified-healthy when integrity_check === "ok"', async () => {
    _setVerifyImplForTesting(() => ({ kind: 'ok' }));
    const result = await nodeAbiMismatchRunbook.verify({} as never);
    expect(result.outcome).toBe('verified-healthy');
    expect(result.reason).toMatch(/integrity_check.*ok/);
  });

  it('verify() returns verify-failed when integrity_check returns "corrupt" (§A9)', async () => {
    _setVerifyImplForTesting(() => ({
      kind: 'corrupt',
      reason: 'integrity_check returned corrupt',
    }));
    const result = await nodeAbiMismatchRunbook.verify({} as never);
    expect(result.outcome).toBe('verify-failed');
    expect(result.reason).toMatch(/corrupt/);
  });

  it('verify() returns verify-inconclusive when integrity_check throws (§A21)', async () => {
    _setVerifyImplForTesting(() => ({
      kind: 'inconclusive',
      reason: 'integrity_check threw: ECONNREFUSED',
    }));
    const result = await nodeAbiMismatchRunbook.verify({} as never);
    expect(result.outcome).toBe('verify-inconclusive');
    expect(result.reason).toMatch(/threw/);
  });

  it('honours expectedRuntimeMs deadline (2 min cap per A57)', () => {
    expect(nodeAbiMismatchRunbook.expectedRuntimeMs).toBe(120_000);
  });

  it('essential=true accepted because blastRadius="machine" (§A36)', () => {
    expect(nodeAbiMismatchRunbook.essential).toBe(true);
    expect(nodeAbiMismatchRunbook.blastRadius).toBe('machine');
    // Re-confirm the registry-load validator agrees.
    expect(() => fx.remediator.registerRunbook(nodeAbiMismatchRunbook)).not.toThrow();
  });

  it('end-to-end dispatch wires runbook → healer → verify and audits each step', async () => {
    const healerSpy = vi
      .spyOn(NativeModuleHealer, 'invokeFromRemediator')
      .mockResolvedValue({
        outcome: 'success',
        details: { rebuiltBinarySha256: 'deadbeef' },
      });
    _setVerifyImplForTesting(() => ({ kind: 'ok' }));

    fx.remediator.registerRunbook(nodeAbiMismatchRunbook);
    const ev = makeEvent();
    const result = await fx.remediator.dispatch(ev);

    expect(result.outcome).toBe('verified-healthy');
    expect(healerSpy).toHaveBeenCalledOnce();

    const entries = readProjection(fx.tmpDir, fx.machineId);
    expect(entries.map((e) => e.outcome)).toEqual([
      'started',
      'verified-healthy',
    ]);
    // The runbookId is recorded on every entry.
    for (const entry of entries) {
      expect(entry.runbookId).toBe('node-abi-mismatch');
    }
  });
});

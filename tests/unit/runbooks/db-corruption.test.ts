// safe-git-allow: test file — uses SafeFsExecutor.safeRmSync for cleanup.
/**
 * Unit tests for the db-corruption runbook (W-4).
 *
 * Covers SELF-HEALING-REMEDIATOR-V2-SPEC §A6, §A9 (durability not liveness),
 * §A21 (inconclusive vs failed), §A34 (surface alignment), §A36 (essential
 * + machine), §A57 (Tier-2 wrapper).
 *
 * Strategy: real `Remediator` + real F-4 primitives (cheap to instantiate
 * with tmpdir), stubbed `SemanticMemory.invokeFromRemediator` and stubbed
 * verify impl so we don't actually corrupt + rebuild a db (the SemanticMemory
 * side has its own tests for that path).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { Remediator } from '../../../src/remediation/Remediator.js';
import {
  dbCorruptionRunbook,
  _setVerifyImplForTesting,
  _setSurfaceImplForTesting,
} from '../../../src/remediation/runbooks/db-corruption.js';
import { SemanticMemory } from '../../../src/memory/SemanticMemory.js';
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
      crypto.hkdfSync('sha256', this.master, this.nonce, info, 32),
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
  overrides?: Partial<NormalizedDegradationEvent>,
): NormalizedDegradationEvent {
  return {
    subsystem: overrides?.subsystem ?? 'semantic-memory',
    errorCode: overrides?.errorCode ?? 'SQLITE_CORRUPT',
    provenance: overrides?.provenance ?? 'native-binding',
    reason: overrides?.reason ?? {
      redacted: 'SemanticMemory db corrupt (redacted)',
      full: 'SemanticMemory integrity_check returned: malformed page 9',
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
  fakeMemoryInstance: SemanticMemory;
}

function makeFixture(): Fixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w4-runbook-'));
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

  // Create a real SemanticMemory instance for precondition + verify wiring.
  // Tests that stub surfaceCallable + verify don't actually exercise it.
  const fakeMemoryInstance = new SemanticMemory({
    dbPath: path.join(tmpDir, 'fake-semantic.db'),
    staleThreshold: 0.3,
    confidenceDecayRate: 0.01,
  });
  SemanticMemory.setActiveInstance(fakeMemoryInstance);

  return {
    tmpDir,
    remediator,
    machineLock,
    intentJournal,
    auditWriter,
    machineId,
    fakeMemoryInstance,
  };
}

function cleanup(fx: Fixture): void {
  try {
    fx.fakeMemoryInstance.close();
  } catch {
    /* ignore */
  }
  SemanticMemory.resetForTesting();
  SafeFsExecutor.safeRmSync(fx.tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/runbooks/db-corruption.test.ts:cleanup',
  });
}

function readProjection(tmpDir: string, machineId: string): AuditEntry[] {
  const p = path.join(
    tmpDir,
    'remediation',
    `audit-projection-${machineId}.jsonl`,
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

describe('db-corruption runbook (W-4)', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
    _setVerifyImplForTesting(null);
    _setSurfaceImplForTesting(null);
  });

  afterEach(() => {
    cleanup(fx);
    _setVerifyImplForTesting(null);
    _setSurfaceImplForTesting(null);
    vi.restoreAllMocks();
  });

  it('id, priority, surface, blastRadius match the W-4 contract', () => {
    expect(dbCorruptionRunbook.id).toBe('db-corruption');
    expect(dbCorruptionRunbook.priority).toBe(95);
    expect(dbCorruptionRunbook.surface).toBe('db-corruption');
    expect(dbCorruptionRunbook.blastRadius).toBe('machine');
    expect(dbCorruptionRunbook.reversibility).toBe('reversible');
    expect(dbCorruptionRunbook.expectedRuntimeMs).toBe(60_000);
    expect(dbCorruptionRunbook.essential).toBe(true);
  });

  it('eventPrefilter includes SQLITE_CORRUPT, SQLITE_NOTADB, SQLITE_IOERR_CORRUPTFS', () => {
    expect(dbCorruptionRunbook.eventPrefilter.errorCode).toEqual([
      'SQLITE_CORRUPT',
      'SQLITE_NOTADB',
      'SQLITE_IOERR_CORRUPTFS',
    ]);
  });

  it('eventPrefilter excludes free-text provenance (§A6)', () => {
    expect(dbCorruptionRunbook.eventPrefilter.provenance).not.toContain(
      'free-text',
    );
    expect(dbCorruptionRunbook.eventPrefilter.provenance).toEqual(
      expect.arrayContaining(['native-binding', 'subsystem-explicit', 'probe-id']),
    );
  });

  it('Remediator.registerRunbook ACCEPTS this runbook (essential+machine, no free-text)', () => {
    expect(() => fx.remediator.registerRunbook(dbCorruptionRunbook)).not.toThrow();
  });

  it('match() accepts semantic-memory subsystem events', () => {
    const ev = makeEvent({ subsystem: 'semantic-memory' });
    expect(dbCorruptionRunbook.match(ev)).toBe(true);
  });

  it('match() accepts memory subsystem events', () => {
    const ev = makeEvent({ subsystem: 'memory' });
    expect(dbCorruptionRunbook.match(ev)).toBe(true);
  });

  it('match() rejects unrelated subsystems with no SemanticMemory reason text', () => {
    const ev = makeEvent({
      subsystem: 'task-flow-registry',
      reason: {
        redacted: 'task flow store db corrupt',
        full: 'task-flow-registry sqlite corruption detected',
      },
    });
    expect(dbCorruptionRunbook.match(ev)).toBe(false);
  });

  it('match() accepts events whose reason mentions SemanticMemory', () => {
    const ev = makeEvent({
      subsystem: 'other-subsystem',
      reason: {
        redacted: 'SemanticMemory failure',
        full: 'SemanticMemory pragma threw: malformed',
      },
    });
    expect(dbCorruptionRunbook.match(ev)).toBe(true);
  });

  it('preconditions() returns false when no active instance is registered', async () => {
    SemanticMemory.setActiveInstance(null);
    const ok = await dbCorruptionRunbook.preconditions(makeEvent());
    expect(ok).toBe(false);
  });

  it('preconditions() returns true when an active instance is registered', async () => {
    // fx already wires an active instance.
    const ok = await dbCorruptionRunbook.preconditions(makeEvent());
    expect(ok).toBe(true);
  });

  it('surfaceCallable invokes SemanticMemory.invokeFromRemediator with ctx', async () => {
    const spy = vi
      .spyOn(SemanticMemory, 'invokeFromRemediator')
      .mockResolvedValue({
        outcome: 'success',
        details: { rebuiltFromJsonl: true, integrityValue: 'ok' },
      });

    const ctx = {
      attemptId: 'test-attempt',
      runbookId: 'db-corruption',
      lockHandle: {} as never,
      auditToken: Buffer.from('test'),
      abortSignal: new AbortController().signal,
      expiresAt: Date.now() + 60_000,
      monotonicDeadline: process.hrtime.bigint() + 60_000_000_000n,
    };

    const result = await dbCorruptionRunbook.surfaceCallable(ctx);
    expect(result.outcome).toBe('success');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('verify() returns verified-healthy on durable + integrity_check ok (§A9)', async () => {
    _setVerifyImplForTesting(() => ({ kind: 'ok', integrityValue: 'ok' }));
    const result = await dbCorruptionRunbook.verify({} as never);
    expect(result.outcome).toBe('verified-healthy');
    expect(result.reason).toMatch(/db\.mode=durable/);
  });

  it('verify() returns verify-failed on integrity_check != ok', async () => {
    _setVerifyImplForTesting(() => ({
      kind: 'corrupt',
      reason: 'integrity_check returned malformed',
    }));
    const result = await dbCorruptionRunbook.verify({} as never);
    expect(result.outcome).toBe('verify-failed');
    expect(result.reason).toMatch(/malformed/);
  });

  it('verify() returns verify-failed on in-memory fallback (§A9 durability lost)', async () => {
    _setVerifyImplForTesting(() => ({
      kind: 'durability-degraded',
      reason: 'SemanticMemory fell back to in-memory mode (DURABILITY_DEGRADED)',
    }));
    const result = await dbCorruptionRunbook.verify({} as never);
    expect(result.outcome).toBe('verify-failed');
    expect(result.reason).toMatch(/DURABILITY_DEGRADED/);
  });

  it('verify() returns verify-inconclusive when the probe throws (§A21)', async () => {
    _setVerifyImplForTesting(() => ({
      kind: 'inconclusive',
      reason: 'integrity_check threw: EIO',
    }));
    const result = await dbCorruptionRunbook.verify({} as never);
    expect(result.outcome).toBe('verify-inconclusive');
    expect(result.reason).toMatch(/threw|inconclusive|no active/);
  });

  it('essential=true accepted because blastRadius="machine" (§A36)', () => {
    expect(dbCorruptionRunbook.essential).toBe(true);
    expect(dbCorruptionRunbook.blastRadius).toBe('machine');
    expect(() => fx.remediator.registerRunbook(dbCorruptionRunbook)).not.toThrow();
  });

  it('end-to-end dispatch wires runbook → SemanticMemory recovery → verify and audits each step', async () => {
    const surfaceSpy = vi
      .spyOn(SemanticMemory, 'invokeFromRemediator')
      .mockResolvedValue({
        outcome: 'success',
        details: { rebuiltFromJsonl: true, integrityValue: 'ok' },
      });
    _setVerifyImplForTesting(() => ({ kind: 'ok', integrityValue: 'ok' }));

    fx.remediator.registerRunbook(dbCorruptionRunbook);
    const ev = makeEvent();
    const result = await fx.remediator.dispatch(ev);

    expect(result.outcome).toBe('verified-healthy');
    expect(surfaceSpy).toHaveBeenCalledOnce();

    const entries = readProjection(fx.tmpDir, fx.machineId);
    expect(entries.map((e) => e.outcome)).toEqual([
      'started',
      'verified-healthy',
    ]);
    for (const entry of entries) {
      expect(entry.runbookId).toBe('db-corruption');
    }
  });
});

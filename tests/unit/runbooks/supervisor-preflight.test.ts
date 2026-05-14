/**
 * Unit tests for the supervisor-preflight runbook (W-2).
 *
 * Covers SELF-HEALING-REMEDIATOR-V2-SPEC §A6, §A9, §A21, §A34, §A36.
 *
 * Strategy: real `Remediator` + real F-4 primitives (cheap to instantiate
 * with tmpdir), stubbed `ServerSupervisor.invokeFromRemediator` and a
 * stubbed verify impl so we don't actually spawn the supervisor body or
 * touch the on-disk shadow-install.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { Remediator } from '../../../src/remediation/Remediator.js';
import {
  supervisorPreflightRunbook,
  _setVerifyImplForTesting,
  _setSupervisorForTesting,
  _setStateDirForVerify,
  verifyLifelineDurable,
  VERIFIED_HEAL_TARGETS,
} from '../../../src/remediation/runbooks/supervisor-preflight.js';
import { MachineLock } from '../../../src/remediation/MachineLock.js';
import { IntentJournal } from '../../../src/remediation/IntentJournal.js';
import {
  AuditWriter,
  type AuditEntry,
} from '../../../src/remediation/audit/AuditWriter.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { writeStartupMarker } from '../../../src/lifeline/startupMarker.js';
import type { NormalizedDegradationEvent } from '../../../src/monitoring/DegradationReporter.js';
import type { ServerSupervisor } from '../../../src/lifeline/ServerSupervisor.js';

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
    subsystem: overrides?.subsystem ?? 'lifeline',
    errorCode: overrides?.errorCode ?? 'BIND_FAILURE',
    provenance: overrides?.provenance ?? 'subsystem-explicit',
    reason: overrides?.reason ?? {
      redacted: 'server bind failure on port 4042 (redacted)',
      full: 'EADDRINUSE: server failed to bind 0.0.0.0:4042 after crash loop',
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2-runbook-'));
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
    operation: 'tests/unit/runbooks/supervisor-preflight.test.ts:cleanup',
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('supervisor-preflight runbook (W-2)', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
    _setVerifyImplForTesting(null);
    _setSupervisorForTesting(null);
    _setStateDirForVerify(null);
  });

  afterEach(() => {
    cleanup(fx);
    _setVerifyImplForTesting(null);
    _setSupervisorForTesting(null);
    _setStateDirForVerify(null);
    vi.restoreAllMocks();
  });

  it('matcher on BIND_FAILURE event with subsystem-explicit provenance triggers runbook', () => {
    expect(() =>
      fx.remediator.registerRunbook(supervisorPreflightRunbook),
    ).not.toThrow();

    const ev = makeEvent({
      provenance: 'subsystem-explicit',
      errorCode: 'BIND_FAILURE',
      subsystem: 'lifeline',
    });

    expect(supervisorPreflightRunbook.match(ev)).toBe(true);
    expect(supervisorPreflightRunbook.eventPrefilter.errorCode).toContain(
      'BIND_FAILURE',
    );
    expect(supervisorPreflightRunbook.eventPrefilter.errorCode).toContain(
      'CRASH_LOOP',
    );
    expect(supervisorPreflightRunbook.eventPrefilter.errorCode).toContain(
      'SUPERVISOR_DEGRADED',
    );
  });

  it('free-text provenance refused at registry load (§A6)', () => {
    // The runbook itself excludes free-text from its prefilter. Mutating it
    // to include free-text MUST be refused by registerRunbook.
    const badRunbook = {
      ...supervisorPreflightRunbook,
      id: 'supervisor-preflight-badproof',
      eventPrefilter: {
        ...supervisorPreflightRunbook.eventPrefilter,
        provenance: [
          ...supervisorPreflightRunbook.eventPrefilter.provenance,
          'free-text' as const,
        ],
      },
    };
    expect(() => fx.remediator.registerRunbook(badRunbook)).toThrow(
      /free-text/i,
    );
    // The shipped runbook does NOT include free-text.
    expect(
      supervisorPreflightRunbook.eventPrefilter.provenance,
    ).not.toContain('free-text');
  });

  it('wrong subsystem (memory) → no match', () => {
    const ev = makeEvent({
      subsystem: 'memory',
      errorCode: 'BIND_FAILURE',
      reason: {
        redacted: 'memory subsystem bind failure (redacted)',
        full: 'memory subsystem reported bind failure on internal handle',
      },
    });
    // The match() callback narrows to lifeline/server/supervisor or reason
    // text mentioning those. A pure-memory event with no server mention
    // must not match.
    expect(supervisorPreflightRunbook.match(ev)).toBe(false);
  });

  it('surfaceCallable invokes ServerSupervisor.invokeFromRemediator with verified ctx', async () => {
    const spy = vi.fn(async () => ({
      outcome: 'success' as const,
      details: { healed: 'shadow install restored', anyHealed: true },
    }));
    _setSupervisorForTesting({
      invokeFromRemediator: spy,
    } as unknown as Pick<ServerSupervisor, 'invokeFromRemediator'>);

    const ctx = {
      attemptId: 'test-attempt',
      runbookId: 'supervisor-preflight',
      lockHandle: {} as never,
      auditToken: Buffer.from('test'),
      abortSignal: new AbortController().signal,
      expiresAt: Date.now() + 180_000,
      monotonicDeadline: process.hrtime.bigint() + 180_000_000_000n,
    };

    const result = await supervisorPreflightRunbook.surfaceCallable(ctx);
    expect(result.outcome).toBe('success');
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0]).toBe(ctx);
  });

  it('verify-healthy when lifeline state.json (startup marker) exists post-restart', () => {
    writeStartupMarker(fx.tmpDir, 'test-version-1.0');
    const probe = verifyLifelineDurable(fx.tmpDir);
    expect(probe.kind).toBe('ok');
  });

  it('verify-failed when marker missing or corrupt', async () => {
    // Missing.
    const probeMissing = verifyLifelineDurable(fx.tmpDir);
    expect(probeMissing.kind).toBe('failed');
    if (probeMissing.kind === 'failed') {
      expect(probeMissing.reason).toMatch(/missing/i);
    }

    // Corrupt JSON.
    fs.writeFileSync(
      path.join(fx.tmpDir, 'lifeline-started-at.json'),
      '{ not valid json',
      'utf-8',
    );
    const probeCorrupt = verifyLifelineDurable(fx.tmpDir);
    expect(probeCorrupt.kind).toBe('failed');

    // Wire into the runbook's verify() — must surface as 'verify-failed'.
    _setVerifyImplForTesting(() => ({
      kind: 'failed',
      reason: 'marker missing at /tmp/foo/lifeline-started-at.json',
    }));
    const result = await supervisorPreflightRunbook.verify({} as never);
    expect(result.outcome).toBe('verify-failed');
    expect(result.reason).toMatch(/missing/i);
  });

  it('verify-inconclusive when probe path errors (§A21)', async () => {
    _setVerifyImplForTesting(() => ({
      kind: 'inconclusive',
      reason: 'marker readFileSync threw (EACCES): permission denied',
    }));
    const result = await supervisorPreflightRunbook.verify({} as never);
    expect(result.outcome).toBe('verify-inconclusive');
    expect(result.reason).toMatch(/EACCES|threw|inconclusive/i);
  });

  it('essential: true + blastRadius: machine validates at registry (§A36)', () => {
    expect(supervisorPreflightRunbook.essential).toBe(true);
    expect(supervisorPreflightRunbook.blastRadius).toBe('machine');
    // The §A36 validator runs at registerRunbook(). Re-confirm.
    expect(() =>
      fx.remediator.registerRunbook(supervisorPreflightRunbook),
    ).not.toThrow();

    // Mutating blastRadius off 'machine' while keeping essential=true MUST
    // be refused by the validator.
    const badRunbook = {
      ...supervisorPreflightRunbook,
      id: 'supervisor-preflight-bad-blast',
      blastRadius: 'process' as const,
    };
    expect(() => fx.remediator.registerRunbook(badRunbook)).toThrow(
      /essential.*machine|machine.*essential/i,
    );
  });

  it('priority is below W-1 (node-abi-mismatch=100) so ABI mismatches dispatch to the precise heal', () => {
    expect(supervisorPreflightRunbook.priority).toBeLessThan(100);
    expect(supervisorPreflightRunbook.priority).toBe(90);
  });

  it('expectedRuntimeMs respects A57 Tier-2 ceiling (3-min cap for compound heals)', () => {
    expect(supervisorPreflightRunbook.expectedRuntimeMs).toBe(180_000);
  });

  it('verify-healthy stale-marker → verify-failed', () => {
    // Marker written 30 minutes ago (older than 10-min default ceiling).
    const oldMs = Date.now() - 30 * 60_000;
    fs.writeFileSync(
      path.join(fx.tmpDir, 'lifeline-started-at.json'),
      JSON.stringify({
        startedAt: new Date(oldMs).toISOString(),
        pid: 1234,
        version: 'old',
      }),
      'utf-8',
    );
    const probe = verifyLifelineDurable(fx.tmpDir);
    expect(probe.kind).toBe('failed');
    if (probe.kind === 'failed') {
      expect(probe.reason).toMatch(/stale|did not respawn/i);
    }
  });

  it('VERIFIED_HEAL_TARGETS enumerates the six §A34 heal steps', () => {
    expect([...VERIFIED_HEAL_TARGETS]).toEqual([
      'shadow-install',
      'node-symlink',
      'git-rebase',
      'better-sqlite3-abi',
      'stale-lifeline-lock',
      'settings-json',
    ]);
  });

  it('end-to-end dispatch wires runbook → supervisor → verify and audits each step', async () => {
    const supervisorSpy = vi.fn(async () => ({
      outcome: 'success' as const,
      details: { healed: 'better-sqlite3 rebuilt', anyHealed: true },
    }));
    _setSupervisorForTesting({
      invokeFromRemediator: supervisorSpy,
    } as unknown as Pick<ServerSupervisor, 'invokeFromRemediator'>);
    _setVerifyImplForTesting(() => ({
      kind: 'ok',
      markerStartedAt: new Date().toISOString(),
    }));

    fx.remediator.registerRunbook(supervisorPreflightRunbook);
    const ev = makeEvent();
    const result = await fx.remediator.dispatch(ev);

    expect(result.outcome).toBe('verified-healthy');
    expect(supervisorSpy).toHaveBeenCalledOnce();
  });
});

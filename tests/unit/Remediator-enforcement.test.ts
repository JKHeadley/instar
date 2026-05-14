/**
 * Unit tests for Remediator F-8 rest of Tier-2 enforcement.
 *
 * Covers SELF-HEALING-REMEDIATOR-V2-SPEC §A3 (capability-token sign on ctx),
 * §A40 (probe authentication), §A52 (probe-source scope binding), and the
 * trust-elevation source consult per §A57 Tier-2 carve-out.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  Remediator,
  DefaultProbeSourceRegistry,
  canonicalProbeEnvelopeBody,
  type ApprovedRunbook,
  type ProbeSourceRegistry,
  type ProbeSignatureEnvelope,
  type RemediationContext,
} from '../../src/remediation/Remediator.js';
import type { NormalizedDegradationEvent } from '../../src/monitoring/DegradationReporter.js';
import { MachineLock } from '../../src/remediation/MachineLock.js';
import { IntentJournal } from '../../src/remediation/IntentJournal.js';
import {
  AuditWriter,
  deserializeAuditEntry,
  type AuditEntry,
} from '../../src/remediation/audit/AuditWriter.js';
import { verifyRemediationContext } from '../../src/remediation/RemediationContext.js';
import {
  TrustElevationSource,
  type TrustedApprovalChannel,
} from '../../src/remediation/TrustElevationSource.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// ── Fakes ─────────────────────────────────────────────────────────────────

class FakeKeyVault {
  private readonly master = crypto.randomBytes(32);
  private readonly nonce = crypto.randomBytes(32);
  deriveLeafKey(context: string, scopeId: string | null): Buffer {
    const info = Buffer.from(`${context}:${scopeId ?? ''}`);
    return Buffer.from(crypto.hkdfSync('sha256', this.master, this.nonce, info, 32));
  }
}

function permissiveTokenVerifier(): (e: AuditEntry) => boolean {
  return (e) => e.auditToken.length > 0;
}

function makeEvent(
  overrides?: Partial<NormalizedDegradationEvent>
): NormalizedDegradationEvent {
  return {
    subsystem: overrides?.subsystem ?? 'lifeline',
    errorCode: overrides?.errorCode ?? 'LIFELINE_PROCESS_DOWN',
    provenance: overrides?.provenance ?? 'probe-id',
    reason: overrides?.reason ?? {
      redacted: 'lifeline down (redacted)',
      full: 'lifeline pid 1234 not running',
    },
    timestamp: overrides?.timestamp ?? new Date().toISOString(),
    monotonicTs: overrides?.monotonicTs ?? performance.now(),
    source: overrides?.source,
  };
}

function makeRunbook(overrides?: Partial<ApprovedRunbook>): ApprovedRunbook {
  return {
    id: overrides?.id ?? 'lifeline-restart',
    priority: overrides?.priority ?? 10,
    surface: overrides?.surface ?? 'lifeline-supervisor',
    eventPrefilter: overrides?.eventPrefilter ?? {
      errorCode: ['LIFELINE_PROCESS_DOWN'],
      provenance: ['probe-id'],
    },
    match: overrides?.match ?? (() => true),
    preconditions: overrides?.preconditions ?? (async () => true),
    surfaceCallable:
      overrides?.surfaceCallable ??
      (async () => ({ outcome: 'success', details: {} })),
    verify:
      overrides?.verify ??
      (async () => ({ outcome: 'verified-healthy', reason: 'ok' })),
    blastRadius: overrides?.blastRadius ?? 'process',
    reversibility: overrides?.reversibility ?? 'reversible',
    expectedRuntimeMs: overrides?.expectedRuntimeMs ?? 1_000,
    essential: overrides?.essential,
  };
}

function signProbeEnvelope(
  vault: FakeKeyVault,
  env: Omit<ProbeSignatureEnvelope, 'signature'>,
): ProbeSignatureEnvelope {
  const leaf = vault.deriveLeafKey('probe', env.probeId);
  const body = canonicalProbeEnvelopeBody(env);
  const signature = crypto.createHmac('sha256', leaf).update(body).digest();
  return { ...env, signature };
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

function readRejected(tmpDir: string): Array<{
  reason: string;
  entry: { subsystem: string; runbookId?: string };
}> {
  const p = path.join(tmpDir, 'remediation', 'audit-rejected.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ── Fixture ──────────────────────────────────────────────────────────────

interface Fixture {
  tmpDir: string;
  remediator: Remediator;
  machineLock: MachineLock;
  intentJournal: IntentJournal;
  auditWriter: AuditWriter;
  keyVault: FakeKeyVault;
  machineId: string;
}

function makeFixture(opts?: {
  probeRegistry?: ProbeSourceRegistry;
  trustSource?: TrustElevationSource;
}): Fixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remediator-enf-'));
  const machineId = 'm-test';
  const machineLock = new MachineLock(tmpDir);
  const intentJournal = new IntentJournal(tmpDir, { machineId });
  const auditWriter = new AuditWriter(tmpDir, {
    machineId,
    tokenVerifier: permissiveTokenVerifier(),
  });
  const keyVault = new FakeKeyVault();
  const remediator = new Remediator({
    stateDir: tmpDir,
    keyVault: keyVault as unknown as Parameters<
      typeof Remediator.prototype.constructor
    >[0]['keyVault'],
    machineLock,
    intentJournal,
    auditWriter,
    probeSourceRegistry: opts?.probeRegistry,
    trustSource: opts?.trustSource,
  });
  return {
    tmpDir,
    remediator,
    machineLock,
    intentJournal,
    auditWriter,
    keyVault,
    machineId,
  };
}

function cleanup(fx: Fixture): void {
  SafeFsExecutor.safeRmSync(fx.tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/Remediator-enforcement.test.ts:cleanup',
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Remediator F-8-rest enforcement', () => {
  describe('probe-source binding (§A40 / §A52)', () => {
    it('unsigned probe-id event → routed to audit-rejected', async () => {
      const tmpDir0 = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-'));
      const kv = new FakeKeyVault();
      const registry = new DefaultProbeSourceRegistry(
        kv as unknown as { deriveLeafKey: (c: 'probe', s: string) => Buffer },
        { 'instar.lifeline.process': ['lifeline'] },
      );
      const fx = makeFixture({ probeRegistry: registry });
      fx.remediator.registerRunbook(makeRunbook());

      const result = await fx.remediator.dispatch(makeEvent()); // no source.probeSignature
      expect(result.outcome).toBe('no-matching-runbook');

      const rejected = readRejected(fx.tmpDir);
      const accepted = readProjection(fx.tmpDir, fx.machineId);
      // The "no-matching-runbook" entry is recorded in the projection (the
      // probe-rejection redacted reason). audit-rejected.jsonl is reserved
      // for forged-token entries; we surface the probe-rejection reason via
      // the entry's `reason.redacted`.
      const probeReject = accepted.find(
        (e) => e.reason?.redacted === 'probe-event-unsigned',
      );
      expect(probeReject).toBeDefined();
      // Sanity: the un-rejected legitimate path would have written a
      // `started` entry; this one didn't.
      expect(accepted.find((e) => e.outcome === 'started')).toBeUndefined();
      // Watermark-rejection path is not triggered here.
      expect(rejected).toHaveLength(0);
      cleanup(fx);
      SafeFsExecutor.safeRmSync(tmpDir0, {
        recursive: true,
        force: true,
        operation: 'test cleanup',
      });
    });

    it('signed probe event in declared scope → dispatched', async () => {
      const kv = new FakeKeyVault();
      const registry = new DefaultProbeSourceRegistry(
        kv as unknown as { deriveLeafKey: (c: 'probe', s: string) => Buffer },
        { 'instar.lifeline.process': ['lifeline'] },
      );
      // The Remediator's vault MUST be the same instance the probe signs
      // against so the leaf keys match.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remediator-enf-'));
      const machineLock = new MachineLock(tmpDir);
      const intentJournal = new IntentJournal(tmpDir, { machineId: 'm' });
      const auditWriter = new AuditWriter(tmpDir, {
        machineId: 'm',
        tokenVerifier: permissiveTokenVerifier(),
      });
      const remediator = new Remediator({
        stateDir: tmpDir,
        keyVault: kv as unknown as Parameters<
          typeof Remediator.prototype.constructor
        >[0]['keyVault'],
        machineLock,
        intentJournal,
        auditWriter,
        probeSourceRegistry: registry,
      });
      remediator.registerRunbook(makeRunbook());

      const sig = signProbeEnvelope(kv, {
        probeId: 'instar.lifeline.process',
        subsystem: 'lifeline',
        outcome: 'down',
        reason: 'pid-not-running',
        monotonicTs: 1234,
      });
      const evt = makeEvent({
        source: { probeSignature: sig },
      });
      const result = await remediator.dispatch(evt);
      expect(result.outcome).toBe('verified-healthy');

      SafeFsExecutor.safeRmSync(tmpDir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/Remediator-enforcement.test.ts:cleanup',
      });
    });

    it('signed probe event OUT of declared scope → routed to audit-rejected (§A52)', async () => {
      const kv = new FakeKeyVault();
      const registry = new DefaultProbeSourceRegistry(
        kv as unknown as { deriveLeafKey: (c: 'probe', s: string) => Buffer },
        { 'instar.lifeline.process': ['lifeline'] }, // probe scope = ['lifeline']
      );
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remediator-enf-'));
      const remediator = new Remediator({
        stateDir: tmpDir,
        keyVault: kv as unknown as Parameters<
          typeof Remediator.prototype.constructor
        >[0]['keyVault'],
        machineLock: new MachineLock(tmpDir),
        intentJournal: new IntentJournal(tmpDir, { machineId: 'm' }),
        auditWriter: new AuditWriter(tmpDir, {
          machineId: 'm',
          tokenVerifier: permissiveTokenVerifier(),
        }),
        probeSourceRegistry: registry,
      });
      remediator.registerRunbook(makeRunbook({
        eventPrefilter: {
          errorCode: ['SCHEDULER_STALL'],
          provenance: ['probe-id'],
        },
      }));

      const sig = signProbeEnvelope(kv, {
        probeId: 'instar.lifeline.process', // probe says it's the lifeline probe
        subsystem: 'scheduler', // but event claims subsystem=scheduler — out of scope
        outcome: 'stall',
        reason: 'queue-empty',
        monotonicTs: 1234,
      });
      const evt = makeEvent({
        subsystem: 'scheduler',
        errorCode: 'SCHEDULER_STALL',
        source: { probeSignature: sig },
      });
      const result = await remediator.dispatch(evt);
      expect(result.outcome).toBe('no-matching-runbook');

      const accepted = readProjection(tmpDir, 'm');
      const outOfScope = accepted.find(
        (e) => e.reason?.redacted === 'probe-subsystem-out-of-scope',
      );
      expect(outOfScope).toBeDefined();
      // Out-of-scope MUST NOT dispatch — no `started` entry.
      expect(accepted.find((e) => e.outcome === 'started')).toBeUndefined();

      SafeFsExecutor.safeRmSync(tmpDir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/Remediator-enforcement.test.ts:cleanup',
      });
    });

    it('signed probe with bad signature → routed to audit-rejected', async () => {
      const kv = new FakeKeyVault();
      const registry = new DefaultProbeSourceRegistry(
        kv as unknown as { deriveLeafKey: (c: 'probe', s: string) => Buffer },
        { 'instar.lifeline.process': ['lifeline'] },
      );
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remediator-enf-'));
      const remediator = new Remediator({
        stateDir: tmpDir,
        keyVault: kv as unknown as Parameters<
          typeof Remediator.prototype.constructor
        >[0]['keyVault'],
        machineLock: new MachineLock(tmpDir),
        intentJournal: new IntentJournal(tmpDir, { machineId: 'm' }),
        auditWriter: new AuditWriter(tmpDir, {
          machineId: 'm',
          tokenVerifier: permissiveTokenVerifier(),
        }),
        probeSourceRegistry: registry,
      });
      remediator.registerRunbook(makeRunbook());

      const evt = makeEvent({
        source: {
          probeSignature: {
            probeId: 'instar.lifeline.process',
            subsystem: 'lifeline',
            outcome: 'down',
            reason: 'pid-not-running',
            monotonicTs: 1234,
            signature: crypto.randomBytes(32), // forged
          },
        },
      });
      const result = await remediator.dispatch(evt);
      expect(result.outcome).toBe('no-matching-runbook');

      const accepted = readProjection(tmpDir, 'm');
      const sigReject = accepted.find(
        (e) => e.reason?.redacted === 'probe-signature-invalid',
      );
      expect(sigReject).toBeDefined();

      SafeFsExecutor.safeRmSync(tmpDir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/Remediator-enforcement.test.ts:cleanup',
      });
    });
  });

  describe('§A3 capability-token signed on dispatched ctx', () => {
    it('dispatched ctx carries a verifiable hmac', async () => {
      const fx = makeFixture();
      let receivedCtx: RemediationContext | null = null;
      fx.remediator.registerRunbook(
        makeRunbook({
          eventPrefilter: {
            errorCode: ['NATIVE_MODULE_ABI_MISMATCH'],
            provenance: ['native-binding'],
          },
          surfaceCallable: async (ctx) => {
            receivedCtx = ctx;
            return { outcome: 'success', details: {} };
          },
        }),
      );

      const evt = makeEvent({
        subsystem: 'memory',
        errorCode: 'NATIVE_MODULE_ABI_MISMATCH',
        provenance: 'native-binding',
      });
      const result = await fx.remediator.dispatch(evt);
      expect(result.outcome).toBe('verified-healthy');
      expect(receivedCtx).not.toBeNull();
      expect(Buffer.isBuffer((receivedCtx as unknown as RemediationContext).hmac)).toBe(true);
      // The signed ctx verifies against the same vault.
      expect(
        verifyRemediationContext(
          receivedCtx as unknown as RemediationContext,
          fx.keyVault as unknown as { deriveLeafKey: (c: 'capability', s: string) => Buffer },
        ),
      ).toBe(true);
      cleanup(fx);
    });
  });

  describe('§A57 trust-elevation source consult', () => {
    it('canTransition delegates to wired source', async () => {
      const trustSource = new TrustElevationSource({
        profile: 'collaborative',
        channels: [],
      });
      const fx = makeFixture({ trustSource });

      // registered-to-live with missing context inputs → refused by source.
      const result = await fx.remediator.canTransition(
        'lifeline-restart',
        'registered-to-live',
        {},
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/missing-dry-run/);

      cleanup(fx);
    });

    it('proposal-to-registered always refused (programmatic path closed)', async () => {
      const trustSource = new TrustElevationSource({
        profile: 'autonomous',
        channels: [],
      });
      const fx = makeFixture({ trustSource });

      const result = await fx.remediator.canTransition(
        'rb',
        'proposal-to-registered',
        {},
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/instar-dev-commit/);
      cleanup(fx);
    });

    it('no trust source wired → falls back to "allowed: true / no-trust-source-wired"', async () => {
      const fx = makeFixture();
      const result = await fx.remediator.canTransition(
        'rb',
        'registered-to-live',
        {},
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('no-trust-source-wired');
      cleanup(fx);
    });
  });

  describe('canonicalProbeEnvelopeBody', () => {
    it('is deterministic across calls with the same input', () => {
      const env = {
        probeId: 'instar.lifeline.process',
        subsystem: 'lifeline',
        outcome: 'down',
        reason: 'pid-not-running',
        monotonicTs: 1234,
      };
      const a = canonicalProbeEnvelopeBody(env);
      const b = canonicalProbeEnvelopeBody(env);
      expect(a.equals(b)).toBe(true);
    });

    it('differs when any field differs', () => {
      const base = {
        probeId: 'p1',
        subsystem: 's1',
        outcome: 'o1',
        reason: 'r1',
        monotonicTs: 1,
      };
      const a = canonicalProbeEnvelopeBody(base);
      const b = canonicalProbeEnvelopeBody({ ...base, subsystem: 's2' });
      expect(a.equals(b)).toBe(false);
    });
  });
});

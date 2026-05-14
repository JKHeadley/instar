/**
 * Unit tests for the messaging-delivery-failed runbook (W-3).
 *
 * Covers SELF-HEALING-REMEDIATOR-V2-SPEC §A1 W-3, §A6 (structured
 * provenance), §A9 (durable verify — full inbox drain), §A21 (verify
 * outcome taxonomy), §A34 R3 (surface alignment via invokeFromRemediator),
 * §A36 (essential=false on process-blast-radius runbook).
 *
 * Strategy: real `Remediator` + real F-4 primitives (tmpdir-backed),
 * real `DeliveryRetryManager` against a real `MessageStore`. We inject
 * deps via `setMessagingDeliveryDeps()` so the runbook resolves to our
 * test instances without touching production singletons.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { Remediator } from '../../../src/remediation/Remediator.js';
import {
  messagingDeliveryFailedRunbook,
  setMessagingDeliveryDeps,
  _setVerifyImplForTesting,
} from '../../../src/remediation/runbooks/messaging-delivery-failed.js';
import { MachineLock } from '../../../src/remediation/MachineLock.js';
import { IntentJournal } from '../../../src/remediation/IntentJournal.js';
import {
  AuditWriter,
  deserializeAuditEntry,
  type AuditEntry,
} from '../../../src/remediation/audit/AuditWriter.js';
import { MessageStore } from '../../../src/messaging/MessageStore.js';
import { MessageDelivery, type TmuxOperations } from '../../../src/messaging/MessageDelivery.js';
import { MessageFormatter } from '../../../src/messaging/MessageFormatter.js';
import { DeliveryRetryManager } from '../../../src/messaging/DeliveryRetryManager.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import type { NormalizedDegradationEvent } from '../../../src/monitoring/DegradationReporter.js';
import type { MessageEnvelope, AgentMessage } from '../../../src/messaging/types.js';

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
    subsystem: overrides?.subsystem ?? 'messaging',
    errorCode: overrides?.errorCode ?? 'DELIVERY_FAILURE',
    provenance: overrides?.provenance ?? 'subsystem-explicit',
    reason: overrides?.reason ?? {
      redacted: 'delivery failure (redacted)',
      full: 'tmux session unreachable after 10 retries',
    },
    timestamp: overrides?.timestamp ?? new Date().toISOString(),
    monotonicTs: overrides?.monotonicTs ?? performance.now(),
  };
}

function makeMessage(overrides?: Partial<AgentMessage>): AgentMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from: { agent: 'sender', session: 'session-1', machine: 'test-machine' },
    to: { agent: 'test-agent', session: 'target-session', machine: 'local' },
    type: 'info',
    priority: 'medium',
    subject: 'Test',
    body: 'Hello',
    createdAt: new Date().toISOString(),
    ttlMinutes: 30,
    ...overrides,
  };
}

function makeEnvelope(overrides?: Partial<AgentMessage>): MessageEnvelope {
  return {
    schemaVersion: 1,
    message: makeMessage(overrides),
    transport: {
      relayChain: [],
      originServer: 'http://localhost:3000',
      nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`,
      timestamp: new Date().toISOString(),
    },
    delivery: {
      phase: 'queued',
      transitions: [
        { from: 'created', to: 'sent', at: new Date().toISOString() },
        { from: 'sent', to: 'queued', at: new Date().toISOString() },
      ],
      attempts: 0,
    },
  };
}

function makeTmux(overrides?: Partial<TmuxOperations>): TmuxOperations {
  return {
    getForegroundProcess: () => 'bash',
    isSessionAlive: () => true,
    hasActiveHumanInput: () => false,
    sendKeys: () => true,
    getOutputLineCount: () => 100,
    ...overrides,
  };
}

interface Fixture {
  tmpDir: string;
  remediator: Remediator;
  machineLock: MachineLock;
  intentJournal: IntentJournal;
  auditWriter: AuditWriter;
  machineId: string;
  store: MessageStore;
  manager: DeliveryRetryManager;
}

async function makeFixture(): Promise<Fixture> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-runbook-'));
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

  const storeDir = path.join(tmpDir, 'messaging');
  fs.mkdirSync(storeDir, { recursive: true });
  const store = new MessageStore(storeDir);
  await store.initialize();
  const delivery = new MessageDelivery(new MessageFormatter(), makeTmux());
  const manager = new DeliveryRetryManager(store, delivery, {
    agentName: 'test-agent',
  });

  setMessagingDeliveryDeps({
    getManager: () => manager,
    getStoreScope: () => ({ store, agentName: 'test-agent' }),
  });

  return {
    tmpDir,
    remediator,
    machineLock,
    intentJournal,
    auditWriter,
    machineId,
    store,
    manager,
  };
}

function cleanup(fx: Fixture): void {
  fx.manager.stop();
  setMessagingDeliveryDeps(null);
  SafeFsExecutor.safeRmSync(fx.tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/runbooks/messaging-delivery-failed.test.ts:cleanup',
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

describe('messaging-delivery-failed runbook (W-3)', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await makeFixture();
    _setVerifyImplForTesting(null);
  });

  afterEach(() => {
    cleanup(fx);
    _setVerifyImplForTesting(null);
    vi.restoreAllMocks();
  });

  it('matches messaging-subsystem events with structured errorCodes', () => {
    expect(() =>
      fx.remediator.registerRunbook(messagingDeliveryFailedRunbook)
    ).not.toThrow();

    expect(
      messagingDeliveryFailedRunbook.match(makeEvent({ errorCode: 'DELIVERY_FAILURE' }))
    ).toBe(true);
    expect(
      messagingDeliveryFailedRunbook.match(makeEvent({ errorCode: 'TELEGRAM_429' }))
    ).toBe(true);
    expect(
      messagingDeliveryFailedRunbook.match(makeEvent({ errorCode: 'TELEGRAM_500' }))
    ).toBe(true);
  });

  it('does NOT include free-text in eventPrefilter.provenance (§A6)', () => {
    expect(messagingDeliveryFailedRunbook.eventPrefilter.provenance).not.toContain(
      'free-text'
    );
  });

  it('match() rejects events from other subsystems', () => {
    const ev = makeEvent({ subsystem: 'memory' });
    expect(messagingDeliveryFailedRunbook.match(ev)).toBe(false);
  });

  it('Remediator.registerRunbook ACCEPTS this runbook (essential=false, process radius, no free-text)', () => {
    expect(() =>
      fx.remediator.registerRunbook(messagingDeliveryFailedRunbook)
    ).not.toThrow();
  });

  it('essential=false honors §A36 (process radius forbids essential=true)', () => {
    expect(messagingDeliveryFailedRunbook.essential).toBe(false);
    expect(messagingDeliveryFailedRunbook.blastRadius).toBe('process');
  });

  it('has priority=80, surface=delivery-retry, expectedRuntimeMs=60_000 per A1 manifest', () => {
    expect(messagingDeliveryFailedRunbook.id).toBe('messaging-delivery-failed');
    expect(messagingDeliveryFailedRunbook.priority).toBe(80);
    expect(messagingDeliveryFailedRunbook.surface).toBe('delivery-retry');
    expect(messagingDeliveryFailedRunbook.expectedRuntimeMs).toBe(60_000);
    expect(messagingDeliveryFailedRunbook.reversibility).toBe('reversible');
  });

  it('preconditions fail when deps are not wired', async () => {
    setMessagingDeliveryDeps(null);
    const ok = await messagingDeliveryFailedRunbook.preconditions(makeEvent());
    expect(ok).toBe(false);
  });

  it('preconditions succeed when manager is wired', async () => {
    const ok = await messagingDeliveryFailedRunbook.preconditions(makeEvent());
    expect(ok).toBe(true);
  });

  it('surfaceCallable invokes manager.invokeFromRemediator with ctx', async () => {
    const spy = vi.spyOn(fx.manager, 'invokeFromRemediator').mockResolvedValue({
      outcome: 'success',
      details: { retried: 1, expired: 0, escalated: 0, skipped: false },
    });

    const ctx = {
      attemptId: 'test-attempt',
      runbookId: 'messaging-delivery-failed',
      lockHandle: {} as never,
      auditToken: Buffer.from('test'),
      abortSignal: new AbortController().signal,
      expiresAt: Date.now() + 60_000,
      monotonicDeadline: process.hrtime.bigint() + 60_000_000_000n,
    };

    const result = await messagingDeliveryFailedRunbook.surfaceCallable(ctx);
    expect(result.outcome).toBe('success');
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0]).toBe(ctx);
  });

  it('verify() returns verified-healthy when inbox is drained (§A9)', async () => {
    _setVerifyImplForTesting(async () => ({ kind: 'ok' }));
    const result = await messagingDeliveryFailedRunbook.verify({} as never);
    expect(result.outcome).toBe('verified-healthy');
    expect(result.reason).toMatch(/drained/);
  });

  it('verify() returns verify-failed when messages are still stuck (§A9 durable)', async () => {
    _setVerifyImplForTesting(async () => ({
      kind: 'stuck',
      stuckCount: 3,
      sampleIds: ['msg-1', 'msg-2', 'msg-3'],
    }));
    const result = await messagingDeliveryFailedRunbook.verify({} as never);
    expect(result.outcome).toBe('verify-failed');
    expect(result.reason).toMatch(/3 messages still queued/);
    expect(result.reason).toMatch(/msg-1/);
  });

  it('verify() returns verify-inconclusive when store probe errors (§A21)', async () => {
    _setVerifyImplForTesting(async () => ({
      kind: 'inconclusive',
      reason: 'queryInbox threw: ENOENT',
    }));
    const result = await messagingDeliveryFailedRunbook.verify({} as never);
    expect(result.outcome).toBe('verify-inconclusive');
    expect(result.reason).toMatch(/ENOENT/);
  });

  it('verify() against real store: queued message → verify-failed (durable assertion, not live)', async () => {
    // Persist a queued envelope. Manager's invokeFromRemediator won't be
    // able to deliver because tmux says session changed mid-flight... but
    // the verify probe just looks at the store state.
    const stuck = makeEnvelope();
    await fx.store.save(stuck);

    // Default verify impl runs against the wired deps.
    const result = await messagingDeliveryFailedRunbook.verify({} as never);
    expect(result.outcome).toBe('verify-failed');
    expect(result.reason).toMatch(/1 messages still queued/);
  });

  it('verify() against real store: empty inbox → verified-healthy', async () => {
    const result = await messagingDeliveryFailedRunbook.verify({} as never);
    expect(result.outcome).toBe('verified-healthy');
  });

  it('end-to-end dispatch on TELEGRAM_429 → invokes manager → verifies durable drain', async () => {
    // Empty inbox at start → after dispatch verify should see clean drain.
    const invokeSpy = vi.spyOn(fx.manager, 'invokeFromRemediator');

    fx.remediator.registerRunbook(messagingDeliveryFailedRunbook);
    const ev = makeEvent({ errorCode: 'TELEGRAM_429' });
    const result = await fx.remediator.dispatch(ev);

    expect(result.outcome).toBe('verified-healthy');
    expect(invokeSpy).toHaveBeenCalledOnce();

    const entries = readProjection(fx.tmpDir, fx.machineId);
    expect(entries.map((e) => e.outcome)).toEqual([
      'started',
      'verified-healthy',
    ]);
    for (const entry of entries) {
      expect(entry.runbookId).toBe('messaging-delivery-failed');
    }
  });

  it('end-to-end dispatch with stuck messages → verify-failed audited', async () => {
    // Two stuck queued envelopes. Manager surface call returns success
    // (it processed what it could), but verify durably sees the stuck
    // state and reports verify-failed per §A9.
    await fx.store.save(makeEnvelope());
    await fx.store.save(makeEnvelope());

    // Stub deliverToSession via the manager's delivery to fail, so the
    // retry leaves them in queued state.
    vi.spyOn(
      (fx.manager as unknown as { delivery: { deliverToSession: () => unknown } })
        .delivery,
      'deliverToSession'
    ).mockResolvedValue({
      success: false,
      reason: 'synthetic test failure',
      action: 'queued',
    } as never);

    fx.remediator.registerRunbook(messagingDeliveryFailedRunbook);
    const ev = makeEvent({ errorCode: 'DELIVERY_FAILURE' });
    const result = await fx.remediator.dispatch(ev);

    expect(result.outcome).toBe('verify-failed');
    const entries = readProjection(fx.tmpDir, fx.machineId);
    const outcomes = entries.map((e) => e.outcome);
    expect(outcomes).toContain('verify-failed');
  });
});

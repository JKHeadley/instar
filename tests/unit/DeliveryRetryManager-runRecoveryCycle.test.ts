/**
 * Unit tests for DeliveryRetryManager.runRecoveryCycle + invokeFromRemediator
 * (W-3 surface entry-point).
 *
 * Covers SELF-HEALING-REMEDIATOR-V2-SPEC §A34 R3 surface-alignment:
 *   - `runRecoveryCycle()` exists as a public method distinct from `tick()`.
 *   - It is idempotent against the running timer (shared in-flight latch).
 *   - `invokeFromRemediator(ctx)` wraps it and returns ExecutionResult.
 *
 * Strategy: real MessageStore + MessageDelivery, controlled tmux fakes.
 * The latch-against-tick test deliberately reaches into a slow store impl
 * to keep one cycle in-flight while a second call races it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { MessageStore } from '../../src/messaging/MessageStore.js';
import { MessageDelivery, type TmuxOperations } from '../../src/messaging/MessageDelivery.js';
import { MessageFormatter } from '../../src/messaging/MessageFormatter.js';
import { DeliveryRetryManager } from '../../src/messaging/DeliveryRetryManager.js';
import type { MessageEnvelope, AgentMessage } from '../../src/messaging/types.js';
import type { RemediationContext } from '../../src/remediation/Remediator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// ── Helpers ──────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-w3-runcycle-'));
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

function makeCtx(): RemediationContext {
  return {
    attemptId: 'test-attempt-' + Math.random().toString(36).slice(2),
    runbookId: 'messaging-delivery-failed',
    lockHandle: {} as never,
    auditToken: Buffer.from('test-token'),
    abortSignal: new AbortController().signal,
    expiresAt: Date.now() + 60_000,
    monotonicDeadline: process.hrtime.bigint() + 60_000_000_000n,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('DeliveryRetryManager.runRecoveryCycle / invokeFromRemediator (W-3)', () => {
  let tmpDir: string;
  let store: MessageStore;
  let delivery: MessageDelivery;
  let manager: DeliveryRetryManager;

  beforeEach(async () => {
    tmpDir = createTempDir();
    store = new MessageStore(tmpDir);
    await store.initialize();
    delivery = new MessageDelivery(new MessageFormatter(), makeTmux());
    manager = new DeliveryRetryManager(store, delivery, {
      agentName: 'test-agent',
    });
  });

  afterEach(() => {
    manager.stop();
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/DeliveryRetryManager-runRecoveryCycle.test.ts:afterEach',
    });
  });

  it('exposes runRecoveryCycle as a distinct public method from tick (§A34 R3)', () => {
    expect(typeof manager.runRecoveryCycle).toBe('function');
    expect(typeof manager.tick).toBe('function');
    // They are different function references.
    expect(manager.runRecoveryCycle).not.toBe(manager.tick);
  });

  it('runRecoveryCycle returns the same shape as tick when inbox is empty', async () => {
    const result = await manager.runRecoveryCycle();
    expect(result.retried).toBe(0);
    expect(result.expired).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBeFalsy();
  });

  it('runRecoveryCycle processes queued messages identically to tick', async () => {
    // Add an expired envelope so runRecoveryCycle will dead-letter it.
    const envelope = makeEnvelope({
      ttlMinutes: 0, // already expired
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await store.save(envelope);

    const result = await manager.runRecoveryCycle();
    expect(result.expired).toBeGreaterThanOrEqual(1);
  });

  it('runRecoveryCycle is idempotent against an in-flight tick (shared latch)', async () => {
    // Drive the manager into a long cycle by stubbing the store's queryInbox
    // to never resolve until we let it.
    let releaseFirst: (() => void) | null = null;
    const realQuery = store.queryInbox.bind(store);
    let callCount = 0;
    store.queryInbox = async (agentName: string) => {
      callCount++;
      if (callCount === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return realQuery(agentName);
    };

    // Kick off tick(); it will block waiting on the stub.
    const tickPromise = manager.tick();

    // Wait a tick to ensure tick() has entered the latch.
    await new Promise((r) => setTimeout(r, 5));

    // Now call runRecoveryCycle — it MUST short-circuit with skipped:true.
    const concurrent = await manager.runRecoveryCycle();
    expect(concurrent).toEqual({
      retried: 0,
      expired: 0,
      escalated: 0,
      skipped: true,
    });

    // Release the first cycle.
    releaseFirst!();
    const tickResult = await tickPromise;
    expect(tickResult.skipped).toBeFalsy();
  });

  it('tick is idempotent against an in-flight runRecoveryCycle (same latch)', async () => {
    // Symmetric test: runRecoveryCycle in-flight blocks tick.
    let releaseFirst: (() => void) | null = null;
    const realQuery = store.queryInbox.bind(store);
    let callCount = 0;
    store.queryInbox = async (agentName: string) => {
      callCount++;
      if (callCount === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return realQuery(agentName);
    };

    const cyclePromise = manager.runRecoveryCycle();
    await new Promise((r) => setTimeout(r, 5));

    const tickResult = await manager.tick();
    expect(tickResult).toEqual({
      retried: 0,
      expired: 0,
      escalated: 0,
      skipped: true,
    });

    releaseFirst!();
    const cycleResult = await cyclePromise;
    expect(cycleResult.skipped).toBeFalsy();
  });

  it('latch resets after cycle completes — subsequent calls run normally', async () => {
    const first = await manager.runRecoveryCycle();
    expect(first.skipped).toBeFalsy();
    const second = await manager.runRecoveryCycle();
    expect(second.skipped).toBeFalsy();
    const third = await manager.tick();
    expect(third.skipped).toBeFalsy();
  });

  it('invokeFromRemediator wraps runRecoveryCycle and returns ExecutionResult success', async () => {
    const ctx = makeCtx();
    const result = await manager.invokeFromRemediator(ctx);
    expect(result.outcome).toBe('success');
    expect(result.details).toMatchObject({
      retried: 0,
      expired: 0,
      escalated: 0,
      skipped: false,
    });
  });

  it('invokeFromRemediator returns failure when runRecoveryCycle throws', async () => {
    // Force queryInbox to throw.
    store.queryInbox = async () => {
      throw new Error('synthetic store failure');
    };
    const ctx = makeCtx();
    const result = await manager.invokeFromRemediator(ctx);
    expect(result.outcome).toBe('failure');
    expect((result.details as { error?: string }).error).toMatch(/synthetic/);
  });

  it('invokeFromRemediator reports skipped:true when cycle is already in-flight', async () => {
    let releaseFirst: (() => void) | null = null;
    let callCount = 0;
    const realQuery = store.queryInbox.bind(store);
    store.queryInbox = async (agentName: string) => {
      callCount++;
      if (callCount === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return realQuery(agentName);
    };

    const inFlight = manager.tick();
    await new Promise((r) => setTimeout(r, 5));

    const ctx = makeCtx();
    const result = await manager.invokeFromRemediator(ctx);
    expect(result.outcome).toBe('success');
    expect((result.details as { skipped?: boolean }).skipped).toBe(true);

    releaseFirst!();
    await inFlight;
  });

  it('stop() clears the in-flight latch (recycle-safe)', async () => {
    // Manually set the latch — simulating a stuck flag from a crashed cycle.
    (manager as unknown as { cycleInFlight: boolean }).cycleInFlight = true;
    manager.stop();
    const result = await manager.runRecoveryCycle();
    expect(result.skipped).toBeFalsy();
  });

  it('existing tick() return shape unchanged (no skipped key) when cycle runs normally', async () => {
    const result = await manager.tick();
    expect(result.retried).toBe(0);
    expect(result.expired).toBe(0);
    expect(result.escalated).toBe(0);
    // skipped is optional; missing/falsy when the cycle actually ran.
    expect(result.skipped).toBeFalsy();
  });
});

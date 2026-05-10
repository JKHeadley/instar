/**
 * Tests for ThreadlineFlowBridge — resumes TaskFlow flows on inbound
 * cross-agent-callback messages.
 *
 * End-to-end shape (spec Phase 2): Echo creates a flow, sets it waiting on
 * `cross-agent-callback`, an envelope arrives via the bridge, the flow
 * resumes, and the wait-fired event carries the message correlation key.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TaskFlowStore } from '../../src/tasks/task-flow-registry.store.sqlite.js';
import { TaskFlowRegistry } from '../../src/tasks/TaskFlowRegistry.js';
import { ThreadlineFlowBridge } from '../../src/tasks/ThreadlineFlowBridge.js';
import type { MessageEnvelope } from '../../src/messaging/types.js';

interface Rig {
  dir: string;
  store: TaskFlowStore;
  registry: TaskFlowRegistry;
  bridge: ThreadlineFlowBridge;
  cleanup: () => void;
}

async function rig(): Promise<Rig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-bridge-test-'));
  const store = new TaskFlowStore({ dbPath: path.join(dir, 'task-flows.db') });
  await store.open();
  const registry = new TaskFlowRegistry({ store });
  const bridge = new ThreadlineFlowBridge({ registry });
  return {
    dir,
    store,
    registry,
    bridge,
    cleanup: () => {
      store.close();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/threadline-flow-bridge.test.ts' });
    },
  };
}

const ctrl = {
  scope: 'controller' as const,
  controllerId: 'EvolutionManager',
  controllerInstanceId: 'inst-1',
};

const baseInput = {
  ownerKey: 'cluster:abc',
  controllerId: 'EvolutionManager',
  controllerInstanceId: 'inst-1',
  idempotencyKey: 'idem-bridge-1234567890',
  goal: 'cross-agent collaboration with Dawn',
};

const correlationId = 'a'.repeat(32);
const threadId = 'thread-uuid-1';
const expectedAgentId = 'Dawn';

function envelope(opts: {
  fromAgent: string;
  threadId?: string;
  payloadCorrelation?: string;
  bodyCorrelation?: string;
  body?: string;
  payload?: Record<string, unknown>;
}): MessageEnvelope {
  return {
    schemaVersion: 1,
    message: {
      id: 'msg-' + Math.random().toString(36).slice(2),
      from: { agent: opts.fromAgent, session: 's', machine: 'local' },
      to: { agent: 'Echo', session: 's', machine: 'local' },
      type: 'response',
      priority: 'medium',
      subject: 'reply',
      body: opts.body ?? (opts.bodyCorrelation ? `prefix [correlation:${opts.bodyCorrelation}] suffix` : ''),
      createdAt: new Date().toISOString(),
      ttlMinutes: 30,
      threadId: opts.threadId,
      payload: opts.payload ?? (opts.payloadCorrelation ? { correlationId: opts.payloadCorrelation } : undefined),
    },
    transport: {
      relayChain: [],
      originServer: 'http://localhost:4042',
      nonce: 'nonce',
      timestamp: new Date().toISOString(),
    },
    delivery: {
      phase: 'received',
      transitions: [],
      attempts: 1,
    },
  };
}

async function makeWaitingFlow(r: Rig) {
  const { flow: f0 } = await r.registry.createFlow(baseInput);
  await r.registry.startStep({
    flowId: f0.flowId,
    expectedRevision: 1,
    principal: ctrl,
    currentStep: 'awaiting-dawn-reply',
  });
  const { flow: f2 } = await r.registry.setFlowWaiting({
    flowId: f0.flowId,
    expectedRevision: 2,
    principal: ctrl,
    waitJson: {
      kind: 'cross-agent-callback',
      threadId,
      correlationId,
      expectedAgentId,
    },
  });
  return f2;
}

describe('ThreadlineFlowBridge', () => {
  let r: Rig;
  beforeEach(async () => { r = await rig(); });
  afterEach(() => { r.cleanup(); });

  it('resumes a waiting flow when correlation + thread + sender all match', async () => {
    const waiting = await makeWaitingFlow(r);
    let fired: any = null;
    r.registry.on('taskflow:wait-fired', (e) => { fired = e; });

    const result = await r.bridge.consumeInbound(envelope({
      fromAgent: 'Dawn',
      threadId,
      payloadCorrelation: correlationId,
    }));

    expect(result.resumed).toBe(true);
    expect(result.flowIds).toEqual([waiting.flowId]);
    const after = r.registry.getFlow(waiting.flowId, { bypassCache: true })!;
    expect(after.status).toBe('running');
    expect(fired?.flowId).toBe(waiting.flowId);
    expect(fired?.waitKind).toBe('cross-agent-callback');
    expect(fired?.correlationId).toBe(correlationId);
  });

  it('falls back to extracting correlationId from body token', async () => {
    const waiting = await makeWaitingFlow(r);
    const result = await r.bridge.consumeInbound(envelope({
      fromAgent: 'Dawn',
      threadId,
      bodyCorrelation: correlationId,
    }));
    expect(result.resumed).toBe(true);
    expect(result.flowIds).toEqual([waiting.flowId]);
  });

  it('rejects when sender agent does not match expectedAgentId (spoof defense)', async () => {
    await makeWaitingFlow(r);
    const result = await r.bridge.consumeInbound(envelope({
      fromAgent: 'Mallory',
      threadId,
      payloadCorrelation: correlationId,
    }));
    expect(result.resumed).toBe(false);
    expect(result.reason).toBe('agent-id-mismatch');
  });

  it('rejects when threadId does not match', async () => {
    await makeWaitingFlow(r);
    const result = await r.bridge.consumeInbound(envelope({
      fromAgent: 'Dawn',
      threadId: 'wrong-thread',
      payloadCorrelation: correlationId,
    }));
    expect(result.resumed).toBe(false);
    expect(result.reason).toBe('thread-id-mismatch');
  });

  it('returns no-correlation-id when neither payload nor body carries one', async () => {
    await makeWaitingFlow(r);
    const result = await r.bridge.consumeInbound(envelope({
      fromAgent: 'Dawn',
      threadId,
      body: 'just a normal reply, no correlation token',
    }));
    expect(result.resumed).toBe(false);
    expect(result.reason).toBe('no-correlation-id');
  });

  it('returns no-matching-flow when correlationId does not match any waiting flow', async () => {
    await makeWaitingFlow(r);
    const result = await r.bridge.consumeInbound(envelope({
      fromAgent: 'Dawn',
      threadId,
      payloadCorrelation: 'b'.repeat(32),
    }));
    expect(result.resumed).toBe(false);
    expect(result.reason).toBe('no-matching-flow');
  });

  it('returns already-consumed when fired twice', async () => {
    await makeWaitingFlow(r);
    const first = await r.bridge.consumeInbound(envelope({
      fromAgent: 'Dawn',
      threadId,
      payloadCorrelation: correlationId,
    }));
    expect(first.resumed).toBe(true);

    const second = await r.bridge.consumeInbound(envelope({
      fromAgent: 'Dawn',
      threadId,
      payloadCorrelation: correlationId,
    }));
    expect(second.resumed).toBe(false);
    // After resume the flow is `running` and is no longer in the
    // findWaitingByCorrelation result set, so the bridge sees no-matching-flow.
    expect(['no-matching-flow', 'already-consumed']).toContain(second.reason);
  });

  it('does not resume a non-waiting flow with the same correlationId', async () => {
    const waiting = await makeWaitingFlow(r);
    // Resume normally (controller path), then try the bridge — must NOT re-resume.
    await r.registry.resumeFlow({
      flowId: waiting.flowId,
      expectedRevision: waiting.revision,
      principal: ctrl,
      waitInstanceId: waiting.waitInstanceId!,
    });
    const result = await r.bridge.consumeInbound(envelope({
      fromAgent: 'Dawn',
      threadId,
      payloadCorrelation: correlationId,
    }));
    expect(result.resumed).toBe(false);
  });
});

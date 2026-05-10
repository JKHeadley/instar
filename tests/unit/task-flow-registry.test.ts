/**
 * Tests for TaskFlowRegistry — durable multi-step job records with OCC.
 *
 * Real SQLite DBs (no mocking). Verifies the contract from
 * docs/specs/OPENCLAW-IMPORT-TASKFLOW-SPEC.md § Mutation Semantics.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TaskFlowStore } from '../../src/tasks/task-flow-registry.store.sqlite.js';
import { TaskFlowRegistry } from '../../src/tasks/TaskFlowRegistry.js';
import { TaskFlowMaintenanceSweeper } from '../../src/tasks/TaskFlowMaintenanceSweeper.js';
import { TaskFlowDueWaker } from '../../src/tasks/TaskFlowDueWaker.js';
import {
  TaskFlowError,
  CreateFlowInput,
  TaskFlowPrincipal,
  WaitJson,
} from '../../src/tasks/task-flow-types.js';

interface TestRig {
  dir: string;
  store: TaskFlowStore;
  registry: TaskFlowRegistry;
  clock: { now: number };
  cleanup: () => Promise<void>;
}

async function rig(): Promise<TestRig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-test-'));
  const store = new TaskFlowStore({ dbPath: path.join(dir, 'task-flows.db') });
  await store.open();
  const clock = { now: 1_700_000_000_000 };
  const registry = new TaskFlowRegistry({ store, now: () => clock.now });
  return {
    dir,
    store,
    registry,
    clock,
    cleanup: async () => {
      store.close();
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/task-flow-registry.test.ts',
      });
    },
  };
}

const baseInput: CreateFlowInput = {
  ownerKey: 'cluster:abc-123',
  controllerId: 'EvolutionManager',
  controllerInstanceId: 'inst-1',
  idempotencyKey: 'idem-create-1234567890',
  goal: 'tier-1 fix attempt for duplicate-reply cluster',
};

const ctrl: TaskFlowPrincipal = {
  scope: 'controller',
  controllerId: 'EvolutionManager',
  controllerInstanceId: 'inst-1',
};

describe('TaskFlowRegistry — createFlow', () => {
  let r: TestRig;
  beforeEach(async () => { r = await rig(); });
  afterEach(async () => { await r.cleanup(); });

  it('creates a queued flow with revision=1', async () => {
    const { flow, created } = await r.registry.createFlow(baseInput);
    expect(created).toBe(true);
    expect(flow.status).toBe('queued');
    expect(flow.revision).toBe(1);
    expect(flow.controllerId).toBe('EvolutionManager');
    expect(flow.flowId).toMatch(/^[0-9a-f-]{36}$/);
    expect(flow.createdAt).toBe(r.clock.now);
  });

  it('idempotently returns the same flow on duplicate idempotencyKey', async () => {
    const a = await r.registry.createFlow(baseInput);
    const b = await r.registry.createFlow(baseInput);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.flow.flowId).toBe(a.flow.flowId);
  });

  it('rejects oversized goal', async () => {
    await expect(
      r.registry.createFlow({ ...baseInput, goal: 'x'.repeat(2000) })
    ).rejects.toThrow(TaskFlowError);
  });

  it('rejects use of reserved TaskFlowMaintenance controllerId', async () => {
    await expect(
      r.registry.createFlow({ ...baseInput, controllerId: 'TaskFlowMaintenance' })
    ).rejects.toThrow(/TaskFlowMaintenance/);
  });
});

describe('TaskFlowRegistry — startStep / setFlowWaiting / resumeFlow / finishFlow', () => {
  let r: TestRig;
  beforeEach(async () => { r = await rig(); });
  afterEach(async () => { await r.cleanup(); });

  it('walks queued → running → waiting → running → succeeded', async () => {
    const { flow: f0 } = await r.registry.createFlow(baseInput);
    const { flow: f1 } = await r.registry.startStep({
      flowId: f0.flowId,
      expectedRevision: 1,
      principal: ctrl,
      currentStep: 'tier-1-fix-attempt',
    });
    expect(f1.status).toBe('running');
    expect(f1.revision).toBe(2);

    const wait: WaitJson = {
      kind: 'human-review',
      question: 'Approve the tier-1 fix?',
      topicId: 9000,
    };
    const { flow: f2 } = await r.registry.setFlowWaiting({
      flowId: f0.flowId,
      expectedRevision: 2,
      principal: ctrl,
      waitJson: wait,
    });
    expect(f2.status).toBe('waiting');
    expect(f2.waitInstanceId).toBeTruthy();
    expect(f2.waitStartedAt).toBe(r.clock.now);

    const { flow: f3 } = await r.registry.resumeFlow({
      flowId: f0.flowId,
      expectedRevision: 3,
      principal: ctrl,
      waitInstanceId: f2.waitInstanceId!,
    });
    expect(f3.status).toBe('running');
    expect(f3.waitInstanceId).toBeUndefined();

    const { flow: f4 } = await r.registry.finishFlow({
      flowId: f0.flowId,
      expectedRevision: 4,
      principal: ctrl,
      result: { ok: true },
    });
    expect(f4.status).toBe('succeeded');
    expect(f4.endedAt).toBe(r.clock.now);
    expect((f4.stateJson as any)._result.ok).toBe(true);
  });

  it('rejects setFlowWaiting from queued', async () => {
    const { flow: f0 } = await r.registry.createFlow(baseInput);
    await expect(
      r.registry.setFlowWaiting({
        flowId: f0.flowId,
        expectedRevision: 1,
        principal: ctrl,
        waitJson: { kind: 'human-review', question: 'q' },
      })
    ).rejects.toMatchObject({ code: 'invalid_transition' });
  });

  it('returns revision_conflict on stale expectedRevision', async () => {
    const { flow: f0 } = await r.registry.createFlow(baseInput);
    await r.registry.startStep({
      flowId: f0.flowId,
      expectedRevision: 1,
      principal: ctrl,
      currentStep: 'tier-1-fix-attempt',
    });
    await expect(
      r.registry.startStep({
        flowId: f0.flowId,
        expectedRevision: 1, // stale
        principal: ctrl,
        currentStep: 'tier-1-fix-attempt',
      })
    ).rejects.toMatchObject({ code: 'revision_conflict' });
  });

  it('returns not_found for unknown flowId', async () => {
    await expect(
      r.registry.startStep({
        flowId: 'no-such-flow',
        expectedRevision: 1,
        principal: ctrl,
        currentStep: 's',
      })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects waitInstanceId mismatch on resume', async () => {
    const { flow: f0 } = await r.registry.createFlow(baseInput);
    await r.registry.startStep({
      flowId: f0.flowId,
      expectedRevision: 1,
      principal: ctrl,
      currentStep: 's1',
    });
    const { flow: f2 } = await r.registry.setFlowWaiting({
      flowId: f0.flowId,
      expectedRevision: 2,
      principal: ctrl,
      waitJson: { kind: 'human-review', question: 'q' },
    });
    await expect(
      r.registry.resumeFlow({
        flowId: f0.flowId,
        expectedRevision: f2.revision,
        principal: ctrl,
        waitInstanceId: 'wrong-id',
      })
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  it('detects reply wait collisions', async () => {
    const { flow: f0 } = await r.registry.createFlow(baseInput);
    await r.registry.startStep({
      flowId: f0.flowId,
      expectedRevision: 1,
      principal: ctrl,
      currentStep: 's1',
    });
    const reply: WaitJson = {
      kind: 'reply',
      channel: 'telegram',
      threadId: '9000',
      peer: 'justin',
    };
    await r.registry.setFlowWaiting({
      flowId: f0.flowId,
      expectedRevision: 2,
      principal: ctrl,
      waitJson: reply,
    });
    // Second flow under same controller cannot create the same reply wait.
    const second = await r.registry.createFlow({
      ...baseInput,
      idempotencyKey: 'idem-create-second-1',
      ownerKey: 'cluster:other',
    });
    await r.registry.startStep({
      flowId: second.flow.flowId,
      expectedRevision: 1,
      principal: ctrl,
      currentStep: 's1',
    });
    await expect(
      r.registry.setFlowWaiting({
        flowId: second.flow.flowId,
        expectedRevision: 2,
        principal: ctrl,
        waitJson: reply,
      })
    ).rejects.toMatchObject({ code: 'wait_collision' });
  });
});

describe('TaskFlowRegistry — terminal + cancel', () => {
  let r: TestRig;
  beforeEach(async () => { r = await rig(); });
  afterEach(async () => { await r.cleanup(); });

  it('rejects mutations on terminal flows with already_terminal', async () => {
    const { flow: f0 } = await r.registry.createFlow(baseInput);
    await r.registry.startStep({
      flowId: f0.flowId,
      expectedRevision: 1,
      principal: ctrl,
      currentStep: 's1',
    });
    await r.registry.finishFlow({
      flowId: f0.flowId,
      expectedRevision: 2,
      principal: ctrl,
    });
    await expect(
      r.registry.startStep({
        flowId: f0.flowId,
        expectedRevision: 3,
        principal: ctrl,
        currentStep: 's2',
      })
    ).rejects.toMatchObject({ code: 'already_terminal' });
  });

  it('cancelFlow requires prior requestFlowCancel', async () => {
    const { flow: f0 } = await r.registry.createFlow(baseInput);
    await expect(
      r.registry.cancelFlow({
        flowId: f0.flowId,
        expectedRevision: 1,
        principal: ctrl,
      })
    ).rejects.toMatchObject({ code: 'invalid_transition' });
  });

  it('requestFlowCancel emits taskflow:cancel-requested when waiting', async () => {
    const { flow: f0 } = await r.registry.createFlow(baseInput);
    await r.registry.startStep({
      flowId: f0.flowId,
      expectedRevision: 1,
      principal: ctrl,
      currentStep: 's1',
    });
    await r.registry.setFlowWaiting({
      flowId: f0.flowId,
      expectedRevision: 2,
      principal: ctrl,
      waitJson: { kind: 'human-review', question: 'q' },
    });
    let fired: any = null;
    r.registry.on('taskflow:cancel-requested', (e) => { fired = e; });
    await r.registry.requestFlowCancel({
      flowId: f0.flowId,
      expectedRevision: 3,
      requesterOrigin: { kind: 'user', id: 'justin' },
    });
    expect(fired?.flowId).toBe(f0.flowId);
  });
});

describe('TaskFlowRegistry — pingFlow', () => {
  let r: TestRig;
  beforeEach(async () => { r = await rig(); });
  afterEach(async () => { await r.cleanup(); });

  it('updates heartbeat without bumping revision', async () => {
    const { flow: f0 } = await r.registry.createFlow(baseInput);
    await r.registry.startStep({
      flowId: f0.flowId,
      expectedRevision: 1,
      principal: ctrl,
      currentStep: 's1',
    });
    r.clock.now += 1000;
    const pinged = await r.registry.pingFlow({ flowId: f0.flowId, principal: ctrl });
    expect(pinged.revision).toBe(2); // unchanged
    expect(pinged.controllerHeartbeatAt).toBe(r.clock.now);
  });

  it('rebinds controllerInstanceId on ping (re-attach)', async () => {
    const { flow: f0 } = await r.registry.createFlow(baseInput);
    await r.registry.startStep({
      flowId: f0.flowId,
      expectedRevision: 1,
      principal: ctrl,
      currentStep: 's1',
    });
    const reattach: TaskFlowPrincipal = {
      scope: 'controller',
      controllerId: 'EvolutionManager',
      controllerInstanceId: 'inst-2-after-restart',
    };
    const pinged = await r.registry.pingFlow({ flowId: f0.flowId, principal: reattach });
    expect(pinged.controllerInstanceId).toBe('inst-2-after-restart');
  });

  it('rejects ping on non-running flow', async () => {
    const { flow: f0 } = await r.registry.createFlow(baseInput);
    await expect(
      r.registry.pingFlow({ flowId: f0.flowId, principal: ctrl })
    ).rejects.toMatchObject({ code: 'invalid_transition' });
  });

  it('rejects ping with wrong controllerId', async () => {
    const { flow: f0 } = await r.registry.createFlow(baseInput);
    await r.registry.startStep({
      flowId: f0.flowId,
      expectedRevision: 1,
      principal: ctrl,
      currentStep: 's1',
    });
    const other: TaskFlowPrincipal = {
      scope: 'controller',
      controllerId: 'InitiativeTracker',
      controllerInstanceId: 'inst-x',
    };
    await expect(
      r.registry.pingFlow({ flowId: f0.flowId, principal: other })
    ).rejects.toMatchObject({ code: 'unauthorized_controller' });
  });
});

describe('TaskFlowMaintenanceSweeper', () => {
  let r: TestRig;
  beforeEach(async () => { r = await rig(); });
  afterEach(async () => { await r.cleanup(); });

  it('marks running flow lost when heartbeat is stale', async () => {
    const { flow: f0 } = await r.registry.createFlow(baseInput);
    await r.registry.startStep({
      flowId: f0.flowId,
      expectedRevision: 1,
      principal: ctrl,
      currentStep: 's1',
    });
    // Advance clock past RUNNING_LOST (6h default).
    r.clock.now += 7 * 60 * 60 * 1000;
    const sweeper = new TaskFlowMaintenanceSweeper({
      registry: r.registry,
      store: r.store,
      now: () => r.clock.now,
    });
    const counts = await sweeper.sweep();
    expect(counts.scanned).toBeGreaterThanOrEqual(1);
    expect(counts.marked).toBe(1);
    const after = r.registry.getFlow(f0.flowId, { bypassCache: true })!;
    expect(after.status).toBe('lost');
    expect(after.supersededBy?.reason).toBe('lost');
  });

  it('does NOT mark a fresh running flow lost', async () => {
    const { flow: f0 } = await r.registry.createFlow(baseInput);
    await r.registry.startStep({
      flowId: f0.flowId,
      expectedRevision: 1,
      principal: ctrl,
      currentStep: 's1',
    });
    const sweeper = new TaskFlowMaintenanceSweeper({
      registry: r.registry,
      store: r.store,
      now: () => r.clock.now,
    });
    const counts = await sweeper.sweep();
    expect(counts.marked).toBe(0);
  });

  it('exempts scheduled-tick waits from lost-eligibility', async () => {
    const { flow: f0 } = await r.registry.createFlow(baseInput);
    await r.registry.startStep({
      flowId: f0.flowId,
      expectedRevision: 1,
      principal: ctrl,
      currentStep: 's1',
    });
    await r.registry.setFlowWaiting({
      flowId: f0.flowId,
      expectedRevision: 2,
      principal: ctrl,
      waitJson: { kind: 'scheduled-tick', dueAt: r.clock.now + 30 * 24 * 60 * 60 * 1000 },
    });
    r.clock.now += 365 * 24 * 60 * 60 * 1000; // a year
    const sweeper = new TaskFlowMaintenanceSweeper({
      registry: r.registry,
      store: r.store,
      now: () => r.clock.now,
    });
    const counts = await sweeper.sweep();
    expect(counts.marked).toBe(0);
  });
});

describe('TaskFlowDueWaker', () => {
  let r: TestRig;
  beforeEach(async () => { r = await rig(); });
  afterEach(async () => { await r.cleanup(); });

  it('resumes scheduled-tick waits whose dueAt has passed', async () => {
    const { flow: f0 } = await r.registry.createFlow(baseInput);
    await r.registry.startStep({
      flowId: f0.flowId,
      expectedRevision: 1,
      principal: ctrl,
      currentStep: 's1',
    });
    const dueAt = r.clock.now + 1000;
    await r.registry.setFlowWaiting({
      flowId: f0.flowId,
      expectedRevision: 2,
      principal: ctrl,
      waitJson: { kind: 'scheduled-tick', dueAt },
    });

    // Before dueAt: tick wakes nothing.
    const waker = new TaskFlowDueWaker({ registry: r.registry, now: () => r.clock.now });
    expect(await waker.tick()).toBe(0);

    // After dueAt: tick resumes.
    r.clock.now += 2000;
    let firedFlowId = '';
    r.registry.on('taskflow:wait-fired', (e) => { firedFlowId = e.flowId; });
    expect(await waker.tick()).toBe(1);
    expect(firedFlowId).toBe(f0.flowId);
    const after = r.registry.getFlow(f0.flowId, { bypassCache: true })!;
    expect(after.status).toBe('running');
    expect(after.waitInstanceId).toBeUndefined();
  });
});

describe('TaskFlowRegistry — find* lookups', () => {
  let r: TestRig;
  beforeEach(async () => { r = await rig(); });
  afterEach(async () => { await r.cleanup(); });

  it('findWaitingByCorrelation matches cross-agent-callback waits', async () => {
    const { flow: f0 } = await r.registry.createFlow(baseInput);
    await r.registry.startStep({
      flowId: f0.flowId,
      expectedRevision: 1,
      principal: ctrl,
      currentStep: 's1',
    });
    const correlationId = 'a'.repeat(32);
    await r.registry.setFlowWaiting({
      flowId: f0.flowId,
      expectedRevision: 2,
      principal: ctrl,
      waitJson: {
        kind: 'cross-agent-callback',
        threadId: 'th-1',
        correlationId,
        expectedAgentId: 'Dawn',
      },
    });
    const matches = r.registry.findWaitingByCorrelation({
      waitKind: 'cross-agent-callback',
      correlationId,
    });
    expect(matches.length).toBe(1);
    expect(matches[0].flowId).toBe(f0.flowId);
  });

  it('findWaitingByReply matches reply waits by tuple', async () => {
    const { flow: f0 } = await r.registry.createFlow(baseInput);
    await r.registry.startStep({
      flowId: f0.flowId,
      expectedRevision: 1,
      principal: ctrl,
      currentStep: 's1',
    });
    await r.registry.setFlowWaiting({
      flowId: f0.flowId,
      expectedRevision: 2,
      principal: ctrl,
      waitJson: { kind: 'reply', channel: 'telegram', threadId: '9000', peer: 'justin' },
    });
    const matches = r.registry.findWaitingByReply({
      channel: 'telegram',
      threadId: '9000',
      peer: 'justin',
    });
    expect(matches.length).toBe(1);
    expect(matches[0].flowId).toBe(f0.flowId);
  });
});

describe('TaskFlowRegistry — redaction', () => {
  let r: TestRig;
  beforeEach(async () => { r = await rig(); });
  afterEach(async () => { await r.cleanup(); });

  it('getRedactedFlow strips stateJson and waitJson identifying fields', async () => {
    const { flow: f0 } = await r.registry.createFlow({
      ...baseInput,
      stateJson: { secret: 'do-not-leak' },
    });
    await r.registry.startStep({
      flowId: f0.flowId,
      expectedRevision: 1,
      principal: ctrl,
      currentStep: 's1',
    });
    await r.registry.setFlowWaiting({
      flowId: f0.flowId,
      expectedRevision: 2,
      principal: ctrl,
      waitJson: {
        kind: 'reply',
        channel: 'telegram',
        threadId: '9000',
        peer: 'justin',
      },
    });
    const redacted = r.registry.getRedactedFlow(f0.flowId)!;
    expect(redacted.stateJson).toBeUndefined();
    expect(redacted.waitJson).toEqual({ kind: 'reply' });
  });
});

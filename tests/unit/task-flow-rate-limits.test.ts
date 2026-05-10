/**
 * Tests for TaskFlow Phase 5 — per-controller rate limits and per-flow ping limits.
 * Spec: docs/specs/OPENCLAW-IMPORT-TASKFLOW-SPEC.md § Phase 5 line 650-653;
 *       § Threat Model lines 679, 685.
 *
 * Real SQLite (no mocking). Verifies:
 *  - createFlow throws quota_exceeded with code='rate_limit' at threshold
 *  - createFlow throws quota_exceeded with code='max_active' beyond max-active cap
 *  - pingFlow throws quota_exceeded with code='rate_limited' at threshold
 *  - configurability is honored (overrides take effect)
 *  - 429 details include retryAfterMs
 *  - idempotent replay does NOT count against the create rate limit
 *  - terminal transitions release active-count slots
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TaskFlowStore } from '../../src/tasks/task-flow-registry.store.sqlite.js';
import { TaskFlowRegistry } from '../../src/tasks/TaskFlowRegistry.js';
import {
  TaskFlowError,
  CreateFlowInput,
  TaskFlowPrincipal,
} from '../../src/tasks/task-flow-types.js';

interface TestRig {
  dir: string;
  store: TaskFlowStore;
  registry: TaskFlowRegistry;
  clock: { now: number };
  cleanup: () => Promise<void>;
}

async function rig(opts: {
  createPerSec?: number;
  maxActive?: number;
  pingPerMin?: number;
} = {}): Promise<TestRig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ratelim-'));
  const store = new TaskFlowStore({ dbPath: path.join(dir, 'task-flows.db') });
  await store.open();
  const clock = { now: 1_700_000_000_000 };
  const registry = new TaskFlowRegistry({
    store,
    now: () => clock.now,
    rateLimits: {
      createPerSecPerController: opts.createPerSec ?? 3,
      maxActivePerController: opts.maxActive ?? 5,
      pingPerMinPerFlow: opts.pingPerMin ?? 4,
    },
  });
  return {
    dir,
    store,
    registry,
    clock,
    cleanup: async () => {
      store.close();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/task-flow-rate-limits.test.ts' });
    },
  };
}

function inputFor(n: number, controllerId = 'Phase5Ctrl'): CreateFlowInput {
  return {
    ownerKey: `owner-${n}`,
    controllerId,
    controllerInstanceId: 'inst-1',
    idempotencyKey: `idem-${controllerId}-${n}-aaaaaaaaaa`,
    goal: `goal ${n}`,
  };
}

const ctrlPrincipal = (controllerId = 'Phase5Ctrl'): TaskFlowPrincipal => ({
  scope: 'controller',
  controllerId,
  controllerInstanceId: 'inst-1',
});

describe('TaskFlowRegistry — Phase 5 createFlow rate limit', () => {
  let r: TestRig;
  beforeEach(async () => { r = await rig({ createPerSec: 3 }); });
  afterEach(async () => { await r.cleanup(); });

  it('allows up to N creates per second per controllerId', async () => {
    for (let i = 0; i < 3; i++) {
      const out = await r.registry.createFlow(inputFor(i));
      expect(out.created).toBe(true);
    }
  });

  it('rejects the (N+1)th create within the same window with quota_exceeded', async () => {
    for (let i = 0; i < 3; i++) {
      await r.registry.createFlow(inputFor(i));
    }
    let err: TaskFlowError | null = null;
    try {
      await r.registry.createFlow(inputFor(3));
    } catch (e) {
      err = e as TaskFlowError;
    }
    expect(err).toBeInstanceOf(TaskFlowError);
    expect(err!.code).toBe('quota_exceeded');
    expect((err!.detail as any).code).toBe('rate_limit');
    expect((err!.detail as any).limit).toBe(3);
    expect((err!.detail as any).retryAfterMs).toBeGreaterThan(0);
    expect((err!.detail as any).retryAfterMs).toBeLessThanOrEqual(1000);
  });

  it('per-controller isolation — one controller cannot starve another', async () => {
    for (let i = 0; i < 3; i++) {
      await r.registry.createFlow(inputFor(i, 'A'));
    }
    // Controller A is exhausted; controller B still has its own bucket.
    const out = await r.registry.createFlow(inputFor(0, 'B'));
    expect(out.created).toBe(true);
  });

  it('allows creation again after the window slides', async () => {
    for (let i = 0; i < 3; i++) {
      await r.registry.createFlow(inputFor(i));
    }
    await expect(r.registry.createFlow(inputFor(3))).rejects.toThrow(TaskFlowError);
    r.clock.now += 1_100; // > 1s
    const out = await r.registry.createFlow(inputFor(3));
    expect(out.created).toBe(true);
  });

  it('idempotent replay does NOT count against the rate limit', async () => {
    // Burn the bucket
    for (let i = 0; i < 3; i++) {
      await r.registry.createFlow(inputFor(i));
    }
    // Same key for any existing flow — should short-circuit and not throw.
    const replay = await r.registry.createFlow(inputFor(0));
    expect(replay.created).toBe(false);
  });
});

describe('TaskFlowRegistry — Phase 5 max-active-per-controller', () => {
  let r: TestRig;
  // Use very generous create rate so we only see max_active hits.
  beforeEach(async () => { r = await rig({ createPerSec: 1_000_000, maxActive: 2 }); });
  afterEach(async () => { await r.cleanup(); });

  it('rejects beyond the max-active cap with code=max_active', async () => {
    await r.registry.createFlow(inputFor(0));
    await r.registry.createFlow(inputFor(1));
    let err: TaskFlowError | null = null;
    try {
      await r.registry.createFlow(inputFor(2));
    } catch (e) {
      err = e as TaskFlowError;
    }
    expect(err).toBeInstanceOf(TaskFlowError);
    expect(err!.code).toBe('quota_exceeded');
    expect((err!.detail as any).code).toBe('max_active');
    expect((err!.detail as any).limit).toBe(2);
    expect((err!.detail as any).currentActive).toBe(2);
  });

  it('releases a slot when a flow goes terminal', async () => {
    const a = await r.registry.createFlow(inputFor(0));
    await r.registry.createFlow(inputFor(1));
    // Drive a to terminal.
    const started = await r.registry.startStep({
      flowId: a.flow.flowId,
      expectedRevision: a.flow.revision,
      principal: ctrlPrincipal(),
      currentStep: 'work',
    });
    await r.registry.finishFlow({
      flowId: a.flow.flowId,
      expectedRevision: started.flow.revision,
      principal: ctrlPrincipal(),
    });
    // Now creating another should succeed (active count back to 1).
    const c = await r.registry.createFlow(inputFor(2));
    expect(c.created).toBe(true);
  });
});

describe('TaskFlowRegistry — Phase 5 pingFlow rate limit', () => {
  let r: TestRig;
  beforeEach(async () => { r = await rig({ pingPerMin: 4 }); });
  afterEach(async () => { await r.cleanup(); });

  it('allows up to N pings per minute per flow, then rejects', async () => {
    const { flow } = await r.registry.createFlow(inputFor(0));
    await r.registry.startStep({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      principal: ctrlPrincipal(),
      currentStep: 'work',
    });
    for (let i = 0; i < 4; i++) {
      r.clock.now += 100; // small advance to keep all in window
      const p = await r.registry.pingFlow({ flowId: flow.flowId, principal: ctrlPrincipal() });
      expect(p).toBeTruthy();
    }
    r.clock.now += 100;
    let err: TaskFlowError | null = null;
    try {
      await r.registry.pingFlow({ flowId: flow.flowId, principal: ctrlPrincipal() });
    } catch (e) {
      err = e as TaskFlowError;
    }
    expect(err).toBeInstanceOf(TaskFlowError);
    expect(err!.code).toBe('quota_exceeded');
    expect((err!.detail as any).code).toBe('rate_limited');
    expect((err!.detail as any).limit).toBe(4);
    expect((err!.detail as any).retryAfterMs).toBeGreaterThan(0);
    expect((err!.detail as any).retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it('bogus principal (unauthorized) is rejected BEFORE the rate counter increments', async () => {
    const { flow } = await r.registry.createFlow(inputFor(0));
    await r.registry.startStep({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      principal: ctrlPrincipal(),
      currentStep: 'work',
    });
    // Fire 100 unauthorized pings (wrong controllerId) — these all 422 and must
    // NOT consume slots from the legitimate controller's bucket.
    const bogus = ctrlPrincipal();
    bogus.controllerId = 'Imposter';
    for (let i = 0; i < 100; i++) {
      await expect(
        r.registry.pingFlow({ flowId: flow.flowId, principal: bogus })
      ).rejects.toThrow(/controllerId mismatch/);
    }
    // Now 4 legitimate pings should still succeed.
    for (let i = 0; i < 4; i++) {
      r.clock.now += 10;
      await r.registry.pingFlow({ flowId: flow.flowId, principal: ctrlPrincipal() });
    }
  });
});

describe('TaskFlowRegistry — Phase 5 configurability', () => {
  it('respects custom createPerSecPerController = Infinity (disabled)', async () => {
    const r2 = await rig({ createPerSec: Infinity, maxActive: 1_000_000 });
    try {
      for (let i = 0; i < 50; i++) {
        const out = await r2.registry.createFlow(inputFor(i));
        expect(out.created).toBe(true);
      }
    } finally {
      await r2.cleanup();
    }
  });

  it('respects custom maxActivePerController = Infinity', async () => {
    const r2 = await rig({ maxActive: Infinity, createPerSec: 1_000_000 });
    try {
      for (let i = 0; i < 200; i++) {
        await r2.registry.createFlow(inputFor(i));
      }
    } finally {
      await r2.cleanup();
    }
  });

  it('getRateLimits returns the configured values', async () => {
    const r2 = await rig({ createPerSec: 7, maxActive: 11, pingPerMin: 13 });
    try {
      const rl = r2.registry.getRateLimits();
      expect(rl.createPerSecPerController).toBe(7);
      expect(rl.maxActivePerController).toBe(11);
      expect(rl.pingPerMinPerFlow).toBe(13);
    } finally {
      await r2.cleanup();
    }
  });
});

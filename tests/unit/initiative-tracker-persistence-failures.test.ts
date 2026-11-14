/**
 * InitiativeTracker must not report success when TaskFlow persistence
 * fails, and concurrent updates with the same ifMatch must not both win.
 *
 * Real SQLite TaskFlow store; failures are injected by stubbing a single
 * registry transition to reject.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TaskFlowStore } from '../../src/tasks/task-flow-registry.store.sqlite.js';
import { TaskFlowRegistry } from '../../src/tasks/TaskFlowRegistry.js';
import {
  InitiativeTracker,
  OccVersionMismatchError,
  type InitiativeCreateInput,
} from '../../src/core/InitiativeTracker.js';

function baseInput(id = 'demo'): InitiativeCreateInput {
  return {
    id,
    title: 'Demo Initiative',
    description: 'Persistence failure test.',
    phases: [
      { id: 'plan', name: 'Plan' },
      { id: 'build', name: 'Build' },
    ],
  };
}

describe('InitiativeTracker TaskFlow persistence failures and OCC atomicity', () => {
  let dir: string;
  let store: TaskFlowStore;
  let registry: TaskFlowRegistry;
  let tracker: InitiativeTracker;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-persist-fail-'));
    store = new TaskFlowStore({ dbPath: path.join(dir, 'task-flows.db') });
    await store.open();
    registry = new TaskFlowRegistry({ store });
    tracker = new InitiativeTracker(dir);
    tracker.setTaskFlowRegistry(registry, 'test-instance-1');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/initiative-tracker-persistence-failures.test.ts',
    });
  });

  it('update rejects and leaves stored state unchanged when TaskFlow persistence fails', async () => {
    await tracker.create(baseInput());
    const before = tracker.get('demo')!;
    expect(before.version).toBe(1);

    vi.spyOn(registry, 'setFlowWaiting').mockRejectedValue(new Error('injected persist failure'));

    let outcome: 'resolved' | 'rejected' = 'resolved';
    try {
      await tracker.update('demo', { title: 'New title', ifMatch: 1 });
    } catch {
      outcome = 'rejected';
    }
    expect(outcome).toBe('rejected');

    vi.restoreAllMocks();
    const after = tracker.get('demo')!;
    expect(after.title).toBe('Demo Initiative');
    expect(after.version).toBe(1);
    // In-process cache must not advertise the unpersisted write either.
    expect(tracker.list().find((i) => i.id === 'demo')!.title).toBe('Demo Initiative');
  });

  it('update() rejects when the resume half of the state patch fails, without leaving the new state persisted', async () => {
    await tracker.create(baseInput());
    vi.spyOn(registry, 'resumeFlow').mockRejectedValue(new Error('injected resume failure'));

    let outcome: 'resolved' | 'rejected' = 'resolved';
    try {
      await tracker.update('demo', { title: 'Half-written', ifMatch: 1 });
    } catch {
      outcome = 'rejected';
    }
    expect(outcome).toBe('rejected');

    vi.restoreAllMocks();
    const after = tracker.get('demo')!;
    expect(after.title).toBe('Demo Initiative');
    expect(after.version).toBe(1);
  });

  it('create() rejects when TaskFlow persistence fails', async () => {
    vi.spyOn(registry, 'startStep').mockRejectedValue(new Error('injected persist failure'));
    let outcome: 'resolved' | 'rejected' = 'resolved';
    try {
      await tracker.create(baseInput('failing'));
    } catch {
      outcome = 'rejected';
    }
    expect(outcome).toBe('rejected');
  });

  it('concurrent updates with the same ifMatch: exactly one succeeds, the other gets OccVersionMismatchError', async () => {
    await tracker.create(baseInput());
    // Model real-world async latency in the multi-step persistence so the
    // two writers interleave between the ifMatch check and the write.
    const original = registry.setFlowWaiting.bind(registry);
    vi.spyOn(registry, 'setFlowWaiting').mockImplementation(async (args) => {
      await new Promise((r) => setTimeout(r, 10));
      return original(args);
    });
    const results = await Promise.allSettled([
      tracker.update('demo', { title: 'Writer A', ifMatch: 1 }),
      tracker.update('demo', { title: 'Writer B', ifMatch: 1 }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0].reason).toBeInstanceOf(OccVersionMismatchError);
    const after = tracker.get('demo')!;
    expect(after.version).toBe(2);
    expect(after.title).toBe('Writer A');
  });
});

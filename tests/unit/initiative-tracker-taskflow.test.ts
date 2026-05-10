/**
 * InitiativeTracker × TaskFlow Phase 4 migration tests.
 *
 * Real SQLite (no mocking) per /instar-dev constraints. Verifies:
 *   1. create() writes a TaskFlow record under controllerId=InitiativeTracker.
 *   2. setPhaseStatus advances `currentStep` on the flow.
 *   3. update({needsUser:true}) drives the flow into `waiting` with
 *      a `human-review` waitJson; clearing needsUser resumes to running.
 *   4. update({blockers:[...]}) drives the flow into `waiting`.
 *   5. setPhaseStatus to all-done drives the flow to `succeeded`.
 *   6. update({status:'archived'}) drives the flow to `cancelled`.
 *   7. update({status:'abandoned'}) drives the flow to `failed`.
 *   8. remove() drives the flow to `cancelled` and removes from cache.
 *   9. migrateExistingToTaskFlow is idempotent — running twice = no
 *      duplicates; second pass reports alreadyExisted == count.
 *  10. All existing InitiativeTracker behavior (validation, digest,
 *      legacy JSON fallback) still works when TaskFlow is wired.
 *  11. Reads after a write reflect the latest TaskFlow stateJson.
 *
 * Per spec § Phase 4 (lines 645–648), TaskFlow is read-authoritative and
 * the legacy JSON file is migrated once and never written again while
 * TaskFlow is wired.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TaskFlowStore } from '../../src/tasks/task-flow-registry.store.sqlite.js';
import { TaskFlowRegistry } from '../../src/tasks/TaskFlowRegistry.js';
import {
  InitiativeTracker,
  INITIATIVE_TASKFLOW_CONTROLLER_ID,
  type InitiativeCreateInput,
} from '../../src/core/InitiativeTracker.js';

interface Rig {
  dir: string;
  store: TaskFlowStore;
  registry: TaskFlowRegistry;
  tracker: InitiativeTracker;
  cleanup: () => Promise<void>;
}

async function rig(opts: { wireTaskFlow: boolean; preexistingJson?: unknown[] } = {
  wireTaskFlow: true,
}): Promise<Rig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-taskflow-test-'));
  const store = new TaskFlowStore({ dbPath: path.join(dir, 'task-flows.db') });
  await store.open();
  const registry = new TaskFlowRegistry({ store });
  if (opts.preexistingJson) {
    fs.writeFileSync(
      path.join(dir, 'initiatives.json'),
      JSON.stringify({ initiatives: opts.preexistingJson }, null, 2)
    );
  }
  const tracker = new InitiativeTracker(dir);
  if (opts.wireTaskFlow) {
    tracker.setTaskFlowRegistry(registry, 'test-instance-1');
  }
  return {
    dir,
    store,
    registry,
    tracker,
    cleanup: async () => {
      store.close();
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/initiative-tracker-taskflow.test.ts',
      });
    },
  };
}

function baseInput(id = 'demo'): InitiativeCreateInput {
  return {
    id,
    title: 'Demo Initiative',
    description: 'A worked example for TaskFlow tests.',
    phases: [
      { id: 'plan', name: 'Plan' },
      { id: 'build', name: 'Build' },
      { id: 'ship', name: 'Ship' },
    ],
  };
}

describe('InitiativeTracker × TaskFlow Phase 4 — basic lifecycle', () => {
  let r: Rig;
  afterEach(async () => {
    if (r) await r.cleanup();
  });

  it('create() writes a TaskFlow record under controllerId=InitiativeTracker', async () => {
    r = await rig();
    await r.tracker.create(baseInput());
    const flows = r.registry.findByControllerId(INITIATIVE_TASKFLOW_CONTROLLER_ID);
    expect(flows).toHaveLength(1);
    expect(flows[0].ownerKey).toBe('initiative:demo');
    expect(flows[0].goal).toBe('Demo Initiative');
    // Active, no blockers ⇒ flow should be running on first phase.
    expect(flows[0].status).toBe('running');
    expect(flows[0].currentStep).toBe('plan');
  });

  it('create() persists the full Initiative shape in stateJson', async () => {
    r = await rig();
    const created = await r.tracker.create(baseInput());
    const flows = r.registry.findByControllerId(INITIATIVE_TASKFLOW_CONTROLLER_ID);
    const state = flows[0].stateJson as { initiative: typeof created };
    expect(state.initiative.id).toBe('demo');
    expect(state.initiative.phases).toHaveLength(3);
    expect(state.initiative.status).toBe('active');
  });

  it('rejects duplicate ids via TaskFlow lookup', async () => {
    r = await rig();
    await r.tracker.create(baseInput());
    await expect(r.tracker.create(baseInput())).rejects.toThrow(/already exists/);
  });

  it('setPhaseStatus advances currentStep on the flow', async () => {
    r = await rig();
    await r.tracker.create(baseInput());
    await r.tracker.setPhaseStatus('demo', 'plan', 'done');
    const flows = r.registry.findByControllerId(INITIATIVE_TASKFLOW_CONTROLLER_ID);
    expect(flows[0].status).toBe('running');
    expect(flows[0].currentStep).toBe('build');
  });

  it('all-phases-done drives the flow to succeeded', async () => {
    r = await rig();
    await r.tracker.create(baseInput());
    await r.tracker.setPhaseStatus('demo', 'plan', 'done');
    await r.tracker.setPhaseStatus('demo', 'build', 'done');
    const final = await r.tracker.setPhaseStatus('demo', 'ship', 'done');
    expect(final.status).toBe('completed');
    const flows = r.registry.findByControllerId(INITIATIVE_TASKFLOW_CONTROLLER_ID);
    expect(flows[0].status).toBe('succeeded');
  });

  it('update({needsUser:true}) drives the flow to waiting with human-review', async () => {
    r = await rig();
    await r.tracker.create(baseInput());
    await r.tracker.update('demo', { needsUser: true, needsUserReason: 'pick scope' });
    const flows = r.registry.findByControllerId(INITIATIVE_TASKFLOW_CONTROLLER_ID);
    expect(flows[0].status).toBe('waiting');
    expect(flows[0].waitJson?.kind).toBe('human-review');
    if (flows[0].waitJson?.kind === 'human-review') {
      expect(flows[0].waitJson.question).toBe('pick scope');
    }
  });

  it('clearing needsUser resumes from waiting back to running', async () => {
    r = await rig();
    await r.tracker.create(baseInput());
    await r.tracker.update('demo', { needsUser: true, needsUserReason: 'pick scope' });
    let flows = r.registry.findByControllerId(INITIATIVE_TASKFLOW_CONTROLLER_ID);
    expect(flows[0].status).toBe('waiting');
    await r.tracker.update('demo', { needsUser: false, needsUserReason: null });
    flows = r.registry.findByControllerId(INITIATIVE_TASKFLOW_CONTROLLER_ID);
    expect(flows[0].status).toBe('running');
    expect(flows[0].waitJson).toBeUndefined();
  });

  it('update({blockers:[...]}) drives the flow to waiting', async () => {
    r = await rig();
    await r.tracker.create(baseInput());
    await r.tracker.update('demo', { blockers: ['external service down'] });
    const flows = r.registry.findByControllerId(INITIATIVE_TASKFLOW_CONTROLLER_ID);
    expect(flows[0].status).toBe('waiting');
    expect(flows[0].waitJson?.kind).toBe('human-review');
  });

  it('update({status:"archived"}) drives the flow to cancelled', async () => {
    r = await rig();
    await r.tracker.create(baseInput());
    await r.tracker.update('demo', { status: 'archived' });
    const flows = r.registry.findByControllerId(INITIATIVE_TASKFLOW_CONTROLLER_ID);
    expect(flows[0].status).toBe('cancelled');
  });

  it('update({status:"abandoned"}) drives the flow to failed', async () => {
    r = await rig();
    await r.tracker.create(baseInput());
    await r.tracker.update('demo', { status: 'abandoned' });
    const flows = r.registry.findByControllerId(INITIATIVE_TASKFLOW_CONTROLLER_ID);
    expect(flows[0].status).toBe('failed');
  });

  it('remove() drives the flow to cancelled and removes from cache', async () => {
    r = await rig();
    await r.tracker.create(baseInput());
    expect(await r.tracker.remove('demo')).toBe(true);
    expect(r.tracker.get('demo')).toBeUndefined();
    const flows = r.registry.findByControllerId(INITIATIVE_TASKFLOW_CONTROLLER_ID);
    expect(flows[0].status).toBe('cancelled');
  });

  it('reads after a write reflect the latest TaskFlow stateJson', async () => {
    r = await rig();
    await r.tracker.create(baseInput());
    await r.tracker.update('demo', { description: 'updated description' });
    const fetched = r.tracker.get('demo');
    expect(fetched?.description).toBe('updated description');
  });
});

describe('InitiativeTracker × TaskFlow — backfill idempotency', () => {
  let r: Rig;
  afterEach(async () => {
    if (r) await r.cleanup();
  });

  it('migrateExistingToTaskFlow is idempotent — second pass produces no duplicates', async () => {
    const preexisting = [
      {
        id: 'legacy-a',
        title: 'Legacy A',
        description: 'A previously persisted initiative.',
        status: 'active',
        phases: [
          { id: 'plan', name: 'Plan', status: 'in-progress', startedAt: '2026-04-01T00:00:00.000Z' },
          { id: 'ship', name: 'Ship', status: 'pending' },
        ],
        currentPhaseIndex: 0,
        lastTouchedAt: '2026-04-01T00:00:00.000Z',
        needsUser: false,
        blockers: [],
        links: [],
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      },
      {
        id: 'legacy-b',
        title: 'Legacy B',
        description: 'A second pre-existing initiative, blocked.',
        status: 'active',
        phases: [{ id: 'phase-a', name: 'Phase A', status: 'pending' }],
        currentPhaseIndex: 0,
        lastTouchedAt: '2026-04-02T00:00:00.000Z',
        needsUser: true,
        needsUserReason: 'awaiting decision',
        blockers: [],
        links: [],
        createdAt: '2026-04-02T00:00:00.000Z',
        updatedAt: '2026-04-02T00:00:00.000Z',
      },
    ];
    r = await rig({ wireTaskFlow: false, preexistingJson: preexisting });
    // Cache should be loaded from the legacy file.
    expect(r.tracker.list().map((i) => i.id).sort()).toEqual(['legacy-a', 'legacy-b']);
    r.tracker.setTaskFlowRegistry(r.registry, 'test-instance-1');

    const first = await r.tracker.migrateExistingToTaskFlow();
    expect(first.created).toBe(2);
    expect(first.alreadyExisted).toBe(0);

    const second = await r.tracker.migrateExistingToTaskFlow();
    expect(second.created).toBe(0);
    expect(second.alreadyExisted).toBe(2);

    // No duplicate flows.
    const flows = r.registry.findByControllerId(INITIATIVE_TASKFLOW_CONTROLLER_ID);
    expect(flows).toHaveLength(2);
    // legacy-b should be in waiting (needsUser=true).
    const legacyB = flows.find((f) => f.ownerKey === 'initiative:legacy-b')!;
    expect(legacyB.status).toBe('waiting');
    if (legacyB.waitJson?.kind === 'human-review') {
      expect(legacyB.waitJson.question).toBe('awaiting decision');
    }
  });

  it('after wiring, legacy initiatives.json is no longer overwritten', async () => {
    r = await rig({ wireTaskFlow: true });
    const beforeStat = fs.existsSync(path.join(r.dir, 'initiatives.json'));
    expect(beforeStat).toBe(false);
    await r.tracker.create(baseInput());
    const afterStat = fs.existsSync(path.join(r.dir, 'initiatives.json'));
    // No JSON file should be written when TaskFlow is wired.
    expect(afterStat).toBe(false);
  });

  it('TaskFlow disabled: falls back to legacy JSON storage', async () => {
    r = await rig({ wireTaskFlow: false });
    const created = await r.tracker.create(baseInput());
    expect(created.id).toBe('demo');
    expect(fs.existsSync(path.join(r.dir, 'initiatives.json'))).toBe(true);
    const flows = r.registry.findByControllerId(INITIATIVE_TASKFLOW_CONTROLLER_ID);
    expect(flows).toHaveLength(0);
  });
});

describe('InitiativeTracker × TaskFlow — read consistency + digest', () => {
  let r: Rig;
  afterEach(async () => {
    if (r) await r.cleanup();
  });

  it('digest reads from TaskFlow when wired', async () => {
    r = await rig();
    await r.tracker.create({
      ...baseInput('a'),
      needsUser: true,
      needsUserReason: 'decide scope',
    });
    const d = r.tracker.digest();
    expect(d.items).toHaveLength(1);
    expect(d.items[0].reason).toBe('needs-user');
    expect(d.items[0].detail).toBe('decide scope');
  });

  it('list() picks up new initiatives written through TaskFlow by another caller', async () => {
    r = await rig();
    await r.tracker.create(baseInput('a'));
    await r.tracker.create(baseInput('b'));
    const tracker2 = new InitiativeTracker(r.dir);
    tracker2.setTaskFlowRegistry(r.registry, 'test-instance-2');
    expect(tracker2.list().map((i) => i.id).sort()).toEqual(['a', 'b']);
  });

  it('persistence: a fresh instance with TaskFlow wired sees prior state', async () => {
    r = await rig();
    await r.tracker.create(baseInput());
    await r.tracker.setPhaseStatus('demo', 'plan', 'done');
    const tracker2 = new InitiativeTracker(r.dir);
    tracker2.setTaskFlowRegistry(r.registry, 'test-instance-2');
    const fetched = tracker2.get('demo');
    expect(fetched).toBeDefined();
    expect(fetched!.phases[0].status).toBe('done');
    expect(fetched!.currentPhaseIndex).toBe(1);
  });
});

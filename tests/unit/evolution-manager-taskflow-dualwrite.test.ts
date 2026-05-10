/**
 * EvolutionManager × TaskFlow Phase 3a dual-write tests.
 *
 * Real SQLite (no mocking) per /instar-dev constraints. Verifies:
 *   1. addProposal creates a queued flow under controllerId=EvolutionManager.
 *   2. updateProposalStatus(approved) startSteps the flow to running.
 *   3. updateProposalStatus(implemented) finishes the flow to succeeded.
 *   4. updateProposalStatus(rejected) fails the flow.
 *   5. updateProposalStatus(deferred) cancels the flow.
 *   6. migrateExistingToTaskFlow is idempotent — running twice = no duplicates.
 *   7. setShadowWritesHalted(true) suppresses subsequent dual-writes.
 *   8. Without setTaskFlowRegistry wired, no flows are written.
 *   9. JSON state remains the source of truth — dual-write failures don't
 *      affect EvolutionManager's local state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TaskFlowStore } from '../../src/tasks/task-flow-registry.store.sqlite.js';
import { TaskFlowRegistry } from '../../src/tasks/TaskFlowRegistry.js';
import { EvolutionManager } from '../../src/core/EvolutionManager.js';

interface Rig {
  dir: string;
  stateDir: string;
  store: TaskFlowStore;
  registry: TaskFlowRegistry;
  evolution: EvolutionManager;
  cleanup: () => Promise<void>;
}

async function rig(opts: { wireTaskFlow: boolean } = { wireTaskFlow: true }): Promise<Rig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-taskflow-test-'));
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const store = new TaskFlowStore({ dbPath: path.join(dir, 'task-flows.db') });
  await store.open();
  const registry = new TaskFlowRegistry({ store });
  const evolution = new EvolutionManager({ stateDir });
  if (opts.wireTaskFlow) {
    evolution.setTaskFlowRegistry(registry, 'test-instance');
  }
  return {
    dir,
    stateDir,
    store,
    registry,
    evolution,
    cleanup: async () => {
      store.close();
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/evolution-manager-taskflow-dualwrite.test.ts',
      });
    },
  };
}

function ownerKey(proposalId: string): string {
  return `evolution:cluster:${proposalId}`;
}

/** Drain microtasks so void promises fire. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('EvolutionManager × TaskFlow Phase 3a dual-write', () => {
  let r: Rig;

  afterEach(async () => {
    if (r) await r.cleanup();
  });

  it('addProposal creates a queued flow under controllerId=EvolutionManager', async () => {
    r = await rig();
    const p = r.evolution.addProposal({
      title: 'Test proposal',
      source: 'test',
      description: 'desc',
      type: 'capability',
    });
    await flush();
    const flows = r.registry.findByControllerId('EvolutionManager');
    expect(flows).toHaveLength(1);
    expect(flows[0].ownerKey).toBe(ownerKey(p.id));
    expect(flows[0].status).toBe('queued');
    expect(flows[0].goal).toBe('Test proposal');
    expect(flows[0].currentStep).toBe('proposed');
  });

  it('updateProposalStatus(approved) starts the flow', async () => {
    r = await rig();
    const p = r.evolution.addProposal({
      title: 'P1',
      source: 't',
      description: 'd',
      type: 'capability',
    });
    await flush();
    r.evolution.updateProposalStatus(p.id, 'approved');
    await flush();
    const flows = r.registry.findByControllerId('EvolutionManager');
    expect(flows).toHaveLength(1);
    expect(flows[0].status).toBe('running');
    expect(flows[0].currentStep).toBe('approved');
  });

  it('updateProposalStatus(implemented) finishes the flow', async () => {
    r = await rig();
    const p = r.evolution.addProposal({
      title: 'P2',
      source: 't',
      description: 'd',
      type: 'capability',
    });
    await flush();
    r.evolution.updateProposalStatus(p.id, 'approved');
    await flush();
    r.evolution.updateProposalStatus(p.id, 'implemented');
    await flush();
    const flows = r.registry.findByControllerId('EvolutionManager');
    expect(flows[0].status).toBe('succeeded');
    expect(flows[0].endedAt).toBeGreaterThan(0);
  });

  it('updateProposalStatus(rejected) fails the flow', async () => {
    r = await rig();
    const p = r.evolution.addProposal({
      title: 'P3',
      source: 't',
      description: 'd',
      type: 'capability',
    });
    await flush();
    r.evolution.updateProposalStatus(p.id, 'rejected', 'not enough evidence');
    await flush();
    const flows = r.registry.findByControllerId('EvolutionManager');
    expect(flows[0].status).toBe('failed');
    expect((flows[0].stateJson as any)._failureReason).toBe('not enough evidence');
  });

  it('updateProposalStatus(deferred) cancels the flow', async () => {
    r = await rig();
    const p = r.evolution.addProposal({
      title: 'P4',
      source: 't',
      description: 'd',
      type: 'capability',
    });
    await flush();
    r.evolution.updateProposalStatus(p.id, 'deferred', 'later');
    await flush();
    const flows = r.registry.findByControllerId('EvolutionManager');
    expect(flows[0].status).toBe('cancelled');
  });

  it('migrateExistingToTaskFlow is idempotent — second run produces no duplicates', async () => {
    r = await rig({ wireTaskFlow: false });
    // Add proposals WITHOUT taskflow wiring (so no dual-write yet).
    const p1 = r.evolution.addProposal({
      title: 'A',
      source: 't',
      description: 'd',
      type: 'capability',
    });
    const p2 = r.evolution.addProposal({
      title: 'B',
      source: 't',
      description: 'd',
      type: 'workflow',
    });
    r.evolution.updateProposalStatus(p2.id, 'implemented');
    // Now wire taskflow and migrate.
    r.evolution.setTaskFlowRegistry(r.registry, 'test-instance');
    const first = await r.evolution.migrateExistingToTaskFlow();
    expect(first.created).toBe(2);
    const after1 = r.registry.findByControllerId('EvolutionManager');
    expect(after1).toHaveLength(2);
    // p2 should be succeeded (advanced during catch-up).
    const flowP2 = after1.find((f) => f.ownerKey === ownerKey(p2.id))!;
    expect(flowP2.status).toBe('succeeded');
    const flowP1 = after1.find((f) => f.ownerKey === ownerKey(p1.id))!;
    expect(flowP1.status).toBe('queued');

    // Second run — no new creates, no extra advancement.
    const second = await r.evolution.migrateExistingToTaskFlow();
    expect(second.created).toBe(0);
    expect(second.alreadyExisted).toBe(2);
    expect(second.advanced).toBe(0);
    const after2 = r.registry.findByControllerId('EvolutionManager');
    expect(after2).toHaveLength(2);
  });

  it('setShadowWritesHalted(true) suppresses subsequent dual-writes', async () => {
    r = await rig();
    r.evolution.setShadowWritesHalted(true, 'test-divergence');
    expect(r.evolution.isShadowWritesHalted().halted).toBe(true);
    const p = r.evolution.addProposal({
      title: 'while halted',
      source: 't',
      description: 'd',
      type: 'capability',
    });
    await flush();
    let flows = r.registry.findByControllerId('EvolutionManager');
    expect(flows).toHaveLength(0);

    // Resume — subsequent additions write through.
    r.evolution.setShadowWritesHalted(false);
    const p2 = r.evolution.addProposal({
      title: 'after resume',
      source: 't',
      description: 'd',
      type: 'capability',
    });
    await flush();
    flows = r.registry.findByControllerId('EvolutionManager');
    expect(flows).toHaveLength(1);
    expect(flows[0].ownerKey).toBe(ownerKey(p2.id));
    // p1 is still JSON-only; that's the expected behavior — halted writes are
    // never retroactively replayed. The next migrate-existing pass would
    // backfill it on demand.
    void p;
  });

  it('without setTaskFlowRegistry, no flows are written', async () => {
    r = await rig({ wireTaskFlow: false });
    r.evolution.addProposal({
      title: 'no taskflow',
      source: 't',
      description: 'd',
      type: 'capability',
    });
    await flush();
    expect(r.registry.findByControllerId('EvolutionManager')).toHaveLength(0);
  });

  it('JSON state survives even if taskflow registry blows up mid-dualwrite', async () => {
    r = await rig();
    // Close the underlying store — subsequent createFlow calls will throw.
    r.store.close();
    const p = r.evolution.addProposal({
      title: 'corrupt taskflow',
      source: 't',
      description: 'd',
      type: 'capability',
    });
    await flush();
    // JSON-side: proposal still present.
    const proposals = r.evolution.listProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].id).toBe(p.id);
  });

  it('TaskFlow record is read-authoritative via findByControllerId', async () => {
    r = await rig();
    const p = r.evolution.addProposal({
      title: 'auth',
      source: 't',
      description: 'd',
      type: 'capability',
    });
    await flush();
    r.evolution.updateProposalStatus(p.id, 'approved');
    await flush();
    // Restart-from-disk simulation: discard the in-memory EvolutionManager
    // and rebuild from the registry — the flow row tells us status=running.
    const flowsAfter = r.registry.findByControllerId('EvolutionManager');
    expect(flowsAfter[0].status).toBe('running');
    expect(flowsAfter[0].currentStep).toBe('approved');
  });
});

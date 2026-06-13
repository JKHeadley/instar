/**
 * EvolutionManager × TaskFlow Phase 3b authority tests.
 *
 * Phase 3b cutover (per docs/specs/OPENCLAW-IMPORT-TASKFLOW-SPEC.md § Phase 3b
 * line 641): TaskFlow is the sole authority for proposal lifecycle state when
 * the registry is wired. The legacy `evolution-queue.json` is a read-only
 * historical artifact and the JSONL shadow writes have been removed from the
 * cluster lifecycle methods.
 *
 * This file is the renamed/repurposed Phase 3a `evolution-manager-taskflow-
 * dualwrite.test.ts`. Five wired-TaskFlow cases continue as regression
 * coverage for the TaskFlow-authority write path. Three cases changed shape:
 *   - The `setShadowWritesHalted` test was removed (the brake API was
 *     deleted along with `DivergenceChecker`).
 *   - The "JSON-state survives a registry blowup" test became a
 *     "no JSON shadow write when registry fails under wired-TaskFlow"
 *     assertion — the proposal is intentionally dropped on the floor under
 *     Phase 3b semantics; we verify the local JSON file is NOT written.
 *   - The "without taskflow, no flows are written" case grew a sibling
 *     assertion: when TaskFlow is NOT wired (opt-out installs), the legacy
 *     JSON write continues so proposals aren't silently lost.
 *
 * Real SQLite (no mocking) per /instar-dev constraints.
 */

import { describe, it, expect, afterEach } from 'vitest';
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
        operation: 'tests/unit/evolution-manager-taskflow-authority.test.ts',
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

describe('EvolutionManager × TaskFlow Phase 3b authority', () => {
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
    // Add proposals WITHOUT taskflow wiring — these write to the legacy JSON
    // file (Phase 3b keeps the JSON fallback when TaskFlow is opt-out).
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
    // Now wire taskflow and migrate the pre-cutover proposals.
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

  it('without setTaskFlowRegistry, the legacy JSON write continues (opt-out fallback)', async () => {
    r = await rig({ wireTaskFlow: false });
    const p = r.evolution.addProposal({
      title: 'no taskflow',
      source: 't',
      description: 'd',
      type: 'capability',
    });
    await flush();
    expect(r.registry.findByControllerId('EvolutionManager')).toHaveLength(0);
    // listProposals reads `evolution-queue.json` — verify the legacy fallback
    // is intact for opt-out installs.
    const proposals = r.evolution.listProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].id).toBe(p.id);
  });

  it('with TaskFlow wired, the legacy JSON file is NOT written by addProposal (Phase 3b cutover)', async () => {
    r = await rig({ wireTaskFlow: true });
    const queueFile = path.join(r.stateDir, 'evolution-queue.json');
    expect(fs.existsSync(queueFile)).toBe(false);
    r.evolution.addProposal({
      title: 'authority',
      source: 't',
      description: 'd',
      type: 'capability',
    });
    await flush();
    // Phase 3b: TaskFlow is sole authority — JSON file is NOT written.
    expect(fs.existsSync(queueFile)).toBe(false);
    // TaskFlow row exists.
    const flows = r.registry.findByControllerId('EvolutionManager');
    expect(flows).toHaveLength(1);
  });

  it('TaskFlow registry blowup under wired Phase 3b drops the proposal (no JSON shadow rescue)', async () => {
    r = await rig({ wireTaskFlow: true });
    // Close the underlying store — subsequent createFlow calls will throw,
    // get warn-logged, and absorbed inside writeCreateToTaskFlow.
    r.store.close();
    r.evolution.addProposal({
      title: 'registry down',
      source: 't',
      description: 'd',
      type: 'capability',
    });
    await flush();
    // No JSON shadow rescue in Phase 3b — the queue file is not written.
    const queueFile = path.join(r.stateDir, 'evolution-queue.json');
    expect(fs.existsSync(queueFile)).toBe(false);
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
    // Restart-from-disk simulation: the flow row is the authoritative
    // record of proposal state.
    const flowsAfter = r.registry.findByControllerId('EvolutionManager');
    expect(flowsAfter[0].status).toBe('running');
    expect(flowsAfter[0].currentStep).toBe('approved');
  });
});

/**
 * DivergenceChecker tests — TaskFlow Phase 3a.
 *
 * Real SQLite (no mocking). Verifies:
 *   1. Happy path — zero divergence when JSON and TaskFlow agree.
 *   2. json-only — proposal in JSON but no matching flow.
 *   3. taskflow-only — flow without a matching JSON proposal.
 *   4. status-mismatch — JSON says implemented, flow still running.
 *   5. step-mismatch — JSON says approved, flow's currentStep is something else.
 *   6. wait-kind-mismatch — flow has a waitJson (proposals shouldn't, in Phase 3a).
 *   7. On divergence > 0: emits ledger note + halts shadow writes.
 *   8. On divergence == 0 after a halt: resumes shadow writes.
 *   9. lastReport / divergenceCount / lastCheckAt are populated after run.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TaskFlowStore } from '../../src/tasks/task-flow-registry.store.sqlite.js';
import { TaskFlowRegistry } from '../../src/tasks/TaskFlowRegistry.js';
import { EvolutionManager } from '../../src/core/EvolutionManager.js';
import { DivergenceChecker } from '../../src/tasks/DivergenceChecker.js';

interface Rig {
  dir: string;
  store: TaskFlowStore;
  registry: TaskFlowRegistry;
  evolution: EvolutionManager;
  checker: DivergenceChecker;
  ledgerNotes: any[];
  cleanup: () => Promise<void>;
}

async function rig(): Promise<Rig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'divergence-test-'));
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const store = new TaskFlowStore({ dbPath: path.join(dir, 'task-flows.db') });
  await store.open();
  const registry = new TaskFlowRegistry({ store });
  const evolution = new EvolutionManager({ stateDir });
  evolution.setTaskFlowRegistry(registry, 'test-instance');

  const ledgerNotes: any[] = [];
  const fakeLedger = {
    append: async (payload: any) => {
      ledgerNotes.push(payload);
      return { id: 'fake', t: new Date().toISOString(), ...payload };
    },
  } as any;

  const checker = new DivergenceChecker({
    registry,
    evolutionManager: evolution,
    ledger: fakeLedger,
  });

  return {
    dir,
    store,
    registry,
    evolution,
    checker,
    ledgerNotes,
    cleanup: async () => {
      checker.stop();
      store.close();
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/divergence-checker.test.ts',
      });
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('DivergenceChecker', () => {
  let r: Rig;

  afterEach(async () => {
    if (r) await r.cleanup();
  });

  it('zero divergence when JSON and TaskFlow agree (happy path)', async () => {
    r = await rig();
    const p = r.evolution.addProposal({
      title: 'aligned',
      source: 't',
      description: 'd',
      type: 'capability',
    });
    await flush();
    r.evolution.updateProposalStatus(p.id, 'approved');
    await flush();
    const report = await r.checker.runOnce();
    expect(report.divergenceCount).toBe(0);
    expect(report.mismatches).toHaveLength(0);
    expect(report.scannedJsonProposals).toBe(1);
    expect(report.scannedTaskFlowRecords).toBe(1);
    expect(r.checker.divergenceCount).toBe(0);
    expect(r.checker.lastCheckAt).not.toBeNull();
    expect(r.checker.lastReport).not.toBeNull();
  });

  it('json-only: proposal in JSON but no matching flow', async () => {
    r = await rig();
    // Halt shadow writes BEFORE adding the proposal so taskflow stays empty.
    r.evolution.setShadowWritesHalted(true, 'test-suppress');
    r.evolution.addProposal({
      title: 'orphan-json',
      source: 't',
      description: 'd',
      type: 'capability',
    });
    await flush();
    expect(r.registry.findByControllerId('EvolutionManager')).toHaveLength(0);
    // Resume so the checker doesn't see the halt as our fault.
    r.evolution.setShadowWritesHalted(false);
    const report = await r.checker.runOnce();
    expect(report.divergenceCount).toBe(1);
    expect(report.mismatches[0].kind).toBe('json-only');
  });

  it('taskflow-only: flow without matching JSON proposal', async () => {
    r = await rig();
    // Directly create a flow with no corresponding proposal.
    await r.registry.createFlow({
      controllerId: 'EvolutionManager',
      controllerInstanceId: 'test-instance',
      ownerKey: 'evolution:cluster:ORPHAN-001',
      idempotencyKey: 'evolution-cluster-create-ORPHAN-001',
      goal: 'orphan',
    });
    const report = await r.checker.runOnce();
    expect(report.divergenceCount).toBe(1);
    expect(report.mismatches[0].kind).toBe('taskflow-only');
  });

  it('status-mismatch: JSON implemented, flow still running', async () => {
    r = await rig();
    const p = r.evolution.addProposal({
      title: 'status-mm',
      source: 't',
      description: 'd',
      type: 'capability',
    });
    await flush();
    r.evolution.updateProposalStatus(p.id, 'approved');
    await flush();
    // Now: halt shadow writes, then JSON-update to implemented WITHOUT propagating.
    r.evolution.setShadowWritesHalted(true, 'test-induce-divergence');
    r.evolution.updateProposalStatus(p.id, 'implemented');
    await flush();
    // Clear the halt before running the checker — the checker should observe
    // the post-update divergence and re-halt.
    r.evolution.setShadowWritesHalted(false);
    const report = await r.checker.runOnce();
    const statusMm = report.mismatches.find((m) => m.kind === 'status-mismatch');
    expect(statusMm).toBeDefined();
    expect(statusMm!.proposalStatus).toBe('implemented');
    expect(statusMm!.flowStatus).toBe('running');
    // The checker should now have re-halted EM.
    expect(r.evolution.isShadowWritesHalted().halted).toBe(true);
  });

  it('step-mismatch: JSON approved, flow current_step differs', async () => {
    r = await rig();
    r.evolution.setShadowWritesHalted(true, 'test-prep');
    const p = r.evolution.addProposal({
      title: 'step-mm',
      source: 't',
      description: 'd',
      type: 'capability',
    });
    await flush();
    // Create the flow directly with a wrong currentStep.
    await r.registry.createFlow({
      controllerId: 'EvolutionManager',
      controllerInstanceId: 'test-instance',
      ownerKey: `evolution:cluster:${p.id}`,
      idempotencyKey: `evolution-cluster-create-${p.id}`,
      goal: 'step-mm',
      currentStep: 'WRONG-STEP',
    });
    const flow = r.registry
      .findByControllerId('EvolutionManager')
      .find((f) => f.ownerKey === `evolution:cluster:${p.id}`)!;
    await r.registry.startStep({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      principal: {
        scope: 'controller',
        controllerId: 'EvolutionManager',
        controllerInstanceId: 'test-instance',
      },
      currentStep: 'WRONG-STEP-2',
    });
    // JSON status: approved → expects step 'approved'.
    r.evolution.updateProposalStatus(p.id, 'approved');
    await flush();
    r.evolution.setShadowWritesHalted(false);
    const report = await r.checker.runOnce();
    const stepMm = report.mismatches.find((m) => m.kind === 'step-mismatch');
    expect(stepMm).toBeDefined();
    expect(stepMm!.expectedStep).toBe('approved');
    expect(stepMm!.actualStep).toBe('WRONG-STEP-2');
  });

  it('wait-kind-mismatch: flow has waitJson (proposals shouldnt in Phase 3a)', async () => {
    r = await rig();
    const p = r.evolution.addProposal({
      title: 'wait-mm',
      source: 't',
      description: 'd',
      type: 'capability',
    });
    await flush();
    r.evolution.updateProposalStatus(p.id, 'approved');
    await flush();
    const flow = r.registry
      .findByControllerId('EvolutionManager')
      .find((f) => f.ownerKey === `evolution:cluster:${p.id}`)!;
    // Manually set a wait — this is a coherence violation for Phase 3a.
    await r.registry.setFlowWaiting({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      principal: {
        scope: 'controller',
        controllerId: 'EvolutionManager',
        controllerInstanceId: 'test-instance',
      },
      waitJson: {
        kind: 'human-review',
        question: 'should we ship?',
      },
    });
    const report = await r.checker.runOnce();
    const wkMm = report.mismatches.find((m) => m.kind === 'wait-kind-mismatch');
    expect(wkMm).toBeDefined();
    expect(wkMm!.actualWaitKind).toBe('human-review');
  });

  it('on divergence > 0: emits ledger note and halts shadow writes', async () => {
    r = await rig();
    // Induce a json-only divergence.
    r.evolution.setShadowWritesHalted(true);
    r.evolution.addProposal({
      title: 'will-diverge',
      source: 't',
      description: 'd',
      type: 'capability',
    });
    await flush();
    r.evolution.setShadowWritesHalted(false);
    expect(r.evolution.isShadowWritesHalted().halted).toBe(false);
    const report = await r.checker.runOnce();
    expect(report.divergenceCount).toBeGreaterThan(0);
    await flush();
    // Ledger note emitted.
    expect(r.ledgerNotes.length).toBeGreaterThan(0);
    expect(r.ledgerNotes[0].subject).toBe('taskflow-divergence');
    expect(r.ledgerNotes[0].kind).toBe('note');
    // Shadow writes halted.
    expect(r.evolution.isShadowWritesHalted().halted).toBe(true);
    expect(r.evolution.isShadowWritesHalted().reason).toContain('taskflow-divergence');
  });

  it('on divergence cleared after halt: resumes shadow writes', async () => {
    r = await rig();
    // First induce divergence.
    r.evolution.setShadowWritesHalted(true);
    const p = r.evolution.addProposal({
      title: 'temp-divergence',
      source: 't',
      description: 'd',
      type: 'capability',
    });
    await flush();
    r.evolution.setShadowWritesHalted(false);
    await r.checker.runOnce();
    expect(r.evolution.isShadowWritesHalted().halted).toBe(true);
    // Now backfill — clears the divergence.
    await r.evolution.migrateExistingToTaskFlow();
    void p;
    const report = await r.checker.runOnce();
    expect(report.divergenceCount).toBe(0);
    expect(r.evolution.isShadowWritesHalted().halted).toBe(false);
  });

  it('zero-divergence pass does NOT clear an operator-imposed halt', async () => {
    r = await rig();
    // Operator imposes a halt with a non-checker source.
    r.evolution.setShadowWritesHalted(true, 'operator-pause', 'manual');
    expect(r.evolution.isShadowWritesHalted().source).toBe('manual');
    // Zero-divergence pass.
    const report = await r.checker.runOnce();
    expect(report.divergenceCount).toBe(0);
    // Halt persists — checker only auto-clears halts it set.
    expect(r.evolution.isShadowWritesHalted().halted).toBe(true);
    expect(r.evolution.isShadowWritesHalted().source).toBe('manual');
  });

  it('runOnce populates divergenceCount, lastCheckAt, lastReport', async () => {
    r = await rig();
    expect(r.checker.divergenceCount).toBe(0);
    expect(r.checker.lastCheckAt).toBeNull();
    expect(r.checker.lastReport).toBeNull();
    await r.checker.runOnce();
    expect(r.checker.lastCheckAt).not.toBeNull();
    expect(r.checker.lastReport).not.toBeNull();
    expect(r.checker.lastReport!.scannedJsonProposals).toBe(0);
    expect(r.checker.lastReport!.scannedTaskFlowRecords).toBe(0);
  });
});

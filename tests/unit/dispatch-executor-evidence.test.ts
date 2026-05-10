/**
 * Tests for WikiClaim Evidence Phase 2 — DispatchExecutor producer integration.
 *
 * Covers spec § Producers (DispatchExecutor): on successful execute(),
 * record a `decision` MemoryEntity carrying evidence rows linking the
 * decision to the source cluster (`pattern-entity`), the dispatch id
 * (`ledger-entry`), prior runs (`job-run`), and prior decision entities
 * (`pattern-entity` for supersedes edges).
 *
 * Real SQLite, no mocks (per repo policy).
 *
 * Spec: docs/specs/OPENCLAW-IMPORT-WIKICLAIM-EVIDENCE-SPEC.md § Producers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SemanticMemory } from '../../src/memory/SemanticMemory.js';
import { DispatchExecutor, type DispatchEvidenceContext } from '../../src/core/DispatchExecutor.js';
import { EvolutionManager } from '../../src/core/EvolutionManager.js';
import type { ActionPayload } from '../../src/core/DispatchExecutor.js';

interface Setup {
  dir: string;
  memory: SemanticMemory;
  executor: DispatchExecutor;
  evolution: EvolutionManager;
  cleanup: () => void;
}

async function setup(): Promise<Setup> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-evidence-test-'));
  const dbPath = path.join(dir, 'semantic.db');
  const memory = new SemanticMemory({
    dbPath,
    decayHalfLifeDays: 30,
    lessonDecayHalfLifeDays: 90,
    staleThreshold: 0.2,
  });
  await memory.open();
  const executor = new DispatchExecutor(dir, null);
  executor.setSemanticMemory(memory);
  const evolution = new EvolutionManager({ stateDir: dir });
  evolution.setSemanticMemory(memory);
  return {
    dir,
    memory,
    executor,
    evolution,
    cleanup: () => {
      memory.close();
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/dispatch-executor-evidence.test.ts',
      });
    },
  };
}

const noopPayload: ActionPayload = {
  description: 'Test dispatch — file_write only',
  steps: [
    {
      type: 'file_write',
      path: 'dispatch-output.txt',
      content: 'ok',
    },
  ],
};

describe('DispatchExecutor.execute — evidence emission', () => {
  let s: Setup;
  beforeEach(async () => { s = await setup(); });
  afterEach(() => { s.cleanup(); });

  it('without evidenceCtx, no decision entity is created (legacy path)', async () => {
    const result = await s.executor.execute(noopPayload);
    expect(result.success).toBe(true);
    expect(s.executor.getLastDecisionEntityId()).toBeNull();
  });

  it('with evidenceCtx pointing at a cluster, creates a decision entity with pattern-entity evidence', async () => {
    const proposal = s.evolution.addProposal({
      title: 'Source cluster',
      source: 'feedback:fb_source',
      description: '...',
      type: 'workflow',
    });
    const ctx: DispatchEvidenceContext = {
      clusterEntityId: proposal.entityId!,
      dispatchId: 'disp_001',
    };
    const result = await s.executor.execute(noopPayload, ctx);
    expect(result.success).toBe(true);
    const decisionId = s.executor.getLastDecisionEntityId();
    expect(decisionId).not.toBeNull();
    const fetched = s.memory.getEntityWithEvidence(decisionId!, 'shared-project');
    expect(fetched).not.toBeNull();
    expect(fetched!.type).toBe('decision');
    // pattern-entity row pointing at the cluster + ledger-entry row for dispatch id
    const kinds = fetched!.evidence.map((e) => e.kind).sort();
    expect(kinds).toEqual(['ledger-entry', 'pattern-entity']);
    const patternRow = fetched!.evidence.find((e) => e.kind === 'pattern-entity')!;
    expect(patternRow.sourceId).toBe(proposal.entityId);
    const ledgerRow = fetched!.evidence.find((e) => e.kind === 'ledger-entry')!;
    expect(ledgerRow.sourceId).toBe('disp_001');
  });

  it('emits job-run evidence for prior runs', async () => {
    const proposal = s.evolution.addProposal({
      title: 'Prior runs',
      source: 'feedback:fb_priors',
      description: '...',
      type: 'workflow',
    });
    const ctx: DispatchEvidenceContext = {
      clusterEntityId: proposal.entityId!,
      dispatchId: 'disp_002',
      priorRunIds: ['run_a', 'run_b'],
    };
    await s.executor.execute(noopPayload, ctx);
    const decisionId = s.executor.getLastDecisionEntityId()!;
    const fetched = s.memory.getEntityWithEvidence(decisionId, 'shared-project')!;
    const jobRuns = fetched.evidence.filter((e) => e.kind === 'job-run').map((e) => e.sourceId).sort();
    expect(jobRuns).toEqual(['run_a', 'run_b']);
  });

  it('supersedes-via-pattern-entity: priorDispatchEntityIds emits pattern-entity rows with note', async () => {
    const proposal = s.evolution.addProposal({
      title: 'Supersedes chain',
      source: 'feedback:fb_super',
      description: '...',
      type: 'workflow',
    });
    // First dispatch
    await s.executor.execute(noopPayload, {
      clusterEntityId: proposal.entityId!,
      dispatchId: 'disp_v1',
    });
    const firstDecisionId = s.executor.getLastDecisionEntityId()!;
    // Second dispatch supersedes the first
    await s.executor.execute(noopPayload, {
      clusterEntityId: proposal.entityId!,
      dispatchId: 'disp_v2',
      priorDispatchEntityIds: [firstDecisionId],
    });
    const secondDecisionId = s.executor.getLastDecisionEntityId()!;
    expect(secondDecisionId).not.toBe(firstDecisionId);
    const fetched = s.memory.getEntityWithEvidence(secondDecisionId, 'shared-project')!;
    const patternRows = fetched.evidence.filter((e) => e.kind === 'pattern-entity');
    // One row points at the cluster, one at the prior decision entity
    expect(patternRows.length).toBe(2);
    const sourceIds = patternRows.map((e) => e.sourceId).sort();
    expect(sourceIds).toContain(proposal.entityId);
    expect(sourceIds).toContain(firstDecisionId);
    const supersedesRow = patternRows.find((e) => e.sourceId === firstDecisionId)!;
    expect(supersedesRow.note).toContain('supersedes');
  });

  it('failed dispatch (precondition not met) does NOT create a decision entity', async () => {
    const proposal = s.evolution.addProposal({
      title: 'Precondition fail',
      source: 'feedback:fb_fail',
      description: '...',
      type: 'workflow',
    });
    const failingPayload: ActionPayload = {
      description: 'should not run',
      steps: [{ type: 'file_write', path: 'x.txt', content: 'x' }],
      conditions: { fileExists: 'definitely-not-here.txt' },
    };
    const result = await s.executor.execute(failingPayload, {
      clusterEntityId: proposal.entityId!,
      dispatchId: 'disp_fail',
    });
    expect(result.success).toBe(false);
    expect(s.executor.getLastDecisionEntityId()).toBeNull();
  });
});

describe('Cross-product integration: feedback → cluster → dispatch', () => {
  let s: Setup;
  beforeEach(async () => { s = await setup(); });
  afterEach(() => { s.cleanup(); });

  it('findCitations({kind:feedback, sourceId:fb1}) returns the cluster entity, and the dispatch decision cites the cluster', async () => {
    // 1. Feedback fb1 spawns a cluster
    const proposal = s.evolution.addProposal({
      title: 'End-to-end traceability',
      source: 'feedback:fb1',
      description: 'Cross-product test',
      type: 'workflow',
    });
    // 2. Verify inverse query: feedback fb1 → cluster
    const fbCitations = s.memory.findCitations(
      { kind: 'feedback', sourceId: 'fb1' },
      'shared-project',
    );
    expect(fbCitations.length).toBe(1);
    expect(fbCitations[0].id).toBe(proposal.entityId);

    // 3. Dispatch executes against this cluster, creating a decision entity
    await s.executor.execute(noopPayload, {
      clusterEntityId: proposal.entityId!,
      dispatchId: 'disp_e2e',
    });
    const decisionId = s.executor.getLastDecisionEntityId()!;

    // 4. Verify inverse query: pattern-entity reference to cluster → decision entity
    const decisionCitations = s.memory.findCitations(
      { kind: 'pattern-entity', sourceId: proposal.entityId! },
      'shared-project',
    );
    expect(decisionCitations.length).toBe(1);
    expect(decisionCitations[0].id).toBe(decisionId);
  });
});

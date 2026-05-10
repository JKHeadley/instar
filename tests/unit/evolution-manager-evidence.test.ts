/**
 * Tests for WikiClaim Evidence Phase 2 — EvolutionManager producer integration.
 *
 * Covers spec § Producers (EvolutionManager): cluster MemoryEntity created on
 * `addProposal()`, with evidence rows linking the cluster to its constituent
 * feedback IDs. `addClusterEvidence()` appends incrementally, atomically.
 * Privacy narrowing-only constraint enforced at write time.
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
import { SemanticMemory, EvidencePolicyError } from '../../src/memory/SemanticMemory.js';
import { EvolutionManager } from '../../src/core/EvolutionManager.js';
import type { MemoryEvidence } from '../../src/core/types.js';

interface Setup {
  dir: string;
  memory: SemanticMemory;
  evolution: EvolutionManager;
  cleanup: () => void;
}

async function setup(): Promise<Setup> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-evidence-test-'));
  const dbPath = path.join(dir, 'semantic.db');
  const memory = new SemanticMemory({
    dbPath,
    decayHalfLifeDays: 30,
    lessonDecayHalfLifeDays: 90,
    staleThreshold: 0.2,
  });
  await memory.open();
  const evolution = new EvolutionManager({ stateDir: dir });
  evolution.setSemanticMemory(memory);
  return {
    dir,
    memory,
    evolution,
    cleanup: () => {
      memory.close();
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/evolution-manager-evidence.test.ts',
      });
    },
  };
}

describe('EvolutionManager.addProposal — cluster entity creation', () => {
  let s: Setup;
  beforeEach(async () => { s = await setup(); });
  afterEach(() => { s.cleanup(); });

  it('creates a cluster MemoryEntity and emits feedback evidence from feedback:<id> source', async () => {
    const proposal = s.evolution.addProposal({
      title: 'Telegram tone gate over-blocks file paths',
      source: 'feedback:fb_abc123',
      description: 'Pattern: messages with /paths/ are flagged as code-like.',
      type: 'workflow',
      impact: 'high',
    });
    expect(proposal.entityId).toBeDefined();
    const fetched = s.memory.getEntityWithEvidence(proposal.entityId!, 'shared-project');
    expect(fetched).not.toBeNull();
    expect(fetched!.type).toBe('pattern');
    expect(fetched!.tags).toContain('cluster');
    expect(fetched!.evidence.length).toBe(1);
    expect(fetched!.evidence[0].kind).toBe('feedback');
    expect(fetched!.evidence[0].sourceId).toBe('fb_abc123');
    expect(fetched!.evidence[0].weight).toBe(1.0);
  });

  it('creates cluster entity with empty evidence when source has no recognized prefix', async () => {
    const proposal = s.evolution.addProposal({
      title: 'Capability gap: rate limiting',
      source: 'observation',
      description: 'Detected from session activity.',
      type: 'capability',
    });
    expect(proposal.entityId).toBeDefined();
    const fetched = s.memory.getEntityWithEvidence(proposal.entityId!, 'shared-project');
    expect(fetched!.evidence.length).toBe(0);
  });

  it('persists entityId in JSON state across reload', async () => {
    const proposal = s.evolution.addProposal({
      title: 'Reload persistence check',
      source: 'feedback:fb_reload',
      description: '...',
      type: 'workflow',
    });
    const stateFile = path.join(s.dir, 'state', 'evolution', 'evolution-queue.json');
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    const persisted = raw.proposals.find((p: { id: string }) => p.id === proposal.id);
    expect(persisted.entityId).toBe(proposal.entityId);
  });

  it('addProposal still succeeds when SemanticMemory is not wired (legacy path)', async () => {
    const evolution2 = new EvolutionManager({ stateDir: s.dir });
    // No setSemanticMemory call — legacy posture
    const proposal = evolution2.addProposal({
      title: 'Legacy add',
      source: 'feedback:fb_legacy',
      description: '...',
      type: 'workflow',
    });
    expect(proposal.entityId).toBeUndefined();
  });
});

describe('EvolutionManager.addClusterEvidence — incremental append', () => {
  let s: Setup;
  beforeEach(async () => { s = await setup(); });
  afterEach(() => { s.cleanup(); });

  const more = (sourceId: string, over: Partial<MemoryEvidence> = {}): MemoryEvidence => ({
    kind: 'feedback',
    sourceId,
    weight: 0.5,
    confidence: 0.7,
    updatedAt: '2026-05-10T12:00:00Z',
    ...over,
  });

  it('appends additional feedback evidence to an existing cluster atomically', async () => {
    const proposal = s.evolution.addProposal({
      title: 'Incremental cluster',
      source: 'feedback:fb_first',
      description: '...',
      type: 'workflow',
    });
    s.evolution.addClusterEvidence(proposal.id, [
      more('fb_second'),
      more('fb_third', { weight: 0.4 }),
    ]);
    const fetched = s.memory.getEntityWithEvidence(proposal.entityId!, 'shared-project');
    expect(fetched!.evidence.length).toBe(3);
    const sourceIds = fetched!.evidence.map((e) => e.sourceId).sort();
    expect(sourceIds).toEqual(['fb_first', 'fb_second', 'fb_third']);
  });

  it('atomic: array append rolls back fully when one row violates a policy gate', async () => {
    const proposal = s.evolution.addProposal({
      title: 'Atomic rollback',
      source: 'feedback:fb_a',
      description: '...',
      type: 'workflow',
    });
    // 'commit' kind is not in EvolutionManager allowlist — should reject.
    expect(() =>
      s.evolution.addClusterEvidence(proposal.id, [
        more('fb_b'),
        // Cast through unknown to bypass the typed kind union for the negative test.
        more('sha_xyz', { kind: 'commit' as unknown as MemoryEvidence['kind'] }),
      ])
    ).toThrow(EvidencePolicyError);
    // Original feedback evidence still present, but neither of the two new rows landed.
    const fetched = s.memory.getEntityWithEvidence(proposal.entityId!, 'shared-project');
    expect(fetched!.evidence.length).toBe(1);
    expect(fetched!.evidence[0].sourceId).toBe('fb_a');
  });

  it('no-op when proposal does not exist', async () => {
    expect(() => s.evolution.addClusterEvidence('EVO-999', more('fb_x'))).not.toThrow();
  });

  it('no-op when proposal exists but has no entityId (legacy proposal)', async () => {
    // Build a legacy proposal by writing JSON directly — bypasses cluster creation.
    const legacyState = {
      proposals: [{
        id: 'EVO-LEGACY',
        title: 'Legacy',
        source: 'feedback:fb_old',
        description: '...',
        type: 'workflow',
        impact: 'medium',
        effort: 'medium',
        status: 'proposed',
        proposedBy: 'agent',
        proposedAt: '2026-04-01T00:00:00Z',
        // no entityId
      }],
      stats: { totalProposals: 1, byStatus: {}, byType: {}, lastUpdated: '2026-04-01T00:00:00Z' },
    };
    const legacyDir = path.join(s.dir, 'state', 'evolution');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'evolution-queue.json'), JSON.stringify(legacyState));
    expect(() => s.evolution.addClusterEvidence('EVO-LEGACY', more('fb_new'))).not.toThrow();
  });
});

describe('EvolutionManager — privacy narrowing', () => {
  let s: Setup;
  beforeEach(async () => { s = await setup(); });
  afterEach(() => { s.cleanup(); });

  it('rejects evidence with privacyTier wider than the cluster scope (shared-project rejects public)', async () => {
    const proposal = s.evolution.addProposal({
      title: 'Privacy narrowing check',
      source: 'feedback:fb_priv',
      description: '...',
      type: 'workflow',
    });
    // Cluster scope is 'shared-project' — adding a 'public'-tier evidence is wider, must reject.
    expect(() =>
      s.evolution.addClusterEvidence(proposal.id, {
        kind: 'feedback',
        sourceId: 'fb_public_attempt',
        privacyTier: 'public',
        updatedAt: '2026-05-10T00:00:00Z',
      })
    ).toThrow(EvidencePolicyError);
  });

  it('accepts evidence at equal-or-narrower tier (shared-project entity, private evidence row)', async () => {
    const proposal = s.evolution.addProposal({
      title: 'Privacy narrowing pass',
      source: 'feedback:fb_priv_ok',
      description: '...',
      type: 'workflow',
    });
    s.evolution.addClusterEvidence(proposal.id, {
      kind: 'feedback',
      sourceId: 'fb_narrower',
      privacyTier: 'private',
      updatedAt: '2026-05-10T00:00:00Z',
    });
    // Read-back at private viewer scope — should see the narrowed row.
    const fetched = s.memory.getEntityWithEvidence(proposal.entityId!, 'private');
    expect(fetched!.evidence.length).toBe(2);
  });
});

describe('EvolutionManager — inverse traceability via findCitations', () => {
  let s: Setup;
  beforeEach(async () => { s = await setup(); });
  afterEach(() => { s.cleanup(); });

  it('findCitations returns the cluster entity for a feedback sourceId', async () => {
    const proposal = s.evolution.addProposal({
      title: 'Citation lookup',
      source: 'feedback:fb_citeme',
      description: '...',
      type: 'workflow',
    });
    const citations = s.memory.findCitations(
      { kind: 'feedback', sourceId: 'fb_citeme' },
      'shared-project',
    );
    expect(citations.length).toBe(1);
    expect(citations[0].id).toBe(proposal.entityId);
  });
});

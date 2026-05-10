/**
 * Cross-product privacy tests for EvidenceRenderer (WikiClaim Phase 5).
 *
 * Per spec § Risks line 356: "Add a test that renders every privacyScope ×
 * privacyTier combination and asserts no sensitive evidence reaches
 * lower-scope output."
 *
 * The helper `renderEvidenceForScope(entity, viewerScope)` is the single
 * privacy-enforcement point for any code path that needs to ship a
 * `MemoryEntity` (with evidence) to a viewer at a specific scope. This
 * file walks every (entityScope × evidenceTier × viewerScope) tuple and
 * asserts no leak.
 */

import { describe, it, expect } from 'vitest';
import {
  renderEvidenceForScope,
  filterEvidenceArrayForScope,
  isEntityVisibleAtScope,
  isEvidenceVisibleAtScope,
} from '../../src/memory/EvidenceRenderer.js';
import type {
  MemoryEntity,
  MemoryEvidence,
  EvidencePrivacyTier,
  PrivacyScopeType,
} from '../../src/core/types.js';

const ENTITY_SCOPES: PrivacyScopeType[] = ['shared-project', 'shared-topic', 'private'];
const EVIDENCE_TIERS: (EvidencePrivacyTier | undefined)[] = [
  undefined, // inherit
  'public',
  'shared-project',
  'private',
  'sensitive',
];
const VIEWER_SCOPES: PrivacyScopeType[] = ['shared-project', 'shared-topic', 'private'];

/**
 * The truth table the spec's narrowing-only constraint AND viewer-scope
 * filter together imply. A viewer should see an evidence row iff their
 * scope's tier-ordinal >= the evidence's tier-ordinal.
 *
 * Mapping (must mirror EvidenceRenderer.ts):
 *   shared-project  → 1
 *   shared-topic    → 2 (maps to 'private' tier ordinal)
 *   private         → 2 (same ordinal as shared-topic)
 *
 * Evidence tier ordinals:
 *   public          → 0
 *   shared-project  → 1
 *   private         → 2
 *   sensitive       → 3
 */
function expectedEvidenceVisible(
  evidenceTier: EvidencePrivacyTier | undefined,
  viewerScope: PrivacyScopeType,
): boolean {
  if (evidenceTier === undefined) return true; // inherits — already passed entity-filter
  const viewerOrdinal = viewerScope === 'shared-project' ? 1 : 2;
  const tierOrdinal =
    evidenceTier === 'public'
      ? 0
      : evidenceTier === 'shared-project'
        ? 1
        : evidenceTier === 'private'
          ? 2
          : 3; // sensitive
  return viewerOrdinal >= tierOrdinal;
}

function expectedEntityVisible(
  entityScope: PrivacyScopeType,
  viewerScope: PrivacyScopeType,
): boolean {
  // ENTITY_SCOPE_ORDER: shared-project=0, shared-topic=1, private=2
  const ord = (s: PrivacyScopeType) =>
    s === 'shared-project' ? 0 : s === 'shared-topic' ? 1 : 2;
  return ord(viewerScope) >= ord(entityScope);
}

function makeEvidence(tier: EvidencePrivacyTier | undefined): MemoryEvidence {
  const ev: MemoryEvidence = {
    kind: 'external-url',
    sourceId: `tier-${tier ?? 'inherit'}`,
    updatedAt: '2026-05-09T00:00:00Z',
  };
  if (tier !== undefined) ev.privacyTier = tier;
  return ev;
}

function makeEntity(
  scope: PrivacyScopeType,
  evidenceTiers: (EvidencePrivacyTier | undefined)[],
): MemoryEntity {
  return {
    id: `e_${scope}`,
    type: 'fact',
    name: 'cross-product entity',
    content: 'test',
    confidence: 0.9,
    createdAt: '2026-05-09T00:00:00Z',
    lastVerified: '2026-05-09T00:00:00Z',
    lastAccessed: '2026-05-09T00:00:00Z',
    source: 'test',
    tags: [],
    privacyScope: scope,
    evidence: evidenceTiers.map(makeEvidence),
  };
}

describe('EvidenceRenderer — cross-product privacy enforcement', () => {
  for (const entityScope of ENTITY_SCOPES) {
    for (const viewerScope of VIEWER_SCOPES) {
      it(`entity=${entityScope}, viewer=${viewerScope} → correct entity visibility + filtered evidence`, () => {
        const entity = makeEntity(entityScope, EVIDENCE_TIERS);
        const result = renderEvidenceForScope(entity, viewerScope);

        const entityShouldShow = expectedEntityVisible(entityScope, viewerScope);
        if (!entityShouldShow) {
          expect(result).toBeNull();
          return;
        }
        expect(result).not.toBeNull();
        expect(result!.privacyScope).toBe(entityScope);

        // Every evidence row should match the truth table.
        const filteredTiers = (result!.evidence ?? []).map((e) => e.privacyTier);
        const expectedTiers = EVIDENCE_TIERS.filter((t) =>
          expectedEvidenceVisible(t, viewerScope),
        );
        expect(new Set(filteredTiers)).toEqual(new Set(expectedTiers));
      });
    }
  }

  it('does not mutate the input entity (safe to reuse across viewers)', () => {
    const entity = makeEntity('shared-project', EVIDENCE_TIERS);
    const beforeLen = entity.evidence!.length;
    renderEvidenceForScope(entity, 'shared-project');
    renderEvidenceForScope(entity, 'private');
    expect(entity.evidence!.length).toBe(beforeLen);
  });

  it('preserves evidence: undefined (lazy not-loaded signal)', () => {
    const entity: MemoryEntity = {
      ...makeEntity('shared-project', []),
      evidence: undefined,
    };
    const result = renderEvidenceForScope(entity, 'shared-project');
    expect(result).not.toBeNull();
    expect(result!.evidence).toBeUndefined();
  });

  it('filterEvidenceArrayForScope mirrors renderEvidenceForScope filtering', () => {
    for (const viewerScope of VIEWER_SCOPES) {
      const evidence = EVIDENCE_TIERS.map(makeEvidence);
      const filtered = filterEvidenceArrayForScope(evidence, viewerScope);
      const expectedTiers = EVIDENCE_TIERS.filter((t) =>
        expectedEvidenceVisible(t, viewerScope),
      );
      expect(filtered.map((e) => e.privacyTier).sort()).toEqual(
        expectedTiers.map((t) => t).sort(),
      );
    }
  });

  it('sensitive evidence NEVER reaches a non-private viewer', () => {
    // Spec-critical: even the highest entity scope must hide 'sensitive'
    // evidence from a 'shared-project' viewer.
    const entity = makeEntity('shared-project', ['sensitive']);
    const result = renderEvidenceForScope(entity, 'shared-project');
    expect(result).not.toBeNull();
    expect(result!.evidence).toHaveLength(0);
  });

  it('private viewer sees private evidence on a shared-project entity', () => {
    const entity = makeEntity('shared-project', ['private']);
    const result = renderEvidenceForScope(entity, 'private');
    expect(result!.evidence).toHaveLength(1);
  });

  it('public evidence visible to every viewer scope', () => {
    for (const viewerScope of VIEWER_SCOPES) {
      const entity = makeEntity('shared-project', ['public']);
      const result = renderEvidenceForScope(entity, viewerScope);
      expect(result).not.toBeNull();
      expect(result!.evidence?.[0].privacyTier).toBe('public');
    }
  });
});

describe('EvidenceRenderer — visibility predicates (used by SemanticMemory)', () => {
  it('isEntityVisibleAtScope: viewer-scope-tier ordering', () => {
    expect(isEntityVisibleAtScope('shared-project', 'shared-project')).toBe(true);
    expect(isEntityVisibleAtScope('shared-project', 'private')).toBe(true);
    expect(isEntityVisibleAtScope('private', 'shared-project')).toBe(false);
    expect(isEntityVisibleAtScope('shared-topic', 'shared-project')).toBe(false);
    expect(isEntityVisibleAtScope(undefined, 'shared-project')).toBe(true); // default
  });

  it('isEvidenceVisibleAtScope: tier ordering with vocabulary widening', () => {
    expect(isEvidenceVisibleAtScope(undefined, 'shared-project')).toBe(true);
    expect(isEvidenceVisibleAtScope('public', 'shared-project')).toBe(true);
    expect(isEvidenceVisibleAtScope('shared-project', 'shared-project')).toBe(true);
    expect(isEvidenceVisibleAtScope('private', 'shared-project')).toBe(false);
    expect(isEvidenceVisibleAtScope('sensitive', 'private')).toBe(false);
    expect(isEvidenceVisibleAtScope('private', 'private')).toBe(true);
  });
});

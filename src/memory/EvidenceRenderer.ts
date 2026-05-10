/**
 * EvidenceRenderer — single privacy-enforcement helper for MemoryEntity
 * evidence rendering.
 *
 * Per WikiClaim spec § Storage and Privacy (line 315) and § Risks line 356,
 * "the renderer is the privacy-enforcement boundary, not the storage layer."
 * The storage layer already filters at read time via `getEvidence` /
 * `getEntityWithEvidence` / `findCitations`, but any downstream code path
 * that touches an already-loaded `MemoryEntity.evidence` array must pipe
 * through this helper instead of inlining the comparison — that way the
 * filter rule lives in exactly ONE place and Phase 4 HTTP / dashboard /
 * threadline render callsites can never accidentally leak.
 *
 * The helper enforces:
 *   1. Entity-level visibility — if the entity's `privacyScope` exceeds the
 *      viewer's scope, the entity itself is hidden (returns null).
 *   2. Evidence-level visibility — each evidence row's `privacyTier` (or
 *      `undefined`, which inherits the entity scope) is checked against
 *      the viewer scope; restricted rows are dropped.
 *
 * Spec citations:
 *   - § Storage and Privacy line 315: renderer is the enforcement boundary
 *   - § Risks line 356: "render every privacyScope × privacyTier
 *     combination" cross-product test asserts no leak
 *   - § Storage and Privacy line 316: inverse-query privacy filter
 */

import type {
  MemoryEntity,
  MemoryEvidence,
  EvidencePrivacyTier,
  PrivacyScopeType,
} from '../core/types.js';

/**
 * Entity-level privacy ordering. `private` > `shared-topic` > `shared-project`.
 * A viewer at higher tier sees their tier and everything below.
 *
 * Mirrors `ENTITY_SCOPE_ORDER` in SemanticMemory.ts — kept colocated rather
 * than imported to keep the renderer side-effect-free and avoid pulling
 * better-sqlite3 into render contexts that don't need it (e.g., HTTP
 * response shapers).
 */
const ENTITY_SCOPE_ORDER: Record<PrivacyScopeType, number> = {
  'shared-project': 0,
  'shared-topic': 1,
  'private': 2,
};

/**
 * Evidence-level privacy ordering. Wider vocabulary than entity scope:
 * adds `public` (more permissive than shared-project) and `sensitive`
 * (more restrictive than private). Per spec § Schema Changes line 136.
 */
const EVIDENCE_TIER_ORDER: Record<EvidencePrivacyTier, number> = {
  'public': 0,
  'shared-project': 1,
  'private': 2,
  'sensitive': 3,
};

/** Map an entity-vocabulary scope onto the evidence-tier scale. */
function entityScopeToTierOrdinal(scope: PrivacyScopeType): number {
  switch (scope) {
    case 'shared-project':
      return EVIDENCE_TIER_ORDER['shared-project'];
    case 'shared-topic':
      // Conservative-map: 'shared-topic' is absent from the evidence
      // vocabulary; treat it like 'private' so wider tiers cannot be
      // attached to topic-scope entities.
      return EVIDENCE_TIER_ORDER['private'];
    case 'private':
      return EVIDENCE_TIER_ORDER['private'];
  }
}

/** True iff entity at `itemScope` is visible to a viewer at `viewerScope`. */
export function isEntityVisibleAtScope(
  itemScope: PrivacyScopeType | undefined,
  viewerScope: PrivacyScopeType,
): boolean {
  const item = itemScope ?? 'shared-project';
  return ENTITY_SCOPE_ORDER[viewerScope] >= ENTITY_SCOPE_ORDER[item];
}

/**
 * True iff an evidence row tagged `evidenceTier` is visible to `viewerScope`.
 * `undefined` evidenceTier inherits the entity's scope — by the time this
 * helper is called the entity-level filter has already accepted the entity,
 * so undefined tiers pass through. (Mirrors SemanticMemory's `getEvidence`
 * read-time filter.)
 */
export function isEvidenceVisibleAtScope(
  evidenceTier: EvidencePrivacyTier | undefined,
  viewerScope: PrivacyScopeType,
): boolean {
  if (evidenceTier === undefined) return true;
  return entityScopeToTierOrdinal(viewerScope) >= EVIDENCE_TIER_ORDER[evidenceTier];
}

/**
 * Filter an entity for a viewer. Returns:
 *  - `null` if the entity's own `privacyScope` is wider than the viewer's
 *    scope (entity itself is hidden).
 *  - A shallow clone with `evidence` filtered to only rows visible at the
 *    viewer's scope. The `evidence` field is preserved as `[]` if all rows
 *    are filtered out and as `undefined` if the input didn't have one
 *    loaded (matches the lazy-load contract in MemoryEntity).
 *
 * SAFETY: never mutates the input entity. Callers can pass the same entity
 * to multiple viewers without cross-contamination.
 */
export function renderEvidenceForScope(
  entity: MemoryEntity,
  viewerScope: PrivacyScopeType,
): (MemoryEntity & { evidence?: MemoryEvidence[] }) | null {
  if (!isEntityVisibleAtScope(entity.privacyScope, viewerScope)) {
    return null;
  }
  if (entity.evidence === undefined) {
    // Lazy: caller didn't load evidence; pass through unchanged.
    return { ...entity };
  }
  const filtered = entity.evidence.filter((ev) =>
    isEvidenceVisibleAtScope(ev.privacyTier, viewerScope),
  );
  return { ...entity, evidence: filtered };
}

/**
 * Filter a bare evidence array for a viewer scope. Used when the consumer
 * has evidence in hand without the parent entity (e.g., a separate evidence
 * panel that received a pre-loaded array).
 *
 * NOTE: this skips the entity-level visibility check. Use `renderEvidenceForScope`
 * whenever the entity is available. This helper exists for the narrow
 * `findCitations`-derived flow where the entity was already filtered and
 * only its evidence array is being trimmed.
 */
export function filterEvidenceArrayForScope(
  evidence: readonly MemoryEvidence[],
  viewerScope: PrivacyScopeType,
): MemoryEvidence[] {
  return evidence.filter((ev) => isEvidenceVisibleAtScope(ev.privacyTier, viewerScope));
}

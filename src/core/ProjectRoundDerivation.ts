/**
 * Derive a project's round state from its member records.
 *
 * `InitiativeRound.status` is a cached conclusion. The child initiatives are
 * the evidence-bearing source of truth, so readers must not use that cache to
 * decide whether work is complete (or whether it should be run again).
 */

import type {
  Initiative,
  InitiativeRound,
  RoundStatus,
} from './InitiativeTracker.js';

export type MergedEvidenceField = 'prNumber' | 'mergeCommitOid' | 'ciCheckedAt';

export interface ProjectRoundDerivation {
  /** Status exposed to readers after reconciling the cached status with members. */
  effectiveStatus: RoundStatus;
  /** A terminal conclusion earned entirely from member state, when available. */
  terminalStatus?: 'complete' | 'complete-with-skips';
  /** Referenced child IDs absent from the tracker. */
  missingMemberIds: string[];
  /** Non-terminal members that still represent unfinished work. */
  incompleteItemIds: string[];
  /** `merged` claims whose record cannot identify what was verified. */
  evidenceMissingByItem: Record<string, MergedEvidenceField[]>;
}

export function missingMergedEvidenceFields(
  item: Pick<Initiative, 'prNumber' | 'mergeCommitOid' | 'ciCheckedAt'>,
): MergedEvidenceField[] {
  const missing: MergedEvidenceField[] = [];
  if (!Number.isInteger(item.prNumber) || (item.prNumber ?? 0) <= 0) missing.push('prNumber');
  if (
    typeof item.mergeCommitOid !== 'string'
    || !/^[0-9a-f]{7,64}$/i.test(item.mergeCommitOid.trim())
  ) {
    missing.push('mergeCommitOid');
  }
  if (
    typeof item.ciCheckedAt !== 'string'
    || !item.ciCheckedAt.trim()
    || !Number.isFinite(Date.parse(item.ciCheckedAt))
  ) {
    missing.push('ciCheckedAt');
  }
  return missing;
}

export function hasCompleteMergedEvidence(
  item: Pick<Initiative, 'prNumber' | 'mergeCommitOid' | 'ciCheckedAt'>,
): boolean {
  return missingMergedEvidenceFields(item).length === 0;
}

export function deriveProjectRound(
  round: InitiativeRound,
  childrenById: ReadonlyMap<string, Initiative>,
): ProjectRoundDerivation {
  const missingMemberIds: string[] = [];
  const incompleteItemIds: string[] = [];
  const evidenceMissingByItem: Record<string, MergedEvidenceField[]> = {};
  let skippedCount = 0;

  for (const itemId of round.itemIds ?? []) {
    const item = childrenById.get(itemId);
    if (!item) {
      missingMemberIds.push(itemId);
      continue;
    }
    if (item.pipelineStage === 'skipped') {
      skippedCount += 1;
      continue;
    }
    if (item.pipelineStage === 'merged') {
      const missing = missingMergedEvidenceFields(item);
      if (missing.length > 0) evidenceMissingByItem[itemId] = missing;
      continue;
    }
    incompleteItemIds.push(itemId);
  }

  const hasMembers = (round.itemIds ?? []).length > 0;
  const allMembersTerminal = hasMembers
    && missingMemberIds.length === 0
    && incompleteItemIds.length === 0
    && Object.keys(evidenceMissingByItem).length === 0;
  const terminalStatus = allMembersTerminal
    ? (skippedCount > 0 ? 'complete-with-skips' : 'complete')
    : undefined;

  // A cached terminal conclusion whose members no longer support it has been
  // invalidated. Other non-terminal workflow statuses remain useful hints.
  const cachedWasTerminal = round.status === 'complete' || round.status === 'complete-with-skips';
  const effectiveStatus: RoundStatus = terminalStatus
    ?? (cachedWasTerminal ? 'regressed' : (round.status ?? 'pending'));

  return {
    effectiveStatus,
    terminalStatus,
    missingMemberIds,
    incompleteItemIds,
    evidenceMissingByItem,
  };
}

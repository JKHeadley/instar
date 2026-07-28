import type { ClassReviewStore } from './ClassReviewStore.js';
import type { CorrectionLedger } from './CorrectionLedger.js';

export interface CorrectionInstanceFixAdmission {
  allow: boolean;
  wouldRefuse: boolean;
  classReviewRef?: string;
  reason: 'not-correction-derived' | 'feature-dark' | 'correction-not-found' | 'correspondence-mismatch' | 'review-absent' | 'review-pending' | 'review-filled' | 'review-dead-lettered';
}

/** Correspondence-bound admission. In dry-run every branch allows, but the
 * exact refusal is returned for audit/metrics. Dead-letter and dark-peer paths
 * deliberately fail toward allow even in enforce mode. */
export function evaluateCorrectionInstanceFix(input: {
  originCorrection: boolean;
  correctionId?: string;
  claimedClassReviewRef?: string;
  dryRun: boolean;
  correctionLedger: CorrectionLedger | null;
  classReviewStore: ClassReviewStore | null;
}): CorrectionInstanceFixAdmission {
  if (!input.originCorrection) return { allow: true, wouldRefuse: false, reason: 'not-correction-derived' };
  const correction = input.correctionId ? input.correctionLedger?.get(input.correctionId) : null;
  if (!correction) return decision(input.dryRun, 'correction-not-found');
  if (input.claimedClassReviewRef && input.claimedClassReviewRef !== correction.dedupeKey) {
    return decision(input.dryRun, 'correspondence-mismatch', correction.dedupeKey);
  }
  if (!input.classReviewStore) return { allow: true, wouldRefuse: false, classReviewRef: correction.dedupeKey, reason: 'feature-dark' };
  // A peer's filled judgment proves that the unified per-dedupe artifact was
  // produced. Its lifecycle dispositions remain advisory and cannot mutate
  // this machine's operator-owned lifecycle (the store enforces that split).
  const review = input.classReviewStore.get(correction.dedupeKey);
  if (!review) return decision(input.dryRun, 'review-absent', correction.dedupeKey);
  if (review.fillState === 'pending') return decision(input.dryRun, 'review-pending', correction.dedupeKey);
  if (review.fillState === 'dead-lettered') return { allow: true, wouldRefuse: false, classReviewRef: correction.dedupeKey, reason: 'review-dead-lettered' };
  return { allow: true, wouldRefuse: false, classReviewRef: correction.dedupeKey, reason: 'review-filled' };
}

function decision(dryRun: boolean, reason: CorrectionInstanceFixAdmission['reason'], classReviewRef?: string): CorrectionInstanceFixAdmission {
  return { allow: dryRun, wouldRefuse: true, ...(classReviewRef ? { classReviewRef } : {}), reason };
}

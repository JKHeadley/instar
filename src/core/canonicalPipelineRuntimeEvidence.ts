export interface CanonicalPipelineRuntimeEvidence {
  consumerConstructed: boolean;
  cadenceEnabled: boolean;
  productionConsumerAdapter: boolean;
  authoritativeReadBack: boolean;
  attemptedDeliveries: number;
  uniqueWorkRows: number;
  uniqueArtifactLinks: number;
  progressMetricBefore: number | null;
  progressMetricAfter: number | null;
}

export function validateCanonicalPipelineRuntimeEvidence(e: CanonicalPipelineRuntimeEvidence): string[] {
  const failures: string[] = [];
  if (!e.consumerConstructed) failures.push('consumer-unconstructed');
  if (!e.cadenceEnabled) failures.push('cadence-disabled');
  if (!e.productionConsumerAdapter || !e.authoritativeReadBack) failures.push('fake-wiring');
  if (e.attemptedDeliveries < 1 || e.uniqueWorkRows !== 1 || e.uniqueArtifactLinks !== 1) failures.push('ineffective-idempotency');
  if (e.progressMetricBefore === null || e.progressMetricAfter === null || e.progressMetricAfter <= e.progressMetricBefore) failures.push('missing-progress-metric');
  return failures;
}

/** Public detector diagnostics contain only fixed reasons and aggregate counts.
 * None of these observations grants recording, delivery or ownership authority. */
export interface OriginSourceHealth {
  state: 'healthy' | 'unavailable' | 'stale' | 'closed' | 'pending';
  reason: string;
  attemptedAt: number | null;
  succeededAt: number | null;
  busy: boolean;
  revision?: number;
}
export interface OriginCanaryHealth {
  scope: 'owned-file-backed-secretstore-fixture';
  osKeychainVerified: false;
  state: 'pending' | 'running' | 'pass' | 'fail' | 'stale' | 'closed';
  reason: string;
  attemptedAt: number | null;
  finishedAt: number | null;
  validUntil: number | null;
  attempts: number;
  intervalMs: number;
  checks: string[];
}

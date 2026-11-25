import type { LeaseHoldVerdict } from '../core/LeaseCoordinator.js';

const VERDICTS: Record<LeaseHoldVerdict, true> = {
  holding: true, suspended: true, 'not-current-holder': true,
  'renewal-lapsed': true, superseded: true,
};

function duration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    ? Math.round(value) : null;
}

/** Observation only: never changes the lease preflight or includes request data. */
export function recordMobileChatServingRefusal(options: {
  readFreshness?: () => unknown;
  now?: () => number;
  write?: (line: string) => void;
}): void {
  let at: string | null = null;
  let observedLeaseVerdict = 'unavailable';
  let msSinceConfirmedRenewal: number | null = null;
  let ttlMs: number | null = null;
  try { at = new Date((options.now ?? Date.now)()).toISOString(); }
  catch { /* @silent-fallback-ok — a failed diagnostic clock cannot change the refusal */ }
  try {
    const value = options.readFreshness?.();
    if (value && typeof value === 'object') {
      const snapshot = value as Record<string, unknown>;
      const verdict = snapshot.verdict;
      if (typeof verdict === 'string' && Object.hasOwn(VERDICTS, verdict)) {
        observedLeaseVerdict = verdict;
      }
      msSinceConfirmedRenewal = duration(snapshot.msSinceConfirmedRenewal);
      ttlMs = duration(snapshot.ttlMs);
    }
  } catch { /* @silent-fallback-ok — unavailable diagnostics never grant or deny authority */ }
  try {
    (options.write ?? console.warn)(JSON.stringify({
      kind: 'mobile-chat-not-serving', at, pid: process.pid,
      sample: 'after-refusal', observedLeaseVerdict, msSinceConfirmedRenewal, ttlMs,
    }));
  } catch { /* @silent-fallback-ok — logging failure must preserve the original 409 */ }
}

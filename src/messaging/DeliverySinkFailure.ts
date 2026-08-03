import { DegradationReporter } from '../monitoring/DegradationReporter.js';

export interface DeliverySinkFailure {
  component: string;
  primary: string;
  reason: string;
  impact: string;
}

/**
 * Delivery absence is never a successful no-op. This helper gives every
 * send-side component the same loud, durable degradation path while allowing
 * callers to keep their own retry/backoff authority.
 */
export function reportDeliverySinkFailure(failure: DeliverySinkFailure): void {
  console.error(`[delivery-sink] ${failure.component}: ${failure.reason}`);
  DegradationReporter.getInstance().report({
    feature: `${failure.component}.delivery-sink`,
    primary: failure.primary,
    fallback: 'Record the delivery failure through the owning component policy',
    reason: failure.reason,
    impact: failure.impact,
  });
}

export function requireDeliverySink<T>(
  sink: T | null | undefined,
  failure: DeliverySinkFailure,
): sink is T {
  if (sink != null) return true;
  reportDeliverySinkFailure(failure);
  return false;
}

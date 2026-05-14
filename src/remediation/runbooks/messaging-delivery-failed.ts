/**
 * messaging-delivery-failed — Tier-2 W-3 runbook.
 *
 * SELF-HEALING-REMEDIATOR-V2-SPEC §A1 W-3, §A6 (structured provenance only),
 * §A9 (durable verify — drain ALL stuck messages, not just one), §A34 R3
 * (surface-alignment: `DeliveryRetryManager.runRecoveryCycle()` is a new
 * public method distinct from timer-driven `tick()`, idempotent against the
 * running timer via a shared in-flight latch), §A57 (Tier-2 W-3).
 *
 * Surface: `DeliveryRetryManager.invokeFromRemediator(ctx)` (added by W-3).
 * The legacy `tick()` timer entry-point on `start()` stays unchanged — it
 * remains the steady-state cadence; this runbook is the parallel,
 * Remediator-orchestrated path for when degradation events fire (Telegram
 * 429/500, generic DELIVERY_FAILURE).
 *
 * Match contract:
 *   eventPrefilter.errorCode    = ['DELIVERY_FAILURE','TELEGRAM_429','TELEGRAM_500']
 *   eventPrefilter.provenance   = ['subsystem-explicit','probe-id']
 *
 * `'free-text'` is intentionally NOT in the prefilter — §A6 mandates
 * structured-provenance only.
 *
 * Verify (A9 — durable, not just live):
 *   The verify step queries the durable inbox (via the messaging adapter
 *   injected for testing, or the manager's own store) and asserts that
 *   NO messages remain in `queued` or `undelivered` phase for the manager's
 *   agent. A clean inbox → `verified-healthy`. Any stuck messages →
 *   `verify-failed` (durability not restored). A probe error (cannot read
 *   the store) → `verify-inconclusive` per §A21.
 *
 *   This is a stronger assertion than "the cycle ran" — a single retry
 *   could succeed for one message and leave nine others stuck. Durable
 *   drain is the spec's bar.
 *
 * essential:
 *   This runbook is `essential: false`. Messaging downtime is recoverable
 *   via the standard 15s timer cadence — the Remediator-orchestrated path
 *   is desirable (faster recovery + audit-tracked) but not load-bearing
 *   for agent survival. blastRadius is 'process' (the cycle touches
 *   only in-process state + the on-disk message store), and §A36 forbids
 *   essential=true on non-machine blast-radius.
 */

import type { ApprovedRunbook, RemediationContext, ExecutionResult, VerifyOutcome } from '../Remediator.js';
import type { DeliveryRetryManager } from '../../messaging/DeliveryRetryManager.js';
import type { MessageStore } from '../../messaging/MessageStore.js';

/**
 * Dependencies the runbook resolves at dispatch time. Production wires the
 * live `DeliveryRetryManager` + its `MessageStore`; tests inject fakes.
 *
 * Late-bound via a registry function rather than a constant so the runbook
 * module doesn't have to import the messaging singleton at module-load
 * time (which would create a circular import path through the server).
 */
export interface MessagingDeliveryDeps {
  /** Returns the live manager, or null if messaging is not initialized. */
  getManager: () => DeliveryRetryManager | null;
  /**
   * Returns the live message store + the agent name to scope inbox queries
   * to. The verify probe uses this to assert durable drain.
   */
  getStoreScope: () => { store: MessageStore; agentName: string } | null;
}

let _deps: MessagingDeliveryDeps | null = null;

/**
 * Production wires the live manager + store at boot via this setter. Tests
 * inject fakes. Setting to `null` resets — the surfaceCallable + verify
 * report `verify-inconclusive` (probe error) until re-wired.
 */
export function setMessagingDeliveryDeps(deps: MessagingDeliveryDeps | null): void {
  _deps = deps;
}

/**
 * §A9 durable verify probe. Returns a structured kind so the runbook's
 * verify() can map to the {verified-healthy | verify-failed | verify-inconclusive}
 * taxonomy without ambiguity.
 *
 * "Durable" means the on-disk inbox query, not the in-memory retry-state
 * map. The store is the source of truth — retryState is a transient
 * scheduling hint that resets on process restart.
 */
async function probeDurableDrain(
  deps: MessagingDeliveryDeps | null,
): Promise<
  | { kind: 'ok' }
  | { kind: 'stuck'; stuckCount: number; sampleIds: string[] }
  | { kind: 'inconclusive'; reason: string }
> {
  if (!deps) {
    return { kind: 'inconclusive', reason: 'messaging-delivery deps not wired' };
  }
  const scope = deps.getStoreScope();
  if (!scope) {
    return { kind: 'inconclusive', reason: 'messaging store-scope unavailable' };
  }
  try {
    const inbox = await scope.store.queryInbox(scope.agentName);
    const stuck = inbox.filter(
      (e) => e.delivery.phase === 'queued' || e.delivery.phase === 'undelivered',
    );
    if (stuck.length === 0) {
      return { kind: 'ok' };
    }
    return {
      kind: 'stuck',
      stuckCount: stuck.length,
      sampleIds: stuck.slice(0, 5).map((e) => e.message.id),
    };
  } catch (err) {
    return {
      kind: 'inconclusive',
      reason: `queryInbox threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Allow tests to inject a deterministic verify probe. Production always
 * uses `probeDurableDrain` against the wired deps.
 */
type VerifyFn = (deps: MessagingDeliveryDeps | null) => Promise<
  | { kind: 'ok' }
  | { kind: 'stuck'; stuckCount: number; sampleIds: string[] }
  | { kind: 'inconclusive'; reason: string }
>;
let _verifyImpl: VerifyFn = probeDurableDrain;
export function _setVerifyImplForTesting(fn: VerifyFn | null): void {
  _verifyImpl = fn ?? probeDurableDrain;
}

async function callSurface(ctx: RemediationContext): Promise<ExecutionResult> {
  if (!_deps) {
    return {
      outcome: 'failure',
      details: { error: 'messaging-delivery deps not wired' },
    };
  }
  const mgr = _deps.getManager();
  if (!mgr) {
    return {
      outcome: 'failure',
      details: { error: 'DeliveryRetryManager not initialized' },
    };
  }
  return mgr.invokeFromRemediator(ctx);
}

export const messagingDeliveryFailedRunbook: ApprovedRunbook = {
  id: 'messaging-delivery-failed',
  priority: 80,
  surface: 'delivery-retry',
  eventPrefilter: {
    // Three structured errorCodes the messaging subsystem emits. Telegram
    // 429 (rate-limit) and 500 (upstream error) are the dominant
    // failure-mode classes; generic DELIVERY_FAILURE catches the long
    // tail (tmux session unreachable, ack-timeout escalation, etc.).
    errorCode: ['DELIVERY_FAILURE', 'TELEGRAM_429', 'TELEGRAM_500'],
    // §A6: NOT free-text. Probe-id is allowed because future messaging
    // probes (e.g., a periodic queue-depth probe) will emit signed events.
    provenance: ['subsystem-explicit', 'probe-id'],
  },
  match: (event) => {
    // Match anything that came from the messaging subsystem. The errorCode
    // prefilter is already narrow; the match() callback is defence-in-depth
    // against an unrelated subsystem that happens to ship one of these
    // generic codes (e.g., a future HTTP client emitting a generic 429).
    return event.subsystem === 'messaging' || event.subsystem === 'delivery-retry';
  },
  preconditions: async (_event) => {
    // Deps must be wired AND the manager must be live. Without either,
    // calling the surface is meaningless — short-circuit at precondition
    // time so the audit trail records the right reason.
    if (!_deps) return false;
    return _deps.getManager() !== null;
  },
  surfaceCallable: callSurface,
  verify: async (_ctx) => {
    const result = await _verifyImpl(_deps);
    const v: VerifyOutcome = (() => {
      switch (result.kind) {
        case 'ok':
          return {
            outcome: 'verified-healthy',
            reason: 'inbox drained — 0 queued/undelivered messages',
          };
        case 'stuck':
          return {
            outcome: 'verify-failed',
            reason:
              `${result.stuckCount} messages still queued/undelivered after recovery cycle ` +
              `(sample: ${result.sampleIds.join(', ')})`,
          };
        case 'inconclusive':
          return {
            outcome: 'verify-inconclusive',
            reason: result.reason,
          };
      }
    })();
    return v;
  },
  blastRadius: 'process',
  reversibility: 'reversible',
  expectedRuntimeMs: 60_000,
  // §A36: essential=true requires blastRadius='machine'. Messaging downtime
  // is recoverable via the timer cadence (15s tick), so the Remediator-
  // orchestrated path is desirable-not-required — essential stays false.
  essential: false,
};

// Re-export the verify probe for tests / consumers that want it raw.
export { probeDurableDrain };

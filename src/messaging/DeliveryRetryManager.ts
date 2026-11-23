/**
 * DeliveryRetryManager — handles retry, watchdog, and TTL expiry for message delivery.
 *
 * Three responsibilities:
 * 1. Retry delivery for queued messages (Layer 2 retry with exponential backoff)
 * 2. Post-injection watchdog: after tmux injection, verify session is still alive
 * 3. TTL expiry: move expired messages to dead-letter, escalate critical/alert to Telegram
 *
 * Per spec Phase 3: Layer 1 retry (server unreachable) uses exponential backoff
 * with max 4-hour retry window. Layer 2 retry (session unavailable) retries
 * every 30s for up to 5 minutes. Layer 3 timeout varies by message type.
 */

import { HOLDER_RETRY_WINDOW_MS } from './types.js';
import type {
  MessageEnvelope,
  MessageType,
  DeliveryPhase,
  MessagingStats,
} from './types.js';
import type { MessageStore } from './MessageStore.js';
import { beginDeliveryAttempt, type DeliveryAttemptClaim, type MessageDelivery } from './MessageDelivery.js';
import type { RemediationContext, ExecutionResult } from '../remediation/Remediator.js';

/** Layer 3 ACK timeout by message type (in minutes). null = no timeout (fire-and-forget) */
const ACK_TIMEOUT: Record<MessageType, number | null> = {
  info: null,
  sync: null,
  alert: null,
  request: 10,
  query: 5,
  response: null,
  handoff: null,
  wellness: 2,
  system: null,
  'delivery-notice': null,
};

/** Layer 1 retry backoff schedule (seconds). Doubles after each attempt. */
const LAYER1_BACKOFF_BASE_MS = 5_000;
const LAYER1_MAX_INTERVAL_MS = 30 * 60_000; // 30 minutes
const LAYER1_MAX_WINDOW_MS = 4 * 60 * 60_000; // 4 hours

/** Layer 2 retry interval */
export const LAYER2_RETRY_INTERVAL_MS = 30_000; // 30 seconds
export const LAYER2_MAX_RETRIES = 10; // count ceiling
export const LAYER2_RETRY_WINDOW_MS = HOLDER_RETRY_WINDOW_MS; // inherited five-minute work window

/**
 * relay-asof-holder-skew §2: the Layer-2 lane's one decision for a pass, as a pure
 * function so the self-action ratchet can drive it (src/testing/selfActionRegistry.ts,
 * `message-holder-redelivery`). `give-up` is taken once, then the envelope is a dead
 * letter and leaves the inbox; `wait` costs nothing; `attempt` is one redelivery.
 */
export function layer2RetryDecision(
  state: { attempts: number; lastAttemptAt: number; firstAttemptAt?: number } | undefined,
  nowMs: number,
): 'give-up' | 'wait' | 'attempt' {
  const attempts = state?.attempts ?? 0;
  if (attempts >= LAYER2_MAX_RETRIES) return 'give-up';
  const durableLane = state?.firstAttemptAt !== undefined;
  if (durableLane && nowMs - state!.firstAttemptAt! >= LAYER2_RETRY_WINDOW_MS) return 'give-up';
  const interval = durableLane
    ? Math.min(LAYER2_RETRY_WINDOW_MS, LAYER2_RETRY_INTERVAL_MS * 2 ** Math.max(0, attempts - 1))
    : LAYER2_RETRY_INTERVAL_MS;
  if (nowMs - (state?.lastAttemptAt ?? 0) < interval) return 'wait';
  return 'attempt';
}

/** How often the manager runs its tick */
const TICK_INTERVAL_MS = 15_000; // 15 seconds

export interface DeliveryRetryManagerConfig {
  /** Agent name for filtering messages */
  agentName: string;
  currentSessionGeneration?: (tmuxSession: string) => string | null;
  generationEvidence?: (kind: 'fired' | 'held' | 'error', reason: string, messageId: string) => void;
  /** Callback for escalation (e.g., send to Telegram) */
  onEscalate?: (envelope: MessageEnvelope, reason: string) => void;
  /**
   * messages-reach-renamed-sessions §B: true when the envelope is addressed to this
   * machine (its id, 'local', or unset). Retries, the watchdog and the ACK-timeout step
   * act only on these. Absent ⇒ every envelope (today's behaviour).
   */
  isLocalEnvelope?: (envelope: MessageEnvelope) => boolean;
  /** §B: is the pinned session (name + Session.id) still the running one? */
  isPinnedSessionLive?: (tmuxSession: string, sessionId: string) => boolean;
  /** §C: a local envelope that was never typed reached a dead letter. Never throws. */
  onDeadLetter?: (envelope: MessageEnvelope, reason: string) => void;
  /**
   * §D.6: true for an origin copy of a cross-machine message that is kept open for a
   * late remote notice; the TTL sweep skips it.
   */
  holdForRemoteNotice?: (envelope: MessageEnvelope) => boolean;
  /**
   * relay-asof-holder-skew §2: a queued envelope marked `holderPending` is re-resolved
   * here (MessageRouter.redeliverSameAgentLocal) instead of being typed into
   * `to.session` by name. Returns the phase reached. Absent ⇒ no typing; the
   * envelope ends with an explicit configuration failure notice.
   */
  redeliverUnresolved?: (envelope: MessageEnvelope, claim: DeliveryAttemptClaim) => Promise<DeliveryPhase>;
}

/** A message counts as typed once it reached 'delivered' (the paste succeeded). */
export function wasEverTyped(envelope: MessageEnvelope): boolean {
  return envelope.delivery.transitions.some((t) => t.to === 'delivered');
}

/* @self-action-controller: message-holder-redelivery */
export class DeliveryRetryManager {
  private readonly store: MessageStore;
  private readonly delivery: MessageDelivery;
  private readonly config: DeliveryRetryManagerConfig;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Track watchdog targets: messageId → injection timestamp */
  private readonly watchdogTargets = new Map<string, number>();

  /** Track retry state: messageId → { attempts, firstAttemptAt } */
  private readonly retryState = new Map<string, { attempts: number; firstAttemptAt: number; lastAttemptAt: number }>();

  /**
   * §A34 R3 surface-alignment: in-flight latch for `tick()` /
   * `runRecoveryCycle()` to guarantee idempotence against the running timer.
   * When the timer-driven `tick()` is mid-cycle and the Remediator-driven
   * `runRecoveryCycle()` (or another `tick()`) arrives, the second caller
   * returns early instead of double-processing the inbox.
   *
   * This is a single-process latch (not a cross-process lock) — the
   * Remediator's MachineLock handles cross-process exclusion at the dispatch
   * layer. Inside one process, two timer callbacks (or timer + Remediator
   * call) racing the same inbox is prevented here.
   */
  private cycleInFlight = false;

  constructor(store: MessageStore, delivery: MessageDelivery, config: DeliveryRetryManagerConfig) {
    this.store = store;
    this.delivery = delivery;
    this.config = config;
  }

  /** Start the periodic tick */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  /** Stop the periodic tick */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.watchdogTargets.clear();
    this.retryState.clear();
    // Reset the in-flight latch on stop. If a cycle is genuinely mid-flight
    // when stop() is called, the latch clears on the cycle's own finally
    // block anyway — this is belt-and-suspenders for the case where the
    // manager is recycled mid-test.
    this.cycleInFlight = false;
  }

  private recordGenerationEvidence(kind: 'fired' | 'held' | 'error', reason: string, messageId: string): void {
    try { this.config.generationEvidence?.(kind, reason, messageId); }
    catch { /* @silent-fallback-ok: telemetry does not change durable delivery */ }
  }

  /** Register a message for post-injection watchdog monitoring */
  registerWatchdog(messageId: string): void {
    this.watchdogTargets.set(messageId, Date.now());
  }

  /** Main tick — runs every 15 seconds */
  async tick(): Promise<{ retried: number; expired: number; escalated: number; skipped?: boolean }> {
    // §A34 R3: idempotence against the running timer. If another `tick()` or
    // `runRecoveryCycle()` is mid-cycle, return early with a structured skip
    // marker — the in-flight cycle will sweep the queue, no work is lost.
    if (this.cycleInFlight) {
      return { retried: 0, expired: 0, escalated: 0, skipped: true };
    }
    this.cycleInFlight = true;
    try {
      return await this.doCycle();
    } finally {
      this.cycleInFlight = false;
    }
  }

  /**
   * §A34 R3 — Remediator-orchestrated recovery cycle.
   *
   * Distinct entry-point from the timer-driven `tick()` but shares the same
   * internal lock (`cycleInFlight`). If `tick()` is mid-flight when the
   * Remediator dispatches, this returns early with `skipped: true` rather
   * than racing the same inbox.
   *
   * Behaviorally equivalent to `tick()` once it enters `doCycle()`; the
   * distinction exists so the audit trail can distinguish timer-driven from
   * Remediator-driven recoveries.
   *
   * Idempotence proof: both entry-points share `cycleInFlight`; whichever
   * arrives second short-circuits. The first caller's `doCycle()` sweeps
   * every queued / undelivered / expired message in the inbox, so the
   * second caller would have done identical work on the same items.
   */
  async runRecoveryCycle(): Promise<{ retried: number; expired: number; escalated: number; skipped?: boolean }> {
    if (this.cycleInFlight) {
      return { retried: 0, expired: 0, escalated: 0, skipped: true };
    }
    this.cycleInFlight = true;
    try {
      return await this.doCycle();
    } finally {
      this.cycleInFlight = false;
    }
  }

  /**
   * §A34 R3 — Remediator surface entry point.
   *
   * Mirrors the `invokeFromRemediator(ctx)` convention from W-1's
   * `NativeModuleHealer`. Wraps `runRecoveryCycle()` and translates the
   * structured result into a `ExecutionResult` so the runbook's
   * `surfaceCallable` can forward it. The Tier-1 skeleton in
   * `src/remediation/Remediator.ts` runs `verify(ctx)` after a `success`
   * outcome — the runbook's verify probe asserts inbox-drain durability
   * (§A9), independent of this surface call's return value.
   *
   * The `ctx.abortSignal` is informational — Layer 2 / TTL / watchdog
   * operations are short, atomic, and durable. We don't pre-empt mid-cycle.
   * If the deadline trips, the Remediator's `aborted-deadline` branch
   * supersedes anything we return.
   */
  async invokeFromRemediator(_ctx: RemediationContext): Promise<ExecutionResult> {
    try {
      const result = await this.runRecoveryCycle();
      return {
        outcome: 'success',
        details: {
          retried: result.retried,
          expired: result.expired,
          escalated: result.escalated,
          skipped: result.skipped ?? false,
        },
      };
    } catch (err) {
      return {
        outcome: 'failure',
        details: {
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  private notifyDeadLetter(envelope: MessageEnvelope, reason: string): void {
    try { this.config.onDeadLetter?.(envelope, reason); } catch { /* @silent-fallback-ok: notice is best-effort; the dead letter is recorded */ }
  }

  /**
   * Inner cycle body extracted so `tick()` and `runRecoveryCycle()` share
   * one implementation under one in-flight latch.
   */
  private async doCycle(): Promise<{ retried: number; expired: number; escalated: number }> {
    let retried = 0;
    let expired = 0;
    let escalated = 0;

    const inbox = await this.store.queryInbox(this.config.agentName);

    for (const snapshot of inbox) {
      // Sent has its initial synchronous router executor; a timer must not steal it.
      if (snapshot.delivery.phase === 'sent' && !this.isExpired(snapshot)) continue;
      const claim = beginDeliveryAttempt(snapshot.message.id);
      if (!claim) continue;
      try {
      const envelope = await this.store.get(snapshot.message.id);
      if (!envelope) continue;
      const phase = envelope.delivery.phase;
      const messageId = envelope.message.id;
      const local = this.config.isLocalEnvelope ? this.config.isLocalEnvelope(envelope) : true;


      // A process ended between pin/typing and outcome persistence. The retry
      // timer can start before boot recovery finishes: neither may retype it.
      if (local && envelope.delivery.deliveryPending && envelope.delivery.typingStartedAt
        && !['delivered', 'read', 'failed', 'expired', 'dead-lettered'].includes(phase)) {
          const reason = 'outcome unknown: delivery began but its final state was not recorded; the message may have arrived';
        envelope.delivery.phase = 'failed';
        envelope.delivery.failureReason = reason;
        envelope.delivery.deliveryPending = false;
        envelope.delivery.transitions.push({ from: phase, to: 'failed', at: new Date().toISOString(), reason });
        await this.store.updateDelivery(messageId, envelope.delivery);
        this.retryState.delete(messageId);
        if (envelope.message.to.sessionId) this.recordGenerationEvidence('error', 'delivery-outcome-unknown', messageId);
        this.notifyDeadLetter(envelope, reason);
        continue;
      }

      // ── TTL Expiry Check ──────────────────────────────────
      if (this.isExpired(envelope)) {
        // §D.5: the relay queue ends its own envelopes after one pass.
        if (phase === 'relaying' || (this.config.holdForRemoteNotice?.(envelope) ?? false)) continue;
        if (phase !== 'read' && phase !== 'dead-lettered' && phase !== 'failed' && phase !== 'expired') {
          await this.store.deadLetter(messageId, 'TTL expired');
          expired++;
          if (local && !wasEverTyped(envelope)) this.notifyDeadLetter(envelope, 'TTL expired');

          // Escalate critical/alert to callback
          const priority = envelope.message.priority;
          const type = envelope.message.type;
          if ((priority === 'critical' || type === 'alert') && this.config.onEscalate) {
            this.config.onEscalate(envelope, `Message expired without delivery (type=${type}, priority=${priority})`);
            escalated++;
          }
        }
        continue;
      }

      // The timer that wins initial ownership must execute accepted unarmed work.
      if (local && phase === 'received' && envelope.delivery.deliveryPending
        && !envelope.delivery.typingStartedAt && !envelope.delivery.holderPending && this.config.redeliverUnresolved) {
        await this.config.redeliverUnresolved(envelope, claim);
        continue;
      }

      // ── Layer 2 Retry: queued or undelivered messages ─────
      // 'undelivered' is entered by SpawnRequestManager.dispose() handoff.
      // It participates in Layer-2 retry identically to 'queued'.
      if (!local) continue;

      if (phase === 'queued' || phase === 'undelivered' || (phase === 'received' && envelope.delivery.holderPending)) {
        const state = {
          firstAttemptAt: Date.now(),
          ...(envelope.delivery.holderRetryState ?? this.retryState.get(messageId) ?? { attempts: 0, lastAttemptAt: 0 }),
        };

        const decision = layer2RetryDecision(envelope.delivery.holderRetryState ? state : { attempts: state.attempts, lastAttemptAt: state.lastAttemptAt }, Date.now());
        if (decision === 'give-up') {
          // Max retries exceeded — expire. The sender hears the last refusal in plain words.
          const detail = envelope.delivery.refusalDetail ?? envelope.delivery.failureReason;
          await this.store.deadLetter(messageId, `Layer 2 retry budget ended after ${state.attempts} tries`);
          expired++;
          this.retryState.delete(messageId);
          if (!wasEverTyped(envelope)) this.notifyDeadLetter(envelope, `not delivered after ${state.attempts} tries${detail ? `: ${detail}` : ''}`);
          continue;
        }
        if (decision === 'wait') {
          continue; // Not yet time to retry
        }

        // relay-asof-holder-skew §2: a role with no accepted holder yet is re-resolved,
        // never typed by name (the name may now belong to a session that started after
        // the message). The router records the outcome on the envelope itself.
        if (envelope.delivery.holderPending || envelope.delivery.holderRetryState) {
          // Reserve before acting: a restart cannot reset this lane's budget or cadence.
          state.attempts++;
          state.lastAttemptAt = Date.now();
          envelope.delivery.holderRetryState = state;
          await this.store.updateDelivery(messageId, envelope.delivery);
          this.retryState.set(messageId, state);
        }
        if (envelope.delivery.holderPending && !envelope.delivery.resolvedSessionId) {
          if (!this.config.redeliverUnresolved) {
            const reason = 'holder retry resolver is unavailable; no message was typed';
            await this.store.deadLetter(messageId, reason);
            this.retryState.delete(messageId);
            this.notifyDeadLetter(envelope, reason);
            expired++;
            continue;
          }
          const reached = await this.config.redeliverUnresolved(envelope, claim);
          if (reached === 'delivered') {
            this.registerWatchdog(messageId);
            retried++;
          } else if (reached === 'failed') {
            this.retryState.delete(messageId);
          }
          continue;
        }

        // Attempt redelivery: held to the pinned session (§B), never re-resolved.
        const targetSession = envelope.delivery.resolvedSession ?? envelope.message.to.session;
        const pinId = envelope.delivery.resolvedSessionId;
        if (pinId && this.config.isPinnedSessionLive && !this.config.isPinnedSessionLive(targetSession, pinId)) {
          const currentId = this.config.currentSessionGeneration?.(targetSession);
          const replacement = !!currentId && currentId !== pinId;
          const reason = envelope.message.to.sessionId ? (replacement ? 'target-session-generation-changed' : 'target-session-generation-unavailable') : 'resolved-session-ended';
          const now = new Date().toISOString();
          envelope.delivery.transitions.push({ from: phase, to: 'failed', at: now, reason });
          envelope.delivery.phase = 'failed';
          envelope.delivery.failureReason = reason;
          await this.store.updateEnvelope(envelope);
          this.retryState.delete(messageId);
          if (envelope.message.to.sessionId) this.recordGenerationEvidence('held', replacement ? 'generation-changed' : 'generation-unavailable', messageId);
          this.notifyDeadLetter(envelope, reason);
          continue;
        }
          // Reserve the uncertain injection interval before any delivery await.
          // Older binaries never retry a received envelope by name during this
          // uncertain interval; their boot recovery recognizes its typing marker.
          envelope.delivery.phase = 'received';
          envelope.delivery.typingStartedAt = new Date().toISOString();
          envelope.delivery.deliveryPending = true;
          await this.store.updateDelivery(messageId, envelope.delivery);
          const result = await this.delivery.deliverToSession(targetSession, envelope);
          envelope.delivery.deliveryPending = false;
          if (!result.success) {
            if (!result.outcomeUnknown) delete envelope.delivery.typingStartedAt;
            envelope.delivery.phase = phase;
          }
          if (!result.success && !result.shouldRetry) {
            const reason = result.failureReason ?? 'resolved-session-ended';
            envelope.delivery.transitions.push({ from: phase, to: 'failed', at: new Date().toISOString(), reason });
            envelope.delivery.phase = 'failed';
            envelope.delivery.failureReason = reason;
            delete envelope.delivery.refusalDetail;
            await this.store.updateEnvelope(envelope);
            this.retryState.delete(messageId);
            if (envelope.message.to.sessionId) {
              if (result.outcomeUnknown) this.recordGenerationEvidence('error', 'delivery-outcome-unknown', messageId);
              else if (reason === 'target-session-generation-changed') this.recordGenerationEvidence('held', 'generation-changed', messageId);
            }
            this.notifyDeadLetter(envelope, reason);
            continue;
          }
          if (!result.success) await this.store.updateDelivery(messageId, envelope.delivery);

          if (!envelope.delivery.holderRetryState) {
            state.attempts++;
            state.lastAttemptAt = Date.now();
            this.retryState.set(messageId, state);
          }

          if (result.success) {
            const fromPhase = phase;
            envelope.delivery.phase = 'delivered';
            envelope.delivery.transitions.push({
              from: fromPhase,
              to: 'delivered',
              at: new Date().toISOString(),
              reason: `Retry attempt ${state.attempts}`,
            });
            envelope.delivery.attempts = state.attempts;
            await this.store.updateEnvelope(envelope);
            if (envelope.message.to.sessionId) this.recordGenerationEvidence('fired', 'generation-delivered', messageId);
            // Keep retryState so interval is respected if watchdog regresses to queued
            this.registerWatchdog(messageId);
            retried++;
          }
      }

      // ── Layer 3 Timeout: unacknowledged delivered messages ─
      if (phase === 'delivered') {
        const timeout = ACK_TIMEOUT[envelope.message.type];
        if (timeout !== null) {
          const deliveredAt = envelope.delivery.transitions
            .filter(t => t.to === 'delivered')
            .pop()?.at;
          if (deliveredAt) {
            const elapsed = Date.now() - new Date(deliveredAt).getTime();
            if (elapsed > timeout * 60_000) {
              // ACK timeout — escalate
              if (this.config.onEscalate) {
                this.config.onEscalate(
                  envelope,
                  `Layer 3 ACK timeout: ${envelope.message.type} message not acknowledged after ${timeout} minutes`,
                );
                escalated++;
              }
              // Mark as expired
              envelope.delivery.phase = 'expired';
              envelope.delivery.transitions.push({
                from: 'delivered',
                to: 'expired',
                at: new Date().toISOString(),
                reason: `ACK timeout (${timeout}min) for type=${envelope.message.type}`,
              });
              await this.store.updateEnvelope(envelope);
              expired++;
            }
          }
        }
      }
      } finally { claim.release(); }
    }

    // ── Watchdog: check injected messages ──────────────────
    for (const [messageId, injectedAt] of this.watchdogTargets) {
      const elapsed = Date.now() - injectedAt;
      if (elapsed < 10_000) continue; // Wait 10 seconds

      // Watchdog window has passed — check if session is still alive
      const envelope = await this.store.get(messageId);
      if (!envelope || envelope.delivery.phase !== 'delivered') {
        this.watchdogTargets.delete(messageId);
        continue;
      }

      // Confirmed pinned injection cannot be undone by later liveness evidence.
      if (envelope.delivery.resolvedSessionId || envelope.message.to.sessionId) {
        this.watchdogTargets.delete(messageId); this.retryState.delete(messageId); continue;
      }
      const targetSession = envelope.delivery.resolvedSession ?? envelope.message.to.session;
      const safety = await this.delivery.checkInjectionSafety(targetSession);

      // If session process changed to something unsafe (crash/restart),
      // regress to queued for retry
      if (!safety.isSafeProcess) {
        envelope.delivery.phase = 'queued';
        envelope.delivery.transitions.push({
          from: 'delivered',
          to: 'queued',
          at: new Date().toISOString(),
          reason: `Watchdog: session process changed to ${safety.foregroundProcess}`,
        });
        await this.store.updateEnvelope(envelope);
      } else {
        // Session healthy — delivery confirmed, clean up retry state
        this.retryState.delete(messageId);
      }

      this.watchdogTargets.delete(messageId);
    }

    return { retried, expired, escalated };
  }

  /** Check if a message's delivery TTL has expired */
  private isExpired(envelope: MessageEnvelope): boolean {
    const createdAt = new Date(envelope.message.createdAt).getTime();
    const ttlMs = envelope.message.ttlMinutes * 60_000;
    return Date.now() > (envelope.delivery.expiresAt ?? createdAt + ttlMs);
  }
}

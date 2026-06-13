/**
 * NegotiatorGate — the lease/voice send gate (D-B) for the Threadline
 * single-negotiator lock (THREADLINE-SINGLE-NEGOTIATOR-SPEC.md, CMT-1362).
 *
 * This is the chokepoint orchestration that the server's `/threadline/relay-send`
 * route calls right after it mints the effective threadId, BEFORE the content is
 * delivered. It does exactly one decision: enforce the lease so only the owning
 * session is the agent's voice (G1). It has NO authority over content MEANING —
 * binding lives only in the existing operator-anchored primitives (G2, D-C).
 *
 * Behavior by config (FD-7):
 *  - enabled:false (default, ships dark) → pure pass-through. No store write, no
 *    log, zero overhead. The fleet sees no behavior change.
 *  - enabled:true + dryRun:true → observe-only. Acquire/record the lease and log
 *    the verdict it WOULD reach, but ALWAYS allow the send.
 *  - enabled:true + dryRun:false → enforce. A non-owner's CONTENT send is
 *    withheld; the gate emits at most one holding-notice to the peer (rate-
 *    limited, FD-3) and the owning session is the only voice.
 *
 * Fail-open (FD / D-B): a lease-store ERROR fails OPEN for the send (it proceeds)
 * — G1 is explicitly NOT enforced during that window — AND raises a HIGH-priority
 * alert (never silent). Safe because prose is inert (G2): the worst case is two
 * of the agent's own sessions briefly both speaking inert prose, never a binding.
 */

import path from 'node:path';
import { ConversationStore } from './ConversationStore.js';
import {
  resolveSingleNegotiatorConfig,
  buildHoldingNotice,
  shouldEmitHoldingNotice,
  appendNegotiatorLog,
  type SingleNegotiatorConfig,
  type HoldingNotice,
  type LeaseResult,
} from './NegotiatorLease.js';

/** What the route should do with the send. */
export type SendGateVerdict =
  /** Caller owns the voice (acquired/renewed) — deliver the content. */
  | { decision: 'allow'; reason: 'own' }
  /** Feature dark — pure pass-through, deliver the content. */
  | { decision: 'allow'; reason: 'disabled' }
  /** Lease-store error — fail open, deliver the content; an alert was raised. */
  | { decision: 'allow'; reason: 'fail-open' }
  /** Dry-run observed a foreign lease — deliver anyway, but it was logged. */
  | { decision: 'allow'; reason: 'would-hold' }
  /** Enforcing + foreign live lease — WITHHOLD the content. */
  | {
      decision: 'hold';
      /** A holding notice to best-effort deliver to the peer (null if rate-limited). */
      notice: HoldingNotice | null;
      ownerSessionName: string;
      epoch: number;
    };

export interface SendGateDeps {
  conversationStore?: ConversationStore | null;
  /** Raw `threadline.singleNegotiator` config block (resolved defensively). */
  rawConfig: unknown;
  /** This machine's id. */
  machineId: string;
  /** This agent's display name (interpolated into the fixed holding-notice template). */
  agentName: string;
  /** The sending session's server-authoritative name (from INSTAR_SESSION_NAME). */
  ownerSessionName: string | undefined;
  /** Directory for the dry-run/fail-open observability JSONL (logs/). */
  logDir: string;
  /** Whether a session is currently live (fences a dead foreign owner). */
  isSessionLive?: (sessionName: string) => boolean;
  /** Raise a HIGH-priority alert on fail-open (never silent). Best-effort. */
  raiseFailOpenAlert?: (detail: { threadId: string; sessionName: string; reason: string }) => void;
  /** Clock injection for tests. */
  now?: () => number;
}

/**
 * Evaluate the send gate for one outbound send. Returns the verdict the route
 * acts on. Performs the lease CAS + holding-notice stamp + observability log
 * internally; never throws into the send path (a store error fails open).
 */
export async function evaluateSendGate(threadId: string, deps: SendGateDeps): Promise<SendGateVerdict> {
  const cfg: SingleNegotiatorConfig = resolveSingleNegotiatorConfig(deps.rawConfig);

  // Dark ship: pure pass-through, zero overhead.
  if (!cfg.enabled) return { decision: 'allow', reason: 'disabled' };

  const store = deps.conversationStore;
  if (!store) {
    // No store wired — cannot enforce; fail open (this is a wiring gap, alert).
    deps.raiseFailOpenAlert?.({ threadId, sessionName: deps.ownerSessionName ?? '(unknown)', reason: 'no-conversation-store' });
    appendNegotiatorLog(deps.logDir, {
      ts: new Date(deps.now?.() ?? Date.now()).toISOString(),
      threadId,
      action: 'fail-open',
      sessionName: deps.ownerSessionName ?? '(unknown)',
      dryRun: cfg.dryRun,
      detail: 'no-conversation-store',
    });
    return { decision: 'allow', reason: 'fail-open' };
  }

  // A send with no resolvable owning session cannot be lease-checked (no identity
  // to own the voice). Treat as fail-open + alert rather than withhold a real send.
  const ownerSessionName = (deps.ownerSessionName ?? '').trim();
  if (!ownerSessionName) {
    deps.raiseFailOpenAlert?.({ threadId, sessionName: '(none)', reason: 'no-owner-session-identity' });
    appendNegotiatorLog(deps.logDir, {
      ts: new Date(deps.now?.() ?? Date.now()).toISOString(),
      threadId,
      action: 'fail-open',
      sessionName: '(none)',
      dryRun: cfg.dryRun,
      detail: 'no-owner-session-identity',
    });
    return { decision: 'allow', reason: 'fail-open' };
  }

  const nowMs = deps.now?.() ?? Date.now();
  let lease: LeaseResult;
  try {
    lease = await store.acquireOrRenewLease(
      threadId,
      { ownerSessionName, ownerMachineId: deps.machineId },
      { ttlMs: cfg.leaseTtlMs, now: nowMs, isOwnerLive: deps.isSessionLive },
    );
  } catch (err) {
    // Store/CAS error — FAIL OPEN for the send, raise a HIGH-priority alert.
    const reason = err instanceof Error ? err.message : String(err);
    deps.raiseFailOpenAlert?.({ threadId, sessionName: ownerSessionName, reason });
    appendNegotiatorLog(deps.logDir, {
      ts: new Date(nowMs).toISOString(),
      threadId,
      action: /CAS retry budget/.test(reason) ? 'cas-exhausted' : 'fail-open',
      sessionName: ownerSessionName,
      dryRun: cfg.dryRun,
      detail: reason,
    });
    return { decision: 'allow', reason: 'fail-open' };
  }

  if (lease.ownedByCaller) {
    appendNegotiatorLog(deps.logDir, {
      ts: new Date(nowMs).toISOString(),
      threadId,
      action: 'allow-own',
      sessionName: ownerSessionName,
      epoch: lease.lease.epoch,
      dryRun: cfg.dryRun,
    });
    return { decision: 'allow', reason: 'own' };
  }

  // Foreign live lease — the caller is NOT the voice.
  if (cfg.dryRun) {
    // Observe-only: log what we WOULD do, still send.
    appendNegotiatorLog(deps.logDir, {
      ts: new Date(nowMs).toISOString(),
      threadId,
      action: 'would-hold',
      sessionName: ownerSessionName,
      ownerSessionName: lease.lease.ownerSessionName,
      epoch: lease.lease.epoch,
      dryRun: true,
    });
    return { decision: 'allow', reason: 'would-hold' };
  }

  // Enforce: WITHHOLD the content. Decide whether to emit a (rate-limited) notice.
  const conv = store.get(threadId);
  const emit = shouldEmitHoldingNotice({
    epoch: lease.lease.epoch,
    lastHoldingNoticeEpoch: conv?.lastHoldingNoticeEpoch,
    lastHoldingNoticeAt: conv?.lastHoldingNoticeAt,
    minIntervalMs: cfg.holdingNoticeMinIntervalMs,
    now: nowMs,
  });
  let notice: HoldingNotice | null = null;
  if (emit) {
    notice = buildHoldingNotice(deps.agentName, lease.lease);
    // Stamp the durable rate-limit fields BEFORE the route delivers the notice.
    try {
      await store.recordHoldingNotice(threadId, lease.lease.epoch, nowMs);
    } catch {
      // @silent-fallback-ok: a stamp failure at worst allows one extra notice next
      // send; never withhold/deliver differently because the bookkeeping write failed.
    }
  }
  appendNegotiatorLog(deps.logDir, {
    ts: new Date(nowMs).toISOString(),
    threadId,
    action: 'hold',
    sessionName: ownerSessionName,
    ownerSessionName: lease.lease.ownerSessionName,
    epoch: lease.lease.epoch,
    dryRun: false,
    detail: emit ? 'notice-emitted' : 'notice-rate-limited',
  });
  return { decision: 'hold', notice, ownerSessionName: lease.lease.ownerSessionName, epoch: lease.lease.epoch };
}

/** Resolve the standard logs/ directory for negotiator observability. */
export function negotiatorLogDir(stateDir: string): string {
  // stateDir is the agent's .instar dir; logs live as a sibling under it.
  return path.join(stateDir, '..', 'logs');
}

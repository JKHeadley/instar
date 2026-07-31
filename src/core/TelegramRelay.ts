/**
 * TelegramRelay — the tokenless-standby outbound relay (bug #7), extracted as a
 * pure, testable unit.
 *
 * A multi-machine pool standby serving a moved session holds NO Telegram bot
 * token (single-owner invariant — avoids the 409 poller conflict). When such a
 * standby needs to reply, `TelegramAdapter.sendToTopic` invokes this relay,
 * which POSTs the reply to the Telegram-OWNING lease holder's
 * `/telegram/reply/:topicId` so the message reaches the user without the standby
 * ever sending on the shared bot.
 *
 * THE BUGS THIS FIXES (found driving the live multi-machine proof, 2026-06-01):
 *  1. NO TIMEOUT — the original `fetch` had no AbortSignal, so when the holder's
 *     tunnel was momentarily unreachable (e.g. mid-restart) the relay HUNG until
 *     the calling client gave up (observed >70s with no result). A moved
 *     session's reply must fail FAST and surface, not hang.
 *  2. SILENT FAILURE — every failure path returned null with no log line, so a
 *     dropped reply was invisible (no peer URL, non-2xx, network error, timeout
 *     all looked identical: nothing). Driving it live was the only way to see it.
 *
 * This module makes the relay bounded + observable. The transport (fetch) and
 * clock are injected so the timeout/branch behavior is deterministically
 * unit-testable without real network or wall-clock.
 */

import type { MessageProvenance } from '../messaging/shared/MessageProvenance.js';

export interface RelayResult {
  messageId: number;
  topicId: number;
}

/**
 * A holder REFUSAL carried back verbatim (a 422: tone-gate nudge, credential
 * wall, reason-required). Distinct from `null`, which means the relay could not
 * reach a verdict at all. The distinction is load-bearing: a refusal is
 * actionable by the agent, a transport failure is not, and reporting the first
 * as the second is what made a relayed advisory unanswerable.
 */
export interface RelayRefusal {
  refused: true;
  status: 422;
  body: Record<string, unknown>;
}

export function isRelayRefusal(r: RelayResult | RelayRefusal | null): r is RelayRefusal {
  return !!r && (r as RelayRefusal).refused === true;
}

/**
 * Thrown at the adapter boundary so a holder refusal travels up the existing
 * throw-based send path (which expects `messageId | null`) WITHOUT the standby
 *'s route having to special-case a third return shape. The route catches it and
 * re-emits the holder's status + body verbatim.
 */
export class RelayRefusedError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(refusal: RelayRefusal) {
    super(`telegram relay refused by holder (${refusal.status})`);
    this.name = 'RelayRefusedError';
    this.status = refusal.status;
    this.body = refusal.body;
  }
}

export interface RelayDeps {
  /** Resolve the lease holder's machine id, or null if we hold it / none known. */
  leaseHolder: () => string | null;
  /** This machine's own mesh id (so we never relay to ourselves). */
  selfMachineId: string;
  /** Resolve a peer machine id to its reachable base URL, or null. */
  peerUrl: (machineId: string) => string | null;
  /** Bearer token for the holder's authenticated /telegram/reply. */
  authToken: string | undefined;
  /** Max ms to wait for the holder before failing fast. */
  timeoutMs: number;
  /** Injected fetch (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** Injected logger for the (previously silent) failure paths. */
  log?: (line: string) => void;
}

/**
 * Relay one outbound reply through the lease holder. Returns the sent message's
 * RelayResult, a RelayRefusal when the holder REFUSED it with a reason (422), or
 * null when it could not be delivered at all (logged, never silent).
 */
export async function relayOutbound(
  topicId: number,
  text: string,
  opts: { silent?: boolean; kindMetadata?: Record<string, unknown>; provenance?: Exclude<MessageProvenance, 'user'> } | undefined,
  deps: RelayDeps,
): Promise<RelayResult | RelayRefusal | null> {
  const log = deps.log ?? (() => {});
  const holder = deps.leaseHolder();
  if (!holder || holder === deps.selfMachineId) return null; // we ARE the owner, or none known

  const url = deps.peerUrl(holder);
  if (!url) {
    log(`[telegram-relay] no peer URL for lease holder ${holder} — cannot relay topic ${topicId}`);
    return null;
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), deps.timeoutMs);
  try {
    const resp = await fetchImpl(`${url}/telegram/reply/${topicId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${deps.authToken}` },
      // Forward the kind metadata so an automated send keeps its kind across
      // the hop and the HOLDER's gate/audit see accurate context (spec
      // outbound-jargon-filepath-gap §2.5). The preflight already ran on the
      // ORIGINATING machine — it never re-runs here.
      body: JSON.stringify({
        text,
        ...(opts?.silent ? { silent: true } : {}),
        ...(opts?.kindMetadata || opts?.provenance
          ? { metadata: { ...opts?.kindMetadata, ...(opts?.provenance ? { provenance: opts.provenance } : {}) } }
          : {}),
      }),
      signal: ac.signal,
    });
    if (!resp.ok) {
      // ── Refusal vs failure ────────────────────────────────────────────────
      // A 422 from the holder is a REFUSAL WITH A REASON (a tone-gate nudge, a
      // credential wall), not a transport failure. Collapsing it to `null` made
      // the standby report "router unreachable" — so the agent saw a network
      // error instead of the rule, the decisionRef, and how to proceed, and
      // could never act on it. Surface the holder's own body so a relayed topic
      // gets the same actionable refusal a direct send does.
      if (resp.status === 422) {
        const body = (await resp.json().catch(() => {
          /* @silent-fallback-ok — an unparseable refusal body degrades to `{}`, and
             that is the honest outcome: the REFUSAL itself (status 422) is still
             surfaced, which is the load-bearing fact. Throwing here would collapse
             a real refusal back into the transport-failure path this branch exists
             to escape, turning an actionable nudge into "router unreachable" again. */
          return {};
        })) as Record<string, unknown>;
        log(`[telegram-relay] holder ${url} REFUSED topic ${topicId}: ${String(body.error ?? body.blockedBy ?? '422')}`);
        return { refused: true, status: 422, body };
      }
      log(`[telegram-relay] holder ${url} returned ${resp.status} for topic ${topicId} (${Date.now() - started}ms) — reply not delivered`);
      return null;
    }
    const j = (await resp.json().catch(() => ({}))) as { messageId?: number };
    // Truthful success: the holder must report a REAL positive Telegram
    // messageId. A 2xx with a missing/0 messageId means the holder accepted the
    // request but did NOT confirm a Telegram delivery — treat that as FAILURE,
    // not success, so the relay never reports "delivered" for a message that
    // didn't land (the false-success-under-load class). The caller's
    // sendToTopic then throws and the durable retry path can re-attempt.
    if (typeof j.messageId !== 'number' || j.messageId <= 0) {
      log(`[telegram-relay] holder ${url} returned ok but NO confirmed messageId for topic ${topicId} (${Date.now() - started}ms) — treating as undelivered`);
      return null;
    }
    return { messageId: j.messageId, topicId };
  } catch (err) {
    const reason = ac.signal.aborted
      ? `timeout after ${deps.timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    log(`[telegram-relay] relay to ${url} FAILED for topic ${topicId} (${Date.now() - started}ms): ${reason} — reply not delivered`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

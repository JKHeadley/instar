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

export interface RelayResult {
  messageId: number;
  topicId: number;
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
 * RelayResult, or null when it could not be delivered (logged, never silent).
 */
export async function relayOutbound(
  topicId: number,
  text: string,
  opts: { silent?: boolean } | undefined,
  deps: RelayDeps,
): Promise<RelayResult | null> {
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
      body: JSON.stringify({ text, ...(opts?.silent ? { silent: true } : {}) }),
      signal: ac.signal,
    });
    if (!resp.ok) {
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

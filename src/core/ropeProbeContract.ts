/**
 * ropeProbeContract — the U4.3 recovery probe's payload + typed-response contract
 * (docs/specs/u4-3-breaker-recovery-probe.md §2 "Probe success is the exact typed
 * contract, never any-2xx").
 *
 * The probe reuses the G4 delivery-canary PAYLOAD contract: a signed, bogus-uid
 * `deliverMessage` MeshRpc command the peer answers with a TYPED refusal per its
 * role — `not-router` (403, RBAC: we are not the lease holder in the peer's view)
 * or `sender-rejected` (200 ack, the peer's sender re-validation refused the
 * bogus uid). Either typed refusal PROVES the whole path: transport connect +
 * signed envelope verified + the peer's real dispatcher answered. A malformed,
 * untyped, or unsigned 2xx (captive portal, wrong server) is a FAILURE.
 *
 * `parseProbeResponse` is the REGISTERED parser (Scrape/Parser Fixture Realness):
 * it consumes the RAW response body bytes + HTTP status, and its tests feed it
 * captured byte-for-byte fixtures of real /mesh/rpc responses (see
 * tests/fixtures/captured/mesh-rpc-probe-responses/ + SCRAPE_PARSERS in
 * scripts/lint-scrape-fixture-realness.js).
 */

import type { MeshCommand } from './MeshRpc.js';

/**
 * A deliberately-unresolvable sender uid (no Telegram uid is ever this value and
 * the users registry can never contain it) — the "bogus uid" of the G4 canary
 * payload contract. The peer's sender re-validation refuses it with the typed
 * `sender-rejected` ack; it can never inject a real message.
 */
export const ROPE_PROBE_BOGUS_UID = 999_999_999_999;

/** The session-key prefix — non-numeric BY DESIGN so no topic-shaped consumer
 *  (working-set trigger, spawn bridge — both `Number(session)`-gated) can ever
 *  act on a probe, and the SenderRejectionNoticer's user-topic exclusion holds. */
export const ROPE_PROBE_SESSION_PREFIX = 'rope-probe:';

/**
 * Build the probe command. `ownershipEpoch: 0` + an unknown session means the
 * stale-ownership fence passes through to sender re-validation (ownerEpochOf on
 * an unknown session is null), so the answer is deterministic per role.
 */
export function buildRopeProbeCommand(selfMachineId: string, nonce: string): MeshCommand {
  return {
    type: 'deliverMessage',
    session: `${ROPE_PROBE_SESSION_PREFIX}${selfMachineId}`,
    messageId: `rope-probe:${selfMachineId}:${nonce}`,
    payload: { probe: 'rope-recovery', note: 'signed bogus-uid canary — expect a typed refusal' },
    ownershipEpoch: 0,
    // The §3.4 sender re-validation envelope — the bogus uid the peer refuses.
    senderEnvelope: { userId: ROPE_PROBE_BOGUS_UID },
  } as MeshCommand;
}

export type RopeProbeClassification =
  | 'ack-sender-rejected'   // 200 { ok:true, result:{ accepted:'sender-rejected' } } — typed success
  | 'refused-not-router'    // 403 { ok:false, reason:'not-router' }                  — typed success
  | 'untyped-2xx'           // a 2xx that is NOT the typed ack (captive portal, wrong server)
  | 'auth-rejected'         // 401 signature-invalid / unknown-sender / wrong-recipient
  | 'accepted-not-refused'  // typed ack but accepted !== sender-rejected (queued/duplicate/stale-ownership)
  | 'malformed'             // body does not parse as JSON
  | 'http-error';           // any other non-2xx

export interface RopeProbeVerdict {
  /** TRUE only for the two typed refusals — the exact contract; any-2xx never closes. */
  typedSuccess: boolean;
  classification: RopeProbeClassification;
  /** The dispatcher's typed reason / ack value, when one parsed (for logs). */
  detail?: string;
}

/**
 * Classify a raw /mesh/rpc probe response (REGISTERED parser — fed captured
 * byte-for-byte fixtures in tests). Success is the EXACT typed contract:
 *   - 403 with dispatcher reason `not-router` (peer refused our non-router send), OR
 *   - 200 ack `{ result: { accepted: 'sender-rejected' } }` (peer's sender
 *     re-validation refused the bogus uid).
 * EVERYTHING else — an untyped 2xx, a malformed body, an unsigned/unknown-sender
 * rejection, or an unexpected acceptance — records as FAILURE.
 */
export function parseProbeResponse(rawBody: string, status: number): RopeProbeVerdict {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    // @silent-fallback-ok: an unparseable probe response IS the classification
    // (malformed ⇒ failure) — the verdict carries it; nothing is swallowed.
    return { typedSuccess: false, classification: 'malformed' };
  }
  const obj = (body && typeof body === 'object' ? body : {}) as {
    ok?: unknown;
    reason?: unknown;
    result?: { messageId?: unknown; accepted?: unknown } | null;
  };

  if (status === 200) {
    const accepted = obj.result && typeof obj.result === 'object' ? obj.result.accepted : undefined;
    if (obj.ok === true && accepted === 'sender-rejected') {
      return { typedSuccess: true, classification: 'ack-sender-rejected', detail: 'sender-rejected' };
    }
    if (obj.ok === true && typeof accepted === 'string') {
      // A typed ack that ACCEPTED the bogus probe (queued/duplicate/stale-ownership)
      // is NOT the contract — e.g. a peer whose degenerate registry failed toward
      // delivery. Recorded as failure (the strict any-2xx-never-closes rule).
      return { typedSuccess: false, classification: 'accepted-not-refused', detail: accepted };
    }
    return { typedSuccess: false, classification: 'untyped-2xx' };
  }

  if (status >= 200 && status < 300) {
    return { typedSuccess: false, classification: 'untyped-2xx' };
  }

  const reason = typeof obj.reason === 'string' ? obj.reason : undefined;
  if (status === 403 && reason === 'not-router') {
    return { typedSuccess: true, classification: 'refused-not-router', detail: reason };
  }
  if (status === 401) {
    return { typedSuccess: false, classification: 'auth-rejected', detail: reason };
  }
  return { typedSuccess: false, classification: 'http-error', detail: reason ?? `status-${status}` };
}

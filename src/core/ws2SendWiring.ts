/**
 * ws2SendWiring — the SEND-side wiring manifest + the wiring-integrity ratchet
 * (WS2 send-side, docs/specs/WS2-SEND-SIDE-EMISSION-SPEC.md §6/§7).
 *
 * THE INVARIANT THIS ENFORCES: every replicated store registered in the
 * `ReplicatedKindRegistry` (the RECEIVE/advert half) must be CONSCIOUSLY classified
 * as either SEND-WIRED (its manager's emit hooks are attached to the journal-backed
 * emitter) or SEND-PENDING (a known, enumerated follow-up). A new replicated kind
 * added to the registry WITHOUT placing it in one of these sets fails the ratchet —
 * which is the EXACT gap this workstream fixes: a kind shipped receive-only (advert +
 * apply machinery) with the SEND half silently a no-op. The ratchet makes that a CI
 * failure, not a memory item (Structure > Willpower).
 *
 * Pure data + a pure check — no I/O, no deps. The server's wiring + the
 * wiring-integrity test BOTH read these sets, so they cannot drift.
 */

/** Stores whose manager emit hooks ARE attached to the journal-backed emitter (their
 *  records actually cross). The learnings slice ships first; the other seamed stores
 *  follow on the SAME emitter (WS2-SEND-2). */
export const WS2_SEND_WIRED_STORES: ReadonlyArray<string> = Object.freeze([
  'learnings',
  'relationships',
  'knowledge',
  'evolutionActions',
  'topicOperator',
]);

/**
 * Stores registered for RECEIVE but whose SEND wiring is a KNOWN, enumerated
 * follow-up — NOT a silent omission. Each is here for a stated reason:
 *  - userRegistry: fully seamed manager (emitPut + emitDelete); its canonical write
 *    instance lives in the AgentServer, so it needs the emitter plumbed there before it
 *    can be wired (WS2-SEND-2b).
 *  - preferences: NO manager emit seam yet — it rode the deprecated `preferences-sync`
 *    verb; needs a manager emit hook before it can be wired (WS2-SEND-3).
 */
export const WS2_SEND_PENDING_STORES: ReadonlyArray<string> = Object.freeze([
  'userRegistry',
  'preferences',
]);

/** A registered store's send-wiring classification. */
export type Ws2SendStatus = 'wired' | 'pending' | 'unclassified';

/** Classify a registered store's send-wiring status. */
export function ws2SendStatus(store: string): Ws2SendStatus {
  if (WS2_SEND_WIRED_STORES.includes(store)) return 'wired';
  if (WS2_SEND_PENDING_STORES.includes(store)) return 'pending';
  return 'unclassified';
}

/** The ratchet result: any registered store that is neither wired nor pending. */
export interface Ws2SendWiringAudit {
  wired: string[];
  pending: string[];
  /** Registered stores in NEITHER set — the failure condition (a silent receive-only kind). */
  unclassified: string[];
  ok: boolean;
}

/**
 * Audit a set of registered store keys against the wiring manifest. `ok` is false iff
 * any registered store is unclassified (neither wired nor pending) — the exact
 * receive-only gap this workstream closes. Also flags a store in BOTH sets (a manifest
 * authoring error) as unclassified-style failure via a thrown precondition is avoided;
 * instead WIRED takes precedence and the overlap is surfaced by the caller's own
 * disjointness assertion in the test.
 */
export function auditWs2SendWiring(registeredStores: ReadonlyArray<string>): Ws2SendWiringAudit {
  const wired: string[] = [];
  const pending: string[] = [];
  const unclassified: string[] = [];
  for (const store of registeredStores) {
    const status = ws2SendStatus(store);
    if (status === 'wired') wired.push(store);
    else if (status === 'pending') pending.push(store);
    else unclassified.push(store);
  }
  return { wired, pending, unclassified, ok: unclassified.length === 0 };
}

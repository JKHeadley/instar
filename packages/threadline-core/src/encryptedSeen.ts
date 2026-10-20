/**
 * The `encryptedSeen` mark as one unified record (spec threadline-standalone-pairing D6, D11).
 *
 * The first time a pinned peer sends us encrypted ordinary chat, that time is recorded. From
 * then on, plaintext under its fingerprint is refused, so a relay cannot downgrade a peer that
 * has spoken to us encrypted. The mark is bound to the pinned identity key and has three rules:
 *
 *  - **Set once.** Setting it again never moves it; the earliest time stands.
 *  - **Merged as a union keeping the earliest time.** Several holders (an agent's machines) may
 *    each record the mark; the merged mark is the earliest valid time any of them recorded for
 *    the same pinned key. A holder that never saw encrypted chat never removes another's mark.
 *  - **Removed only when the person unpairs.** An unpair cancels every mark for that key that it
 *    comes after; a mark recorded after the unpair (a new pairing that spoke encrypted) stands.
 *
 * Pure functions, no I/O. The ordering of events is the caller's (`compare`): a file store uses
 * time, a replicated store uses its hybrid logical clock.
 */

const KEY = /^[0-9a-f]{64}$/;

/** A valid mark time: an ISO-8601 string that parses. Anything else is no mark. */
export function isMarkTime(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 64 && Number.isFinite(Date.parse(v));
}

/**
 * Union of two marks, keeping the earliest. An invalid or missing side is ignored, so a mark can
 * only be set or moved earlier, never cleared, by a merge.
 */
export function earliestMark(a: unknown, b: unknown): string | undefined {
  const va = isMarkTime(a) ? a : undefined;
  const vb = isMarkTime(b) ? b : undefined;
  if (va === undefined) return vb;
  if (vb === undefined) return va;
  return Date.parse(vb) < Date.parse(va) ? vb : va;
}

/** One holder's statement about a peer's mark, as replicated or logged. */
export type EncryptedSeenEvent<O> =
  /** A holder recorded the mark for `peerIdentityPub` at `at`. */
  | { kind: 'seen'; peerIdentityPub: string; at: string; order: O }
  /** The person unpaired: every earlier mark for `peerIdentityPub` is cancelled. With no key it
   *  applies to every key (a holder that does not say which pin it removed). */
  | { kind: 'unpaired'; peerIdentityPub?: string; order: O };

/**
 * The unified mark for `pinnedKey`: the earliest `seen` time for that key that no later `unpaired`
 * event for that key (or an unkeyed one) cancels. `compare(a, b) > 0` means `a` comes after `b`.
 * Events for other keys never count: a mark belongs to the pin, and a new key is a new agent (D8).
 */
export function unifyEncryptedSeen<O>(
  events: ReadonlyArray<EncryptedSeenEvent<O>>,
  pinnedKey: string,
  compare: (a: O, b: O) => number,
): string | undefined {
  const key = String(pinnedKey || '').toLowerCase();
  if (!KEY.test(key)) return undefined;
  const unpairs = events.filter((e) => e.kind === 'unpaired' && (e.peerIdentityPub === undefined || e.peerIdentityPub.toLowerCase() === key));
  let out: string | undefined;
  for (const e of events) {
    if (e.kind !== 'seen' || String(e.peerIdentityPub || '').toLowerCase() !== key || !isMarkTime(e.at)) continue;
    if (unpairs.some((u) => compare(u.order, e.order) > 0)) continue;
    out = earliestMark(out, e.at);
  }
  return out;
}

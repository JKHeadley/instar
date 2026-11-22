/**
 * Asking again after a no, when a real problem shows up that a service would fix
 * (docs/specs/recommended-services.md, "Re-offering after a no" reason 1 and "Real-problem events").
 *
 * Deterministic: no model decides anything here. Pure, so every machine and every test reaches the same answer
 * from the same ledger. Recording and sending live in the routes. A re-offer writes to the ledger only and never
 * changes the choice, so a no stands until a confirmed yes.
 *
 * The floor, all in code:
 * - The service must be available, and its choice must be `no`, or unset with a delivered offer (`offered`).
 * - The problem must come after that no or offer, and be fresh (EVENT_FRESH_MS), so turning the switch on
 *   never digs up an old problem.
 * - Each kind re-offers a given service at most once per cool-off: 90, then 180, then 360 days, staying there.
 * - At most one re-offer a day across services. A capped problem waits rather than being dropped.
 * - Spent on delivery: only an `offered` row (the platform's message id) uses up the allowance. A reservation
 *   (`pending`) with no delivery is released after REOFFER_PENDING_TTL_MS.
 */
import type { CatalogRow } from './catalog.js';
import { isServiceAvailable } from './catalog.js';
import type { EffectiveChoice, OfferState, ReofferRow } from './RecommendedServicesLedger.js';

const DAY_MS = 24 * 60 * 60_000;

/** A reservation that never got a message id is released after this long. */
export const REOFFER_PENDING_TTL_MS = 7 * DAY_MS;
/** At most one re-offer in this window, across every service. */
export const REOFFER_DAILY_WINDOW_MS = DAY_MS;
/** A problem older than this never triggers a re-offer. */
export const EVENT_FRESH_MS = 30 * DAY_MS;
/** The same kind of problem is recorded at most once in this window, so a burst of voice notes is one event. */
export const EVENT_DEDUPE_MS = DAY_MS;

/** The wait before the same kind may re-offer the same service again, after `delivered` re-offers so far. */
export function cooloffMs(delivered: number): number {
  if (delivered <= 0) return 0;
  if (delivered === 1) return 90 * DAY_MS;
  if (delivered === 2) return 180 * DAY_MS;
  return 360 * DAY_MS;
}

export interface ProblemKind {
  /** The service this kind re-offers. */
  service: string;
  /** Why the agent is asking now, in fixed words. Never includes error text. */
  why: string;
}

/**
 * The real-problem table. Each kind is called only from its named source. Slice A wires `voice-unreadable`;
 * the other kinds in the spec's table (`address-repeatedly-down`, `provider-exhausted`, `secret-lost`,
 * `state-loss-risk`) join with their sources.
 */
export const PROBLEM_KINDS: Readonly<Record<string, ProblemKind>> = {
  'voice-unreadable': {
    service: 'voice-transcription',
    why: "A voice note came in that I couldn't turn into text, because nothing on this machine can transcribe voice yet.",
  },
};

export function isProblemKind(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROBLEM_KINDS, kind);
}

export interface ReofferFacts {
  choice: (service: string) => EffectiveChoice;
  offer: (service: string) => OfferState;
  /** When the newest delivered offer of this service to this owner was, or null. */
  offeredAt: (service: string) => number | null;
}

export type ReofferDecision =
  | { action: 'resume'; pending: ReofferRow }
  | { action: 'send'; event: ReofferRow }
  | { action: 'none'; why: 'nothing-waiting' | 'daily-cap' };

const ms = (iso: string): number => Date.parse(iso);

/** Delivered re-offers, and reservations still in flight, for an owner. */
function liveReservations(rows: readonly ReofferRow[], nowMs: number): { delivered: ReofferRow[]; inFlight: ReofferRow[] } {
  const delivered = rows.filter((r) => r.state === 'offered');
  const deliveredRefs = new Set(delivered.map((r) => r.eventRef));
  const inFlight = rows.filter((r) => r.state === 'pending' && !deliveredRefs.has(r.eventRef) && nowMs - ms(r.at) < REOFFER_PENDING_TTL_MS);
  return { delivered, inFlight };
}

/** Why an event may not re-offer now, or null when it may. Exported for the dashboard and tests. */
export function eventBlock(event: ReofferRow, rows: readonly ReofferRow[], catalog: readonly CatalogRow[], facts: ReofferFacts, nowMs: number): string | null {
  const kind = PROBLEM_KINDS[event.kind];
  if (!kind || kind.service !== event.service) return 'unknown-kind';
  const row = catalog.find((r) => r.id === event.service);
  if (!row || !isServiceAvailable(row)) return 'unavailable';
  const at = ms(event.at);
  if (nowMs - at >= EVENT_FRESH_MS) return 'stale';
  const choice = facts.choice(event.service);
  if (choice.choice === 'no') {
    if (choice.at === null || at <= ms(choice.at)) return 'before-the-no';
  } else if (choice.choice === 'unset' && facts.offer(event.service) === 'offered') {
    const offeredAt = facts.offeredAt(event.service);
    if (offeredAt === null || at <= offeredAt) return 'before-the-offer';
  } else {
    return 'not-refused';
  }
  const { delivered, inFlight } = liveReservations(rows, nowMs);
  if (inFlight.some((r) => r.eventRef === event.eventId)) return 'in-flight';
  const same = delivered.filter((r) => r.kind === event.kind && r.service === event.service);
  if (same.length) {
    const last = Math.max(...same.map((r) => ms(r.at)));
    if (at <= last) return 'spent';
    if (at < last + cooloffMs(same.length)) return 'cool-off';
  }
  return null;
}

/**
 * What the lease holder does now for one owner: resend a reservation still in flight, send the oldest eligible
 * problem, or nothing. `rows` are this owner's re-offer rows.
 */
export function nextReoffer(rows: readonly ReofferRow[], catalog: readonly CatalogRow[], facts: ReofferFacts, nowMs: number): ReofferDecision {
  const { delivered, inFlight } = liveReservations(rows, nowMs);
  if (inFlight.length) {
    return { action: 'resume', pending: [...inFlight].sort((a, b) => ms(a.at) - ms(b.at))[0]! };
  }
  const events = rows.filter((r) => r.state === 'event').sort((a, b) => ms(a.at) - ms(b.at) || (a.eventId < b.eventId ? -1 : 1));
  const eligible = events.find((e) => eventBlock(e, rows, catalog, facts, nowMs) === null);
  if (!eligible) return { action: 'none', why: 'nothing-waiting' };
  if (delivered.some((r) => nowMs - ms(r.at) < REOFFER_DAILY_WINDOW_MS)) return { action: 'none', why: 'daily-cap' };
  return { action: 'send', event: eligible };
}

/** True when a fresh event of this kind is already waiting, so another sighting adds nothing. */
export function isDuplicateEvent(rows: readonly ReofferRow[], kind: string, nowMs: number): boolean {
  return rows.some((r) => r.state === 'event' && r.kind === kind && nowMs - ms(r.at) < EVENT_DEDUPE_MS);
}

/**
 * The re-offer message: why now, from the kind's fixed words; the service's facts; how to say yes; and that a no
 * stands with nothing to do. No buttons: the choice is already made, and a re-offer never changes it.
 */
export function renderReoffer(kind: string, row: CatalogRow, opts: { linkBase: string | null; choice: EffectiveChoice['choice']; deliveredBefore: number }): string {
  const problem = PROBLEM_KINDS[kind];
  if (!problem) throw new Error(`recommended-services: no template for problem kind ${kind}`);
  const earlier = opts.choice === 'no'
    ? `You said no to ${row.name} earlier, and this is the problem it fixes, so I'm asking once more.`
    : `${row.name} was on my list of services, and this is the problem it fixes, so I'm asking once more.`;
  const days = Math.round(cooloffMs(opts.deliveredBefore + 1) / DAY_MS);
  const lines = [
    problem.why,
    earlier,
    '',
    `What you get: ${row.benefit}`,
    `What leaves this machine: ${row.dataLeaves}`,
    `Cost: ${row.cost}`,
    `Account: ${row.account}`,
    '',
    opts.linkBase
      ? `Yes: ${opts.linkBase}/dashboard/service-yes?service=${encodeURIComponent(row.id)} (your PIN)`
      : 'Yes: open my dashboard and say yes on the Services row, with your PIN.',
    `If it's still no, there's nothing to do. Your answer stands, and this problem won't make me ask again for at least ${days} days.`,
  ];
  return lines.join('\n');
}

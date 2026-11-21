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
  /** The service this kind re-offers (the first choice, when `alternate` is set). */
  service: string;
  /**
   * The service offered instead once `service` is already a yes, or this kind has already re-offered it
   * (spec: "Tailscale, then Cloudflare if Tailscale is already `yes` or this kind already re-offered it").
   */
  alternate?: string;
  /** Why the agent is asking now, in fixed words. Never includes error text. */
  why: string;
}

/**
 * The real-problem table. Each kind is called only from its named source: `voice-unreadable` from the shared
 * transcription wrapper, `secret-lost` from the boot check over the loaded config, `state-loss-risk` from the restore marker
 * read at start, `address-repeatedly-down` from the tunnel's own give-up transitions. `provider-exhausted` joins
 * with its source and the fixed-template path it needs.
 */
export const PROBLEM_KINDS: Readonly<Record<string, ProblemKind>> = {
  'voice-unreadable': {
    service: 'voice-transcription',
    why: "A voice note came in that I couldn't turn into text, because nothing on this machine can transcribe voice yet.",
  },
  'secret-lost': {
    service: 'bitwarden',
    why: "One of my saved passwords or keys is missing on this machine, and there's no vault holding a copy I could restore it from.",
  },
  'address-repeatedly-down': {
    service: 'tailscale',
    alternate: 'cloudflare-domain',
    why: "My web address went down three times in the last day, and each time it didn't come back on its own, so you couldn't reach me from your phone.",
  },
  'state-loss-risk': {
    service: 'github-state-backup',
    why: "I was just restored from a snapshot kept on this same machine, and there's no copy of my memory and settings anywhere else. If this machine is lost, so is everything I know.",
  },
};

/**
 * The `secret-lost` boot check: where the loaded config still holds a `{ "secret": true }` placeholder after the
 * encrypted store was merged in, a secret the config refers to is missing. Returns the dotted paths (for tests
 * and logs; the paths never reach a message or the ledger). Bounded depth, so a strange config can't stall boot.
 */
export function findUnresolvedSecrets(config: unknown, maxDepth = 8): string[] {
  const found: string[] = [];
  const walk = (v: unknown, at: string, depth: number): void => {
    if (depth > maxDepth || v === null || typeof v !== 'object') return;
    if (!Array.isArray(v) && (v as Record<string, unknown>)['secret'] === true) {
      found.push(at || '(root)');
      return;
    }
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) walk(child, at ? `${at}.${k}` : k, depth + 1);
  };
  walk(config, '', 0);
  return found;
}

export function isProblemKind(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROBLEM_KINDS, kind);
}

/** The services a kind may re-offer. */
export function problemServices(kind: string): string[] {
  const k = PROBLEM_KINDS[kind];
  return k ? [k.service, ...(k.alternate ? [k.alternate] : [])] : [];
}

/**
 * Which service a new problem of this kind re-offers: the kind's first choice, or its alternate once the first is
 * a yes or has already been re-offered for this kind. Null when the alternate is a yes too (nothing left to offer).
 */
export function serviceForProblem(kind: string, rows: readonly ReofferRow[], choice: (service: string) => EffectiveChoice): string | null {
  const k = PROBLEM_KINDS[kind];
  if (!k) return null;
  if (!k.alternate) return k.service;
  const firstSpent = choice(k.service).choice === 'yes' || rows.some((r) => r.state === 'offered' && r.kind === kind && r.service === k.service);
  if (!firstSpent) return k.service;
  return choice(k.alternate).choice === 'yes' ? null : k.alternate;
}

/** `address-repeatedly-down`: this many outages self-heal didn't resolve, within the window, is one problem. */
export const ADDRESS_OUTAGES_THRESHOLD = 3;
export const ADDRESS_OUTAGE_WINDOW_MS = DAY_MS;

/**
 * Adds one outage to the kept times (newest last, at most the threshold kept) and says whether the threshold is
 * now met within the window. Pure, so the per-machine file stays a dumb list.
 */
export function noteOutage(times: readonly number[], nowMs: number): { times: number[]; problem: boolean } {
  const kept = [...times.filter((t) => Number.isFinite(t) && nowMs - t < ADDRESS_OUTAGE_WINDOW_MS && t <= nowMs), nowMs].slice(-ADDRESS_OUTAGES_THRESHOLD);
  const problem = kept.length >= ADDRESS_OUTAGES_THRESHOLD;
  return { times: problem ? [] : kept, problem };
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
  if (!kind || !problemServices(event.kind).includes(event.service)) return 'unknown-kind';
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

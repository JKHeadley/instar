/**
 * checkInReminderCore — the pure, deterministic half of the dated-commitment
 * check-in reminder (ACT-724; docs/specs/dated-commitment-reminder.md).
 *
 * "Is this commitment due for its check-in reminder?" is arithmetic over
 * durable state — open status AND `checkInAt` has arrived AND no idempotency
 * stamp — so it is an INVARIANT, not a judgment. It lives here, free of I/O,
 * so both sides of every clause are testable without a store, a clock, or a
 * transport.
 *
 * The stateful half (CAS stamping, posting, lease gating) lives in the
 * reconciler that calls this.
 */
import type { Commitment, CommitmentStatus } from './CommitmentTracker.js';

/**
 * Statuses in which a commitment is still OPEN — i.e. the promise is live and a
 * check-in is still owed.
 *
 * Enumerated as an explicit allowlist rather than "not one of the terminal
 * ones": a status added later must be classified deliberately, and the safe
 * default for an unrecognised status is "not open", which sends nothing.
 */
export const OPEN_COMMITMENT_STATUSES: ReadonlySet<CommitmentStatus> = new Set<CommitmentStatus>([
  'pending',
]);

export type NotDueReason =
  | 'no-check-in-date'
  | 'unparseable-check-in-date'
  | 'not-yet-due'
  | 'already-reminded'
  | 'retries-exhausted'
  | 'not-open'
  | 'no-topic';

/**
 * Delivery attempts before giving up LOUDLY (recording
 * `checkInReminderFailedAt`) rather than retrying a broken transport forever.
 *
 * Retry exists at all because the alternative — marking a reminder sent before
 * sending it — turns any transport failure into a permanently dropped promise.
 * The bound exists because unbounded retry is its own failure mode.
 */
export const CHECK_IN_MAX_ATTEMPTS = 5;

export type DueVerdict = { due: true } | { due: false; reason: NotDueReason };

export interface DuePredicateInput {
  commitment: Pick<
    Commitment,
    | 'status'
    | 'checkInAt'
    | 'checkInReminderSentAt'
    | 'checkInReminderAttempts'
    | 'topicId'
  >;
  nowMs: number;
}

/**
 * The whole decision. Order matters only for the QUALITY of the reason
 * returned, never for the outcome — every clause must hold.
 */
export function isCheckInReminderDue(input: DuePredicateInput): DueVerdict {
  const c = input.commitment;

  // A commitment with no date never produces a reminder. This is the common
  // case and is deliberately first: most commitments are undated.
  if (!c.checkInAt) return { due: false, reason: 'no-check-in-date' };

  // A reminder with nowhere to go is not a reminder. Checked before the clock
  // so a dated-but-unrouted commitment reports the real problem.
  if (typeof c.topicId !== 'number' || !Number.isFinite(c.topicId)) {
    return { due: false, reason: 'no-topic' };
  }

  // Terminal statuses end the obligation. THIS is the teardown: delivering or
  // withdrawing makes the commitment ineligible, so nothing has to be deleted,
  // disabled, or unregistered (ACT-724 defect (c) — self-disable by file edit).
  if (!OPEN_COMMITMENT_STATUSES.has(c.status)) return { due: false, reason: 'not-open' };

  // Delivered. Set only AFTER a successful send, so this genuinely means the
  // user has the reminder — never "we tried and gave up".
  if (c.checkInReminderSentAt) return { due: false, reason: 'already-reminded' };

  // Retries exhausted: stop, and let `checkInReminderFailedAt` carry the fact.
  // Deliberately NOT silent — an undelivered reminder is a real failure and is
  // surfaced on the read route rather than absorbed here.
  if ((c.checkInReminderAttempts ?? 0) >= CHECK_IN_MAX_ATTEMPTS) {
    return { due: false, reason: 'retries-exhausted' };
  }

  const at = Date.parse(c.checkInAt);
  // An unparseable date fails CLOSED (no reminder) rather than being coerced to
  // 0 and treated as infinitely overdue — which would fire immediately, the
  // exact shape of the boot-time bug this feature had to fix in the scheduler.
  if (Number.isNaN(at)) return { due: false, reason: 'unparseable-check-in-date' };

  if (at > input.nowMs) return { due: false, reason: 'not-yet-due' };

  return { due: true };
}

/** Partition a batch. Pure — the reconciler decides what to do with each side. */
export function selectDueCommitments<T extends DuePredicateInput['commitment'] & { id: string }>(
  commitments: readonly T[],
  nowMs: number,
): { due: T[]; skipped: Array<{ id: string; reason: NotDueReason }> } {
  const due: T[] = [];
  const skipped: Array<{ id: string; reason: NotDueReason }> = [];
  for (const c of commitments) {
    const v = isCheckInReminderDue({ commitment: c, nowMs });
    if (v.due) due.push(c);
    else skipped.push({ id: c.id, reason: v.reason });
  }
  return { due, skipped };
}

/**
 * The reminder text. A FIXED TEMPLATE, deliberately not model-authored.
 *
 * A reminder is a fact — "you said X by Y" — so there is no judgment to make,
 * and generating it would add a failure mode (provider down, gate holds) to a
 * path whose entire purpose is to not fail. It also means the message carries
 * no agent prose for an outbound gate to judge, which is why it can ride the
 * deterministic delivery path.
 *
 * The commitment's own text is quoted as DATA, clamped, and never interpreted.
 */
export const CHECK_IN_TEXT_MAX = 400;

export function buildCheckInReminderText(opts: {
  userRequest: string;
  checkInAt: string;
}): string {
  const promise = (opts.userRequest ?? '').trim().replace(/\s+/g, ' ').slice(0, CHECK_IN_TEXT_MAX);
  const when = formatCheckInDate(opts.checkInAt);
  return (
    `Check-in I promised you${when ? ` for ${when}` : ''}:\n\n` +
    `“${promise}”\n\n` +
    `That's the date arriving — not a status update. Nothing here says the work happened. ` +
    `Tell me if it's still wanted and I'll pick it up.`
  );
}

/** Human date, or '' when unparseable — never throws, never invents. */
export function formatCheckInDate(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  const day = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${day} at ${time}`;
}

/**
 * PromisedUpdateCapture — records "next update by 7 PM" as a dated commitment
 * the moment the message goes out (docs/specs/promised-update-capture.md).
 *
 * The rule "register a commitment when you promise a time" depended on the
 * session remembering to do it, and it failed three times (2026-10-13,
 * 2026-11-03, 2026-11-07). This makes it structural: it listens on the same
 * message-logged seam every other observer uses, so every agent message to a
 * topic passes through it with no step a session can skip.
 *
 * Lifecycle, all on existing machinery:
 *   1. An agent message names a time for its next update → one commitment with
 *      `checkInAt` = that time + a short grace, keyed on the message
 *      (`externalKey`), so a replay never makes two.
 *   2. Any LATER agent message to the same topic is the update → the open
 *      promised-update commitments for that topic close as `delivered`. (If that
 *      message promises a new time, step 1 records the new one.)
 *   3. Nothing came by the time → the existing CheckInReminderReconciler posts
 *      one honest line and hands the promise back to the topic's session
 *      (which the inbound path resumes or respawns) — see routes.ts.
 *
 * Signal, not authority: it only writes commitment records. It never blocks,
 * edits, or delays a message, and every failure is swallowed after a log line
 * so the message path it observes is never affected.
 */
import type { Commitment, CommitmentTracker } from './CommitmentTracker.js';
import { detectPromisedUpdate, formatPromiseTime } from './promisedUpdateDetector.js';
import { resolveDevAgentGate, type DevAgentGateConfig } from '../core/devAgentGate.js';

/** externalKey prefix — the marker every other part of the feature reads. */
export const PROMISED_UPDATE_KEY_PREFIX = 'promised-update:';
/** "by about 7 PM" — an update at 7:05 is on time. */
export const PROMISED_UPDATE_GRACE_MS = 15 * 60_000;
/**
 * A reply often goes out as two or three messages a few seconds apart. A
 * message this soon after the promise is the rest of the same report, not the
 * update it promised, so it does not close the promise.
 */
export const SAME_REPORT_WINDOW_MS = 5 * 60_000;

/**
 * Whether a message sent at `sentAt` is the promised update rather than the
 * tail of the message that made the promise. Past the same-report window it
 * always counts; a short promise ("back in 3 minutes") counts from half its
 * lead, so a reply kept on time is never read as part of the promise.
 */
export function countsAsUpdate(c: Pick<Commitment, 'createdAt' | 'checkInAt'>, sentAt: number): boolean {
  const promisedAt = Date.parse(c.createdAt);
  if (!Number.isFinite(promisedAt)) return true;
  const dueAt = Date.parse(c.checkInAt ?? '') - PROMISED_UPDATE_GRACE_MS;
  const lead = Number.isFinite(dueAt) ? dueAt - promisedAt : SAME_REPORT_WINDOW_MS * 2;
  return sentAt - promisedAt >= Math.min(SAME_REPORT_WINDOW_MS, Math.max(0, lead / 2));
}

export function isPromisedUpdateCommitment(c: Pick<Commitment, 'externalKey'>): boolean {
  return typeof c.externalKey === 'string' && c.externalKey.startsWith(PROMISED_UPDATE_KEY_PREFIX);
}

export interface LoggedMessage {
  messageId: number;
  topicId: number | null;
  text: string;
  fromUser: boolean;
  timestamp: string;
  provenance?: string;
}

export interface PromisedUpdateCaptureDeps {
  tracker: Pick<CommitmentTracker, 'getActive' | 'record' | 'deliver'>;
  /** Read per message so a live config flip takes effect without a restart. */
  enabled: () => boolean;
  /** IANA zone the agent writes times in; absent → this machine's zone. */
  timeZone?: () => string | undefined;
  now?: () => number;
  log?: (line: string) => void;
}

export type CaptureOutcome = {
  closed: string[];
  recorded: string | null;
};

export class PromisedUpdateCapture {
  constructor(private readonly deps: PromisedUpdateCaptureDeps) {}

  /** Never throws: an observer must not break the message path it watches. */
  onMessageLogged(entry: LoggedMessage): CaptureOutcome {
    const outcome: CaptureOutcome = { closed: [], recorded: null };
    try {
      if (!this.deps.enabled()) return outcome;
      // Only the agent's own words. User messages promise nothing on the
      // agent's behalf; automation (reminders, beacons, notices) is not the
      // agent speaking and must neither make nor discharge a promise.
      if (entry.fromUser || entry.provenance !== 'agent') return outcome;
      if (typeof entry.topicId !== 'number' || !Number.isFinite(entry.topicId) || !entry.text) return outcome;
      const topicId = entry.topicId;
      const key = `${PROMISED_UPDATE_KEY_PREFIX}${topicId}:${entry.messageId}`;
      const sentAt = Date.parse(entry.timestamp);

      // 1. Does this message promise the next one by a time?
      const now = (this.deps.now ?? Date.now)();
      const zone = this.deps.timeZone?.();
      const found = detectPromisedUpdate(entry.text, now, zone);

      // 2. This message is the update for every earlier open promise here —
      // unless it is the rest of the same report, sent moments later. A message
      // that names a new time replaces earlier promises however soon it comes.
      for (const c of this.deps.tracker.getActive()) {
        if (!isPromisedUpdateCommitment(c) || c.topicId !== topicId || c.externalKey === key) continue;
        if (!found && Number.isFinite(sentAt) && !countsAsUpdate(c, sentAt)) continue;
        const done = this.deps.tracker.deliver(c.id, String(entry.messageId), found
          ? 'A later message to this topic set a new time'
          : 'A later message was sent to this topic');
        if (done) outcome.closed.push(c.id);
      }

      if (!found) return outcome;
      const when = formatPromiseTime(found.dueAtMs, zone);
      const c = this.deps.tracker.record({
        type: 'one-time-action',
        userRequest: `Send the update promised for ${when}`,
        agentResponse: found.sentence,
        topicId,
        source: 'sentinel',
        externalKey: key,
        checkInAt: new Date(found.dueAtMs + PROMISED_UPDATE_GRACE_MS).toISOString(),
        // The dated check-in reminder is the follow-through; the cadence beacon
        // would only add a second voice for the same promise.
        beaconEnabled: false,
        followThroughOptOutReason: 'Dated check-in reminder covers this promised update',
        boundBy: 'server:promised-update-capture',
      });
      outcome.recorded = c.id;
      this.log(`[promised-update] ${c.id} topic ${topicId}: update promised for ${when} ("${found.phrase}")`);
    } catch (err) {
      this.log(`[promised-update] capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return outcome;
  }

  private log(line: string): void {
    (this.deps.log ?? console.log)(line);
  }
}

/**
 * Chain the capture onto an adapter's message-logged callback, keeping every
 * earlier observer. One call at the wiring site, so the server's startup
 * function grows by a single statement.
 */
export function chainPromisedUpdateCapture<E extends LoggedMessage>(
  adapter: { onMessageLogged: ((entry: E) => void) | null } | null | undefined,
  capture: PromisedUpdateCapture | null,
): boolean {
  if (!adapter || !capture) return false;
  const before = adapter.onMessageLogged;
  adapter.onMessageLogged = (entry: E) => {
    if (before) before(entry);
    capture.onMessageLogged(entry);
  };
  return true;
}

export interface PromisedUpdateCommitmentsConfig {
  checkInReminder?: { enabled?: boolean };
  promisedUpdateCapture?: { enabled?: boolean; timeZone?: string };
}

/**
 * Capture follows the check-in reminder's gate (live on a development agent,
 * dark on the fleet until the reminder is flipped on) — a captured promise is
 * only useful where the reminder can fire. `promisedUpdateCapture.enabled`
 * overrides either way; read live per message.
 */
export function resolvePromisedUpdateCaptureEnabled(
  commitments: PromisedUpdateCommitmentsConfig | undefined,
  config: DevAgentGateConfig | undefined,
): boolean {
  const own = commitments?.promisedUpdateCapture?.enabled;
  if (typeof own === 'boolean') return own;
  return resolveDevAgentGate(commitments?.checkInReminder?.enabled, config);
}

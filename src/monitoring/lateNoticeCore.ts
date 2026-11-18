/**
 * lateNoticeCore — shared constants and helpers for promise follow-through.
 *
 * The overdue-promise decisions (which stage a promise is in, the pickup
 * ladder, the last-resort text and the session notice) moved to
 * promiseKeepingCore (docs/specs/promise-keeping-before-the-deadline.md).
 * What stays here: the backlog window, the last-resort send bounds, the
 * person-facing time format, and the "ask once" date-missing hint.
 *
 * Only `softDeadlineAt` is a promised time. `hardDeadlineAt` is synthesized by
 * record() and the action-claim lane from durations ("soon" → +2h), so acting
 * on it would treat a time nobody promised as a promise.
 */
import type { Commitment } from './CommitmentTracker.js';
import { resolveTimeZone } from './promisedUpdateDetector.js';

/** Backlog window before a machine's first live pass (see spec §3.2 "Window"). */
export const LATE_NOTICE_BACKLOG_MS = 24 * 60 * 60_000;
/** Attempts per promised time (pickups, then the fallback send) before giving up loudly. */
export const LATE_NOTICE_MAX_ATTEMPTS = 5;
/** One late message per conversation per this long. */
export const DEFAULT_LATE_TOPIC_COOLDOWN_MS = 60 * 60_000;
/** Conversations that may get a late message in one pass (agent-wide). */
export const DEFAULT_MAX_LATE_TOPICS_PER_PASS = 3;
/** Conversations that may get a late message per rolling hour (agent-wide). */
export const DEFAULT_MAX_LATE_TOPICS_PER_HOUR = 12;
/** Quoted promise text is clamped to this many characters. */
export const LATE_TEXT_QUOTE_MAX = 300;
/** Rows listed in one aggregated message before "+N more". */
export const LATE_TEXT_MAX_LISTED = 5;

/** "Wednesday 18 November, 12:00 PM" — weekday, date and time from ONE zone. Never throws. */
export function formatPromisedTime(iso: string, timeZone?: string | null): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  try {
    const zone = resolveTimeZone(timeZone);
    const d = new Date(ms);
    const day = d.toLocaleDateString('en-GB', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long' });
    const time = d.toLocaleTimeString('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' });
    return `${day}, ${time}`;
  } catch {
    return ''; // @silent-fallback-ok — no Intl data: the text omits the time rather than inventing one
  }
}

export interface DateMissingHint {
  found: string;
  suggestedSoftDeadlineAt: string;
  suggestedLocal: string;
  ask: string;
}

/**
 * §3.5 "ask once": a just-recorded promise in a conversation names a completion
 * time but carries no promised time. The keyword guard decides only whether to
 * ASK; the recording session decides the date. Never writes anything.
 */
export function buildDateMissingHint(
  c: Pick<Commitment, 'id' | 'topicId' | 'softDeadlineAt' | 'checkInAt' | 'agentResponse' | 'originMachineId'>,
  nowMs: number,
  detect: (text: string, nowMs: number, tz?: string | null) => { dueAtMs: number; phrase: string } | null,
  timeZone?: string | null,
): DateMissingHint | null {
  if (typeof c.topicId !== 'number' || c.softDeadlineAt || c.checkInAt) return null;
  const found = detect(c.agentResponse ?? '', nowMs, timeZone);
  if (!found) return null;
  const iso = new Date(found.dueAtMs).toISOString();
  const phrase = found.phrase.replace(/[.\s]+$/, '');
  const q = c.originMachineId ? `?origin=${encodeURIComponent(c.originMachineId)}` : '';
  return {
    found: phrase,
    suggestedSoftDeadlineAt: iso,
    suggestedLocal: formatPromisedTime(iso, timeZone),
    ask: `This promise names a time ("${phrase}") but has no date, so nothing will tell the person if it slips. If that time is the promise, set it: PATCH /commitments/${c.id}${q} {"softDeadlineAt": "${iso}"}.`,
  };
}

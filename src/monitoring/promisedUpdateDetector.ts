/**
 * promisedUpdateDetector — the pure half of promised-update capture
 * (docs/specs/promised-update-capture.md).
 *
 * Finds a promise of a NEXT MESSAGE BY A NAMED TIME in an outgoing agent
 * message ("Next update by about 7 PM", "I'll report back in 30 minutes") and
 * resolves that time to an instant.
 *
 * Live failure (Echo Bugs 10000002488, 2026-11-07): an unprompted status update
 * ended "Next update by about 7 PM". Nothing recorded it — the commitment
 * sentinel only reads "user asked → agent agreed" pairs — so when the session
 * stopped at 18:18, nothing knew a message was owed. Justin asked 37 hours
 * later.
 *
 * Signal, not authority: a match only RECORDS a dated commitment. It blocks
 * nothing and sends nothing by itself. A miss leaves things as they were
 * before; a false match costs one honest "I said I'd update you by X" line,
 * and only if no message at all follows by that time.
 *
 * Deliberately narrow: a sentence must carry BOTH a promise-of-a-message cue
 * AND a concrete time (a clock time, or "in/within N minutes/hours"). Vague
 * horizons ("later", "end of day", "soon") are not captured — they have no
 * moment at which "it is now late" is a fact.
 */

export interface PromisedUpdate {
  /** The promised instant, epoch ms. */
  dueAtMs: number;
  /** The sentence that made the promise (trimmed, clamped). */
  sentence: string;
  /** The time phrase as written ("by about 7 PM", "in 30 minutes"). */
  phrase: string;
}

export const PROMISE_SENTENCE_MAX = 400;
/** A resolved time further out than this is not a "next update" promise. */
export const MAX_HORIZON_MS = 36 * 60 * 60_000;
/** With an explicit weekday the horizon is a week. */
export const MAX_WEEKDAY_HORIZON_MS = 7 * 24 * 60 * 60_000;
/** Times this close to now are noise ("in 1 minute"). */
export const MIN_LEAD_MS = 2 * 60_000;
/**
 * A clock time that already passed today, by less than this, is a late or past
 * reference ("by 5 PM" said at 5:20 PM), not a promise for tomorrow. Further
 * back it rolls to the next day ("by 9 AM" said at 11 PM).
 */
export const RECENT_PAST_MS = 3 * 60 * 60_000;

// A promise that a message from the agent is coming. Each alternative names
// the MESSAGE (update / report / results / back to you), so "the job runs at
// 7 PM" or "the build finished at 5 PM" never match.
const CUE = new RegExp(
  [
    String.raw`\bnext\s+(?:update|status(?:\s+update)?|check-?in|report|note|message)\b`,
    String.raw`\b(?:i'll|i\s+will|i'm\s+going\s+to|i\s+am\s+going\s+to|we'll|we\s+will)\s+(?:\w+\s+){0,2}?(?:send|post|give|report|update|message|ping|write|share|check\s+back|come\s+back|get\s+back|circle\s+back|follow\s+up|be\s+back|have\s+(?:an?\s+)?(?:update|answer|results?|news))\b`,
    // A bare noun only with a deadline word: "status at 14:30: green" and "the
    // update at 7 PM failed" are labels and past events, not promises.
    String.raw`\b(?:update|report|results?|status|answer|news)\s+(?:from\s+me\s+)?(?:by|within|before)\b`,
    String.raw`\b(?:you'll|you\s+will)\s+(?:hear\s+from\s+me|get\s+(?:an?\s+)?(?:update|answer|results?|report)|have\s+(?:an?\s+)?(?:update|answer|results?|report))\b`,
    String.raw`\b(?:report|check|circle|get)\s+back\b`,
  ].join('|'),
  'i',
);

// Negations and past tense that turn a cue into a non-promise.
// Narrow on purpose: "Not done yet; next update by 7 PM" is still a promise.
const NEGATION = new RegExp(
  [
    String.raw`\b(?:no|not\s+an?)\s+(?:further\s+|more\s+|new\s+)?updates?\b`,
    String.raw`\b(?:won't|will\s+not|can't|cannot|didn't|did\s+not|never)\s+(?:\w+\s+){0,2}?(?:send|post|update|report|message|get\s+back|check\s+back)\b`,
    String.raw`\bi\s+(?:promised|said|told\s+you)\b`,
  ].join('|'),
  'i',
);

const HEDGE = String.raw`(?:about\s+|around\s+|roughly\s+|approximately\s+|approx\.?\s+|~\s*)?`;
const CLOCK = new RegExp(
  String.raw`\b(by|at|before|around|until|till|for)\s+${HEDGE}(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)?(?![\w:])`,
  'i',
);
const NAMED_CLOCK = new RegExp(String.raw`\b(by|at|before|around)\s+${HEDGE}(noon|midnight)\b`, 'i');
const RELATIVE = new RegExp(
  String.raw`\b(in|within)\s+${HEDGE}(an?|half\s+an|one|two|three|four|five|six|\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|h)\b`,
  'i',
);
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_RE = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i;
const WORD_NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

function normalize(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'").replace(/[  ]/g, ' ');
}

/** Split into sentences / lines; keeps each piece short enough to judge alone. */
export function splitSentences(text: string): string[] {
  return normalize(text)
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9"“(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Offset (ms) of `timeZone` from UTC at instant `ms`. */
function tzOffsetMs(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Wall-clock parts of `ms` in `timeZone`. */
function wallParts(ms: number, timeZone: string): { y: number; m: number; d: number; dow: number } {
  const shifted = new Date(ms + tzOffsetMs(ms, timeZone));
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth(), d: shifted.getUTCDate(), dow: shifted.getUTCDay() };
}

/** The instant at wall-clock y-m-d h:mi in `timeZone` (DST-correct to the minute). */
function zonedInstant(y: number, m: number, d: number, h: number, mi: number, timeZone: string): number {
  const guess = Date.UTC(y, m, d, h, mi);
  const first = guess - tzOffsetMs(guess, timeZone);
  return guess - tzOffsetMs(first, timeZone);
}

export function resolveTimeZone(tz?: string | null): string {
  if (tz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return tz;
    } catch { /* @silent-fallback-ok — an invalid configured zone falls back to the machine zone */ }
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC'; // @silent-fallback-ok — no Intl zone data: UTC is a defined answer
  }
}

function resolveClock(sentence: string, nowMs: number, timeZone: string): { dueAtMs: number; phrase: string; maxHorizon: number } | null {
  let hour: number;
  let minute = 0;
  let phrase: string;
  const named = sentence.match(NAMED_CLOCK);
  const clock = sentence.match(CLOCK);
  if (named && (!clock || (named.index ?? 0) <= (clock.index ?? 0))) {
    hour = named[2].toLowerCase() === 'noon' ? 12 : 0;
    phrase = named[0];
  } else if (clock) {
    hour = Number(clock[2]);
    minute = clock[3] ? Number(clock[3]) : 0;
    const meridiem = clock[4]?.toLowerCase().replace(/[^ap]/g, '');
    if (minute > 59) return null;
    if (meridiem) {
      if (hour < 1 || hour > 12) return null;
      if (meridiem === 'p' && hour !== 12) hour += 12;
      if (meridiem === 'a' && hour === 12) hour = 0;
    } else {
      // No am/pm: only an unambiguous 24-hour clock ("by 19:00") is a time.
      // "by 7" or "at 3" could be a count, a version, or a date.
      if (!clock[3] || hour > 23) return null;
    }
    phrase = clock[0];
  } else {
    return null;
  }

  const today = wallParts(nowMs, timeZone);
  let dayOffset = 0;
  let maxHorizon = MAX_HORIZON_MS;
  const weekday = sentence.match(WEEKDAY_RE);
  if (/\btomorrow\b/i.test(sentence)) {
    dayOffset = 1;
  } else if (weekday) {
    const target = WEEKDAYS.indexOf(weekday[1].toLowerCase());
    dayOffset = (target - today.dow + 7) % 7;
    maxHorizon = MAX_WEEKDAY_HORIZON_MS;
  }
  let due = zonedInstant(today.y, today.m, today.d + dayOffset, hour, minute, timeZone);
  if (due <= nowMs) {
    // An explicit day that is already past is not a promise.
    if (dayOffset > 0) return null;
    // Passed only a little while ago: a late or past reference, not tomorrow.
    if (!weekday && nowMs - due < RECENT_PAST_MS) return null;
    // "by 9 AM" said at 11 PM means tomorrow morning; a weekday that is today
    // but already past means next week.
    due = zonedInstant(today.y, today.m, today.d + (weekday ? 7 : 1), hour, minute, timeZone);
  }
  return { dueAtMs: due, phrase: phrase.trim(), maxHorizon };
}

function resolveRelative(sentence: string, nowMs: number): { dueAtMs: number; phrase: string; maxHorizon: number } | null {
  const rel = sentence.match(RELATIVE);
  if (!rel) return null;
  const rawN = rel[2].toLowerCase().replace(/\s+/g, ' ');
  const n = rawN === 'half an' ? 0.5 : (WORD_NUMBERS[rawN] ?? Number(rawN));
  if (!Number.isFinite(n) || n <= 0) return null;
  const unitMs = /^m/i.test(rel[3]) ? 60_000 : 3_600_000;
  return { dueAtMs: nowMs + Math.round(n * unitMs), phrase: rel[0].trim(), maxHorizon: MAX_HORIZON_MS };
}

/**
 * The first sentence that promises a message by a concrete time, resolved.
 * Pure: same text + clock + zone → same answer.
 */
export function detectPromisedUpdate(text: string, nowMs: number, timeZone?: string | null): PromisedUpdate | null {
  if (!text || typeof text !== 'string') return null;
  const zone = resolveTimeZone(timeZone);
  for (const sentence of splitSentences(text)) {
    if (!CUE.test(sentence)) continue;
    if (NEGATION.test(sentence)) continue;
    const resolved = resolveClock(sentence, nowMs, zone) ?? resolveRelative(sentence, nowMs);
    if (!resolved) continue;
    const lead = resolved.dueAtMs - nowMs;
    if (lead < MIN_LEAD_MS || lead > resolved.maxHorizon) continue;
    return {
      dueAtMs: resolved.dueAtMs,
      sentence: sentence.slice(0, PROMISE_SENTENCE_MAX),
      phrase: resolved.phrase,
    };
  }
  return null;
}

/** "7:00 PM" in the zone — for the reminder text. Never throws. */
export function formatPromiseTime(ms: number, timeZone?: string | null): string {
  try {
    return new Date(ms).toLocaleTimeString('en-US', { timeZone: resolveTimeZone(timeZone), hour: 'numeric', minute: '2-digit' });
  } catch {
    return new Date(ms).toISOString(); // @silent-fallback-ok — an ISO time is still a true time
  }
}

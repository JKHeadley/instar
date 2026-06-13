/**
 * time-claim.ts — deterministic detector for elapsed/remaining/percent time
 * claims that contradict the live session clock of the sending topic's active
 * time-boxed (autonomous) session.
 *
 * Founding incident (2026-06-12, topic 13481): an autonomous progress report
 * claimed "~7h elapsed / 24h total" when the run's real clock read 1h 35m —
 * the operator mandated structurally-enforced accurate time reporting
 * ("MANDATE accurate time reporting and NOT allow guessing"). The session
 * clock API exists precisely so no time is ever estimated
 * (docs/specs/ROBUST-SESSION-TIME-AWARENESS-SPEC.md); this detector closes the
 * loop on the OUTBOUND side: a report that contradicts the clock is flagged
 * BEFORE it reaches the user.
 *
 * Pure + total (no I/O, no LLM): the caller passes the already-computed
 * clock(s); every malformed input degrades to "not detected" (fail-open, the
 * advisory layer's contract). Signal-only — it feeds the inform-only outbound
 * advisory surface (src/messaging/OutboundAdvisory.ts) and never blocks.
 *
 * Deliberately CONSERVATIVE extraction: only claims with an explicit
 * elapsed/remaining/percent anchor are parsed ("7h elapsed", "7.5 hours in:",
 * "2h 40m left", "8% elapsed"). Unanchored durations ("the test took 3h",
 * "in 2 hours I'll check") are never matched — a missed claim is an accepted
 * under-block; a false fire on conversational text is the failure mode this
 * conservatism exists to avoid.
 */

import { humanizeDuration } from './SessionClock.js';

/** The clock fields the detector compares against (subset of SessionClock). */
export interface TimeClaimClock {
  elapsedSeconds: number;
  /** null for an unbounded run — remaining/percent claims are then skipped. */
  remainingSeconds: number | null;
  /** null for an unbounded run. */
  percentElapsed: number | null;
}

export interface TimeClaimResult {
  detected: boolean;
  /** Bounded inert summary: `claimed <X>; live clock: <Y>` (≤120 chars). */
  match?: string;
}

interface ExtractedClaim {
  kind: 'elapsed' | 'remaining' | 'percent';
  /** Claimed value in seconds (elapsed/remaining) or percent points. */
  value: number;
  /** The matched claim text, for the inert match summary. */
  text: string;
}

// Anchored claim patterns. Each requires the anchor WORD so plain durations
// never match. Hours may be fractional ("7.5 hours"); "Xh Ym" composes.
// "in" as an elapsed anchor is only accepted at a boundary ("7.5 hours in:",
// "1h50m in.", "2h in)") — never "3h in CI" / "in 2 hours".
const HOURS = String.raw`(\d{1,3}(?:\.\d+)?)\s*h(?:ours?|rs?)?`;
const MINUTES = String.raw`(\d{1,2})\s*m(?:in(?:ute)?s?)?`;
const HM = `${HOURS}(?:\\s*${MINUTES})?|${MINUTES}`;
const PRE = String.raw`(?:~|≈|about\s+|around\s+|roughly\s+)?`;

const ELAPSED_RE = new RegExp(
  `${PRE}(?:${HM})\\s*(?:elapsed|into\\s+the\\s+(?:run|session)|in(?=\\s*(?:[,.;:)\\]!\\n—–-]|$|now\\b)))`,
  'gi',
);
const REMAINING_RE = new RegExp(
  `${PRE}(?:${HM})\\s*(?:remaining|left|to\\s+go|on\\s+the\\s+clock)`,
  'gi',
);
// Percent anchors require an explicit TIME noun ("of the run", "through the
// session") — never bare "complete"/"done"/"through"/"in", which dominantly
// mean TASK progress ("the migration is 80% done"), not wall-clock fraction.
// Comparing task progress against percentElapsed fires on the NORMAL state
// (work is never proportional to wall-clock) and the guidance would then make
// the report WRONG (second-pass review concern 1, 2026-06-12).
const PERCENT_RE = new RegExp(
  String.raw`(\d{1,3})\s*%\s*(?:elapsed|(?:through|of|into)\s+the\s+(?:run|session|clock))`,
  'gi',
);

/** Parse the H/M capture groups of ELAPSED_RE/REMAINING_RE into seconds. */
function groupsToSeconds(m: RegExpExecArray): number | null {
  // Groups: 1=hours, 2=minutes-after-hours, 3=minutes-only (per HM alternation).
  const hours = m[1] !== undefined ? Number(m[1]) : null;
  const minAfter = m[2] !== undefined ? Number(m[2]) : 0;
  const minOnly = m[3] !== undefined ? Number(m[3]) : null;
  if (hours !== null && Number.isFinite(hours)) {
    return Math.round(hours * 3600 + (Number.isFinite(minAfter) ? minAfter : 0) * 60);
  }
  if (minOnly !== null && Number.isFinite(minOnly)) {
    return Math.round(minOnly * 60);
  }
  return null;
}

/**
 * A claim directly preceded by a quote/backtick is someone QUOTING a number
 * (e.g. a correction message citing the wrong claim it is correcting:
 * `my "~7h elapsed" line was wrong`) — never a fresh assertion. Skipped.
 */
const QUOTE_CHARS = new Set(['"', "'", '“', '”', '‘', '’', '`']);

function isQuoted(text: string, index: number): boolean {
  for (let i = index - 1; i >= 0 && i >= index - 2; i--) {
    const ch = text[i];
    if (QUOTE_CHARS.has(ch)) return true;
    if (ch !== ' ' && ch !== '(') return false;
  }
  return false;
}

/** Extract every anchored time claim from `text` (bounded input expected). */
export function extractTimeClaims(text: string): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];
  if (typeof text !== 'string' || text.length === 0) return claims;

  for (const [re, kind] of [
    [ELAPSED_RE, 'elapsed'],
    [REMAINING_RE, 'remaining'],
  ] as const) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null && claims.length < 16) {
      const seconds = groupsToSeconds(m);
      if (seconds !== null && !isQuoted(text, m.index)) {
        claims.push({ kind, value: seconds, text: m[0].trim().slice(0, 40) });
      }
    }
  }

  PERCENT_RE.lastIndex = 0;
  let p: RegExpExecArray | null;
  while ((p = PERCENT_RE.exec(text)) !== null && claims.length < 16) {
    const pct = Number(p[1]);
    if (Number.isFinite(pct) && pct <= 100 && !isQuoted(text, p.index)) {
      claims.push({ kind: 'percent', value: pct, text: p[0].trim().slice(0, 40) });
    }
  }

  return claims;
}

/** Duration tolerance: generous on purpose — only a GROSS guess should fire. */
const DURATION_TOLERANCE_FLOOR_S = 15 * 60; // 15 minutes
const DURATION_TOLERANCE_FRACTION = 0.2; // 20% of the true value
/** Percent tolerance in absolute points. */
const PERCENT_TOLERANCE_POINTS = 15;

function durationConsistent(claimed: number, actual: number): boolean {
  const tol = Math.max(DURATION_TOLERANCE_FLOOR_S, actual * DURATION_TOLERANCE_FRACTION);
  return Math.abs(claimed - actual) <= tol;
}

/**
 * Compare every anchored claim in `text` against the active clock(s).
 * A claim passes if it is consistent with ANY provided clock (lenient by
 * design — multiple active clocks for a topic should not cross-fire).
 * No clocks → never detected (nothing to contradict).
 */
export function detectTimeClaimContradiction(
  text: string,
  clocks: ReadonlyArray<TimeClaimClock>,
): TimeClaimResult {
  if (!Array.isArray(clocks) || clocks.length === 0) return { detected: false };
  const claims = extractTimeClaims(text);
  if (claims.length === 0) return { detected: false };

  for (const claim of claims) {
    let consistentWithAny = false;
    let comparable = false;
    for (const clock of clocks) {
      if (claim.kind === 'elapsed') {
        if (!Number.isFinite(clock.elapsedSeconds)) continue;
        comparable = true;
        if (durationConsistent(claim.value, clock.elapsedSeconds)) consistentWithAny = true;
      } else if (claim.kind === 'remaining') {
        if (typeof clock.remainingSeconds !== 'number' || !Number.isFinite(clock.remainingSeconds)) continue;
        comparable = true;
        if (durationConsistent(claim.value, clock.remainingSeconds)) consistentWithAny = true;
      } else {
        if (typeof clock.percentElapsed !== 'number' || !Number.isFinite(clock.percentElapsed)) continue;
        comparable = true;
        if (Math.abs(claim.value - clock.percentElapsed) <= PERCENT_TOLERANCE_POINTS) consistentWithAny = true;
      }
      if (consistentWithAny) break;
    }
    if (comparable && !consistentWithAny) {
      const clock = clocks[0];
      const live =
        claim.kind === 'percent'
          ? `${clock.percentElapsed}% elapsed`
          : claim.kind === 'remaining'
            ? `${humanizeDuration(clock.remainingSeconds ?? 0)} remaining`
            : `${humanizeDuration(clock.elapsedSeconds)} elapsed`;
      return {
        detected: true,
        match: `claimed "${claim.text}"; live clock: ${live}`.slice(0, 120),
      };
    }
  }
  return { detected: false };
}

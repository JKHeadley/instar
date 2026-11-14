/**
 * Rate-limit (server-side throttle) detection — pure predicate, shared by
 * SessionWatchdog (periodic poll signal) and SessionManager (idle-error path).
 *
 * Distinguishes Anthropic's short-lived shared-capacity throttle
 *   "Server is temporarily limiting requests (not your usage limit) · Rate limited"
 *   "Repeated 529 Overloaded errors"
 * from the account's plan/usage quota (which is PresenceProxy /
 * QuotaExhaustionDetector's domain — wait-for-reset, not retry).
 *
 * Strings are taken from authoritative sources (the user's live screenshot and
 * the Claude Code error reference), NOT invented — see the spec
 * docs/specs/rate-limit-sentinel.md §Detection and the fixtures in
 * tests/unit/rate-limit-detection.test.ts. Treat them as empirical-until-
 * reverified.
 */

/** The throttle is present (shared-capacity, NOT the user's quota). */
export const THROTTLE_PATTERNS: RegExp[] = [
  /server is temporarily limiting requests/i,
  /not your usage limit/i,
  /repeated 529 overloaded errors/i,
  /\b529\b[^\n]*overloaded/i,
];

/**
 * Usage-limit / plan-quota phrasing. If any of these match, this is the user's
 * quota — NOT a server throttle — so the rate-limit sentinel must stand down.
 * (Mirrors PresenceProxy.QUOTA_EXHAUSTION_PATTERNS intent.)
 */
export const USAGE_LIMIT_PATTERNS: RegExp[] = [
  /you've hit your (?:session|weekly|opus|usage) limit/i,
  /\bresets?\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?/i,
  /\/extra-usage to finish/i,
  /usage limit.*reached/i,
];

/**
 * Claude Code's own retry spinner ("Retrying in Ns · attempt x/y"). While this
 * is on the pane the framework is still retrying internally — we do NOT
 * intervene. Keyed on "retrying in <n>" after middot-stripping so encoding /
 * ANSI drift around the `·` can't break the match.
 */
export const RETRY_SPINNER_PATTERN = /retrying in\s+\d+/i;

/** How many trailing pane lines detection inspects by default. */
export const RATE_LIMIT_CAPTURE_LINES = 20;

/**
 * Wider window for the settled-throttle backstop (SessionWatchdog). Claude
 * Code's input box + footer + task list + tips can render 15-25 rows BELOW the
 * "API Error: …" line, pushing the throttle string past the default 20-line
 * window — which is precisely why the watchdog never detected it in the wild
 * (the 2026-05-30 "sessions hang on 429" incident). The settled-output guard
 * (see evaluateThrottleSettle) keeps the wider window from matching a stale
 * throttle the session already recovered from.
 */
export const RATE_LIMIT_SETTLED_CAPTURE_LINES = 45;

/** Default time a throttled pane must stay byte-identical before we recover it. */
export const RATE_LIMIT_DEFAULT_SETTLE_MS = 20_000;

/** Replace middot / bullet separators with spaces so matches don't hinge on them. */
export function stripSeparators(s: string): string {
  return s.replace(/[·•∙]/g, ' ');
}

/**
 * True iff the recent pane output indicates an active server-side throttle that
 * we should own: throttle string present, NOT a usage-limit, and Claude is not
 * currently mid-retry.
 *
 * Caller is responsible for the idle-at-prompt precondition (recency); this
 * function only classifies the text. `captureLines` widens the inspected
 * trailing-line window (default 20) — callers that scan past the input box use
 * RATE_LIMIT_SETTLED_CAPTURE_LINES.
 */
export function detectRateLimited(
  snapshot: string | null | undefined,
  captureLines: number = RATE_LIMIT_CAPTURE_LINES,
): boolean {
  if (!snapshot) return false;
  const recent = stripSeparators(
    snapshot.split('\n').slice(-captureLines).join('\n'),
  );
  // Still retrying internally → framework owns it.
  if (RETRY_SPINNER_PATTERN.test(recent)) return false;
  // Must look like the throttle.
  if (!THROTTLE_PATTERNS.some(p => p.test(recent))) return false;
  // Must NOT be the user's plan quota.
  if (USAGE_LIMIT_PATTERNS.some(p => p.test(recent))) return false;
  return true;
}

/**
 * A stable fingerprint of the recent pane, used to decide whether the session
 * is *settled* (turn ended) vs still producing work. Trailing whitespace is
 * stripped per line so cursor/animation jitter doesn't read as a change.
 */
export function throttleSignature(
  snapshot: string,
  captureLines: number = RATE_LIMIT_SETTLED_CAPTURE_LINES,
): string {
  return snapshot
    .split('\n')
    .slice(-captureLines)
    .map(l => l.replace(/\s+$/g, ''))
    .join('\n');
}

export type ThrottleSettleDecision = 'no-throttle' | 'waiting' | 'settled';

/** Per-session settle tracking: the last poll's pane fingerprint + when it first appeared. */
export interface ThrottleSettleState {
  sig: string;
  since: number;
}

/**
 * Decide whether a session is genuinely stuck on a *settled* server throttle.
 *
 * The key insight that makes this robust where the old gates failed: an
 * actively-working Claude session animates its spinner and elapsed-timer every
 * tick, so byte-identical pane output across two consecutive polls means NO
 * work is being produced — the turn has ended on the throttle. This needs no
 * process-tree inspection (a lingering background shell used to mask the
 * throttle) and no at-prompt heuristic (the input box used to hide the error).
 *
 * Pure + clock-injected so all timing is unit-testable without real timers.
 *  - 'no-throttle': throttle absent / mid-retry / usage-limit → caller clears tracking.
 *  - 'waiting'    : throttle present but pane changed since last poll, or not settled long enough.
 *  - 'settled'    : throttle present and pane unchanged ≥ settleMs → caller hands to recovery.
 */
export function evaluateThrottleSettle(
  snapshot: string | null | undefined,
  prev: ThrottleSettleState | undefined,
  now: number,
  opts?: { settleMs?: number; captureLines?: number },
): { decision: ThrottleSettleDecision; next: ThrottleSettleState | undefined } {
  const captureLines = opts?.captureLines ?? RATE_LIMIT_SETTLED_CAPTURE_LINES;
  const settleMs = opts?.settleMs ?? RATE_LIMIT_DEFAULT_SETTLE_MS;

  if (!detectRateLimited(snapshot, captureLines)) {
    return { decision: 'no-throttle', next: undefined };
  }
  const sig = throttleSignature(snapshot as string, captureLines);
  if (!prev || prev.sig !== sig) {
    // First sighting, or the pane changed since last poll → (re)start the settle clock.
    return { decision: 'waiting', next: { sig, since: now } };
  }
  if (now - prev.since >= settleMs) {
    return { decision: 'settled', next: prev };
  }
  return { decision: 'waiting', next: prev };
}

export type IdleThrottleAction = 'emit' | 'wait' | 'fall-through';

/**
 * The SessionManager idle-monitor's SETTLE-GATED decision for a session whose recent
 * output already matched a throttle string. Today the idle path emits `rateLimitedAtIdle`
 * on that single glance — which false-fires on a transient throttle that has already
 * cleared, or a throttle line still scrolled in the buffer of a session that has since
 * moved on. This re-checks the settled-lines window with the SAME discipline the
 * SessionWatchdog already uses (`evaluateThrottleSettle`: throttle present AND pane
 * byte-identical across polls = the turn genuinely ended on the throttle), and returns:
 *   - 'emit'         : settled → hand to recovery now (clear tracking).
 *   - 'wait'         : throttle present but pane still changing / not settled long enough
 *                      → recheck next idle tick, do NOT emit yet (carry `nextState`).
 *   - 'fall-through' : no throttle in the settled window → not a current throttle; clear
 *                      tracking and let the caller continue to its generic-error check.
 *
 * Pure + clock-injected (no tmux) so the new decision is fully unit-testable. STRICTLY
 * more conservative than the legacy immediate emit — it can only ever emit LESS often,
 * never more — so it cannot create a recovery it didn't already make. Gated behind the
 * dark `monitoring.idleThrottleSettleGate` flag; the deeper redesign (unifying the idle +
 * watchdog detection paths, and distinguishing an active-tail throttle from old
 * scrollback) stays a tracked follow-up.
 */
export function nextIdleThrottleAction(
  snapshot: string | null | undefined,
  prev: ThrottleSettleState | undefined,
  now: number,
  opts?: { settleMs?: number; captureLines?: number },
): { action: IdleThrottleAction; nextState: ThrottleSettleState | undefined } {
  const { decision, next } = evaluateThrottleSettle(snapshot, prev, now, opts);
  if (decision === 'settled') return { action: 'emit', nextState: undefined };
  if (decision === 'waiting') return { action: 'wait', nextState: next };
  return { action: 'fall-through', nextState: undefined }; // 'no-throttle'
}

// ── Usage wall (the account's own plan quota) ───────────────────────────────
//
// A server throttle (above) clears by itself in seconds; a usage wall does not
// clear until the account's window resets — hours or days. They need different
// remedies: the throttle is retried in place, the wall is solved by moving the
// session to another subscription account that still has room. So the wall is
// its own signal, never folded into the throttle decision.

/**
 * Strong usage-wall phrasing: the banner Claude Code prints when the account
 * itself is out of quota. Deliberately narrower than USAGE_LIMIT_PATTERNS (which
 * only has to VETO a throttle reading): a bare "resets 8am" can appear in
 * ordinary output, so it never counts as a wall on its own here.
 *
 * Taken from real panes: "You've hit your weekly limit · resets Nov 6",
 * "Usage limit reached · limit resets 8am" (Claude Code 2.1.300, 2026-11-04
 * incident, feedback fb-d2862f4d-b52), "Session limit reached ∙ resets 10:30pm"
 * (2026-06-05 incident), "/extra-usage to finish what you're working on".
 *
 * ANCHORED to the banner's shape: the phrase must OPEN the line (after
 * indentation, an optional result/bullet glyph and an optional "API Error:"),
 * so a session that merely prints or quotes the words mid-line (grep output,
 * a spec, a test) does not read as walled. Not a proof — a file whose first
 * line is the banner text, cat'ed as the last thing on screen, still matches;
 * the rescue therefore corroborates every wall against the account's own
 * quota reading before acting (UsageWallRescue).
 */
const BANNER_LEAD = String.raw`^\s*(?:[⎿●⏺✗⚠]\s*)?(?:api error:\s*)?`;
export const USAGE_WALL_PATTERNS: RegExp[] = [
  new RegExp(BANNER_LEAD + String.raw`you've hit your (?:session |weekly |opus |sonnet |usage )?limit`, 'i'),
  new RegExp(BANNER_LEAD + String.raw`usage limit reached\b`, 'i'),
  new RegExp(BANNER_LEAD + String.raw`(?:session|weekly|opus|sonnet) limit reached\b`, 'i'),
  new RegExp(BANNER_LEAD + String.raw`/extra-usage to finish`, 'i'),
  // Claude Code 2.1.3xx (2026-11-10, fb-f8b946ae-597) renamed the companion
  // hint: "/usage-credits to finish what you’re working on."
  new RegExp(BANNER_LEAD + String.raw`/usage-credits to finish`, 'i'),
];

/** The banner phrasing without the line anchor, for text that is known to be
 * the provider's own message (a transcript API-error row), never pane prose. */
export const USAGE_WALL_TEXT_PATTERN =
  /(?:you['’]?ve|you have) (?:hit|reached) your (?:(?:session|weekly|opus|sonnet|usage|5-hour) )?limit\b|(?:session|weekly|opus|sonnet|usage|5-hour) limit\s*(?:(?:has been )?reached\b|[·•∙,]\s*resets\b)|\/(?:extra-usage|usage-credits) to finish\b/i;

/**
 * Terminal furniture that Claude Code draws BELOW its last real output: the
 * auto-continue notice, the input box, the permission-mode status line, the
 * shortcuts hint, box rules, an empty prompt. None of it is the session doing
 * work, so none of it may count as "the session moved on past the banner".
 *
 * Counting these as real output is exactly the fb-d2862f4d-b52 defect: after
 * "Usage limit reached · limit resets 8am" the pane shows "Continuing
 * automatically at 8am · esc to cancel · /usage-credits to continue now" and the
 * "⏵⏵ bypass permissions on (shift+tab to cycle)" line — two lines, which the
 * old recovery heuristic read as two lines of fresh work.
 */
export const PANE_CHROME_PATTERNS: RegExp[] = [
  // Each pattern is ANCHORED to a whole chrome row (matched against the trimmed
  // line), so ordinary prose that merely mentions these words ("I reviewed how
  // to upgrade your plan") stays session output.
  // "Continuing automatically at 8am · esc to cancel · /usage-credits to continue now"
  /^continuing automatically at [^·•∙]+?(?:\s*[·•∙]\s*(?:esc to cancel|\/usage-credits to continue now|\/extra-usage to continue now))*\s*$/i,
  // a bare slash-command hint row, nothing else on it
  /^\/(?:extra-usage|usage-credits|upgrade)\s*$/i,
  // the limit menu
  /^(?:[❯>]\s*)?\d+\.\s+(?:stop and wait for limit to reset|switch to extra usage|upgrade your plan)\s*$/i,
  // the permission-mode status row, optionally with its trailing hints
  // ("⏵⏵ bypass permissions on · 7 shells · ↓ to manage", 2026-11-10)
  /^(?:⏵⏵\s*)?(?:bypass permissions|accept edits|plan mode) on(?:\s*\(shift\+tab to cycle\))?(?:\s*[·•∙]\s*(?:esc to interrupt|ctrl\+t to (?:hide|show) tasks|\? for shortcuts|\d+ (?:shells?|background tasks?|agents?|tasks?)|↓ to manage))*\s*$/i,
  // the usage-credits promotion row under the wall banner:
  // "Usage credits are at least 30% off for one purchase · 14 days left · /usage-credits"
  /^usage credits are [^\n]*[·•∙]\s*\/(?:usage-credits|extra-usage)\s*$/i,
  // the finished-turn row: "✻ Baked for 3s · done 7:56 AM · 7 shells still running"
  // (one capitalised verb, a duration, then only known hint segments)
  /^[✻✽✶✳✢]\s+[A-Z][a-z]+\s+for\s+\d+[hms](?:\s+\d+[hms]){0,2}(?:\s*[·•∙]\s*(?:done \d{1,2}:\d{2}\s*(?:[AaPp][Mm])?|\d+ (?:shells?|background tasks?|agents?|tasks?) still running))*\s*$/,
  // the self-update notice: "✔ Update installed · Restart to update"
  /^[✔✓]\s*update installed(?:\s*[·•∙]\s*restart to update)?\s*$/i,
  /^\?\s+for shortcuts\s*$/i,
  /^context left until auto-compact:?\s*\d+%\s*$/i,
  /^[\s│|╭╮╰╯─━═┃┌┐└┘_-]*$/,                                           // box rules, borders, blank-ish rows
  /^[\s│|]*(?:❯|>)\s*[│|]?\s*$/,                                       // the empty input prompt (boxed or bare)
  /^[\s│|]*⎿\s*$/,                                                      // empty tool-result connector
];

/** True when a pane line is Claude Code's own chrome, not session output. */
export function isPaneChromeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  return PANE_CHROME_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * A background-agent row of Claude Code's task list:
 * "◯ general-purpose  Pushing side-effects artifact commit upstream  1h 8m 2s · ↓ 312.5k tokens".
 * Anchored on the status glyph, the column gaps and the trailing elapsed timer
 * (+ optional token count) — the timer ticks every second, which is why these
 * rows must count as chrome AND why the wall's settle signature must not
 * include them.
 */
export const BACKGROUND_AGENT_ROW =
  /^[◯○◉●◐◑◒◓◌✓✔✗⏸]\s+[\w.-]+\s{2,}\S.*?\s{2,}\d+[hms](?:\s+\d+[hms]){0,2}(?:\s*[·•∙]\s*[↓↑]\s*[\d.,]+[kKmM]?\s+tokens)?\s*$/;

/** The "⏺ main" header that tops the task list. Only chrome when a
 * background-agent row follows it: on its own it is indistinguishable from an
 * assistant reply that is the single word "main". */
const TASK_LIST_HEADER = /^⏺\s+main$/;

/** Chrome check for line `i` of `lines`, with the context-dependent rows. */
function isChromeAt(lines: string[], i: number): boolean {
  if (isPaneChromeLine(lines[i])) return true;
  const trimmed = lines[i].trim();
  if (BACKGROUND_AGENT_ROW.test(trimmed)) return true;
  if (TASK_LIST_HEADER.test(trimmed)) {
    return lines.slice(i + 1).some((l) => BACKGROUND_AGENT_ROW.test(l.trim()));
  }
  return false;
}

/**
 * Remove a right-hand side panel (Claude Code's diff / file view) from pane
 * lines. The panel draws a vertical rule "│" at the SAME column on most rows
 * and fills the space after it with its own text, so every row of a walled
 * pane carried diff text and nothing read as chrome (fb-f8b946ae-597).
 *
 * Detection is structural, not textual: a column ≥ 20 where at least 5 rows
 * and 40% of the non-blank rows carry "│". Each row is cut at its rule (±2
 * columns, for a wide glyph earlier on the row). Rows without the rule are
 * kept whole. A boxed input prompt ("│ > │") has its rules at the edges of a
 * short box, which never reaches the threshold on a real pane.
 */
export function stripSidePanel(lines: string[]): string[] {
  const counts = new Map<number, number>();
  let nonBlank = 0;
  for (const line of lines) {
    if (line.trim()) nonBlank += 1;
    const seen = new Set<number>();
    for (let i = line.indexOf('│'); i >= 0; i = line.indexOf('│', i + 1)) {
      if (i >= 20 && !seen.has(i)) { seen.add(i); counts.set(i, (counts.get(i) ?? 0) + 1); }
    }
  }
  let col = -1;
  let best = 0;
  for (const [c, n] of counts) if (n > best) { best = n; col = c; }
  if (col < 0 || best < 5 || best < nonBlank * 0.4) return lines;
  return lines.map((line) => {
    for (let i = Math.max(0, col - 2); i <= col + 2 && i < line.length; i++) {
      if (line[i] === '│') return line.slice(0, i).replace(/\s+$/, '');
    }
    return line;
  });
}

/** The inspected window, side panel removed. */
function wallWindow(snapshot: string, captureLines: number): string[] {
  return stripSidePanel(snapshot.split('\n').slice(-captureLines));
}

/** Index of the last usage-wall banner line in `lines`, or -1. */
function lastBannerIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (USAGE_WALL_PATTERNS.some((p) => p.test(lines[i]))) return i;
  }
  return -1;
}

/** A retry spinner after the banner means the framework is still moving.
 * Checked on RAW lines, before chrome is dropped ("Retrying in 10s · esc to
 * cancel" must veto, not be filtered away as chrome). */
function retryingAfter(lines: string[], idx: number): boolean {
  return lines.slice(idx + 1).some((l) => RETRY_SPINNER_PATTERN.test(stripSeparators(l)));
}

/** Rows of context above the banner that make up the wall's settle signature. */
const WALL_SIGNATURE_CONTEXT_ROWS = 15;

/**
 * True iff a usage-wall banner is the CURRENT state of the pane: the last
 * banner line in the inspected window is followed only by chrome, never by
 * any session output. A session that walled earlier and has since resumed is
 * not walled. Recovery uses this pane signal with its existing settle window.
 */
export function detectUsageWall(
  snapshot: string | null | undefined,
  captureLines: number = RATE_LIMIT_SETTLED_CAPTURE_LINES,
): boolean {
  if (!snapshot) return false;
  const lines = wallWindow(snapshot, captureLines);
  const idx = lastBannerIndex(lines);
  if (idx < 0) return false;
  if (retryingAfter(lines, idx)) return false;
  for (let i = idx + 1; i < lines.length; i++) {
    if (!isChromeAt(lines, i)) return false;
  }
  return true;
}

/** A row of model output (a reply or a tool call): "⏺ …" (drawn "● …" on some terminals). */
const MODEL_OUTPUT_ROW = /^\s*[⏺●]\s/;

/**
 * Weaker pane signal, used only together with the exact session's transcript:
 * a usage-wall banner is in the inspected window, no retry spinner follows it,
 * and no model output (a "⏺" reply or tool-call row, other than the task-list
 * header) follows it. Unknown chrome rows after the banner are tolerated —
 * the transcript (its latest main-turn row is the provider's wall error) is
 * what establishes that the session stopped at the wall. The model-output
 * veto keeps a resumed session whose transcript id is still the old, walled
 * one from reading as walled under a replayed banner.
 */
export function paneShowsUsageWallBanner(
  snapshot: string | null | undefined,
  captureLines: number = RATE_LIMIT_SETTLED_CAPTURE_LINES,
): boolean {
  if (!snapshot) return false;
  const lines = wallWindow(snapshot, captureLines);
  const idx = lastBannerIndex(lines);
  if (idx < 0 || retryingAfter(lines, idx)) return false;
  for (let i = idx + 1; i < lines.length; i++) {
    if (MODEL_OUTPUT_ROW.test(lines[i]) && !isChromeAt(lines, i)) return false;
  }
  return true;
}

/**
 * Settle fingerprint for a wall: the banner row and the rows above it (side
 * panel removed), never the chrome below it. Background-agent timers and the
 * shell counter tick every second below the banner, so a whole-pane
 * fingerprint never stays byte-identical and the wall could never settle.
 * Anything that is real session output after the banner already fails
 * detection, so excluding the tail loses nothing.
 */
export function usageWallSignature(
  snapshot: string,
  captureLines: number = RATE_LIMIT_SETTLED_CAPTURE_LINES,
): string {
  const lines = wallWindow(snapshot, captureLines);
  const idx = lastBannerIndex(lines);
  if (idx < 0) return throttleSignature(snapshot, captureLines);
  return lines
    .slice(Math.max(0, idx - WALL_SIGNATURE_CONTEXT_ROWS), idx + 1)
    .map((l) => l.replace(/\s+$/g, ''))
    .join('\n');
}

/** Current usage-banner signal for courtesy notices. Claude also renders real
 * provider errors with a tool-result connector, so that connector alone cannot
 * establish ownership. Only finished-turn chrome may follow the banner; the
 * consumer must corroborate ownership with the exact serving-session transcript. */
export function currentUsageLimitBanner(snapshot: string | null | undefined): string | null {
  if (!snapshot) return null;
  const lines = wallWindow(snapshot, RATE_LIMIT_SETTLED_CAPTURE_LINES);
  const banner = new RegExp(String.raw`^\s*(?:[●⏺✗⚠⎿]\s*)?(?:api error:\s*)?(?:` + USAGE_WALL_TEXT_PATTERN.source + ')', 'i');
  const finished = /^[✻✽✶✳✢]\s+\S+ for \d[^\n]*$/;
  let found: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (banner.test(line)) {
      // Extra-usage is a companion hint, not a replacement for the banner's
      // reset time. Preserve both when the framework prints both rows.
      found = found ? `${found}\n${line}` : line;
      continue;
    }
    if (found && !isChromeAt(lines, i) && !finished.test(line.trim())) found = null;
  }
  return found;
}

/**
 * Settle decision for a usage wall, same discipline as evaluateThrottleSettle:
 * the wall must be the current state AND its banner region must stay
 * byte-identical for `settleMs` before the wall is reported, so a single
 * glance at a pane that is about to move on never fires.
 *
 * The wall is current when either
 *  - the pane alone shows it (banner followed only by chrome), or
 *  - `transcriptConfirmed`: the exact session's own transcript ends on the
 *    provider's usage-wall error AND the pane still shows the banner (no retry
 *    spinner after it). This is the robust path: it survives Claude Code
 *    layouts whose rows the chrome list does not know yet.
 *
 * The signature covers the banner and the rows above it only, so ticking
 * timer rows below the banner never restart the settle clock.
 */
export function evaluateUsageWallSettle(
  snapshot: string | null | undefined,
  prev: ThrottleSettleState | undefined,
  now: number,
  opts?: { settleMs?: number; captureLines?: number; transcriptConfirmed?: boolean },
): { decision: ThrottleSettleDecision; next: ThrottleSettleState | undefined } {
  const captureLines = opts?.captureLines ?? RATE_LIMIT_SETTLED_CAPTURE_LINES;
  const settleMs = opts?.settleMs ?? RATE_LIMIT_DEFAULT_SETTLE_MS;
  const present = detectUsageWall(snapshot, captureLines)
    || (opts?.transcriptConfirmed === true && paneShowsUsageWallBanner(snapshot, captureLines));
  if (!present) {
    return { decision: 'no-throttle', next: undefined };
  }
  const sig = usageWallSignature(snapshot as string, captureLines);
  if (!prev || prev.sig !== sig) return { decision: 'waiting', next: { sig, since: now } };
  if (now - prev.since >= settleMs) return { decision: 'settled', next: prev };
  return { decision: 'waiting', next: prev };
}

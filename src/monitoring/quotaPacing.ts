/**
 * quotaPacing — the pure forecast behind GET /quota-pacing (docs/specs/quota-pacing-forecast.md §2).
 *
 * Pure functions over quota-history rows plus an explicit `now`. No I/O and no clock reads, so
 * every boundary is unit-testable. Signal only: nothing in this step reads a verdict to decide.
 *
 *   - window validity and the shared 5-minute reset tolerance
 *   - arrival-order eligibility (an old usage-file reading arriving after a live one is kept for
 *     audit but never enters a rate), identity partitioning (a rebound slot never mixes logins)
 *   - cycle / rate-segment detection, the fixed-window (rolling-suspected) check, the early-drop
 *     segment break (a provider credit never reads as negative burn)
 *   - least-squares slopes (6h / 24h / segment, each with a minimum span), central/low/high
 *     projections (uncapped internally, capped only for display)
 *   - freshness with a reason, the three-scenario 168-hour provider runway with placement groups
 *     and persistent unserved demand, verdicts with fixed precedence and plain wording
 *   - calibration replay with a polledAt knowledge cutoff and censored outcomes
 *   - peer-summary validation and the per-login merge used by the pool view
 *
 * Unknown is never zero: missing, stale, synthesized, out-of-order and invalid inputs surface as
 * `null` / `unknown` / `cannot-tell` with a reason.
 */
import { createHash } from 'node:crypto';

// ── Constants (one block; the 85 and 50 display lines are advisory and tunable) ─────────────

export const HOUR_MS = 3_600_000;
export const PACING = {
  /** Two resetsAt values within this distance are the same reset (Codex drifts 1-2 s per read). */
  RESET_TOLERANCE_MS: 5 * 60_000,
  /** A measuredAt more than this far after polledAt is clamped to polledAt. */
  FUTURE_CLAMP_MS: 5 * 60_000,
  /** Fixed spacing bucket for history rows. */
  BUCKET_MS: 5 * 60_000,
  /** A drop of more than this many points with no reset move starts a new rate segment. */
  EARLY_DROP_POINTS: 2,
  /** More than this many forward reset moves inside one cycle marks the window rolling-suspected. */
  ROLLING_MOVES_MAX: 3,
  SLOPE_6H: { windowH: 6, minRows: 3, minSpanH: 2 },
  SLOPE_24H: { windowH: 24, minRows: 3, minSpanH: 12 },
  SLOPE_SEGMENT: { minRows: 3, minSpanH: 12 },
  /** Fresh = newest valid row read and measured within this many read intervals. */
  FRESH_INTERVALS: 3,
  /** Account verdict line: a central forecast under this leaves quota unused (display only). */
  UNUSED_LINE: 85,
  /** Provider verdict line: a pessimistic lowest point under this is tight (half one account). */
  TIGHT_LINE: 50,
  /** Runway horizon: one weekly window. */
  HORIZON_H: 168,
  /** Calibration replays the forecast as it stood this long before each reset. */
  CALIBRATION_LEAD_H: 24,
  /** Two machines measuring the same login within this window and this far apart disagree. */
  DISAGREE_WINDOW_MS: 15 * 60_000,
  DISAGREE_POINTS: 5,
  /** A peer whose polledAt is further than this ahead of our clock is ignored for that login. */
  CLOCK_AHEAD_MS: 5 * 60_000,
  WINDOW_HOURS: { fiveHour: 5, sevenDay: 168, fable: 168 } as Record<WindowKey, number>,
} as const;

export const QUOTA_PACING_SCHEMA = 'quota-pacing/1';
export const ACCOUNT_ID_RE = /^[a-z0-9-]+$/;
export const BASIS = 'weekly window only';

// ── Types ─────────────────────────────────────────────────────────────────────

export type WindowKey = 'fiveHour' | 'sevenDay' | 'fable';
export type ForecastWindowKey = 'sevenDay' | 'fable';
export type OutcomeKind = 'signed-out' | 'read-failing';
export type Resolution = 'full' | 'hourly' | 'cycle-end';

export interface HistoryWindow {
  /** null when the window was invalid (no/expired reset) or the provider sent no percentage. */
  pct: number | null;
  resetsAt: string | null;
  invalid?: true;
}

export interface HistoryRow {
  v: 1;
  polledAt: string;
  /** null on an outcome (failed-read) row. */
  measuredAt: string | null;
  measuredAtSynthesized?: true;
  identity: string | null;
  source: string | null;
  drifted: boolean;
  windows: Partial<Record<WindowKey, HistoryWindow>>;
  noQuotaWindow?: true;
  /** Present on a failed-read row; such a row carries no percentages. */
  outcome?: OutcomeKind;
  /** Absent = full resolution. Set by compaction. */
  resolution?: Resolution;
}

export interface Slope { pctPerHour: number; spanH: number; rows: number }
export type SlopeName = '6h' | '24h' | 'segment';

export interface WindowForecast {
  window: ForecastWindowKey;
  /** Current-segment usage (the newest accepted reading), null when unknown. */
  used: number | null;
  resetsAt: string | null;
  hoursLeft: number | null;
  slopes: { h6: Slope | null; h24: Slope | null; segment: Slope | null };
  /** Uncapped projections; may exceed 100 or fall below `used`. */
  central: number | null;
  low: number | null;
  high: number | null;
  lowBasis: SlopeName | null;
  highBasis: SlopeName | null;
  /** Pace used by the central forecast (24h slope, else whole segment). */
  pace: number | null;
  rollingSuspected: boolean;
  outOfOrderRows: number;
  /** True when a slope used compacted (hourly) rows. */
  usesHourlyRows: boolean;
  /** Why the forecast is unknown, when it is. */
  reason: string | null;
}

// ── Small helpers ─────────────────────────────────────────────────────────────

export const parseMs = (s: string | null | undefined): number => (typeof s === 'string' && s ? Date.parse(s) : NaN);
const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Two reset times count as the same reset when within the shared tolerance. */
export function sameReset(a: number, b: number): boolean {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= PACING.RESET_TOLERANCE_MS;
}

/** A window is valid when it has a finite percentage and a parseable reset after `polledAtMs`. */
export function isWindowValid(w: HistoryWindow | undefined | null, polledAtMs: number): w is HistoryWindow & { pct: number; resetsAt: string } {
  if (!w || w.invalid || !fin(w.pct)) return false;
  const r = parseMs(w.resetsAt);
  return Number.isFinite(r) && r > polledAtMs;
}

/** Normalise a raw provider window into a stored history window (invalid → pct null). */
export function toHistoryWindow(raw: { utilizationPct?: unknown; resetsAt?: unknown } | undefined, polledAtMs: number, pctUnknown = false): HistoryWindow | undefined {
  if (!raw) return undefined;
  const resetsAt = typeof raw.resetsAt === 'string' && raw.resetsAt ? raw.resetsAt : null;
  const w: HistoryWindow = { pct: pctUnknown ? null : (fin(raw.utilizationPct) ? raw.utilizationPct : null), resetsAt };
  if (!isWindowValid(w, polledAtMs)) return { pct: null, resetsAt, invalid: true };
  return w;
}

/**
 * The login identity key: provider plus the first 16 hex chars of SHA-256 of the lower-cased,
 * provider-attested email. The email itself is never stored. null when there is no usable email.
 */
export function identityKey(provider: string, email: string | null | undefined): string | null {
  if (typeof email !== 'string') return null;
  const display = email.trim();
  if (!display || display.length > 254 || display.split('@').length !== 2 || display.startsWith('@') || display.endsWith('@')) return null;
  return `${provider}:${createHash('sha256').update(display.toLowerCase()).digest('hex').slice(0, 16)}`;
}

/** Plain UTC time for wording, e.g. "Wed 18 Nov 06:38 UTC". */
export function fmtWhen(ms: number): string {
  if (!Number.isFinite(ms)) return 'an unknown time';
  const d = new Date(ms);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day} ${d.getUTCDate()} ${mon} ${hh}:${mm} UTC`;
}

export const displayPct = (n: number | null): number | null => (n === null ? null : Math.max(0, Math.min(100, Math.round(n))));

// ── Eligibility, partitioning and segmentation ───────────────────────────────

interface Point { t: number; pct: number; resetsAt: number; hourly: boolean }

export interface Segmentation {
  /** Accepted points of the current rate segment, sorted by measuredAt. */
  segment: Point[];
  /** Reset of the current cycle (ms), NaN when unknown. */
  resetsAt: number;
  /** The current cycle was closed by an invalid window with no valid reading since. */
  closedByInvalid: boolean;
  rollingSuspected: boolean;
  outOfOrderRows: number;
  /** Completed cycles: their reset and last valid reading (used for calibration). */
  cycleEnds: Array<{ resetsAt: number; last: Point; startedAt: number }>;
  /** Start of the current cycle's first accepted point (ms). */
  cycleStartedAt: number;
}

/** Rows in arrival order (polledAt, stable). */
function byArrival(rows: readonly HistoryRow[]): HistoryRow[] {
  return rows
    .map((r, i) => ({ r, i, p: parseMs(r.polledAt) }))
    .filter((x) => Number.isFinite(x.p))
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .map((x) => x.r);
}

/** Keep only rows of one login (exact identity match, null included). */
export function partitionByIdentity(rows: readonly HistoryRow[], identity: string | null): HistoryRow[] {
  return rows.filter((r) => (r.identity ?? null) === identity);
}

/**
 * Walk one window's rows in arrival order and cut them into cycles and rate segments.
 * Eligibility is decided in arrival order: a reading whose measuredAt is not later than the
 * newest accepted measuredAt is excluded and counted out-of-order. A synthesized measuredAt
 * never enters a rate. An invalid window closes the current cycle.
 */
export function segmentWindow(rows: readonly HistoryRow[], window: ForecastWindowKey): Segmentation {
  const halfWindowMs = (PACING.WINDOW_HOURS[window] / 2) * HOUR_MS;
  let newest = -Infinity;
  let outOfOrder = 0;
  let cycle: Point[] = [];
  let segment: Point[] = [];
  let resetsAt = NaN;
  let closedByInvalid = false;
  let forwardMoves = 0;
  let rolling = false;
  let cycleStartedAt = NaN;
  const cycleEnds: Segmentation['cycleEnds'] = [];

  const closeCycle = () => {
    const last = cycle[cycle.length - 1];
    if (last) cycleEnds.push({ resetsAt: last.resetsAt, last, startedAt: cycle[0].t });
    cycle = [];
    segment = [];
    forwardMoves = 0;
    rolling = false;
    cycleStartedAt = NaN;
  };

  for (const r of byArrival(rows)) {
    if (r.outcome) continue; // failed reads carry no percentages
    const w = r.windows?.[window];
    if (!w) continue;
    const polled = parseMs(r.polledAt);
    if (!isWindowValid(w, polled)) {
      // An invalid window closes the current cycle with usage unknown until the next valid reading.
      if (cycle.length > 0) closeCycle();
      resetsAt = NaN;
      closedByInvalid = true;
      continue;
    }
    if (r.measuredAtSynthesized) continue; // age unknown: never enters a rate
    const t = parseMs(r.measuredAt);
    if (!Number.isFinite(t)) continue;
    if (t <= newest) { outOfOrder++; continue; }
    newest = t;
    const p: Point = { t, pct: w.pct, resetsAt: parseMs(w.resetsAt), hourly: r.resolution === 'hourly' };
    closedByInvalid = false;
    if (cycle.length === 0) {
      cycle = [p]; segment = [p]; resetsAt = p.resetsAt; cycleStartedAt = p.t;
      continue;
    }
    const prev = cycle[cycle.length - 1];
    const delta = p.resetsAt - prev.resetsAt;
    if (delta > halfWindowMs) {
      closeCycle();
      cycle = [p]; segment = [p]; resetsAt = p.resetsAt; cycleStartedAt = p.t;
      continue;
    }
    if (delta > PACING.RESET_TOLERANCE_MS) {
      // A fixed weekly window keeps its reset; a reset that keeps creeping forward is a rolling window.
      forwardMoves++;
      if (forwardMoves > PACING.ROLLING_MOVES_MAX) rolling = true;
    }
    cycle.push(p);
    resetsAt = p.resetsAt;
    if (sameReset(p.resetsAt, prev.resetsAt) && prev.pct - p.pct > PACING.EARLY_DROP_POINTS) {
      segment = [p]; // early provider reset or a credit: a new rate segment, never negative burn
    } else {
      segment.push(p);
    }
  }
  return { segment, resetsAt, closedByInvalid, rollingSuspected: rolling, outOfOrderRows: outOfOrder, cycleEnds, cycleStartedAt };
}

// ── Slopes and projections ────────────────────────────────────────────────────

/** Ordinary least squares slope in points per hour; null below the minimum rows or span. */
export function leastSquaresSlope(points: ReadonlyArray<{ t: number; pct: number }>, minRows: number, minSpanH: number): Slope | null {
  if (points.length < minRows) return null;
  const t0 = points[0].t;
  const xs = points.map((p) => (p.t - t0) / HOUR_MS);
  const span = Math.max(...xs) - Math.min(...xs);
  if (span < minSpanH) return null;
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = points.reduce((a, p) => a + p.pct, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (points[i].pct - my); den += (xs[i] - mx) ** 2; }
  if (den === 0) return null;
  return { pctPerHour: num / den, spanH: span, rows: n };
}

export interface ForecastOptions { now: number }

/** Forecast one window of one login from its (identity-partitioned) rows. */
export function forecastWindow(rows: readonly HistoryRow[], window: ForecastWindowKey, opts: ForecastOptions): WindowForecast {
  const { now } = opts;
  const seg = segmentWindow(rows, window);
  const base: WindowForecast = {
    window, used: null, resetsAt: null, hoursLeft: null,
    slopes: { h6: null, h24: null, segment: null },
    central: null, low: null, high: null, lowBasis: null, highBasis: null, pace: null,
    rollingSuspected: seg.rollingSuspected, outOfOrderRows: seg.outOfOrderRows, usesHourlyRows: false, reason: null,
  };
  if (seg.closedByInvalid || seg.segment.length === 0) return { ...base, reason: seg.closedByInvalid ? 'window-invalid' : 'no-readings' };
  const reset = seg.resetsAt;
  if (!Number.isFinite(reset) || reset <= now) return { ...base, reason: 'reset-passed' };
  const latest = seg.segment[seg.segment.length - 1];
  const hoursLeft = (reset - now) / HOUR_MS;
  const inLast = (h: number) => seg.segment.filter((p) => p.t >= now - h * HOUR_MS && p.t <= now);
  const p6 = inLast(PACING.SLOPE_6H.windowH);
  const p24 = inLast(PACING.SLOPE_24H.windowH);
  const h6 = leastSquaresSlope(p6, PACING.SLOPE_6H.minRows, PACING.SLOPE_6H.minSpanH);
  const h24 = leastSquaresSlope(p24, PACING.SLOPE_24H.minRows, PACING.SLOPE_24H.minSpanH);
  const segment = leastSquaresSlope(seg.segment.filter((p) => p.t <= now), PACING.SLOPE_SEGMENT.minRows, PACING.SLOPE_SEGMENT.minSpanH);
  const usesHourlyRows = (h24 !== null && p24.some((p) => p.hourly)) || (segment !== null && seg.segment.some((p) => p.hourly));
  const out: WindowForecast = {
    ...base, used: latest.pct, resetsAt: new Date(reset).toISOString(), hoursLeft: round1(hoursLeft),
    slopes: { h6, h24, segment }, usesHourlyRows,
  };
  if (seg.rollingSuspected) return { ...out, reason: 'rolling-suspected' };
  const pace = h24?.pctPerHour ?? segment?.pctPerHour ?? null;
  if (pace === null) return { ...out, reason: 'not-enough-readings' };
  const known: Array<[SlopeName, number]> = [];
  if (h6) known.push(['6h', h6.pctPerHour]);
  if (h24) known.push(['24h', h24.pctPerHour]);
  if (segment) known.push(['segment', segment.pctPerHour]);
  let lo = known[0], hi = known[0];
  for (const k of known) { if (k[1] < lo[1]) lo = k; if (k[1] > hi[1]) hi = k; }
  const project = (s: number) => latest.pct + s * hoursLeft;
  return {
    ...out, pace,
    central: project(pace), low: project(lo[1]), high: project(hi[1]), lowBasis: lo[0], highBasis: hi[0],
  };
}

// ── Freshness ─────────────────────────────────────────────────────────────────

export type StaleReason = 'benched' | 'signed-out' | 'read-failing' | 'not-polled' | 'identity-drifted' | 'file-only';
export interface Freshness { fresh: boolean; reason: StaleReason | null; newestPolledAt: string | null; newestMeasuredAt: string | null; measuredAtSynthesized: boolean; source: string | null }

export interface FreshnessInput {
  now: number;
  /** Effective read interval: the poll interval, or the backed-off interval while benched. */
  readIntervalMs: number;
  benched: boolean;
  /** Omit during replay to use the drift flag recorded by the last poll at that time. */
  drifted?: boolean;
}

/** Live read sources; a usage-file read (codex-rollout) is not live. */
export const isLiveSource = (s: string | null | undefined) => s === 'oauth-usage-endpoint-fallback' || s === 'codex-app-server' || s === 'claude-code-usage-screen';

/**
 * Fresh only when the newest valid row was both read and measured (not synthesized) within
 * FRESH_INTERVALS × the account's own read interval. Otherwise stale, with a reason.
 */
export function freshness(rows: readonly HistoryRow[], input: FreshnessInput): Freshness {
  const ordered = byArrival(rows);
  const limit = PACING.FRESH_INTERVALS * input.readIntervalMs;
  let newestValid: HistoryRow | null = null;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const r = ordered[i];
    if (r.outcome) continue;
    const p = parseMs(r.polledAt);
    if (isWindowValid(r.windows?.sevenDay, p) || isWindowValid(r.windows?.fable, p) || isWindowValid(r.windows?.fiveHour, p)) { newestValid = r; break; }
  }
  const last = ordered[ordered.length - 1] ?? null;
  const base = {
    newestPolledAt: newestValid?.polledAt ?? null,
    newestMeasuredAt: newestValid?.measuredAt ?? null,
    measuredAtSynthesized: newestValid?.measuredAtSynthesized === true,
    source: newestValid?.source ?? null,
  };
  const stale = (reason: StaleReason): Freshness => ({ fresh: false, reason, ...base });
  if (input.drifted ?? last?.drifted) return stale('identity-drifted');
  const freshRow = newestValid !== null
    && input.now - parseMs(newestValid.polledAt) <= limit
    && !newestValid.measuredAtSynthesized
    && input.now - parseMs(newestValid.measuredAt) <= limit;
  if (freshRow) return { fresh: true, reason: null, ...base };
  if (input.benched) return stale('benched');
  if (last?.outcome === 'signed-out') return stale('signed-out');
  if (last?.outcome === 'read-failing') return stale('read-failing');
  if (!last) return stale('not-polled');
  // Read recently, but what came back is old (a re-read usage file, or a synthesized time).
  if (newestValid && input.now - parseMs(newestValid.polledAt) <= limit) return stale('file-only');
  return stale('not-polled');
}

// ── Account verdicts ──────────────────────────────────────────────────────────

export type AccountVerdict = 'unknown' | 'used-up' | 'will-hit-limit' | 'will-leave-unused' | 'on-track';
export type ProviderVerdict = 'cannot-tell' | 'runs-dry' | 'tight' | 'sustainable';

const STALE_WORDS: Record<StaleReason, string> = {
  benched: 'reads are backed off for this account',
  'signed-out': 'the account is signed out',
  'read-failing': 'reads are failing',
  'not-polled': 'no recent reading',
  'identity-drifted': 'the slot is holding another login',
  'file-only': 'only an old usage file comes back',
};
const UNKNOWN_WORDS: Record<string, string> = {
  'window-invalid': 'the provider sent no current window',
  'no-readings': 'no readings yet',
  'reset-passed': 'the window reset and there is no reading since',
  'rolling-suspected': "this provider's window doesn't behave like a fixed week",
  'not-enough-readings': 'not enough readings to tell',
  'machines-disagree': 'machines disagree',
  'identity-unknown': 'identity unknown',
};

export interface AccountVerdictResult { verdict: AccountVerdict; plain: string; reason: string | null; neutral: boolean }

/** First match wins: unknown → used-up → will-hit-limit → will-leave-unused → on-track. */
export function accountVerdict(f: WindowForecast, fresh: Freshness, provider: ProviderVerdict | null, now: number): AccountVerdictResult {
  const unknown = (reason: string, words: string): AccountVerdictResult => ({ verdict: 'unknown', plain: `can't tell: ${words}`, reason, neutral: true });
  if (!fresh.fresh && fresh.reason) return unknown(fresh.reason, STALE_WORDS[fresh.reason]);
  if (f.reason && f.reason !== 'not-enough-readings') return unknown(f.reason, UNKNOWN_WORDS[f.reason] ?? f.reason);
  const reset = parseMs(f.resetsAt);
  if (f.used !== null && f.used >= 100) {
    return { verdict: 'used-up', plain: `at its limit until ${fmtWhen(reset)}`, reason: null, neutral: provider !== 'runs-dry' };
  }
  if (f.central === null || f.used === null || f.pace === null) return unknown(f.reason ?? 'not-enough-readings', UNKNOWN_WORDS['not-enough-readings']);
  if (f.central >= 100) {
    const at = f.pace > 0 ? now + ((100 - f.used) / f.pace) * HOUR_MS : reset;
    const plain = provider === 'sustainable'
      ? `will reach its limit around ${fmtWhen(at)}; the pool has room`
      : `will reach its limit around ${fmtWhen(at)}, before its reset at ${fmtWhen(reset)}`;
    return { verdict: 'will-hit-limit', plain, reason: null, neutral: provider === 'sustainable' };
  }
  if (f.central < PACING.UNUSED_LINE) {
    const unused = Math.round(100 - f.central);
    const high = displayPct(f.high);
    return { verdict: 'will-leave-unused', plain: `will leave about ${unused}% unused at ${fmtWhen(reset)}; could reach ${high}% at the fastest of the recent paces`, reason: null, neutral: false };
  }
  return { verdict: 'on-track', plain: `on track to use most of its week by ${fmtWhen(reset)}`, reason: null, neutral: true };
}

// ── Calibration replay ────────────────────────────────────────────────────────

export interface CalibrationOutcome {
  resetsAt: string;
  status: 'scored' | 'censored' | 'unavailable' | 'no-forecast';
  actual: number | null;
  central: number | null;
  low: number | null;
  high: number | null;
  error: number | null;
  position: 'inside' | 'below' | 'above' | null;
  width: number | null;
  /** For a censored outcome: how long before the reset the last reading was. */
  lastReadingHoursBefore: number | null;
}
export interface CalibrationSummary {
  outcomes: CalibrationOutcome[];
  scored: number;
  censored: number;
  meanAbsError: number | null;
  inside: number;
  below: number;
  above: number;
  meanWidth: number | null;
}

export const emptyCalibration = (): CalibrationSummary => ({ outcomes: [], scored: 0, censored: 0, meanAbsError: null, inside: 0, below: 0, above: 0, meanWidth: null });

/**
 * Replay the forecast as it stood CALIBRATION_LEAD_H before each completed reset, using only
 * rows with polledAt at or before that moment, and compare with the cycle-end reading. A stale
 * account at replay time yields no forecast. An outcome whose last reading is more than
 * FRESH_INTERVALS × the read interval before the reset is censored. `historyCutAtMs` marks cycles
 * whose replay window is missing as unavailable rather than computed from partial data.
 */
export function calibrate(rows: readonly HistoryRow[], window: ForecastWindowKey, opts: { now: number; readIntervalMs: number; historyCutAtMs?: number | null }): CalibrationSummary {
  const seg = segmentWindow(rows, window);
  const outcomes: CalibrationOutcome[] = [];
  const ends = [...seg.cycleEnds];
  // The newest cycle is complete too once its reset has passed (no reading of the next one yet).
  if (seg.segment.length && Number.isFinite(seg.resetsAt) && seg.resetsAt <= opts.now) {
    ends.push({ resetsAt: seg.resetsAt, last: seg.segment[seg.segment.length - 1], startedAt: seg.cycleStartedAt });
  }
  for (const c of ends) {
    if (!(c.resetsAt <= opts.now)) continue;
    const at = c.resetsAt - PACING.CALIBRATION_LEAD_H * HOUR_MS;
    const blank = { resetsAt: new Date(c.resetsAt).toISOString(), actual: null, central: null, low: null, high: null, error: null, position: null, width: null, lastReadingHoursBefore: null };
    if (opts.historyCutAtMs != null && opts.historyCutAtMs > c.startedAt) { outcomes.push({ ...blank, status: 'unavailable' }); continue; }
    const gap = c.resetsAt - c.last.t;
    if (gap > PACING.FRESH_INTERVALS * opts.readIntervalMs) {
      outcomes.push({ ...blank, status: 'censored', lastReadingHoursBefore: round1(gap / HOUR_MS) });
      continue;
    }
    const known = rows.filter((r) => parseMs(r.polledAt) <= at);
    // A rate can still be calculated from old readings after the account verdict has become unknown.
    // Benching only labels a stale read; the poll's historical drift flag comes from the known rows.
    const asOf = freshness(known, { now: at, readIntervalMs: opts.readIntervalMs, benched: false });
    if (!asOf.fresh) { outcomes.push({ ...blank, actual: c.last.pct, status: 'no-forecast' }); continue; }
    const f = forecastWindow(known, window, { now: at });
    if (f.central === null || !sameReset(parseMs(f.resetsAt), c.resetsAt)) { outcomes.push({ ...blank, actual: c.last.pct, status: 'no-forecast' }); continue; }
    const actual = c.last.pct;
    const low = f.low ?? f.central, high = f.high ?? f.central;
    outcomes.push({
      ...blank, status: 'scored', actual, central: round1(f.central), low: round1(low), high: round1(high),
      error: round1(actual - f.central), position: actual < low ? 'below' : actual > high ? 'above' : 'inside', width: round1(high - low),
    });
  }
  return summariseCalibration(outcomes);
}

export function summariseCalibration(outcomes: CalibrationOutcome[]): CalibrationSummary {
  const scored = outcomes.filter((o) => o.status === 'scored');
  const mean = (xs: number[]) => (xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return {
    outcomes,
    scored: scored.length,
    censored: outcomes.filter((o) => o.status === 'censored').length,
    meanAbsError: mean(scored.map((o) => Math.abs(o.error ?? 0))),
    inside: scored.filter((o) => o.position === 'inside').length,
    below: scored.filter((o) => o.position === 'below').length,
    above: scored.filter((o) => o.position === 'above').length,
    meanWidth: mean(scored.map((o) => o.width ?? 0)),
  };
}

// ── Per-login summaries (what a machine serves at ?scope=local) ──────────────

export type SlotStatus = 'active' | 'warming' | 'rate-limited' | 'needs-reauth' | 'disabled';
export interface WindowSummary extends WindowForecast {
  calibration: CalibrationSummary;
}
export interface LoginSummary {
  identity: string | null;
  accountId: string;
  provider: string;
  framework: string;
  machineId: string;
  drifted: boolean;
  status: SlotStatus;
  readIntervalMs: number;
  sourceKind: 'live' | 'file' | null;
  newestMeasuredAt: string | null;
  measuredAtSynthesized: boolean;
  newestPolledAt: string | null;
  fresh: boolean;
  staleReason: StaleReason | null;
  fiveHour: { used: number | null; resetsAt: string | null } | null;
  sevenDay: WindowSummary | null;
  fable: WindowSummary | null;
}

export interface SummaryInput {
  accountId: string;
  provider: string;
  framework: string;
  machineId: string;
  identity: string | null;
  status: SlotStatus;
  drifted: boolean;
  benched: boolean;
  readIntervalMs: number;
  /** Earliest retained row when the history was cut (droppedRows > 0), else null. */
  historyCutAtMs?: number | null;
}

/** Build one login's summary from its rows on this machine. */
export function summarizeLogin(allRows: readonly HistoryRow[], input: SummaryInput, now: number): LoginSummary {
  const rows = partitionByIdentity(allRows, input.identity);
  const fr = freshness(rows, { now, readIntervalMs: input.readIntervalMs, benched: input.benched, drifted: input.drifted });
  const win = (w: ForecastWindowKey): WindowSummary | null => {
    if (!rows.some((r) => r.windows?.[w])) return null;
    return { ...forecastWindow(rows, w, { now }), calibration: calibrate(rows, w, { now, readIntervalMs: input.readIntervalMs, historyCutAtMs: input.historyCutAtMs ?? null }) };
  };
  let fiveHour: LoginSummary['fiveHour'] = null;
  for (const r of byArrival(rows).reverse()) {
    if (r.outcome || !r.windows?.fiveHour) continue;
    const w = r.windows.fiveHour;
    fiveHour = isWindowValid(w, parseMs(r.polledAt)) ? { used: w.pct, resetsAt: w.resetsAt } : { used: null, resetsAt: null };
    break;
  }
  return {
    identity: input.identity, accountId: input.accountId, provider: input.provider, framework: input.framework, machineId: input.machineId,
    drifted: input.drifted, status: input.status, readIntervalMs: input.readIntervalMs,
    sourceKind: fr.source === null ? null : isLiveSource(fr.source) ? 'live' : 'file',
    newestMeasuredAt: fr.newestMeasuredAt, measuredAtSynthesized: fr.measuredAtSynthesized, newestPolledAt: fr.newestPolledAt,
    fresh: fr.fresh, staleReason: fr.reason, fiveHour,
    sevenDay: win('sevenDay'),
    fable: input.provider === 'anthropic' ? win('fable') : null,
  };
}

// ── Peer summary validation ───────────────────────────────────────────────────

const STATUSES: ReadonlySet<string> = new Set(['active', 'warming', 'rate-limited', 'needs-reauth', 'disabled']);
const STALE_REASONS: ReadonlySet<string> = new Set(Object.keys(STALE_WORDS));
const FORECAST_REASONS: ReadonlySet<string> = new Set(Object.keys(UNKNOWN_WORDS));
const IDENTITY_RE = /^[a-z0-9-]{1,40}:[0-9a-f]{16}$/;
const SLOPE_NAMES: ReadonlySet<string> = new Set(['6h', '24h', 'segment']);

const inRange = (v: unknown, lo: number, hi: number): v is number => fin(v) && v >= lo && v <= hi;
const isoOrNull = (v: unknown): string | null | undefined => (v === null ? null : typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : undefined);
const idOk = (v: unknown, max = 64): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && ACCOUNT_ID_RE.test(v);

function validSlope(v: unknown): Slope | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') return undefined;
  const s = v as Record<string, unknown>;
  if (!inRange(s.pctPerHour, -100, 100) || !inRange(s.spanH, 0, 24 * 60) || !inRange(s.rows, 0, 100_000)) return undefined;
  return { pctPerHour: s.pctPerHour, spanH: s.spanH, rows: Math.round(s.rows) };
}

function validCalibration(v: unknown): CalibrationSummary {
  if (!v || typeof v !== 'object') return emptyCalibration();
  const c = v as Record<string, unknown>;
  const outcomes: CalibrationOutcome[] = [];
  if (Array.isArray(c.outcomes)) {
    for (const raw of c.outcomes.slice(0, 20)) {
      if (!raw || typeof raw !== 'object') continue;
      const o = raw as Record<string, unknown>;
      const resetsAt = isoOrNull(o.resetsAt);
      if (!resetsAt || !['scored', 'censored', 'unavailable', 'no-forecast'].includes(o.status as string)) continue;
      const num = (x: unknown) => (inRange(x, -1000, 1000) ? x : null);
      outcomes.push({
        resetsAt, status: o.status as CalibrationOutcome['status'], actual: num(o.actual), central: num(o.central), low: num(o.low), high: num(o.high),
        error: num(o.error), position: o.position === 'inside' || o.position === 'below' || o.position === 'above' ? o.position : null,
        width: num(o.width), lastReadingHoursBefore: num(o.lastReadingHoursBefore),
      });
    }
  }
  return summariseCalibration(outcomes);
}

function validWindowSummary(v: unknown, window: ForecastWindowKey): WindowSummary | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') return undefined;
  const w = v as Record<string, unknown>;
  const usedOk = w.used === null || inRange(w.used, 0, 100);
  const proj = (x: unknown) => x === null || inRange(x, -100, 1000);
  if (!usedOk || !proj(w.central) || !proj(w.low) || !proj(w.high)) return undefined;
  if (!(w.pace === null || inRange(w.pace, -100, 100))) return undefined;
  if (!(w.hoursLeft === null || inRange(w.hoursLeft, 0, 24 * 60))) return undefined;
  const resetsAt = isoOrNull(w.resetsAt);
  if (resetsAt === undefined) return undefined;
  const sl = (w.slopes && typeof w.slopes === 'object' ? w.slopes : {}) as Record<string, unknown>;
  const h6 = validSlope(sl.h6), h24 = validSlope(sl.h24), segment = validSlope(sl.segment);
  if (h6 === undefined || h24 === undefined || segment === undefined) return undefined;
  const basis = (x: unknown) => (typeof x === 'string' && SLOPE_NAMES.has(x) ? (x as SlopeName) : null);
  return {
    window, used: w.used as number | null, resetsAt, hoursLeft: w.hoursLeft as number | null,
    slopes: { h6, h24, segment },
    central: w.central as number | null, low: w.low as number | null, high: w.high as number | null,
    lowBasis: basis(w.lowBasis), highBasis: basis(w.highBasis), pace: w.pace as number | null,
    rollingSuspected: w.rollingSuspected === true,
    outOfOrderRows: inRange(w.outOfOrderRows, 0, 1e6) ? Math.round(w.outOfOrderRows) : 0,
    usesHourlyRows: w.usesHourlyRows === true,
    reason: typeof w.reason === 'string' && FORECAST_REASONS.has(w.reason) ? w.reason : null,
    calibration: validCalibration(w.calibration),
  };
}

/** Re-validate a peer's login summary. Returns null when anything is out of bounds. */
export function validatePeerSummary(raw: unknown, machineId: string): LoginSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (!idOk(s.accountId)) return null;
  if (!(s.identity === null || (typeof s.identity === 'string' && IDENTITY_RE.test(s.identity)))) return null;
  if (!idOk(s.provider, 40) || !idOk(s.framework, 40)) return null;
  if (typeof s.status !== 'string' || !STATUSES.has(s.status)) return null;
  if (!inRange(s.readIntervalMs, 1_000, 30 * 24 * HOUR_MS)) return null;
  const newestMeasuredAt = isoOrNull(s.newestMeasuredAt);
  const newestPolledAt = isoOrNull(s.newestPolledAt);
  if (newestMeasuredAt === undefined || newestPolledAt === undefined) return null;
  if (!(s.staleReason === null || (typeof s.staleReason === 'string' && STALE_REASONS.has(s.staleReason)))) return null;
  let fiveHour: LoginSummary['fiveHour'] = null;
  if (s.fiveHour && typeof s.fiveHour === 'object') {
    const f = s.fiveHour as Record<string, unknown>;
    const r = isoOrNull(f.resetsAt);
    if (!(f.used === null || inRange(f.used, 0, 100)) || r === undefined) return null;
    fiveHour = { used: f.used as number | null, resetsAt: r };
  }
  const sevenDay = validWindowSummary(s.sevenDay, 'sevenDay');
  const fable = validWindowSummary(s.fable, 'fable');
  if (sevenDay === undefined || fable === undefined) return null;
  return {
    identity: s.identity as string | null, accountId: s.accountId, provider: s.provider, framework: s.framework, machineId,
    drifted: s.drifted === true, status: s.status as SlotStatus, readIntervalMs: s.readIntervalMs,
    sourceKind: s.sourceKind === 'live' || s.sourceKind === 'file' ? s.sourceKind : null,
    newestMeasuredAt, measuredAtSynthesized: s.measuredAtSynthesized === true, newestPolledAt,
    fresh: s.fresh === true, staleReason: s.staleReason as StaleReason | null, fiveHour, sevenDay, fable,
  };
}

// ── Merge per login across machines ───────────────────────────────────────────

export interface MergedLogin {
  key: string;
  identity: string | null;
  chosen: LoginSummary;
  /** Machines where this login is usable (placement). */
  machines: string[];
  disagree: boolean;
  /** Fresh at merge time (re-checked against `now`). */
  fresh: boolean;
}

const usableStatus = (s: SlotStatus) => s === 'active' || s === 'warming' || s === 'rate-limited';
const sourceRank = (s: LoginSummary) => (s.measuredAtSynthesized ? 2 : s.sourceKind === 'live' ? 0 : s.sourceKind === 'file' ? 1 : 3);

export function freshAt(s: LoginSummary, now: number): boolean {
  if (!s.fresh || s.measuredAtSynthesized) return false;
  const limit = PACING.FRESH_INTERVALS * s.readIntervalMs;
  return now - parseMs(s.newestPolledAt) <= limit && now - parseMs(s.newestMeasuredAt) <= limit;
}

export interface MergeResult { logins: MergedLogin[]; clockAhead: number }

/**
 * Merge per login by identity. Drifted slots are never merged. Ranking: fresh first, then
 * source (live > usage file > synthesized), then newest measuredAt. Two same-kind summaries
 * measured within DISAGREE_WINDOW_MS that differ by more than DISAGREE_POINTS → disagree.
 * A login with no identity is kept on its own (keyed by machine and account id).
 */
export function mergeLogins(summaries: readonly LoginSummary[], now: number): MergeResult {
  let clockAhead = 0;
  const groups = new Map<string, LoginSummary[]>();
  for (const s of summaries) {
    if (s.drifted) continue;
    if (Number.isFinite(parseMs(s.newestPolledAt)) && parseMs(s.newestPolledAt) - now > PACING.CLOCK_AHEAD_MS) { clockAhead++; continue; }
    const key = s.identity ?? `none:${s.machineId}:${s.accountId}`;
    const g = groups.get(key) ?? [];
    g.push(s);
    groups.set(key, g);
  }
  const logins: MergedLogin[] = [];
  for (const [key, g] of groups) {
    const ranked = [...g].sort((a, b) =>
      Number(freshAt(b, now)) - Number(freshAt(a, now))
      || sourceRank(a) - sourceRank(b)
      || (parseMs(b.newestMeasuredAt) || 0) - (parseMs(a.newestMeasuredAt) || 0));
    const chosen = ranked[0];
    let disagree = false;
    for (let i = 0; i < g.length && !disagree; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const a = g[i], b = g[j];
        if (a.machineId === b.machineId || a.sourceKind === null || a.sourceKind !== b.sourceKind) continue;
        const ta = parseMs(a.newestMeasuredAt), tb = parseMs(b.newestMeasuredAt);
        if (!Number.isFinite(ta) || !Number.isFinite(tb) || Math.abs(ta - tb) > PACING.DISAGREE_WINDOW_MS) continue;
        const ua = a.sevenDay?.used, ub = b.sevenDay?.used;
        if (fin(ua) && fin(ub) && Math.abs(ua - ub) > PACING.DISAGREE_POINTS) { disagree = true; break; }
      }
    }
    logins.push({
      key, identity: chosen.identity, chosen,
      machines: [...new Set(g.filter((s) => usableStatus(s.status)).map((s) => s.machineId))].sort(),
      disagree, fresh: freshAt(chosen, now) && !disagree,
    });
  }
  logins.sort((a, b) => a.chosen.accountId.localeCompare(b.chosen.accountId));
  return { logins, clockAhead };
}

// ── Provider runway (three scenarios, 168-hour walk) ──────────────────────────

export type ScenarioName = 'central' | 'pessimistic' | 'optimistic';
export interface ScenarioResult {
  lowestRoom: number;
  lowestAt: string;
  firstUnservedAt: string | null;
  unservedGroup: string[];
  unservedAccounts: string[];
  /** Next reset in that placement group after the first unserved hour. */
  nextResetAfterUnserved: string | null;
}
export interface RunwayAccount {
  key: string;
  accountId: string;
  identity: string | null;
  machines: string[];
  fresh: boolean;
  forecast: WindowForecast | null;
}
export interface RunwayResult {
  verdict: ProviderVerdict;
  reason: string | null;
  scenarios: Record<ScenarioName, ScenarioResult> | null;
  /** Slots with no attested identity: forecast on their own, left out of supply. */
  leftOutNoIdentity: number;
  /** Logins no machine can place on: shown, add no room. */
  unplaceable: number;
  withRoom: number;
  counted: number;
}

interface SimAccount { key: string; accountId: string; machines: Set<string>; room: number; reset: number; demand: number }

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Room left at `now` from the last known reading; a reset that already passed means full room. */
function lastKnownRoom(f: WindowForecast | null, now: number): { room: number | null; reset: number } {
  if (!f) return { room: null, reset: NaN };
  let reset = parseMs(f.resetsAt);
  if (f.used === null || !Number.isFinite(reset)) return { room: null, reset: NaN };
  if (reset <= now) {
    const week = PACING.WINDOW_HOURS[f.window] * HOUR_MS;
    while (reset <= now) reset += week;
    return { room: 100, reset };
  }
  return { room: Math.max(0, 100 - f.used), reset };
}

/** Walk one scenario hour by hour. Pure; exported for tests. */
export function walkScenario(accounts: SimAccount[], now: number, horizonH: number = PACING.HORIZON_H, weekH = 168): ScenarioResult {
  const sim = accounts.map((a) => ({ ...a, machines: new Set(a.machines) }));
  const total = () => sim.reduce((s, a) => s + a.room, 0);
  let lowest = total(), lowestAt = now;
  let firstUnserved: number | null = null;
  let unservedGroup: string[] = [];
  let unservedAccounts: string[] = [];
  let nextReset: number | null = null;
  const shares = (a: SimAccount, b: SimAccount) => [...a.machines].some((m) => b.machines.has(m));
  const groupOf = (start: SimAccount) => {
    const seen = new Set<string>([start.key]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const o of sim) if (!seen.has(o.key) && shares(cur, o)) { seen.add(o.key); queue.push(o); }
    }
    return sim.filter((o) => seen.has(o.key));
  };
  for (let h = 1; h <= horizonH; h++) {
    const t = now + h * HOUR_MS;
    for (const a of sim) {
      while (Number.isFinite(a.reset) && a.reset <= t) { a.room = 100; a.reset += weekH * HOUR_MS; }
    }
    const order = [...sim].sort((a, b) => a.reset - b.reset);
    const unservedHere: SimAccount[] = [];
    for (const a of order) {
      let need = Math.max(0, a.demand);
      if (need <= 0) continue;
      const take = (target: SimAccount) => { const x = Math.min(need, target.room); target.room -= x; need -= x; };
      if (a.room > 0 && a.machines.size > 0) take(a);
      while (need > 1e-9) {
        // Burn moves to the account it shares a machine with that resets soonest and has room.
        const target = order.find((o) => o.key !== a.key && o.room > 1e-9 && shares(a, o));
        if (!target) break;
        take(target);
      }
      if (need > 1e-9) unservedHere.push(a);
    }
    const room = total();
    if (room < lowest) { lowest = room; lowestAt = t; }
    if (unservedHere.length && firstUnserved === null) {
      firstUnserved = t;
      const group = groupOf(unservedHere[0]);
      unservedGroup = group.map((g) => g.accountId).sort();
      unservedAccounts = unservedHere.map((a) => a.accountId).sort();
      const resets = group.map((g) => g.reset).filter((r) => Number.isFinite(r) && r > t);
      nextReset = resets.length ? Math.min(...resets) : null;
    }
  }
  return {
    lowestRoom: Math.round(lowest * 10) / 10,
    lowestAt: new Date(lowestAt).toISOString(),
    firstUnservedAt: firstUnserved === null ? null : new Date(firstUnserved).toISOString(),
    unservedGroup, unservedAccounts,
    nextResetAfterUnserved: nextReset === null ? null : new Date(nextReset).toISOString(),
  };
}

/**
 * The provider runway: weekly room only, logins counted once by identity, assuming work moves
 * between logins that share a machine where both are usable. `replayedResets` is how many resets
 * have been replayed for this provider (tight is provisional until at least one).
 */
export function providerRunway(accounts: readonly RunwayAccount[], now: number, opts: { label: string; replayedResets: number }): RunwayResult & { plain: string; provisional: boolean } {
  const leftOutNoIdentity = accounts.filter((a) => a.identity === null).length;
  const supply = accounts.filter((a) => a.identity !== null);
  const unplaceable = supply.filter((a) => a.machines.length === 0).length;
  const known = (pick: (f: WindowForecast) => number | null) =>
    supply.map((a) => (a.fresh && a.forecast ? pick(a.forecast) : null)).filter((x): x is number => x !== null);
  const centralPaces = known((f) => f.pace);
  const highPaces = known((f) => (f.high === null || f.used === null || !f.hoursLeft ? null : (f.high - f.used) / f.hoursLeft));
  const withRoom = supply.filter((a) => a.fresh && a.forecast?.used !== null && a.forecast?.used !== undefined && a.forecast.used < 100 && a.machines.length > 0).length;
  const base = { leftOutNoIdentity, unplaceable, withRoom, counted: supply.length };
  const n = supply.length;
  const lead = `${withRoom} of ${n} ${opts.label} accounts have room`;
  if (n === 0 || unplaceable === n || centralPaces.length === 0) {
    const reason = n === 0 ? 'no accounts with a known identity'
      : unplaceable === n ? 'no account can be used from any machine'
      : 'not enough readings to tell';
    return { ...base, verdict: 'cannot-tell', reason, scenarios: null, plain: `${lead}. Not enough readings to tell (${reason}).`, provisional: false };
  }
  const med = median(centralPaces) ?? 0;
  const fastest = Math.max(...highPaces, ...centralPaces);
  const slopeOf = (f: WindowForecast, end: number | null) => (end === null || f.used === null || !f.hoursLeft ? null : (end - f.used) / f.hoursLeft);
  const build = (name: ScenarioName): SimAccount[] => supply.map((a) => {
    const f = a.fresh ? a.forecast : null;
    const lk = lastKnownRoom(a.forecast, now);
    let demand: number, room: number;
    if (name === 'central') {
      demand = f?.pace ?? med;
      room = lk.room ?? 0;
    } else if (name === 'pessimistic') {
      demand = (f ? slopeOf(f, f.high) : null) ?? fastest;
      room = f && lk.room !== null ? lk.room : 0;
    } else {
      demand = (f ? slopeOf(f, f.low) : null) ?? 0;
      room = lk.room ?? 0;
    }
    if (a.machines.length === 0) { room = 0; demand = 0; }
    const reset = Number.isFinite(lk.reset) ? lk.reset : now + PACING.HORIZON_H * HOUR_MS * 2;
    return { key: a.key, accountId: a.accountId, machines: new Set(a.machines), room, reset, demand: Math.max(0, demand) };
  });
  const scenarios = {
    central: walkScenario(build('central'), now),
    pessimistic: walkScenario(build('pessimistic'), now),
    optimistic: walkScenario(build('optimistic'), now),
  };
  const provisional = opts.replayedResets < 1;
  if (scenarios.central.firstUnservedAt) {
    const at = parseMs(scenarios.central.firstUnservedAt);
    const next = parseMs(scenarios.central.nextResetAfterUnserved);
    const gap = Number.isFinite(next) ? Math.round((next - at) / HOUR_MS) : null;
    return { ...base, verdict: 'runs-dry', reason: null, scenarios, provisional: false,
      plain: `${lead}. At the current pace, weekly room runs out ${fmtWhen(at)}${gap !== null ? `; next reset ${gap} hours later` : ''}.` };
  }
  if (scenarios.pessimistic.firstUnservedAt || scenarios.pessimistic.lowestRoom < PACING.TIGHT_LINE) {
    const at = parseMs(scenarios.pessimistic.firstUnservedAt ?? scenarios.pessimistic.lowestAt);
    const startRoom = build('pessimistic').reduce((sum, a) => sum + a.room, 0);
    const already = startRoom < PACING.TIGHT_LINE || !Number.isFinite(at) || at <= now + HOUR_MS;
    const when = already ? 'already tight now' : `could get tight on ${fmtWhen(at)} if the busiest recent pace kept up`;
    return { ...base, verdict: 'tight', reason: null, scenarios, provisional,
      plain: `${lead}. Fine at the current pace, but ${when}${provisional ? ' (provisional: no reset replayed yet)' : ''}.` };
  }
  return { ...base, verdict: 'sustainable', reason: null, scenarios, provisional: false,
    plain: `${lead}. Weekly room lasts all week, even at the fastest recent pace.` };
}

/** A runway answer computed from this machine alone while the agent has peers. */
export const LOCAL_ONLY_REASON = "only this machine's readings";

/** Assumptions the page states next to every runway. */
export const RUNWAY_ASSUMPTIONS = [
  'weekly room only; five-hour lockouts and the 90% placement threshold are not modelled',
  'assumes work can move between accounts that share a machine',
  'assumes equal-sized accounts',
  'the range is between the slowest and fastest of the recent paces (last 6 hours, last 24 hours, this cycle so far)',
  'the pessimistic scenario overstates, because accounts\' busy hours do not line up',
  'each account\'s own forecast is a straight line from its own pace; placement drains the soonest-resetting account first',
];

// ── Assembly: providers and accounts from merged logins ─────────────────────

const PROVIDER_LABEL: Record<string, string> = { anthropic: 'Claude', openai: 'Codex' };

export interface AccountView {
  accountId: string;
  identity: string | null;
  identityUnknown: boolean;
  machine: string;
  machines: string[];
  status: SlotStatus;
  fresh: boolean;
  staleReason: StaleReason | null;
  disagree: boolean;
  sourceKind: 'live' | 'file' | null;
  newestMeasuredAt: string | null;
  measuredAtSynthesized: boolean;
  fiveHour: LoginSummary['fiveHour'];
  weekly: (WindowSummary & AccountVerdictResult & { display: { used: number | null; central: number | null; low: number | null; high: number | null } }) | null;
  fable: (WindowSummary & AccountVerdictResult & { display: { used: number | null; central: number | null; low: number | null; high: number | null } }) | null;
}
export interface ProviderView {
  provider: string;
  framework: string;
  label: string;
  basis: string;
  verdict: ProviderVerdict;
  plain: string;
  reason: string | null;
  provisional: boolean;
  scenarios: Record<ScenarioName, ScenarioResult> | null;
  leftOutNoIdentity: number;
  unplaceable: number;
  fableRunway?: { verdict: ProviderVerdict; plain: string; reason: string | null; provisional: boolean; scenarios: Record<ScenarioName, ScenarioResult> | null };
  assumptions: string[];
  accounts: AccountView[];
}

function replayedResets(logins: readonly MergedLogin[], w: ForecastWindowKey): number {
  return logins.reduce((n, l) => n + (l.chosen[w]?.calibration.scored ?? 0), 0);
}

/**
 * Build the provider views. `localOnly` (a local answer on an agent with peers) forces the
 * provider verdict to cannot-tell, because one machine's readings are not the pool.
 */
export function assembleProviders(logins: readonly MergedLogin[], now: number, opts: { localOnly: boolean }): ProviderView[] {
  const byProvider = new Map<string, MergedLogin[]>();
  for (const l of logins) {
    const k = `${l.chosen.provider}|${l.chosen.framework}`;
    const g = byProvider.get(k) ?? [];
    g.push(l);
    byProvider.set(k, g);
  }
  const out: ProviderView[] = [];
  for (const [k, group] of [...byProvider].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [provider, framework] = k.split('|');
    const label = PROVIDER_LABEL[provider] ?? provider;
    const runwayFor = (w: ForecastWindowKey) => providerRunway(group.map((l) => ({
      key: l.key, accountId: l.chosen.accountId, identity: l.identity, machines: l.machines,
      fresh: l.fresh, forecast: l.disagree ? null : l.chosen[w],
    })), now, { label, replayedResets: replayedResets(group, w) });
    const weekly = runwayFor('sevenDay');
    const fableR = provider === 'anthropic' && group.some((l) => l.chosen.fable) ? runwayFor('fable') : null;
    const localize = <T extends { verdict: ProviderVerdict; plain: string; reason: string | null }>(r: T): T => (opts.localOnly
      ? { ...r, verdict: 'cannot-tell', reason: LOCAL_ONLY_REASON, plain: `Not enough readings to tell (${LOCAL_ONLY_REASON}).` }
      : r);
    const w = localize(weekly);
    const accountFor = (l: MergedLogin): AccountView => {
      const fr: Freshness = {
        fresh: l.fresh, reason: l.fresh ? null : (l.chosen.staleReason ?? (l.disagree ? null : 'not-polled')),
        newestPolledAt: l.chosen.newestPolledAt, newestMeasuredAt: l.chosen.newestMeasuredAt,
        measuredAtSynthesized: l.chosen.measuredAtSynthesized, source: null,
      };
      const view = (ws: WindowSummary | null, providerVerdict: ProviderVerdict) => {
        if (!ws) return null;
        let v = accountVerdict(ws, fr, providerVerdict, now);
        if (l.disagree) v = { verdict: 'unknown', plain: "can't tell: machines disagree", reason: 'machines-disagree', neutral: true };
        else if (l.identity === null && v.verdict !== 'unknown') v = { ...v, plain: `${v.plain} (identity unknown)` };
        return { ...ws, ...v, display: { used: displayPct(ws.used), central: displayPct(ws.central), low: displayPct(ws.low), high: displayPct(ws.high) } };
      };
      return {
        accountId: l.chosen.accountId, identity: l.identity, identityUnknown: l.identity === null,
        machine: l.chosen.machineId, machines: l.machines, status: l.chosen.status,
        fresh: l.fresh, staleReason: fr.reason, disagree: l.disagree, sourceKind: l.chosen.sourceKind,
        newestMeasuredAt: l.chosen.newestMeasuredAt, measuredAtSynthesized: l.chosen.measuredAtSynthesized,
        fiveHour: l.chosen.fiveHour,
        weekly: view(l.chosen.sevenDay, weekly.verdict),
        fable: view(l.chosen.fable, fableR?.verdict ?? weekly.verdict),
      };
    };
    const pv: ProviderView = {
      provider, framework, label, basis: BASIS,
      verdict: w.verdict, plain: w.plain, reason: w.reason, provisional: w.provisional, scenarios: weekly.scenarios,
      leftOutNoIdentity: weekly.leftOutNoIdentity, unplaceable: weekly.unplaceable,
      assumptions: RUNWAY_ASSUMPTIONS,
      accounts: group.map(accountFor),
    };
    if (fableR) {
      const f = localize(fableR);
      pv.fableRunway = { verdict: f.verdict, plain: f.plain, reason: f.reason, provisional: f.provisional, scenarios: fableR.scenarios };
    }
    out.push(pv);
  }
  return out;
}

/** Pool-level calibration: totals across the chosen summaries (weekly window). */
export function poolCalibration(logins: readonly MergedLogin[]): CalibrationSummary & { byAccount: Array<{ accountId: string; machine: string; weekly: CalibrationSummary | null; fable: CalibrationSummary | null }> } {
  const outcomes = logins.flatMap((l) => l.chosen.sevenDay?.calibration.outcomes ?? []);
  return {
    ...summariseCalibration(outcomes),
    byAccount: logins.map((l) => ({ accountId: l.chosen.accountId, machine: l.chosen.machineId, weekly: l.chosen.sevenDay?.calibration ?? null, fable: l.chosen.fable?.calibration ?? null })),
  };
}

export { round1 as roundPacing };

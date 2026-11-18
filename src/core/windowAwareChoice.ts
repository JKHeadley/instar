/**
 * windowAwareChoice — quota pacing step 2 (docs/specs/quota-pacing-account-choice.md).
 *
 * The pure half of window-aware account choice: read each quota window as it
 * stands NOW (§1), decide which windows bind a placement (§2), and rank accounts
 * in two tiers by one shared use-before-reset score (§3). No I/O, no clocks of
 * its own: every function takes `nowMs`.
 *
 * Unknown is never zero (P20): a window whose reset has passed, a placeholder
 * reading, or a reading nobody has taken recently contributes NOTHING to room
 * and puts the account in the lower (unmeasured) tier. An account in that tier
 * is only used when no account with a real, fresh reading qualifies.
 *
 * Signal vs authority: placement already holds the authority to choose an
 * account; this module only changes which numbers it reads and how it orders
 * accounts. It is reached only when `subscriptionPool.pacing.windowAwareChoice`
 * resolves on (dev-gated); otherwise every caller runs today's code unchanged.
 */

import type {
  AccountQuotaSnapshot,
  QuotaWindowKey,
  SubscriptionAccount,
  SubscriptionFramework,
} from './SubscriptionPool.js';
import { isLocallyExecutable } from './SubscriptionPool.js';
import { resolveModelId } from './models.js';

/** Window lengths, the providers' published lengths (step 1 checks fixed windows per provider). */
export const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60_000;
export const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * The shared freshness for the measured tier: the SAME 60 minutes the default
 * spawn path (`UsageWallRescue.isFresh`) already uses, so both pickers agree.
 * This step adds no new freshness value.
 */
export const FRESH_READING_MS = 60 * 60_000;

/** The poller's default cadence (QuotaPoller `pollIntervalMs`). */
export const DEFAULT_QUOTA_POLL_INTERVAL_MS = 15 * 60_000;

/** A just-rolled 5-hour window keeps the account measured for this many poll intervals. */
export const ROLLED_FIVE_HOUR_GRACE_INTERVALS = 2;

/** Existing urgency floor/clamp, kept from today's `scoreAccount`. */
const NO_DEADLINE_URGENCY = 0.0001;
const MIN_HOURS_TO_RESET = 0.25;
const DEFAULT_SOFT_THRESHOLD = 90;

export type WindowState =
  | 'measured'
  | 'idle'
  | 'rolled'
  | 'unknown'
  | 'not-offered'
  | 'unread-none'
  | 'unread-old-cycle'
  | 'unread-stale';

export interface WindowReading {
  state: WindowState;
  /** Usage percent, only for `measured` / `idle`; null for every other state. */
  pct: number | null;
  /** The window's reset, only for `measured`; null otherwise (no reset is ever projected). */
  resetsAtMs: number | null;
  /** For `rolled`: when the window reset, when known (drives the 5-hour grace clock). */
  rolledAtMs?: number | null;
}

const WINDOW_LENGTH: Record<QuotaWindowKey, number> = {
  fiveHour: FIVE_HOUR_WINDOW_MS,
  sevenDay: WEEKLY_WINDOW_MS,
  fable: WEEKLY_WINDOW_MS,
};

/**
 * Per-provider table of windows the provider never offers (spec §1 state 1, first source).
 * Keyed by provider, not engine: OpenAI (Codex) accounts have no Fable window.
 */
const NOT_OFFERED_BY_PROVIDER: Readonly<Record<string, ReadonlySet<QuotaWindowKey>>> = {
  openai: new Set<QuotaWindowKey>(['fable']),
};

/** Is this window `measured` or `idle` (the two states that carry a real reading)? */
export function isValidState(s: WindowState): boolean {
  return s === 'measured' || s === 'idle';
}

/**
 * Read one window of a snapshot as it stands now (spec §1). Each window is
 * classified on its own; freshness is applied last, so a stale reading of an
 * otherwise measured window reads `unread-stale`.
 */
export function windowNow(
  snap: AccountQuotaSnapshot | null | undefined,
  key: QuotaWindowKey,
  nowMs: number,
  opts: { provider?: string; freshMs?: number } = {},
): WindowReading {
  const w = snap ? snap[key] : undefined;
  // 1. not-offered — only from the provider's own statement, never from absence alone.
  if (!w) {
    if (opts.provider && NOT_OFFERED_BY_PROVIDER[opts.provider]?.has(key)) {
      return { state: 'not-offered', pct: null, resetsAtMs: null };
    }
    if (snap && Array.isArray(snap.windowsListed) && !snap.windowsListed.includes(key)) {
      return { state: 'not-offered', pct: null, resetsAtMs: null };
    }
    // 2. unread-none.
    return { state: 'unread-none', pct: null, resetsAtMs: null };
  }
  const len = WINDOW_LENGTH[key];
  // 3. unknown — a placeholder the reader itself marked.
  if (key === 'fable' && snap?.fableUnknown === true) return { state: 'unknown', pct: null, resetsAtMs: null };
  if (typeof w.utilizationPct !== 'number' || !Number.isFinite(w.utilizationPct)) {
    return { state: 'unknown', pct: null, resetsAtMs: null };
  }
  const raw = typeof w.resetsAt === 'string' ? w.resetsAt : '';
  let base: WindowReading;
  if (raw === '') {
    const basis = snap?.windowBasis?.[key];
    if (basis === 'idle-live') {
      // 4. idle — the provider's own fresh read says no window is running.
      base = { state: 'idle', pct: w.utilizationPct, resetsAtMs: null };
    } else {
      // 5. rolled (rollout history, or an older snapshot with no basis).
      const before = snap?.resetsAtBeforeRewrite?.[key];
      const beforeMs = before ? Date.parse(before) : NaN;
      if (Number.isFinite(beforeMs) && nowMs - beforeMs >= len) {
        // 6. unread-old-cycle via the original reset the poller blanked.
        return { state: 'unread-old-cycle', pct: null, resetsAtMs: null };
      }
      return { state: 'rolled', pct: null, resetsAtMs: null, rolledAtMs: Number.isFinite(beforeMs) ? beforeMs : null };
    }
  } else {
    const resetMs = Date.parse(raw);
    if (!Number.isFinite(resetMs)) return { state: 'unknown', pct: null, resetsAtMs: null };
    if (resetMs <= nowMs) {
      if (nowMs - resetMs >= len) return { state: 'unread-old-cycle', pct: null, resetsAtMs: null };
      return { state: 'rolled', pct: null, resetsAtMs: null, rolledAtMs: resetMs };
    }
    // 7. measured.
    base = { state: 'measured', pct: w.utilizationPct, resetsAtMs: resetMs };
  }
  // Freshness: a real, recent measuredAt; a synthesized time is never fresh.
  const measuredAtMs = snap?.measuredAt ? Date.parse(snap.measuredAt) : NaN;
  const freshMs = opts.freshMs ?? FRESH_READING_MS;
  if (snap?.measuredAtSynthesized === true || !Number.isFinite(measuredAtMs) || nowMs - measuredAtMs > freshMs) {
    return { state: 'unread-stale', pct: null, resetsAtMs: null };
  }
  return base;
}

export type LaunchModelClass = 'fable' | 'non-fable' | 'unknown';

/** A model label/id names a Fable model (same rule as IntelligenceRouter.isFableModel). */
function namesFable(s: string): boolean {
  return /fable/i.test(s);
}

/**
 * Classify the model a spawn will launch (spec §2). Tier labels are resolved to
 * a concrete id first; an unset model is `unknown`.
 */
export function classifyLaunchModel(model: string | null | undefined): LaunchModelClass {
  if (typeof model !== 'string' || model.trim() === '') return 'unknown';
  const m = model.trim();
  let concrete = m;
  try {
    concrete = resolveModelId(m);
  } catch {
    // @silent-fallback-ok: an unresolvable label is classified by its own text
    concrete = m;
  }
  return namesFable(concrete) || namesFable(m) ? 'fable' : 'non-fable';
}

export interface AccountAssessment {
  account: SubscriptionAccount;
  tier: 'measured' | 'unmeasured';
  /** Every valid binding window is under the soft line. */
  eligible: boolean;
  score: number;
  /** Room left in a valid Fable window, or null. */
  fableRoom: number | null;
  /** Highest valid binding percent (null when none is valid). */
  bindingPct: number | null;
  states: Record<QuotaWindowKey, WindowState>;
  /** At least one window is rolled / unknown / unread: ask for a fresh reading. */
  needsRead: boolean;
}

export interface AssessOptions {
  nowMs: number;
  softThresholdPct?: number;
  /** The Fable window binds eligibility and scoring (a known Fable launch). */
  fableBinding: boolean;
  freshMs?: number;
  pollIntervalMs?: number;
  /** Consecutive failed out-of-cycle reads for an account (ends the 5-hour grace). */
  failedReads?: (accountId: string) => number;
}

/** Assess one account against the binding windows (spec §§2-3). */
export function assessAccount(a: SubscriptionAccount, opts: AssessOptions): AccountAssessment {
  const soft = opts.softThresholdPct ?? DEFAULT_SOFT_THRESHOLD;
  const read = (k: QuotaWindowKey) => windowNow(a.lastQuota, k, opts.nowMs, { provider: a.provider, freshMs: opts.freshMs });
  const five = read('fiveHour');
  const week = read('sevenDay');
  const fable = read('fable');
  const states = { fiveHour: five.state, sevenDay: week.state, fable: fable.state };

  const binding: Array<[QuotaWindowKey, WindowReading]> = [['fiveHour', five], ['sevenDay', week]];
  if (opts.fableBinding) binding.push(['fable', fable]);

  const interval = opts.pollIntervalMs ?? DEFAULT_QUOTA_POLL_INTERVAL_MS;
  const failed = opts.failedReads?.(a.id) ?? 0;
  const inFiveHourGrace = (r: WindowReading): boolean =>
    r.state === 'rolled' &&
    typeof r.rolledAtMs === 'number' &&
    opts.nowMs - r.rolledAtMs <= ROLLED_FIVE_HOUR_GRACE_INTERVALS * interval &&
    failed === 0;

  let eligible = true;
  let tier: 'measured' | 'unmeasured' = 'measured';
  let bindingPct: number | null = null;
  for (const [key, r] of binding) {
    if (isValidState(r.state)) {
      const pct = r.pct as number;
      if (pct >= soft) eligible = false;
      bindingPct = bindingPct === null ? pct : Math.max(bindingPct, pct);
    } else if (r.state === 'not-offered') {
      // never demotes
    } else if (key === 'fiveHour' && inFiveHourGrace(r)) {
      // a just-rolled 5-hour window: never room, but no demotion inside the grace
    } else {
      tier = 'unmeasured';
    }
  }

  // Score: least room across the valid binding weekly windows over the soonest of their resets.
  const weekly: WindowReading[] = [week];
  if (opts.fableBinding) weekly.push(fable);
  const validWeekly = weekly.filter((r) => isValidState(r.state));
  let score: number;
  if (validWeekly.length === 0) {
    score = 100 * NO_DEADLINE_URGENCY;
  } else {
    const room = Math.max(0, Math.min(...validWeekly.map((r) => 100 - (r.pct as number))));
    const deadlines = validWeekly.map((r) => r.resetsAtMs).filter((t): t is number => typeof t === 'number');
    let urgency = NO_DEADLINE_URGENCY;
    if (deadlines.length > 0) {
      const hours = Math.max(MIN_HOURS_TO_RESET, (Math.min(...deadlines) - opts.nowMs) / 3_600_000);
      urgency = 1 / hours;
    }
    score = room * urgency;
  }

  const fableRoom = isValidState(fable.state) ? Math.max(0, 100 - (fable.pct as number)) : null;
  const needsRead = [five, week, fable].some(
    (r) => r.state === 'rolled' || r.state === 'unknown' || r.state.startsWith('unread'),
  );
  return { account: a, tier, eligible, score, fableRoom, bindingPct, states, needsRead };
}

export interface RankOptions {
  nowMs: number;
  softThresholdPct?: number;
  framework?: SubscriptionFramework;
  model?: string | null;
  excludeId?: string | null;
  freshMs?: number;
  pollIntervalMs?: number;
  failedReads?: (accountId: string) => number;
  /** Fire-and-forget request for an out-of-cycle reading (never awaited). */
  onNeedsRead?: (accountId: string) => void;
  /** Extra caller filter (e.g. the default spawn path's isFresh / walled checks). */
  filter?: (a: SubscriptionAccount) => boolean;
}

export interface RankResult {
  ranked: AccountAssessment[];
  modelClass: LaunchModelClass;
  /** A known Fable launch found no account with Fable room and fell back (spec §2). */
  fableNoRoom: boolean;
}

function compareAssessments(modelClass: LaunchModelClass, fableFallback: boolean) {
  return (x: AccountAssessment, y: AccountAssessment): number => {
    if (x.tier !== y.tier) return x.tier === 'measured' ? -1 : 1;
    if (fableFallback) {
      const fx = x.fableRoom ?? -1;
      const fy = y.fableRoom ?? -1;
      if (fx !== fy) return fy - fx;
    }
    if (x.score !== y.score) return y.score - x.score;
    if (modelClass === 'unknown') {
      const fx = x.fableRoom ?? -1;
      const fy = y.fableRoom ?? -1;
      if (fx !== fy) return fy - fx;
    }
    return x.account.id.localeCompare(y.account.id);
  };
}

/**
 * Rank the eligible accounts, measured tier first (spec §3). Never awaits the
 * re-read requests it raises. A known Fable launch that finds no account with
 * Fable room drops the Fable window from eligibility and ranks by Fable room,
 * so a Fable-only reason never empties the pick.
 */
export function rankAccounts(accounts: SubscriptionAccount[], opts: RankOptions): RankResult {
  const modelClass = classifyLaunchModel(opts.model);
  const candidates = accounts.filter(
    (a) =>
      isLocallyExecutable(a) &&
      (opts.framework === undefined || a.framework === opts.framework) &&
      a.id !== opts.excludeId &&
      (opts.filter ? opts.filter(a) : true),
  );
  const assess = (fableBinding: boolean) =>
    candidates.map((a) =>
      assessAccount(a, {
        nowMs: opts.nowMs,
        softThresholdPct: opts.softThresholdPct,
        fableBinding,
        freshMs: opts.freshMs,
        pollIntervalMs: opts.pollIntervalMs,
        failedReads: opts.failedReads,
      }),
    );
  let all = assess(modelClass === 'fable');
  let eligible = all.filter((x) => x.eligible);
  let fableNoRoom = false;
  if (modelClass === 'fable' && eligible.length === 0 && candidates.length > 0) {
    const fallback = assess(false).filter((x) => x.eligible);
    if (fallback.length > 0) {
      fableNoRoom = true;
      all = assess(false);
      eligible = fallback;
    }
  }
  if (opts.onNeedsRead) {
    for (const x of all) {
      if (!x.needsRead) continue;
      try {
        opts.onNeedsRead(x.account.id);
      } catch {
        // @silent-fallback-ok: a read request is advisory; placement never depends on it
      }
    }
  }
  eligible.sort(compareAssessments(modelClass, fableNoRoom));
  return { ranked: eligible, modelClass, fableNoRoom };
}

/**
 * Window-aware binding utilization (spec §2): the highest VALID percent over the
 * binding windows, or null when none is valid.
 */
export function windowAwareBindingPct(
  snap: AccountQuotaSnapshot | null | undefined,
  at: { nowMs: number; model?: string | null; provider?: string; freshMs?: number },
): number | null {
  const keys: QuotaWindowKey[] = ['fiveHour', 'sevenDay'];
  if (classifyLaunchModel(at.model) === 'fable') keys.push('fable');
  let out: number | null = null;
  for (const k of keys) {
    const r = windowNow(snap, k, at.nowMs, { provider: at.provider, freshMs: at.freshMs });
    if (isValidState(r.state)) out = out === null ? (r.pct as number) : Math.max(out, r.pct as number);
  }
  return out;
}

/** Why a ranked pick differs from the old rule's pick (spec §5 `reasons`). */
export type ChoiceReason = 'window-pairing' | 'fable' | 'fable-no-room' | 'rolled-window' | 'unknown-window' | 'tier';

/** Explain a differing pick from the assessments (best effort, deterministic). */
export function explainChoice(result: RankResult, oldPickId: string | null): ChoiceReason[] {
  const top = result.ranked[0];
  const reasons = new Set<ChoiceReason>();
  if (result.fableNoRoom) reasons.add('fable-no-room');
  if (!top || top.account.id === oldPickId) return [...reasons];
  const old = result.ranked.find((x) => x.account.id === oldPickId);
  const statesOf = (x: AccountAssessment | undefined) => (x ? Object.values(x.states) : []);
  const involved = [...statesOf(top), ...statesOf(old)];
  if (involved.includes('rolled') || involved.includes('unread-old-cycle')) reasons.add('rolled-window');
  if (involved.includes('unknown')) reasons.add('unknown-window');
  if (old && old.tier !== top.tier) reasons.add('tier');
  else if (!old && oldPickId !== null) reasons.add('tier');
  if (result.modelClass === 'fable' && !result.fableNoRoom) reasons.add('fable');
  if (reasons.size === 0) reasons.add('window-pairing');
  return [...reasons];
}

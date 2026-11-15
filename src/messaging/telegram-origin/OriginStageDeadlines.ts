/**
 * Time budgets for the recording stages of TelegramOriginService, and the one place a whole
 * process can change their defaults.
 *
 * Kept in its own small module (no imports) so a test runner's setup file can lift the
 * defaults for every test file without loading the origin service.
 *
 * Why a process-wide default exists at all: the budgets are real waits on fsync-ing disk
 * commits. On a saturated disk a healthy commit outlasts a sub-second budget, the send is held
 * as a recording outage, and a test that never meant to test timing fails. 46 test files open
 * a real origin service; lifting the budget per fixture did not keep up (2026-11-13: two more
 * files failed an unrelated change the same morning eleven had been fixed).
 *
 * Production never calls `setOriginStageDeadlineProcessDefaults` (pinned by a source scan in
 * tests/unit/telegram-origin/origin-stage-deadlines.test.ts).
 */

/** Per-stage budgets, in milliseconds. */
export interface OriginStageDeadlines {
  /** Evidence into the store. A miss falls to the spool. */
  storeEvidenceMs: number;
  /** Evidence into the local spool. A miss falls to the peer, when one is wired. */
  spoolEvidenceMs: number;
  /** Evidence to a peer machine. A miss holds the send: all-durable-recording-sinks-unavailable. */
  peerEvidenceMs: number;
  /** Verified evidence into the store, before admission. A miss holds: execution-admission-unavailable. */
  verifiedEvidenceMs: number;
  /** Admission of the sealed plan. A miss holds: execution-admission-unavailable. */
  admitMs: number;
}

/** The production budgets. */
export const ORIGIN_STAGE_DEADLINES_MS: Readonly<OriginStageDeadlines> = Object.freeze({
  storeEvidenceMs: 250, spoolEvidenceMs: 500, peerEvidenceMs: 1250, verifiedEvidenceMs: 1000, admitMs: 1000,
});
/** The largest budget anything may set for one stage. */
export const ORIGIN_STAGE_DEADLINE_MAX_MS = 60_000;

const valid = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= ORIGIN_STAGE_DEADLINE_MAX_MS;

let processDefaults: Partial<OriginStageDeadlines> = {};

/**
 * Replace this process's default budgets (the value used when a service sets none for a stage).
 * `null` restores the production budgets. Invalid fields are ignored, stage by stage. For test
 * runners; production code does not call this.
 */
export function setOriginStageDeadlineProcessDefaults(next: Partial<OriginStageDeadlines> | null): void {
  const kept: Partial<OriginStageDeadlines> = {};
  if (next) for (const stage of Object.keys(ORIGIN_STAGE_DEADLINES_MS) as Array<keyof OriginStageDeadlines>) {
    if (valid(next[stage])) kept[stage] = next[stage];
  }
  processDefaults = kept;
}

/**
 * The budget for one stage: the service's own value when valid, else this process's default
 * when one was set, else the production budget. An invalid value at either level is skipped
 * and the next level is used; an invalid value never widens or removes a deadline.
 */
export function resolveOriginStageDeadline(stage: keyof OriginStageDeadlines, own?: Partial<OriginStageDeadlines>): number {
  const set = own?.[stage];
  if (valid(set)) return set;
  const fallback = processDefaults[stage];
  return valid(fallback) ? fallback : ORIGIN_STAGE_DEADLINES_MS[stage];
}

/** The production deadline for one request to the origin store's worker. */
export const ORIGIN_STORE_REQUEST_TIMEOUT_MS = 2000;
/** The largest request deadline a store accepts (OriginStore validates the same bound). */
export const ORIGIN_STORE_REQUEST_TIMEOUT_MAX_MS = 30_000;

const validStoreTimeout = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= ORIGIN_STORE_REQUEST_TIMEOUT_MAX_MS;

let storeRequestTimeoutDefault: number | null = null;

/**
 * Replace this process's default deadline for a store request (used when a store is opened
 * without `requestTimeoutMs`). `null`, or an invalid value, restores the production 2 s.
 *
 * Same reason as the stage budgets above: beside a full suite a healthy worker can take
 * longer than 2 s to answer one request, the caller is told the store is unavailable, and a
 * test that never meant to test timing fails (2026-11-13: recovery-fairness,
 * recovery-review-budget, forward-on-standby, on three unrelated changes). The stage budgets
 * could not reach this: it is the layer below them. For test runners; production code does
 * not call this.
 */
export function setOriginStoreRequestTimeoutProcessDefault(next: number | null): void {
  storeRequestTimeoutDefault = validStoreTimeout(next) ? next : null;
}

/**
 * The deadline for a store's requests: the store's own option when one is given (valid or
 * not: the store validates it and refuses a bad one, as before), else this process's default
 * when one was set, else the production 2 s.
 */
export function resolveOriginStoreRequestTimeout(own?: number): number {
  if (own !== undefined) return own;
  return storeRequestTimeoutDefault ?? ORIGIN_STORE_REQUEST_TIMEOUT_MS;
}


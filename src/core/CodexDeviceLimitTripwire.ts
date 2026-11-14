/**
 * CodexDeviceLimitTripwire — the per-machine state machine that benches a Codex account
 * when OpenAI's per-device limit on paid personal accounts locks it out.
 *
 * Spec: docs/specs/codex-device-limit-tripwire.md (§0, §2–§4, §6, §7).
 *
 * CONTRACT:
 *   - It decides nothing by itself. Every bench rests on two separate app-server refusals of
 *     `account/rateLimits/read`, 5–60 min apart, each FRESHLY judged `device_limit` by the
 *     CodexDeviceLimitJudge (Jev, Luna referee), plus the machine floor: another Codex account
 *     on this machine whose latest completed live read is clean. Every other source (the
 *     initialize error, `codex login status` text, a session screen, a sign-in page) can only
 *     ask for a fresh read.
 *   - The persisted pool record is the authority: benched ⇔ `status === 'needs-reauth' &&
 *     statusCause === 'codex-device-limit'`. Any writer of `active` ends a bench (the pool's
 *     store rule clears the fields).
 *   - It only ever reduces autonomy, and it undoes itself: two clean live reads release, the
 *     ignore list and the switch restore today's behaviour on the next read.
 *   - Clean read = a live app-server `ok`. A rollout-file fallback is never a clean read.
 */
import { createHash } from 'node:crypto';
import type { SubscriptionAccount, SubscriptionPool } from './SubscriptionPool.js';
import { isDeviceLimitBenched } from './SubscriptionPool.js';

export const DEVICE_LIMIT_CONFIRM_DELAY_MS = 5 * 60_000;
export const DEVICE_LIMIT_PAIR_MIN_MS = 5 * 60_000;
export const DEVICE_LIMIT_PAIR_MAX_MS = 60 * 60_000;
export const DEVICE_LIMIT_FLOOR_WINDOW_MS = 60 * 60_000;
export const DEVICE_LIMIT_BACKOFF_BASE_MS = 60 * 60_000;
export const DEVICE_LIMIT_BACKOFF_CAP_MS = 6 * 60 * 60_000;
export const DEVICE_LIMIT_BREAKER_REFUSALS = 8;
export const DEVICE_LIMIT_STOPPED_REPAIR_WINDOW_MS = 24 * 60 * 60_000;
export const DEVICE_LIMIT_RENOTIFY_BRAKE_MS = 24 * 60 * 60_000;
/** A trigger-source verdict may bypass the 10-minute read floor at most once per account per this window. */
export const DEVICE_LIMIT_TRIGGER_BYPASS_WINDOW_MS = 10 * 60_000;

export type DeviceLimitSource = 'read-refusal' | 'initialize-error' | 'login-status' | 'sign-in-page';
export type DeviceLimitVerdict = 'device_limit' | 'not_device_limit' | 'undecided';

/** The judge as this module sees it (CodexDeviceLimitJudge implements it). */
export interface DeviceLimitJudgeLike {
  enqueue(
    job: {
      accountId: string;
      source: DeviceLimitSource;
      text: string;
      email?: string;
      nickname?: string;
      stateChanging: boolean;
    },
    onVerdict: (result: { verdict: DeviceLimitVerdict; decidedBy: string; deciders: number; cached: boolean }) => void,
  ): void;
}

/** One live Codex read, as the poller hands it over. */
export interface CodexReadOutcome {
  kind: 'ok' | 'auth-failed' | 'unavailable';
  refusal?: { stage: 'initialize' | 'read'; text: string };
  /** True for the poller's scheduled pass (backoff and breaker count only these). */
  scheduled: boolean;
}

export interface DeviceLimitNotice {
  machineId: string;
  priority: 'low' | 'normal' | 'HIGH';
  title: string;
  body: string;
  /** True when the row re-opens inside the 24 h re-notify brake (refresh without a buzz). */
  silent: boolean;
}

export interface CodexDeviceLimitTripwireDeps {
  pool: Pick<SubscriptionPool, 'list' | 'get' | 'update'>;
  judge: DeviceLimitJudgeLike | null;
  machineId: string;
  /** Live config: the switch (dev-gate resolved) and this machine's ignore list. */
  config: () => { enabled: boolean; ignoreAccounts: string[] };
  /** Read one account now, through the poller's read gate. `confirmation` bypasses the 10-minute floor. */
  requestRead: (accountId: string, opts: { confirmation: boolean }) => void;
  /** Ledger bookkeeping, best-effort (the pool record is the authority). */
  ledger: {
    benched: (accountId: string, wasNeedsReauth: boolean) => void;
    released: (accountId: string) => void;
  };
  /** Stop every non-terminal repair for the account on this machine. Never throws. */
  settleRepairs: (accountId: string) => Promise<void> | void;
  /** Move live sessions off the account (serialised, braked). Never throws. */
  moveSessions: (accountId: string) => Promise<void> | void;
  /** Raise or refresh the per-machine notice row; null clears it. */
  notice: (notice: DeviceLimitNotice | null) => void;
  log: (row: Record<string, unknown>) => void;
  now?: () => number;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
  /** Schedules a callback (tests inject a fake clock). */
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void } | unknown;
}

interface ReadState { lastCleanAt?: number; latestClean: boolean; latestAt: number }
interface Suspicion { at: number }

export class CodexDeviceLimitTripwire {
  private readonly deps: CodexDeviceLimitTripwireDeps;
  private readonly now: () => number;
  private readonly logger: { log: (m: string) => void; warn: (m: string) => void };
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  /** Latest completed live read per account (in memory: a restart starts conservative). */
  private readonly reads = new Map<string, ReadState>();
  /** Clean reads counted toward a provider release, per benched account. */
  private readonly releaseCleanReads = new Map<string, number>();
  /** Repairs stopped at a possible device-limit page: accountId → { at, benched }. */
  private readonly stoppedRepairs = new Map<string, { at: number }>();
  /** Accounts whose latest refusal was judged device_limit while the machine floor held benches back. */
  private readonly refusingAlike = new Set<string>();
  /** Ids this module benched, to tell a release it did from one another writer did. */
  private readonly knownBenched = new Set<string>();
  /** When a trigger-source verdict last bypassed the read floor, per account (loop brake). */
  private readonly triggerBypassAt = new Map<string, number>();
  private noticeOpen = false;
  private lastNoticeClearedAt = 0;
  private wasEnabled = true;
  readonly counters = { suspected: 0, benched: 0, released: 0, staleVerdicts: 0, refusingAlikeBlocks: 0, stoppedRepairs: 0 };

  constructor(deps: CodexDeviceLimitTripwireDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.logger = deps.logger ?? { log: () => {}, warn: () => {} };
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      (t as { unref?: () => void }).unref?.();
      return t;
    });
    for (const a of this.codexAccounts()) if (isDeviceLimitBenched(a)) this.knownBenched.add(a.id);
  }

  // ── Read hook (every live Codex read passes here) ───────────────────────────────────────────

  /**
   * Called by the poller after every live Codex read, on every path (scheduled poll, a
   * requested check, a confirmation read). Refusals are judged asynchronously; this never blocks.
   */
  afterCodexRead(account: SubscriptionAccount, outcome: CodexReadOutcome): void {
    if (!this.enabled()) return;
    const id = account.id;
    const at = this.now();
    const current = this.deps.pool.get(id) ?? account;
    if (this.ignored(id)) { this.applyIgnore(current); return; }

    if (outcome.kind === 'ok') {
      this.reads.set(id, { lastCleanAt: at, latestClean: true, latestAt: at });
      this.refusingAlike.delete(id);
      if (current.deviceLimitSuspectedAt && !isDeviceLimitBenched(current)) {
        this.endSuspicion(current, 'clean-read');
      }
      if (isDeviceLimitBenched(current)) this.onBenchedCleanRead(current);
      return;
    }

    const prior = this.reads.get(id);
    this.reads.set(id, { lastCleanAt: prior?.lastCleanAt, latestClean: false, latestAt: at });
    if (!outcome.refusal) return; // a transport failure says nothing either way

    if (isDeviceLimitBenched(current)) {
      // Still refused: no judgement can change a bench; count it for the backoff and breaker.
      this.releaseCleanReads.delete(id);
      if (outcome.scheduled) this.onBenchedScheduledRefusal(current);
      return;
    }

    const source: DeviceLimitSource = outcome.refusal.stage === 'read' ? 'read-refusal' : 'initialize-error';
    this.judge(current, source, outcome.refusal.text, at);
  }

  /** The CLI's own `codex login status` text after an auth-failed read (source A′: trigger only). */
  afterLoginStatusText(account: SubscriptionAccount, text: string): void {
    if (!this.enabled() || this.ignored(account.id) || !text) return;
    const current = this.deps.pool.get(account.id) ?? account;
    if (isDeviceLimitBenched(current)) return;
    this.judge(current, 'login-status', text, this.now());
  }

  /**
   * A sign-in repair page judged as a possible device-limit page, or the helper's own
   * `device-limit` report: the repair is already stopped by the caller; this records it for the
   * machine notice and asks for a fresh read (only that read's verdict can bench).
   */
  onRepairStopped(accountId: string): void {
    if (!this.enabled()) return;
    this.stoppedRepairs.set(accountId, { at: this.now() });
    this.counters.stoppedRepairs++;
    this.deps.log({ action: 'repair-stopped', accountId });
    this.refreshNotice();
    if (!this.ignored(accountId)) this.deps.requestRead(accountId, { confirmation: true });
  }

  // ── Verdicts ────────────────────────────────────────────────────────────────────────────────

  private judge(account: SubscriptionAccount, source: DeviceLimitSource, text: string, at: number): void {
    if (!this.deps.judge) return;
    const fp = credentialFingerprint(account);
    this.deps.judge.enqueue(
      // Only a read refusal can move state; trigger-only sources may reuse a cached verdict, so a
      // login that keeps refusing does not spend its daily judge budget on the same text.
      { accountId: account.id, source, text, email: account.email, nickname: account.nickname, stateChanging: source === 'read-refusal' },
      (result) => {
        try { this.onVerdict(account.id, source, at, fp, result); }
        catch (err) { this.logger.warn(`[DeviceLimit] verdict handling failed for ${account.id}: ${err instanceof Error ? err.message : String(err)}`); }
      },
    );
  }

  private onVerdict(
    accountId: string,
    source: DeviceLimitSource,
    readAt: number,
    fpAtRead: string,
    result: { verdict: DeviceLimitVerdict; decidedBy: string; deciders: number; cached: boolean },
  ): void {
    const account = this.deps.pool.get(accountId);
    if (!account) return;
    const stale = !this.enabled()
      || this.ignored(accountId)
      || (this.reads.get(accountId)?.lastCleanAt ?? 0) > readAt
      || credentialFingerprint(account) !== fpAtRead;
    this.deps.log({ action: 'verdict', accountId, source, verdict: result.verdict, decidedBy: result.decidedBy, deciders: result.deciders, cached: result.cached, ...(stale ? { stale: true } : {}) });
    if (stale) { this.counters.staleVerdicts++; this.deps.log({ action: 'stale-verdict', accountId, source }); return; }
    if (isDeviceLimitBenched(account)) return;

    if (source !== 'read-refusal') {
      // Triggers only: a device_limit reading of these asks for a fresh read, nothing more. It comes
      // from a read that just finished, so it may bypass the 10-minute floor, but at most ONCE per
      // account per window: the read it causes can produce the same trigger again (an initialize
      // error, or login-status text after an auth-failed read), and an unbraked loop would spend
      // the account's judge budget before its real read refusal is judged.
      if (result.verdict === 'device_limit') {
        const last = this.triggerBypassAt.get(accountId);
        const bypass = last === undefined || this.now() - last >= DEVICE_LIMIT_TRIGGER_BYPASS_WINDOW_MS;
        if (bypass) this.triggerBypassAt.set(accountId, this.now());
        this.deps.requestRead(accountId, { confirmation: bypass });
      }
      return;
    }

    if (result.verdict === 'not_device_limit') {
      if (account.deviceLimitSuspectedAt) this.endSuspicion(account, 'not-device-limit');
      this.refusingAlike.delete(accountId);
      return;
    }
    if (result.verdict !== 'device_limit' || result.cached) return; // undecided waits; a cached verdict never moves state

    const suspectedAt = account.deviceLimitSuspectedAt ? Date.parse(account.deviceLimitSuspectedAt) : NaN;
    const sinceFirst = readAt - suspectedAt;
    if (!Number.isFinite(suspectedAt) || sinceFirst > DEVICE_LIMIT_PAIR_MAX_MS) {
      this.suspect(account, readAt);
      return;
    }
    if (sinceFirst < DEVICE_LIMIT_PAIR_MIN_MS) return; // same episode as the first observation
    const floor = this.machineFloor(accountId);
    if (floor === 'unknown') {
      // Not every other account has been read since this process started (e.g. right after a
      // restart): no bench and no "refusing alike" alarm; the next confirmation decides.
      this.deps.log({ action: 'floor-unknown', accountId });
      return;
    }
    if (floor === 'blocked') {
      if (!this.refusingAlike.has(accountId)) this.counters.refusingAlikeBlocks++;
      this.refusingAlike.add(accountId);
      this.deps.log({ action: 'floor-blocked', accountId });
      this.refreshNotice();
      return;
    }
    void this.bench(account);
  }

  private suspect(account: SubscriptionAccount, at: number): void {
    this.deps.pool.update(account.id, { deviceLimitSuspectedAt: new Date(at).toISOString() });
    this.counters.suspected++;
    this.deps.log({ action: 'suspected', accountId: account.id });
    this.setTimer(() => {
      const now = this.deps.pool.get(account.id);
      if (now?.deviceLimitSuspectedAt && !isDeviceLimitBenched(now) && this.enabled()) {
        this.deps.requestRead(account.id, { confirmation: true });
      }
    }, DEVICE_LIMIT_CONFIRM_DELAY_MS);
  }

  private endSuspicion(account: SubscriptionAccount, why: string): void {
    this.deps.pool.update(account.id, { deviceLimitSuspectedAt: null });
    this.deps.log({ action: 'suspicion-ended', accountId: account.id, why });
  }

  /**
   * The machine floor: another Codex account here whose latest completed live read is clean and
   * recent ⇒ 'holds'. Every other account refusing ⇒ 'blocked'. An eligible other account not yet
   * read by this process ⇒ 'unknown' (never an alarm). A machine with no other account ⇒ 'blocked'.
   */
  private machineFloor(accountId: string): 'holds' | 'blocked' | 'unknown' {
    const cutoff = this.now() - DEVICE_LIMIT_FLOOR_WINDOW_MS;
    let unread = false;
    for (const other of this.codexAccounts()) {
      if (other.id === accountId) continue;
      if (isDeviceLimitBenched(other) || other.deviceLimitSuspectedAt) continue;
      const r = this.reads.get(other.id);
      if (!r) { unread = true; continue; }
      if (r.latestClean && (r.lastCleanAt ?? 0) >= cutoff) return 'holds';
    }
    return unread ? 'unknown' : 'blocked';
  }

  // ── Bench and release ───────────────────────────────────────────────────────────────────────

  private async bench(account: SubscriptionAccount): Promise<void> {
    const nowIso = new Date(this.now()).toISOString();
    const wasNeedsReauth = account.status === 'needs-reauth';
    this.deps.pool.update(account.id, {
      status: 'needs-reauth',
      statusCause: 'codex-device-limit',
      deviceLimitSince: nowIso,
      deviceLimitSuspectedAt: null,
      deviceLimitNextReadAt: new Date(this.now() + DEVICE_LIMIT_BACKOFF_BASE_MS).toISOString(),
      deviceLimitRefusedReads: 0,
      deviceLimitReadsStopped: false,
    });
    this.knownBenched.add(account.id);
    this.refusingAlike.delete(account.id);
    this.releaseCleanReads.delete(account.id);
    this.counters.benched++;
    this.deps.log({ action: 'benched', accountId: account.id });
    this.logger.warn(`[DeviceLimit] account ${account.id} benched on this machine (suspected device limit)`);
    try { this.deps.ledger.benched(account.id, wasNeedsReauth); }
    catch (err) { this.logger.warn(`[DeviceLimit] ledger bookkeeping failed for ${account.id}: ${err instanceof Error ? err.message : String(err)}`); }
    this.refreshNotice();
    try { await this.deps.settleRepairs(account.id); }
    catch (err) { this.logger.warn(`[DeviceLimit] settling repairs failed for ${account.id}: ${err instanceof Error ? err.message : String(err)}`); }
    try { await this.deps.moveSessions(account.id); }
    catch (err) { this.logger.warn(`[DeviceLimit] moving sessions failed for ${account.id}: ${err instanceof Error ? err.message : String(err)}`); }
  }

  private onBenchedCleanRead(account: SubscriptionAccount): void {
    // A clean read resets the breaker and its count (spec §6): checks resume on the normal backoff.
    if ((account.deviceLimitRefusedReads ?? 0) > 0 || account.deviceLimitReadsStopped) {
      this.deps.pool.update(account.id, { deviceLimitRefusedReads: 0, deviceLimitReadsStopped: false });
    }
    const n = (this.releaseCleanReads.get(account.id) ?? 0) + 1;
    this.releaseCleanReads.set(account.id, n);
    if (n === 1) {
      this.setTimer(() => {
        const now = this.deps.pool.get(account.id);
        if (now && isDeviceLimitBenched(now) && this.enabled()) this.deps.requestRead(account.id, { confirmation: true });
      }, DEVICE_LIMIT_CONFIRM_DELAY_MS);
      return;
    }
    this.release(account, 'provider');
  }

  private release(account: SubscriptionAccount, why: 'provider' | 'ignored' | 'switch-off'): void {
    this.deps.pool.update(account.id, { status: 'active' }); // the store rule clears the bench fields
    this.knownBenched.delete(account.id);
    this.releaseCleanReads.delete(account.id);
    this.counters.released++;
    const observed = why === 'provider' ? 'released-without-sign-in' : why;
    this.deps.log({ action: 'released', accountId: account.id, observed });
    try { this.deps.ledger.released(account.id); }
    catch (err) { this.logger.warn(`[DeviceLimit] ledger release failed for ${account.id}: ${err instanceof Error ? err.message : String(err)}`); }
    this.refreshNotice();
  }

  private onBenchedScheduledRefusal(account: SubscriptionAccount): void {
    const refused = (account.deviceLimitRefusedReads ?? 0) + 1;
    const delay = Math.min(DEVICE_LIMIT_BACKOFF_CAP_MS, DEVICE_LIMIT_BACKOFF_BASE_MS * 2 ** Math.min(refused, 10));
    const atCap = delay >= DEVICE_LIMIT_BACKOFF_CAP_MS;
    const capRefusals = atCap ? refused : 0;
    const stop = atCap && capRefusals >= DEVICE_LIMIT_BREAKER_REFUSALS + 3; // 3 doublings reach the 6 h cap
    this.deps.pool.update(account.id, {
      deviceLimitRefusedReads: refused,
      deviceLimitNextReadAt: new Date(this.now() + delay).toISOString(),
      ...(stop ? { deviceLimitReadsStopped: true } : {}),
    });
    if (stop && !account.deviceLimitReadsStopped) {
      this.deps.log({ action: 'breaker', accountId: account.id });
      this.logger.warn(`[DeviceLimit] account ${account.id}: automatic checks stopped after ~2 days of refusals (breaker)`);
      this.refreshNotice();
    }
  }

  /** Scheduled-read backoff: the poller asks before each scheduled read of an account. */
  skipScheduledRead(account: SubscriptionAccount): boolean {
    if (!this.enabled() || !isDeviceLimitBenched(account)) return false;
    if (account.deviceLimitReadsStopped) return true;
    const next = account.deviceLimitNextReadAt ? Date.parse(account.deviceLimitNextReadAt) : NaN;
    return Number.isFinite(next) && this.now() < next;
  }

  /** The restore hold: a benched account is never restored by the poller's single clean read. */
  holdsRestore(accountId: string): boolean {
    if (!this.enabled()) return false;
    const account = this.deps.pool.get(accountId);
    return !!account && isDeviceLimitBenched(account);
  }

  // ── Periodic upkeep (driven from the poller's pass) ─────────────────────────────────────────

  /**
   * Once per poll pass: switch-off cleanup, ignore list, suspicion expiry, notice refresh, and
   * noticing a bench another writer ended (operator set-active, a successful repair).
   */
  tick(): void {
    const enabled = this.enabled();
    if (!enabled) {
      if (this.wasEnabled) this.switchOff();
      this.wasEnabled = false;
      return;
    }
    this.wasEnabled = true;
    const nowMs = this.now();
    for (const account of this.codexAccounts()) {
      if (this.ignored(account.id)) { this.applyIgnore(account); continue; }
      const sAt = account.deviceLimitSuspectedAt ? Date.parse(account.deviceLimitSuspectedAt) : NaN;
      if (Number.isFinite(sAt) && nowMs - sAt > DEVICE_LIMIT_PAIR_MAX_MS && !isDeviceLimitBenched(account)) {
        this.endSuspicion(account, 'suspicion-expired');
        this.refusingAlike.delete(account.id);
      }
      if (this.knownBenched.has(account.id) && !isDeviceLimitBenched(account)) {
        this.knownBenched.delete(account.id);
        this.deps.log({ action: 'released', accountId: account.id, observed: account.status === 'active' ? 'operator-released' : 'released-by-other-writer' });
      }
      if (isDeviceLimitBenched(account)) this.knownBenched.add(account.id);
    }
    this.refreshNotice();
  }

  private switchOff(): void {
    for (const account of this.codexAccounts()) {
      if (isDeviceLimitBenched(account)) this.release(account, 'switch-off');
      else if (account.deviceLimitSuspectedAt) this.endSuspicion(account, 'switch-off');
    }
    this.refusingAlike.clear();
    this.stoppedRepairs.clear();
    this.releaseCleanReads.clear();
    this.deps.notice(null);
    this.noticeOpen = false;
  }

  private applyIgnore(account: SubscriptionAccount): void {
    if (isDeviceLimitBenched(account)) this.release(account, 'ignored');
    else if (account.deviceLimitSuspectedAt) this.endSuspicion(account, 'ignored');
    this.refusingAlike.delete(account.id);
  }

  // ── The per-machine notice ──────────────────────────────────────────────────────────────────

  refreshNotice(): void {
    const nowMs = this.now();
    for (const [id, s] of this.stoppedRepairs) {
      if (nowMs - s.at > DEVICE_LIMIT_STOPPED_REPAIR_WINDOW_MS) this.stoppedRepairs.delete(id);
    }
    const accounts = this.codexAccounts();
    const benched = accounts.filter((a) => isDeviceLimitBenched(a) && !this.ignored(a.id));
    const stopped = [...this.stoppedRepairs.keys()].filter((id) => !this.ignored(id));
    const alike = this.refusingAlike.size > 0;
    if (benched.length === 0 && stopped.length === 0 && !alike) {
      if (this.noticeOpen) { this.deps.notice(null); this.noticeOpen = false; this.lastNoticeClearedAt = nowMs; }
      return;
    }
    const signedIn = accounts.some((a) => a.status === 'active' && !a.deviceLimitSuspectedAt);
    const priority: DeviceLimitNotice['priority'] = alike || (benched.length > 0 && !signedIn) ? 'HIGH' : benched.length > 0 ? 'normal' : 'low';
    const name = (id: string) => escapeHtml(this.deps.pool.get(id)?.nickname || id);
    const lines: string[] = [];
    for (const a of benched) {
      lines.push(a.deviceLimitReadsStopped
        ? `${name(a.id)}: refused for about two days; automatic checks have stopped.`
        : `${name(a.id)}: benched here since ${a.deviceLimitSince ?? 'recently'}. Its refusals look like OpenAI's device limit (judged twice; not proven to come from OpenAI).`);
    }
    for (const id of stopped) {
      if (benched.some((a) => a.id === id)) continue;
      lines.push(`${name(id)}: a sign-in attempt stopped at what looked like a device-limit page. A fresh check was asked for; nothing is benched, and if that check does not confirm a lockout the repair is retried on its usual slow schedule.`);
    }
    if (alike) lines.push('Every Codex account here is refusing in the same way, so this is probably not the device limit. Nothing is benched.');
    lines.push(benched.length > 0
      ? 'Benched accounts are skipped on this machine only; other machines and accounts carry on, and no sign-in will be tried here. Signing out of another account does not free a slot, so the real choice is which machine keeps which accounts. Leaving them benched is fine; to keep using one here anyway, tell me and I will add it to this machine\'s ignore list.'
      : 'Nothing has been benched.');
    const reopenInsideBrake = !this.noticeOpen && this.lastNoticeClearedAt > 0 && nowMs - this.lastNoticeClearedAt < DEVICE_LIMIT_RENOTIFY_BRAKE_MS;
    this.deps.notice({
      machineId: this.deps.machineId,
      priority,
      title: benched.length > 0 ? `Codex device limit: ${benched.length} account${benched.length === 1 ? '' : 's'} benched on this machine` : 'Codex device limit: possible lockout seen on this machine',
      body: lines.join('\n'),
      silent: reopenInsideBrake,
    });
    this.noticeOpen = true;
  }

  /** Attention resolver answer for this machine's row. */
  noticeCondition(): 'cleared' | 'active' {
    const benched = this.codexAccounts().some((a) => isDeviceLimitBenched(a) && !this.ignored(a.id));
    return benched || this.stoppedRepairs.size > 0 || this.refusingAlike.size > 0 ? 'active' : 'cleared';
  }

  status(): Record<string, unknown> {
    const accounts = this.codexAccounts();
    return {
      enabled: this.enabled(),
      suspectedNow: accounts.filter((a) => !!a.deviceLimitSuspectedAt && !isDeviceLimitBenched(a)).length,
      benchedNow: accounts.filter((a) => isDeviceLimitBenched(a)).length,
      refusingAlike: this.refusingAlike.size > 0,
      stoppedRepairsNow: this.stoppedRepairs.size,
      totals: { ...this.counters },
    };
  }

  // ── helpers ─────────────────────────────────────────────────────────────────────────────────

  private enabled(): boolean {
    try { return this.deps.config().enabled; } catch { return false; } // @silent-fallback-ok — unreadable config ⇒ today's behaviour
  }

  private ignored(accountId: string): boolean {
    try { return this.deps.config().ignoreAccounts.includes(accountId); } catch { return false; } // @silent-fallback-ok — unreadable config ⇒ not ignored
  }

  private codexAccounts(): SubscriptionAccount[] {
    try { return this.deps.pool.list().filter((a) => a.framework === 'codex-cli' && a.provider === 'openai'); }
    catch { return []; } // @silent-fallback-ok — an unreadable pool has no accounts to judge
  }
}

/** Identity of the login sitting in the slot, without reading the credential: home + email + enrollment time. */
function credentialFingerprint(account: SubscriptionAccount): string {
  return createHash('sha256').update(`${account.configHome}\n${account.email ?? ''}\n${account.enrolledAt ?? ''}`).digest('hex').slice(0, 16);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

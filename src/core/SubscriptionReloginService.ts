import type { SubscriptionReloginOrchestrator } from './SubscriptionReloginOrchestrator.js';
import {
  isSlowRetryEligible,
  type SubscriptionReloginEpisode,
  type SubscriptionReloginStore,
} from './SubscriptionReloginStore.js';
import { governor, consumeAdmissionToken } from '../monitoring/selfaction/governor.js';
import type { DerivedTarget } from '../monitoring/selfaction/types.js';

/**
 * Slow automatic retry of a failed repair (spec relogin-unattended-agent-session-and-slow-retry).
 * The n-th retry is due `delaysMs[min(n, last)]` after the failure; at most `maxRetries` per
 * episode (one episode per source incident).
 */
export const DEFAULT_SLOW_RETRY = Object.freeze({ delaysMs: Object.freeze([6 * 60 * 60_000, 24 * 60 * 60_000]), maxRetries: 3,
  quietHours: Object.freeze({ startHour: 23, endHour: 8 }) });
export interface SlowRetryPolicy {
  enabled: boolean; delaysMs: readonly number[]; maxRetries: number;
  /**
   * Local-time window (this machine's clock) in which an approval-mode RE-OFFER is never sent;
   * a re-offer that falls due inside it waits until `endHour`. `null` disables the window.
   */
  quietHours: { startHour: number; endHour: number } | null;
}

/** The next moment outside the quiet window (local time), or `at` itself when it is outside. */
export function outsideQuietHours(at: number, quiet: SlowRetryPolicy['quietHours']): number {
  if (!quiet || quiet.startHour === quiet.endHour) return at;
  const d = new Date(at);
  const hour = d.getHours() + d.getMinutes() / 60;
  const inside = quiet.startHour > quiet.endHour
    ? hour >= quiet.startHour || hour < quiet.endHour
    : hour >= quiet.startHour && hour < quiet.endHour;
  if (!inside) return at;
  const end = new Date(at);
  end.setHours(quiet.endHour, 0, 0, 0);
  if (end.getTime() <= at) end.setDate(end.getDate() + 1);
  return end.getTime();
}

export interface SubscriptionReloginCandidate {
  sourceEpisodeId: number; accountId: string; machineId: string;
  mode: 'observe' | 'approval' | 'unattended'; inputDigest: string;
  profileId: string; framework: string; provider: string;
  /** The login method the candidate was admitted under (recorded on the episode). */
  loginMethod?: string | null;
}
export interface SubscriptionReloginServiceDeps {
  store: SubscriptionReloginStore;
  orchestrator: SubscriptionReloginOrchestrator;
  scanCandidates: () => Promise<SubscriptionReloginCandidate[]>;
  /**
   * Recompute the entire authoritative input digest at the approval boundary. `mode` is the mode the
   * fresh admission resolved (used by the slow retry; absent ⇒ the slow retry refuses).
   */
  revalidate: (episode: SubscriptionReloginEpisode) => Promise<
    { admissible: true; inputDigest: string; mode?: 'observe' | 'approval' | 'unattended'; profileId?: string; loginMethod?: string | null }
    | { admissible: false; reason: string }>;
  /** True while the episode's source sign-in incident is still open (cheap pre-check for the slow retry). */
  sourceIncidentOpen?: (episode: SubscriptionReloginEpisode) => boolean;
  /** Slow automatic retry of failed repairs. Absent ⇒ {@link DEFAULT_SLOW_RETRY}, enabled. */
  slowRetry?: { enabled?: boolean; delaysMs?: number[]; maxRetries?: number; quietHours?: SlowRetryPolicy['quietHours'] };
  onSuggested?: (episode: SubscriptionReloginEpisode, deliveryKey: string) => Promise<void> | void;
  onTerminal?: (episode: SubscriptionReloginEpisode, deliveryKey: string) => Promise<void> | void;
  onOperatorOnly?: (episode: SubscriptionReloginEpisode, deliveryKey: string) => Promise<void> | void;
  /** The fixed "tap Yes on your phone" notice a sign-in helper asked for (spec skill-driven-signin-repair). */
  onPhoneTap?: (episode: SubscriptionReloginEpisode, deliveryKey: string) => Promise<void> | void;
  /**
   * True when the server itself has verified this episode's account×machine cell healthy (an
   * authenticated read with a matching identity). An open repair on such a cell is closed as
   * `resolved-elsewhere` — the account was signed in another way. Absent ⇒ never closes.
   */
  cellHealthy?: (episode: SubscriptionReloginEpisode) => boolean;
  /**
   * codex-device-limit-tripwire §4: true while the episode's account is suspected or benched for a
   * device limit on this machine (read from the pool record, switch-aware). A slow retry is
   * deferred while it holds; the episode itself is never mutated by suspicion.
   */
  deviceLimitHold?: (episode: SubscriptionReloginEpisode) => boolean;
  tickMs?: number;
  now?: () => number;
}

/** Timer owner and single-flight boundary around the deterministic orchestrator. */
/* @self-action-controller: subscription-relogin-redrive */
// Unified self-action backpressure: every slow automatic retry rides the SelfActionGovernor
// chokepoint ADDITIVELY on top of the durable per-episode cap (slowRetryCount ≤ maxRetries) and the
// multi-hour delays. Observe mode records the would-verdict and always allows.
const reloginRedriveGov = governor.for('subscription-relogin-redrive');
function cellOffsetMs(episode: Pick<SubscriptionReloginEpisode, 'accountId' | 'machineId'>): number {
  let h = 0;
  for (const ch of `${episode.accountId}:${episode.machineId}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h % 60) * 60_000;
}
function deriveTargetKey(episode: Pick<SubscriptionReloginEpisode, 'accountId' | 'machineId'>): DerivedTarget {
  return { key: `subscription-relogin-redrive:${episode.accountId}:${episode.machineId}`, classId: 'subscription-relogin-redrive', keyIsVolatile: false };
}

export class SubscriptionReloginService {
  private readonly tickMs: number;
  private readonly slowRetry: SlowRetryPolicy;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private readonly inFlight = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly deps: SubscriptionReloginServiceDeps) {
    this.tickMs = Math.max(5_000, Math.min(15 * 60_000, Math.floor(deps.tickMs ?? 30_000)));
    const rawDelays: unknown = deps.slowRetry?.delaysMs;
    const delays = (Array.isArray(rawDelays) ? rawDelays : [])
      .filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms))
      .map((ms) => Math.max(60_000, Math.min(7 * 24 * 60 * 60_000, Math.floor(ms))));
    const rawMax = deps.slowRetry?.maxRetries;
    const rawQuiet = deps.slowRetry?.quietHours;
    const validHour = (h: unknown): h is number => typeof h === 'number' && Number.isInteger(h) && h >= 0 && h <= 23;
    this.slowRetry = {
      // Only an explicit off turns it off (a boolean false, or the string "false" from a hand edit).
      enabled: !(deps.slowRetry?.enabled === false || (deps.slowRetry?.enabled as unknown) === 'false'),
      delaysMs: delays.length > 0 ? delays : DEFAULT_SLOW_RETRY.delaysMs,
      maxRetries: Math.max(0, Math.min(10, Math.floor(typeof rawMax === 'number' && Number.isFinite(rawMax) ? rawMax : DEFAULT_SLOW_RETRY.maxRetries))),
      quietHours: rawQuiet === null ? null
        : rawQuiet && validHour(rawQuiet.startHour) && validHour(rawQuiet.endHour) ? { startHour: rawQuiet.startHour, endHour: rawQuiet.endHour }
          : { ...DEFAULT_SLOW_RETRY.quietHours },
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  async approve(episodeId: string): Promise<SubscriptionReloginEpisode> {
    return this.approveWithAuthority(episodeId, 'operator');
  }

  private async approveWithAuthority(episodeId: string, authority: 'operator' | 'unattended-policy'): Promise<SubscriptionReloginEpisode> {
    const episode = this.mustGet(episodeId);
    if (episode.mode === 'observe') throw new Error('relogin-observe-only');
    const verdict = await this.deps.revalidate(episode);
    if (!verdict.admissible) throw new Error(`approval-revalidation-refused:${verdict.reason}`);
    if (verdict.mode === 'observe') throw new Error('relogin-observe-only'); // defence in depth: the fresh mode decides too
    let target = episode;
    if (verdict.inputDigest !== episode.inputDigest) {
      // A suggestion whose admitted inputs changed since it was offered (before the next scan
      // re-admitted it): re-admit it on the CURRENT inputs, then approve with the same authority —
      // the operator's tap (or the unattended policy, only if the fresh mode is unattended) approves
      // what is current. Anything else keeps the refusal.
      const freshMode = verdict.mode;
      // The row must still be the SAME suggestion we revalidated: an operator cancel (or any other
      // transition) during the await wins, and is never re-admitted into a tap-free run here.
      const current = this.deps.store.get(episode.id);
      if (!current || current.version !== episode.version || current.state !== 'suggested'
        || (freshMode !== 'approval' && freshMode !== 'unattended')
        || (authority === 'unattended-policy' && freshMode !== 'unattended'))
        throw new Error('approval-input-digest-mismatch');
      target = this.deps.store.suggest({ sourceEpisodeId: episode.sourceEpisodeId, accountId: episode.accountId,
        machineId: episode.machineId, mode: freshMode, inputDigest: verdict.inputDigest, profileId: verdict.profileId ?? episode.profileId,
        framework: episode.framework, provider: episode.provider, loginMethod: verdict.loginMethod !== undefined ? verdict.loginMethod : episode.loginMethod });
      if (target.inputDigest !== verdict.inputDigest || target.state !== 'suggested'
        || (authority === 'unattended-policy' && target.mode !== 'unattended')) throw new Error('approval-input-digest-mismatch');
    }
    const approved = this.deps.store.approve(target.id, { inputDigest: verdict.inputDigest, authority });
    void this.runEpisode(approved.id);
    return approved;
  }

  /**
   * codex-device-limit-tripwire §4: end every non-terminal repair for this account on this machine
   * because it was benched for a (suspected) device limit. `suggested` → `refused`; any other live
   * state → `failed`; both with failureClass `device-limit` (terminal, never slow-retried, no
   * per-episode notice). The store transition comes first, then a live drive in this process is
   * aborted (the orchestrator reports that ending as terminal). A CAS conflict or invalid
   * transition is returned, never thrown: the bench on the pool record stands regardless.
   */
  async endForDeviceLimit(accountId: string, machineId: string): Promise<Array<{ id: string; ended: boolean; reason?: string }>> {
    const results: Array<{ id: string; ended: boolean; reason?: string }> = [];
    const terminal = new Set(['succeeded', 'refused', 'cancelled', 'failed']);
    const at = new Date((this.deps.now ?? Date.now)()).toISOString();
    for (const episode of this.deps.store.list({ accountId, limit: 500 })) {
      if (episode.machineId !== machineId || terminal.has(episode.state)) continue;
      try {
        this.deps.store.transition(episode.id, {
          expectedVersion: episode.version,
          to: episode.state === 'suggested' ? 'refused' : 'failed',
          eventClass: 'device-limit-stopped',
          failureClass: 'device-limit',
          reason: 'relogin-device-limit-benched',
          at,
        });
        this.controllers.get(episode.id)?.abort();
        results.push({ id: episode.id, ended: true });
      } catch (err) {
        results.push({ id: episode.id, ended: false, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return results;
  }

  private deviceLimitHeld(episode: SubscriptionReloginEpisode): boolean {
    try { return this.deps.deviceLimitHold?.(episode) ?? false; }
    catch { return false; } // @silent-fallback-ok — an unreadable pool never blocks a retry (today's behaviour)
  }

  async cancel(episodeId: string): Promise<SubscriptionReloginEpisode> {
    this.controllers.get(episodeId)?.abort();
    return this.deps.store.cancel(episodeId);
  }

  async retry(episodeId: string): Promise<SubscriptionReloginEpisode> {
    const episode = this.mustGet(episodeId);
    const verdict = await this.deps.revalidate(episode);
    if (!verdict.admissible) throw new Error(`retry-revalidation-refused:${verdict.reason}`);
    if (verdict.inputDigest !== episode.inputDigest) {
      // The inputs changed since the operator last saw this repair: re-offer it on the current
      // inputs for one more tap, rather than refusing the retry outright — but never into a mode
      // that cannot run (observe / dry-run).
      if (verdict.mode !== 'approval' && verdict.mode !== 'unattended') throw new Error('retry-revalidation-refused:observe-only');
      return this.deps.store.slowRetry(episode.id, { expectedVersion: episode.version, inputDigest: verdict.inputDigest,
        mode: 'approval', maxRetries: this.slowRetry.maxRetries, operatorRequested: true,
        profileId: verdict.profileId, loginMethod: verdict.loginMethod });
    }
    const approved = this.deps.store.retryFailed(episode.id, { inputDigest: verdict.inputDigest });
    void this.runEpisode(approved.id);
    return approved;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const candidate of await this.deps.scanCandidates()) {
        let episode: SubscriptionReloginEpisode;
        try { episode = this.deps.store.suggest(candidate); }
        catch { continue; }
        // The STORED mode must agree: a re-admitted operator-cancelled repair is stored as `approval`.
        if (candidate.mode === 'unattended' && episode.mode === 'unattended' && episode.state === 'suggested') {
          try { await this.approveWithAuthority(episode.id, 'unattended-policy'); }
          catch { /* revalidation refusal leaves suggestion visible */ }
        }
      }
      this.closeResolvedElsewhere();
      await this.slowRetryDue();
      const runnable = this.deps.store.list({ limit: 500 }).filter((episode) =>
        !['suggested', 'waiting-operator-only', 'succeeded', 'refused', 'cancelled', 'failed'].includes(episode.state));
      // Detached, like approve()/retry(): an agent-session drive can take up to 15 minutes and must
      // never block scanning or notice delivery. `inFlight` prevents double starts.
      for (const episode of runnable) void this.runEpisode(episode.id);
      await this.drainNotifications();
    } finally {
      this.ticking = false;
    }
  }

  private async runEpisode(id: string): Promise<void> {
    if (this.inFlight.has(id)) return;
    this.inFlight.add(id);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    try {
      await this.deps.orchestrator.tick(id, controller.signal);
      // Terminal and operator-only outcomes each queue a notice; deliver it now rather than a tick
      // later. Claims are atomic, so a concurrent drain never double-sends.
      await this.drainNotifications();
    } catch {
      // @silent-fallback-ok — a tick error (e.g. a version conflict) leaves the durable row as-is;
      // the next tick re-reads it. Detached runs must never surface as an unhandled rejection.
    } finally {
      if (this.controllers.get(id) === controller) this.controllers.delete(id);
      this.inFlight.delete(id);
    }
  }

  /**
   * An open repair must not outlive the problem it was opened for. A cell verified healthy by
   * another path (the 2026-09-25 Laptop case: justin@ signed in by hand, yet the cell kept saying
   * "Sign-in needs your help" for hours) closes its episode through the audited store transition.
   * An episode this process is actively driving is left to its own arbiter.
   */
  private closeResolvedElsewhere(): void {
    if (!this.deps.cellHealthy) return;
    for (const episode of this.deps.store.list({ limit: 500 })) {
      // Only PRE-DRIVE states. A mid-repair episode (cli-finishing / identity-verifying /
      // auth-verifying) is this repair's own verification in progress — closing it would record a
      // real success as cancelled, or skip the wrong-identity quarantine. Those finish through the arbiter.
      if (!['suggested', 'approved', 'waiting-operator-only'].includes(episode.state)) continue;
      if (this.inFlight.has(episode.id)) continue;
      let healthy = false;
      try { healthy = this.deps.cellHealthy(episode); } catch { healthy = false; } // @silent-fallback-ok — unmeasurable ⇒ leave it open
      if (!healthy) continue;
      try { this.deps.store.resolveElsewhere(episode.id); }
      catch { /* @silent-fallback-ok — a concurrent transition won; the next tick re-reads */ }
    }
  }

  /**
   * Slow automatic retry (spec relogin-unattended-agent-session-and-slow-retry). A `failed` repair
   * with a non-safety failure class (and no operator hold), whose source incident is still open and
   * whose per-episode cap is not spent, first gets its next retry time recorded (visible on the
   * dashboard), and once due re-runs the FULL admission: unattended → a fresh attempt starts with
   * no tap; approval → the repair is re-offered (never inside the quiet window). At most one retry
   * starts per machine at a time. A refusal pushes the next check to the longest delay — never a
   * tight loop. `refused` and `cancelled` rows are never touched.
   */
  private async slowRetryDue(): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    const failed = this.deps.store.list({ state: 'failed', limit: 500 });
    if (!this.slowRetry.enabled) {
      // Off: never leave a "next try" on the dashboard that will not happen.
      for (const episode of failed) {
        if (episode.nextAttemptAt === null) continue;
        try { this.deps.store.scheduleSlowRetry(episode.id, episode.version, null); }
        catch { /* @silent-fallback-ok — a concurrent transition won; the next tick re-reads */ }
      }
      return;
    }
    const longest = Math.max(...this.slowRetry.delaysMs);
    let startedThisTick = false;
    for (const episode of failed) {
      if (this.inFlight.has(episode.id)) continue;
      const eligible = isSlowRetryEligible(episode) && episode.slowRetryCount < this.slowRetry.maxRetries
        && !this.deps.store.challengedSinceAdmission(episode.id);
      if (!eligible && episode.nextAttemptAt === null) continue; // nothing to do, no lookup needed
      if (eligible && this.deviceLimitHeld(episode)) continue; // deferred, schedule kept
      try {
        let open = false;
        if (eligible) {
          try { open = this.deps.sourceIncidentOpen ? this.deps.sourceIncidentOpen(episode) : true; }
          catch { continue; } // @silent-fallback-ok — unmeasurable incident ⇒ no change this tick (schedule kept)
        }
        if (!eligible || !open) {
          if (episode.nextAttemptAt !== null) this.deps.store.scheduleSlowRetry(episode.id, episode.version, null);
          continue;
        }
        const delay = this.slowRetry.delaysMs[Math.min(episode.slowRetryCount, this.slowRetry.delaysMs.length - 1)];
        if (episode.nextAttemptAt === null) {
          // Counted from when the failure was SEEN by this tick or when it happened, whichever is
          // later — so long-failed rows do not all fall due at once right after an upgrade.
          const finished = Date.parse(episode.finishedAt ?? episode.updatedAt);
          const fromFailure = Number.isFinite(finished) ? finished + delay : now + delay;
          // Rows already overdue (every long-failed row at upgrade) get a stable per-cell offset of
          // up to an hour, so rows first seen in the same scan do not all fall due together.
          const due = fromFailure > now ? fromFailure : now + delay + cellOffsetMs(episode);
          this.deps.store.scheduleSlowRetry(episode.id, episode.version, new Date(due).toISOString());
          continue; // act on a later tick, after the schedule is durable and visible
        }
        if (Date.parse(episode.nextAttemptAt) > now) continue;
        // One retry per machine at a time: a live repair (or one started this tick) holds the seat.
        if (startedThisTick || this.hasLiveRepair()) continue;
        const verdict = await this.deps.revalidate(episode);
        const current = this.deps.store.get(episode.id);
        if (!current || current.version !== episode.version) continue; // changed underneath; re-read next tick
        if (!verdict.admissible || (verdict.mode !== 'approval' && verdict.mode !== 'unattended')) {
          this.deps.store.scheduleSlowRetry(episode.id, episode.version, new Date(now + longest).toISOString(),
            undefined, `relogin-postponed-${verdict.admissible ? 'no-mode' : verdict.reason}`);
          continue;
        }
        if (verdict.mode === 'approval') {
          const allowed = outsideQuietHours(now, this.slowRetry.quietHours);
          if (allowed > now) {
            this.deps.store.scheduleSlowRetry(episode.id, episode.version, new Date(allowed).toISOString(), undefined, 'relogin-postponed-quiet-hours');
            continue;
          }
        }
        const target = deriveTargetKey(episode);
        const admission = await reloginRedriveGov.admit(target, { incarnation: episode.id, lane: 'job' });
        const sink = admission.outcome === 'allow'
          ? consumeAdmissionToken(admission.token, 'subscription-relogin-redrive', { targetKey: target.key }) : null;
        if (!sink?.proceed) {
          this.deps.store.scheduleSlowRetry(episode.id, episode.version, new Date(now + longest).toISOString(), undefined, 'relogin-postponed-governor');
          continue;
        }
        const retried = this.deps.store.slowRetry(episode.id, { expectedVersion: episode.version,
          inputDigest: verdict.inputDigest, mode: verdict.mode, maxRetries: this.slowRetry.maxRetries,
          profileId: verdict.profileId, loginMethod: verdict.loginMethod });
        startedThisTick = true;
        if (retried.state === 'approved') void this.runEpisode(retried.id);
      } catch {
        // @silent-fallback-ok — a version conflict or store refusal leaves the durable row as-is; the next tick re-reads it.
      }
    }
  }

  /**
   * True while a repair on this machine occupies (or is queued for) its one helper seat: `approved`
   * through `auth-verifying`. A `waiting-operator-only` or `suggested` row holds no seat and must
   * not starve other accounts' retries.
   */
  private hasLiveRepair(): boolean {
    const seatStates = ['approved', 'cli-starting', 'artifact-ready', 'browser-driving', 'cli-finishing', 'identity-verifying', 'auth-verifying'];
    return this.deps.store.list({ limit: 500 }).some((episode) => seatStates.includes(episode.state));
  }

  /**
   * True when a terminal `failed` notice should be held because a slow retry will still follow
   * (Self-Heal Before Notify): the operator hears the outcome once the retries are spent.
   */
  private retryWillFollow(episode: SubscriptionReloginEpisode): boolean {
    if (!this.slowRetry.enabled || !isSlowRetryEligible(episode) || episode.slowRetryCount >= this.slowRetry.maxRetries
      || this.deps.store.challengedSinceAdmission(episode.id)) return false;
    try { return this.deps.sourceIncidentOpen ? this.deps.sourceIncidentOpen(episode) : false; }
    catch { return false; } // @silent-fallback-ok — unmeasurable ⇒ deliver the notice (never hide it)
  }

  private mustGet(id: string): SubscriptionReloginEpisode {
    const episode = this.deps.store.get(id);
    if (!episode) throw new Error('relogin-episode-not-found');
    return episode;
  }
  /** Deliver due notices now (e.g. a time-bound phone-tap request). Safe to call concurrently. */
  async flushNotifications(): Promise<void> {
    try { await this.drainNotifications(); }
    catch { /* @silent-fallback-ok — undelivered notices stay queued for the next tick */ }
  }

  private async drainNotifications(): Promise<void> {
    for (const notification of this.deps.store.claimNotifications(20)) {
      const episode = this.deps.store.get(notification.episodeId);
      try {
        if (!episode) throw new Error('notification-episode-missing');
        if (notification.kind === 'suggested') await this.deps.onSuggested?.(episode, notification.deliveryKey);
        else if (notification.kind === 'operator-only') await this.deps.onOperatorOnly?.(episode, notification.deliveryKey);
        else if (notification.kind === 'phone-tap') await this.deps.onPhoneTap?.(episode, notification.deliveryKey);
        else if (notification.kind === 'terminal' && !['succeeded', 'refused', 'cancelled', 'failed'].includes(episode.state)) {
          // A terminal notice whose repair has since been restarted (a slow retry raced its delivery)
          // is stale: never send "repair ended" for a repair that is running again.
        }
        else if (notification.kind === 'terminal' && episode.state === 'failed' && this.retryWillFollow(episode)) {
          // Held while a slow retry is still coming (Self-Heal Before Notify) — but only up to one
          // retry delay past the failure plus an hour: a retry kept deferred by refusals never
          // hides the outcome indefinitely. A retry that starts deletes this queued notice.
          const finished = Date.parse(episode.finishedAt ?? episode.updatedAt);
          const delay = this.slowRetry.delaysMs[Math.min(episode.slowRetryCount, this.slowRetry.delaysMs.length - 1)];
          // For an approval-mode repair the re-offer cannot go out in quiet hours, so the hold runs
          // until it can — the held notice never arrives at night ahead of the morning re-offer.
          const due = (Number.isFinite(finished) ? finished : 0) + delay;
          const holdUntil = (episode.mode === 'approval' ? outsideQuietHours(due, this.slowRetry.quietHours) : due) + 60 * 60_000;
          const now = (this.deps.now ?? Date.now)();
          if (now < holdUntil) {
            // Re-checked at most hourly (retryNotification caps the delay); each re-claim also raises
            // the notice's attemptCount, so a real delivery failure afterwards starts at a longer backoff.
            this.deps.store.retryNotification(notification.id, holdUntil - now);
            continue;
          }
          await this.deps.onTerminal?.(episode, notification.deliveryKey);
        }
        else await this.deps.onTerminal?.(episode, notification.deliveryKey);
        this.deps.store.completeNotification(notification.id);
      } catch {
        const delay = 5_000 * 2 ** Math.min(6, Math.max(0, notification.attemptCount - 1));
        this.deps.store.retryNotification(notification.id, delay);
      }
    }
  }
}

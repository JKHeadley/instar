import type { SubscriptionReloginOrchestrator } from './SubscriptionReloginOrchestrator.js';
import type {
  SubscriptionReloginEpisode,
  SubscriptionReloginStore,
} from './SubscriptionReloginStore.js';

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
  /** Recompute the entire authoritative input digest at the approval boundary. */
  revalidate: (episode: SubscriptionReloginEpisode) => Promise<{ admissible: true; inputDigest: string } | { admissible: false; reason: string }>;
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
  tickMs?: number;
  now?: () => number;
}

/** Timer owner and single-flight boundary around the deterministic orchestrator. */
/* @self-action-controller: subscription-relogin-redrive */
export class SubscriptionReloginService {
  private readonly tickMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private readonly inFlight = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly deps: SubscriptionReloginServiceDeps) {
    this.tickMs = Math.max(5_000, Math.min(15 * 60_000, Math.floor(deps.tickMs ?? 30_000)));
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
    if (verdict.inputDigest !== episode.inputDigest) throw new Error('approval-input-digest-mismatch');
    const approved = this.deps.store.approve(episode.id, { inputDigest: verdict.inputDigest, authority });
    void this.runEpisode(approved.id);
    return approved;
  }

  async cancel(episodeId: string): Promise<SubscriptionReloginEpisode> {
    this.controllers.get(episodeId)?.abort();
    return this.deps.store.cancel(episodeId);
  }

  async retry(episodeId: string): Promise<SubscriptionReloginEpisode> {
    const episode = this.mustGet(episodeId);
    const verdict = await this.deps.revalidate(episode);
    if (!verdict.admissible) throw new Error(`retry-revalidation-refused:${verdict.reason}`);
    if (verdict.inputDigest !== episode.inputDigest) throw new Error('approval-input-digest-mismatch');
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
        if (candidate.mode === 'unattended' && episode.state === 'suggested') {
          try { await this.approveWithAuthority(episode.id, 'unattended-policy'); }
          catch { /* revalidation refusal leaves suggestion visible */ }
        }
      }
      this.closeResolvedElsewhere();
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
        else await this.deps.onTerminal?.(episode, notification.deliveryKey);
        this.deps.store.completeNotification(notification.id);
      } catch {
        const delay = 5_000 * 2 ** Math.min(6, Math.max(0, notification.attemptCount - 1));
        this.deps.store.retryNotification(notification.id, delay);
      }
    }
  }
}

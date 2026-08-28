import type { SubscriptionReloginOrchestrator } from './SubscriptionReloginOrchestrator.js';
import type {
  SubscriptionReloginEpisode,
  SubscriptionReloginStore,
} from './SubscriptionReloginStore.js';

export interface SubscriptionReloginCandidate {
  sourceEpisodeId: number; accountId: string; machineId: string;
  mode: 'observe' | 'approval' | 'unattended'; inputDigest: string;
  profileId: string; framework: string; provider: string;
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
    const episode = this.mustGet(episodeId);
    if (episode.mode === 'observe') throw new Error('relogin-observe-only');
    const verdict = await this.deps.revalidate(episode);
    if (!verdict.admissible) throw new Error(`approval-revalidation-refused:${verdict.reason}`);
    if (verdict.inputDigest !== episode.inputDigest) throw new Error('approval-input-digest-mismatch');
    const approved = this.deps.store.approve(episode.id, { inputDigest: verdict.inputDigest });
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
          try { await this.approve(episode.id); } catch { /* revalidation refusal leaves suggestion visible */ }
        }
      }
      const runnable = this.deps.store.list({ limit: 500 }).filter((episode) =>
        !['suggested', 'waiting-operator-only', 'succeeded', 'refused', 'cancelled', 'failed'].includes(episode.state));
      await Promise.all(runnable.map((episode) => this.runEpisode(episode.id)));
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
      const result = await this.deps.orchestrator.tick(id, controller.signal);
      if (result.outcome === 'terminal') await this.drainNotifications();
    } finally {
      if (this.controllers.get(id) === controller) this.controllers.delete(id);
      this.inFlight.delete(id);
    }
  }

  private mustGet(id: string): SubscriptionReloginEpisode {
    const episode = this.deps.store.get(id);
    if (!episode) throw new Error('relogin-episode-not-found');
    return episode;
  }
  private async drainNotifications(): Promise<void> {
    for (const notification of this.deps.store.claimNotifications(20)) {
      const episode = this.deps.store.get(notification.episodeId);
      try {
        if (!episode) throw new Error('notification-episode-missing');
        if (notification.kind === 'suggested') await this.deps.onSuggested?.(episode, notification.deliveryKey);
        else if (notification.kind === 'operator-only') await this.deps.onOperatorOnly?.(episode, notification.deliveryKey);
        else await this.deps.onTerminal?.(episode, notification.deliveryKey);
        this.deps.store.completeNotification(notification.id);
      } catch {
        const delay = 5_000 * 2 ** Math.min(6, Math.max(0, notification.attemptCount - 1));
        this.deps.store.retryNotification(notification.id, delay);
      }
    }
  }
}

import fs from 'node:fs';
import path from 'node:path';

export type FeedbackDrainRecoveryClass = 'recoverable-dark-development' | 'recoverable-stalled-drain' | 'critical-corruption';

interface RecoveryEpisode {
  episodeKey: string;
  classification: FeedbackDrainRecoveryClass;
  attempts: number;
  status: 'active' | 'healed' | 'breaker-open' | 'critical-held';
  firstDetectedAt: number;
  updatedAt: number;
  nextAttemptAt: number;
  attentionRaised: boolean;
}

interface RecoveryState {
  schemaVersion: 1;
  episodes: Record<string, RecoveryEpisode>;
  successfulHeals: number[];
  healWindowAttentionAt: number | null;
}

export interface FeedbackDrainSelfHealOptions {
  stateDir: string;
  maxAttempts?: number;
  maxWallClockMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  healWindowMs?: number;
  healWindowThreshold?: number;
  clock?: () => number;
  wait?: (ms: number) => Promise<void>;
  raiseAttention?: (input: { id: string; title: string; summary: string; priority: 'HIGH'; sourceContext: string }) => Promise<unknown> | unknown;
}

export interface FeedbackDrainHealRequest {
  episodeKey: string;
  classification: FeedbackDrainRecoveryClass;
  repair: () => Promise<{ changed: boolean }> | { changed: boolean };
  recheck: () => Promise<boolean> | boolean;
  restart?: () => Promise<void> | void;
  tick: () => Promise<unknown> | unknown;
}

export interface FeedbackDrainHealResult {
  status: 'healed' | 'deduped' | 'backing-off' | 'breaker-open' | 'critical-held';
  attempts: number;
  ticked: boolean;
  restarted: boolean;
}

const emptyState = (): RecoveryState => ({ schemaVersion: 1, episodes: {}, successfulHeals: [], healWindowAttentionAt: null });
const safeKey = (value: string): string => value.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 180);

export function feedbackDrainRecoveryBackoff(attempt: number, baseMs = 1_000, ceilingMs = 30_000): number {
  return Math.min(Math.max(baseMs, ceilingMs), Math.max(1, baseMs) * (2 ** Math.max(0, Math.trunc(attempt) - 1)));
}

/* @self-action-controller: feedback-drain-self-heal */
export class FeedbackDrainSelfHeal {
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly maxWallClockMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly healWindowMs: number;
  private readonly healWindowThreshold: number;
  private readonly statePath: string;
  private readonly auditPath: string;
  private readonly inFlight = new Map<string, Promise<FeedbackDrainHealResult>>();

  constructor(private readonly opts: FeedbackDrainSelfHealOptions) {
    this.now = opts.clock ?? Date.now;
    this.wait = opts.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxAttempts = Math.min(2, Math.max(1, Math.trunc(opts.maxAttempts ?? 2)));
    this.maxWallClockMs = Math.min(120_000, Math.max(1_000, Math.trunc(opts.maxWallClockMs ?? 120_000)));
    this.baseBackoffMs = Math.max(1, Math.min(30_000, Math.trunc(opts.baseBackoffMs ?? 1_000)));
    this.maxBackoffMs = Math.max(this.baseBackoffMs, Math.min(60_000, Math.trunc(opts.maxBackoffMs ?? 30_000)));
    this.healWindowMs = Math.max(60_000, Math.min(24 * 60 * 60_000, Math.trunc(opts.healWindowMs ?? 30 * 60_000)));
    this.healWindowThreshold = Math.max(1, Math.min(10, Math.trunc(opts.healWindowThreshold ?? 3)));
    this.statePath = path.join(opts.stateDir, 'state', 'feedback-factory', 'recovery-state.json');
    this.auditPath = path.join(opts.stateDir, 'logs', 'feedback-factory-drain.jsonl');
  }

  async run(request: FeedbackDrainHealRequest): Promise<FeedbackDrainHealResult> {
    const episodeKey = safeKey(request.episodeKey);
    if (!episodeKey) throw new Error('feedback drain recovery episode key is required');
    const existing = this.inFlight.get(episodeKey);
    if (existing) return existing;
    const running = this.runOnce({ ...request, episodeKey }).finally(() => this.inFlight.delete(episodeKey));
    this.inFlight.set(episodeKey, running);
    return running;
  }

  private async runOnce(request: FeedbackDrainHealRequest): Promise<FeedbackDrainHealResult> {
    const episodeKey = request.episodeKey;
    const state = this.readState();
    const now = this.now();
    let episode = state.episodes[episodeKey];
    if (!episode) {
      episode = { episodeKey, classification: request.classification, attempts: 0, status: 'active', firstDetectedAt: now, updatedAt: now, nextAttemptAt: now, attentionRaised: false };
      state.episodes[episodeKey] = episode;
      this.persist(state);
      this.audit('episode-opened', episode, 'detected');
    }
    if (episode.classification !== request.classification) throw new Error('feedback drain recovery episode classification changed');
    if (episode.status === 'healed') return { status: 'deduped', attempts: episode.attempts, ticked: false, restarted: false };
    if (episode.status === 'breaker-open') return { status: 'breaker-open', attempts: episode.attempts, ticked: false, restarted: false };
    if (episode.status === 'critical-held' || request.classification === 'critical-corruption') {
      episode.status = 'critical-held'; episode.updatedAt = now;
      this.persist(state);
      this.audit('critical-mutation-prohibited', episode, 'preserve-bytes-read-only-diagnosis-only');
      await this.raiseEpisodeAttention(state, episode, 'Critical feedback-drain corruption is mutation-held', 'Automatic config repair, restart, restore, and drain ticks are prohibited until integrity and authority are operator-restored.');
      return { status: 'critical-held', attempts: episode.attempts, ticked: false, restarted: false };
    }
    if (now < episode.nextAttemptAt) return { status: 'backing-off', attempts: episode.attempts, ticked: false, restarted: false };

    const startedAt = now;
    let ticked = false;
    let restarted = false;
    while (episode.attempts < this.maxAttempts && this.now() - startedAt < this.maxWallClockMs) {
      episode.attempts++;
      episode.updatedAt = this.now();
      this.persist(state);
      this.audit('heal-attempt', episode, `attempt-${episode.attempts}`);
      try {
        const repair = await request.repair();
        if (repair.changed && request.restart) { await request.restart(); restarted = true; }
        if (!await request.recheck()) throw new Error('post-repair recheck failed');
        await request.tick(); ticked = true;
        episode.status = 'healed'; episode.updatedAt = this.now(); episode.nextAttemptAt = 0;
        state.successfulHeals = state.successfulHeals.filter((at) => at > this.now() - this.healWindowMs);
        state.successfulHeals.push(this.now());
        this.persist(state);
        this.audit('heal-succeeded', episode, repair.changed ? 'state-changed-rechecked-ticked' : 'rechecked-ticked');
        if (state.successfulHeals.length >= this.healWindowThreshold && (state.healWindowAttentionAt === null || state.healWindowAttentionAt <= this.now() - this.healWindowMs)) {
          state.healWindowAttentionAt = this.now(); this.persist(state);
          await this.opts.raiseAttention?.({ id: `feedback-drain-heal-window:${Math.floor(this.now() / this.healWindowMs)}`, title: 'Feedback drain repeatedly self-healed',
            summary: `${state.successfulHeals.length} bounded feedback-drain heals occurred within 30 minutes; the recovery loop stopped paging per attempt and raised this one aggregate.`, priority: 'HIGH', sourceContext: 'feedback-drain:self-heal' });
        }
        return { status: 'healed', attempts: episode.attempts, ticked, restarted };
      } catch (error) {
        const delay = feedbackDrainRecoveryBackoff(episode.attempts, this.baseBackoffMs, this.maxBackoffMs);
        episode.nextAttemptAt = this.now() + delay; episode.updatedAt = this.now();
        this.persist(state);
        this.audit('heal-failed', episode, error instanceof Error ? error.message : 'unknown-failure');
        if (episode.attempts < this.maxAttempts) {
          if (this.now() - startedAt + delay >= this.maxWallClockMs) break;
          await this.wait(delay);
        }
      }
    }
    episode.status = 'breaker-open'; episode.updatedAt = this.now();
    this.persist(state);
    this.audit('p19-breaker-opened', episode, `max-attempts-${this.maxAttempts}`);
    await this.raiseEpisodeAttention(state, episode, 'Feedback drain self-heal exhausted', `The bounded recovery breaker opened after ${episode.attempts} attempts; automatic retries for this episode stopped.`);
    return { status: 'breaker-open', attempts: episode.attempts, ticked, restarted };
  }

  private async raiseEpisodeAttention(state: RecoveryState, episode: RecoveryEpisode, title: string, summary: string): Promise<void> {
    if (episode.attentionRaised) return;
    episode.attentionRaised = true; episode.updatedAt = this.now(); this.persist(state);
    await this.opts.raiseAttention?.({ id: `feedback-drain-recovery:${episode.episodeKey}`, title, summary, priority: 'HIGH', sourceContext: 'feedback-drain:self-heal' });
  }

  private readState(): RecoveryState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as RecoveryState;
      if (parsed.schemaVersion === 1 && parsed.episodes && Array.isArray(parsed.successfulHeals)) return parsed;
    } catch { /* absent/corrupt controller state starts closed and bounded */ }
    return emptyState();
  }

  private persist(state: RecoveryState): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.statePath);
  }

  private audit(kind: string, episode: RecoveryEpisode, reason: string): void {
    fs.mkdirSync(path.dirname(this.auditPath), { recursive: true });
    fs.appendFileSync(this.auditPath, `${JSON.stringify({ at: new Date(this.now()).toISOString(), kind, episodeKey: episode.episodeKey,
      classification: episode.classification, attempts: episode.attempts, status: episode.status, nextAttemptAt: episode.nextAttemptAt, reason: reason.slice(0, 300) })}\n`, { mode: 0o600 });
  }
}

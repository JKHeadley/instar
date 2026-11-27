/**
 * JobAnomalyEpisodeStore — the machine-local record of what a script job has
 * observed (docs/specs/job-cost-reduction.md §5.4 "Episodes", §13).
 *
 * One episode per `<machineId>:<slug>:<reason id>`. An episode describes THIS
 * machine's disk, sessions and server, observed live, so it never converges
 * across machines: the file is git-sync-excluded (FileClassifier) and written
 * here DIRECTLY and atomically (temp file + rename), never through
 * `StateManager.guardWrite`, so standbys record and expire their own episodes
 * (the same shape as `state/external-hog-arm.json`).
 *
 * This module holds state and the pure transitions on it (open, refresh, clean
 * run, close, stale expiry, recurrence counting, mutes). The decisions about
 * WHEN to raise an item or push live in JobAnomalyPusher.
 *
 * Failure posture: a failed write never throws. The in-memory state stays
 * authoritative for this process (so a push already made is not repeated) and
 * each failed write prints ONE line on stderr (§5.4: at 5% free the disk may
 * already refuse writes; a duplicate alarm after a restart is accepted, a
 * silent one is not).
 *
 * Canary isolation (§5.6.4): a store built with `namespace: 'canary:<runId>:'`
 * prefixes every key it writes and only ever lists keys under that prefix; a
 * real store (no namespace) never lists a `canary:` key. Canary runs use an
 * in-memory store (`filePath: null`) with an injected clock.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export type AnomalyClass = 'critical' | 'recoverable';
export type PushKind = 'critical' | 'persistence' | 'recurrence';

export interface EpisodeHealState {
  /** none → requested → ran | refused. `refused` carries the reason (incl. `triage-disabled`). */
  state: 'none' | 'requested' | 'ran' | 'refused';
  requestedAt: string | null;
  settledAt: string | null;
  reason: string | null;
}

export interface AnomalyEpisode {
  /** `<namespace><machineId>:<slug>:<reasonId>` — the dedupe key. */
  key: string;
  /** Key + opening time: unique per episode (idempotency key root). */
  id: string;
  machineId: string;
  slug: string;
  reasonId: string;
  class: AnomalyClass;
  status: 'open' | 'closed' | 'stale';
  firstSeen: string;
  lastSeen: string;
  severity: 1 | 2 | 3;
  /** Severity the last narration was written for (null = never narrated). */
  narratedSeverity: number | null;
  /** The job's own evidence line for this reason (≤300 chars, never sent through the model). */
  evidence: string;
  /** The calm attention item for this episode was raised. */
  statusLineSent: boolean;
  /** A push for this episode was CONFIRMED delivered (or deliberately suppressed). */
  pushed: boolean;
  pushKind: PushKind | null;
  pushedAt: string | null;
  /** Set when no push will be sent by design (e.g. telegramNotify: false). */
  pushSuppressed: string | null;
  /** A push decided but not yet delivered (retried with the brakes in §5.4). */
  pushDue: PushKind | null;
  pushDueSince: string | null;
  pushAttempts: number;
  lastPushAttemptAt: string | null;
  /** The slug's run counter at the last attempt (spacing is counted in runs). */
  lastPushAttemptRun: number | null;
  /** The one "push could not be delivered" item was raised for this episode. */
  undeliveredRaised: boolean;
  heal: EpisodeHealState;
  /** Consecutive clean (reason-absent, successful) runs. 3 close the episode. */
  cleanStreak: number;
  closedAt?: string;
  closeReason?: string;
}

interface StoreFile {
  version: 1;
  episodes: Record<string, AnomalyEpisode>;
  closed: AnomalyEpisode[];
  /** Episode opening times (ms) per key, trimmed to the recurrence window. */
  openings: Record<string, number[]>;
  /** Recurrence/persistence mute expiry (ms) per key. */
  mutedUntil: Record<string, number>;
  /** Per namespaced slug: last run on THIS machine + a monotone run counter. */
  runs: Record<string, { lastRunAt: number; count: number }>;
}

export const EPISODE_CLOSE_CLEAN_RUNS = 3;
export const EPISODE_STALE_INTERVALS = 3;
export const RECURRENCE_WINDOW_MS = 6 * 60 * 60 * 1000;
export const RECURRENCE_THRESHOLD = 3;
export const RECURRENCE_MUTE_MS = 24 * 60 * 60 * 1000;
const CLOSED_KEEP = 100;

export interface JobAnomalyEpisodeStoreOptions {
  /** Absolute path of the store file; null ⇒ in-memory only (canaries, tests). */
  filePath: string | null;
  /** Key prefix, e.g. `canary:<runId>:`. Default '' (the real store). */
  namespace?: string;
  now?: () => number;
  /** One line per failed write. Default: process.stderr. */
  warn?: (msg: string) => void;
}

function emptyFile(): StoreFile {
  return { version: 1, episodes: {}, closed: [], openings: {}, mutedUntil: {}, runs: {} };
}

export class JobAnomalyEpisodeStore {
  readonly filePath: string | null;
  readonly namespace: string;
  private readonly now: () => number;
  private readonly warn: (msg: string) => void;
  private data: StoreFile;
  /** Count of writes that failed (observability + tests). */
  failedWrites = 0;

  constructor(opts: JobAnomalyEpisodeStoreOptions) {
    this.filePath = opts.filePath;
    this.namespace = opts.namespace ?? '';
    this.now = opts.now ?? Date.now;
    this.warn = opts.warn ?? ((m) => { process.stderr.write(m + '\n'); });
    this.data = this.load();
  }

  /** Default on-disk location under an agent's `.instar/` state dir. */
  static defaultPath(stateDir: string): string {
    return path.join(stateDir, 'state', 'job-anomaly-episodes.json');
  }

  private load(): StoreFile {
    if (!this.filePath) return emptyFile();
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<StoreFile>;
      if (!raw || typeof raw !== 'object' || raw.version !== 1) return emptyFile();
      return {
        version: 1,
        episodes: raw.episodes && typeof raw.episodes === 'object' ? raw.episodes : {},
        closed: Array.isArray(raw.closed) ? raw.closed : [],
        openings: raw.openings && typeof raw.openings === 'object' ? raw.openings : {},
        mutedUntil: raw.mutedUntil && typeof raw.mutedUntil === 'object' ? raw.mutedUntil : {},
        runs: raw.runs && typeof raw.runs === 'object' ? raw.runs : {},
      };
    } catch {
      // @silent-fallback-ok: absent or unreadable file ⇒ no episodes yet. An
      // unreadable file costs at most one repeat calm item / push (accepted, §5.4).
      return emptyFile();
    }
  }

  /** Atomic write (temp + rename). Never throws; false + one stderr line on failure. */
  save(): boolean {
    if (!this.filePath) return true;
    const tmp = `${this.filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath); // atomic on POSIX: readers see old-or-new
      return true;
    } catch (err) {
      this.failedWrites++;
      this.warn(`[JobAnomalyEpisodeStore] write failed (${path.basename(this.filePath)}): ${(err as Error).message}`);
      try { SafeFsExecutor.safeRmSync(tmp, { force: true, operation: 'JobAnomalyEpisodeStore.save.cleanup' }); }
      catch { /* @silent-fallback-ok: best-effort temp cleanup */ }
      return false;
    }
  }

  // ── keys + namespace ──────────────────────────────────────────────

  key(machineId: string, slug: string, reasonId: string): string {
    return `${this.namespace}${machineId}:${slug}:${reasonId}`;
  }

  private inNamespace(key: string): boolean {
    if (this.namespace) return key.startsWith(this.namespace);
    return !key.startsWith('canary:');
  }

  private slugKey(slug: string): string {
    return `${this.namespace}${slug}`;
  }

  // ── runs ──────────────────────────────────────────────────────────

  /** Record a run of `slug` on this machine (any result). Returns the new run counter. */
  recordRun(slug: string, at = this.now()): number {
    const k = this.slugKey(slug);
    const prev = this.data.runs[k];
    const count = (prev?.count ?? 0) + 1;
    this.data.runs[k] = { lastRunAt: at, count };
    return count;
  }

  runCount(slug: string): number {
    return this.data.runs[this.slugKey(slug)]?.count ?? 0;
  }

  lastRunAt(slug: string): number | null {
    return this.data.runs[this.slugKey(slug)]?.lastRunAt ?? null;
  }

  // ── episodes ──────────────────────────────────────────────────────

  get(key: string): AnomalyEpisode | undefined {
    return this.data.episodes[key];
  }

  listOpen(slug?: string): AnomalyEpisode[] {
    return Object.values(this.data.episodes)
      .filter(e => this.inNamespace(e.key) && (slug === undefined || e.slug === slug));
  }

  /** Open + recently closed episodes of a slug — for `buildLocalJobs` / `GET /jobs?scope=pool`. */
  episodesForSlug(slug: string, closedLimit = 10): { open: AnomalyEpisode[]; recentClosed: AnomalyEpisode[] } {
    return {
      open: this.listOpen(slug),
      recentClosed: this.data.closed.filter(e => this.inNamespace(e.key) && e.slug === slug).slice(-closedLimit),
    };
  }

  open(input: { machineId: string; slug: string; reasonId: string; class: AnomalyClass; severity: 1 | 2 | 3; evidence: string; at?: number }): AnomalyEpisode {
    const at = input.at ?? this.now();
    const key = this.key(input.machineId, input.slug, input.reasonId);
    const iso = new Date(at).toISOString();
    const ep: AnomalyEpisode = {
      key, id: `${key}:${at}`,
      machineId: input.machineId, slug: input.slug, reasonId: input.reasonId, class: input.class,
      status: 'open', firstSeen: iso, lastSeen: iso,
      severity: input.severity, narratedSeverity: null, evidence: input.evidence.slice(0, 300),
      statusLineSent: false,
      pushed: false, pushKind: null, pushedAt: null, pushSuppressed: null,
      pushDue: null, pushDueSince: null, pushAttempts: 0, lastPushAttemptAt: null, lastPushAttemptRun: null,
      undeliveredRaised: false,
      heal: { state: 'none', requestedAt: null, settledAt: null, reason: null },
      cleanStreak: 0,
    };
    this.data.episodes[key] = ep;
    const list = (this.data.openings[key] ?? []).filter(t => at - t < RECURRENCE_WINDOW_MS);
    list.push(at);
    this.data.openings[key] = list;
    return ep;
  }

  /** Episodes opened for `key` within the recurrence window (incl. the current one). */
  openingsInWindow(key: string, at = this.now()): number {
    return (this.data.openings[key] ?? []).filter(t => at - t < RECURRENCE_WINDOW_MS).length;
  }

  isMuted(key: string, at = this.now()): boolean {
    const until = this.data.mutedUntil[key];
    return typeof until === 'number' && at < until;
  }

  mute(key: string, at = this.now()): void {
    this.data.mutedUntil[key] = at + RECURRENCE_MUTE_MS;
  }

  /** Close an open episode (clean runs or stale) and move it to the closed list. */
  close(key: string, reason: string, status: 'closed' | 'stale' = 'closed', at = this.now()): AnomalyEpisode | undefined {
    const ep = this.data.episodes[key];
    if (!ep) return undefined;
    delete this.data.episodes[key];
    ep.status = status;
    ep.closedAt = new Date(at).toISOString();
    ep.closeReason = reason;
    this.data.closed.push(ep);
    if (this.data.closed.length > CLOSED_KEEP) this.data.closed.splice(0, this.data.closed.length - CLOSED_KEEP);
    return ep;
  }

  /**
   * Close open episodes of jobs this machine no longer runs (§5.4 "Expiry"):
   * no run here for 3 cron intervals. Called on every scheduler tick and when
   * `buildLocalJobs` reads the store. `intervalFor` returns the slug's cron
   * interval in ms (null ⇒ unknown, never expired). Returns the closed episodes
   * so the caller can clear their calm items. Does NOT save.
   */
  expireStale(now: number, intervalFor: (slug: string) => number | null): AnomalyEpisode[] {
    const out: AnomalyEpisode[] = [];
    for (const ep of this.listOpen()) {
      const interval = intervalFor(ep.slug);
      if (interval === null || !(interval > 0)) continue;
      const last = this.lastRunAt(ep.slug) ?? Date.parse(ep.lastSeen);
      if (!Number.isFinite(last)) continue;
      if (now - last > EPISODE_STALE_INTERVALS * interval) {
        const closed = this.close(ep.key, 'stale: job no longer runs here', 'stale', now);
        if (closed) out.push(closed);
      }
    }
    return out;
  }

  /** Test/diagnostic: a deep copy of the persisted shape. */
  snapshot(): StoreFile {
    return structuredClone(this.data);
  }
}

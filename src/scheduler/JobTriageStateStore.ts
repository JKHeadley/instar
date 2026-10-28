/**
 * JobTriageStateStore — the machine-local triage state
 * (`.instar/state/job-triage-state.json`, job-cost-reduction §5.6.2/§5.6.3/§13).
 *
 * Holds what must survive a restart for the bounds to hold: per-condition
 * cooldowns, the daily session counts (per slug and per machine), the
 * once-a-day cap/critical-bypass marks, the per-episode session record, the
 * fingerprint answer cache, the backup check's cursors + pending batch ids,
 * the routine-run pool the backup check samples from, and the last triage
 * sessions' (already scrubbed, clamped) final outputs.
 *
 * Machine-local by design (§13: the caps bound sessions spawned into THIS
 * host's process slots, the backup cursor points into THIS machine's run
 * history). Written atomically (tmp + rename) outside guardWrite, and only
 * when the serialized content changed. An unreadable file starts fresh: the
 * caps then re-seed from zero for the rest of the day, which can only ADD at
 * most one day's sessions — logged, never thrown.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface TriageEpisodeRecord {
  at: string;
  slug: string;
  sessionName?: string;
  /** spawned | refused:<reason> | suppressed-* */
  outcome: string;
}

export interface TriageSessionRecord {
  sessionName: string;
  slug: string;
  runId: string;
  startedAt: string;
  endedAt?: string;
  /** Scrubbed final output, ≤2,000 chars; first line ≤200 for structured-only slugs. */
  output?: string;
  outcome?: string;
  episodeId?: string;
  origin: 'floor' | 'cascade' | 'backup' | 'heal';
}

export interface RoutinePoolEntry {
  runId: string;
  finishedAt: string;
  fp: string;
  /** Non-ok result or anomaly-bearing — read first. */
  priority: boolean;
  /** The run's evidence projection, clamped to 1,000 characters. */
  evidence: string;
}

export interface FingerprintEntry {
  fp: string;
  at: string;
  decision: 'routine' | 'needs_session';
  decider: string;
}

export interface TriageState {
  version: 1;
  /** `<slug>:<reason set>` → ISO time of the last session spawned for it. */
  cooldowns: Record<string, string>;
  /** `<slug>:<reason set>` → UTC day the critical bypass was used. */
  criticalBypass: Record<string, string>;
  daily: { day: string; perSlug: Record<string, number>; machine: number; capItemDay?: string };
  episodes: Record<string, TriageEpisodeRecord>;
  fingerprints: Record<string, FingerprintEntry[]>;
  backup: {
    cursors: Record<string, string>;
    /** Run ids selected for the in-flight / failed batch, per slug (retried next pass). */
    pending: Record<string, string[]>;
    routine: Record<string, RoutinePoolEntry[]>;
    /** Routine runs seen since the cursor, per slug (duplicates included). */
    seen: Record<string, number>;
    lastPassAt?: string;
    consecutiveFailures: number;
    lastConsidered?: Record<string, { considered: number; read: number; unread: number; at: string }>;
  };
  sessions: TriageSessionRecord[];
}

export const MAX_FINGERPRINTS_PER_SLUG = 20;
export const MAX_ROUTINE_PER_SLUG = 100;
export const MAX_SESSION_RECORDS = 50;
export const MAX_EPISODES = 200;

export function emptyTriageState(): TriageState {
  return {
    version: 1,
    cooldowns: {},
    criticalBypass: {},
    daily: { day: '', perSlug: {}, machine: 0 },
    episodes: {},
    fingerprints: {},
    backup: { cursors: {}, pending: {}, routine: {}, seen: {}, consecutiveFailures: 0 },
    sessions: [],
  };
}

function normalize(raw: unknown): TriageState {
  const base = emptyTriageState();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<TriageState>;
  const obj = <T>(v: unknown, d: T): T => (v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : d);
  const b = obj(r.backup, base.backup) as TriageState['backup'];
  return {
    version: 1,
    cooldowns: obj(r.cooldowns, {}),
    criticalBypass: obj(r.criticalBypass, {}),
    daily: {
      day: typeof r.daily?.day === 'string' ? r.daily.day : '',
      perSlug: obj(r.daily?.perSlug, {}),
      machine: typeof r.daily?.machine === 'number' ? r.daily.machine : 0,
      ...(typeof r.daily?.capItemDay === 'string' ? { capItemDay: r.daily.capItemDay } : {}),
    },
    episodes: obj(r.episodes, {}),
    fingerprints: obj(r.fingerprints, {}),
    backup: {
      cursors: obj(b.cursors, {}),
      pending: obj(b.pending, {}),
      routine: obj(b.routine, {}),
      seen: obj(b.seen, {}),
      ...(typeof b.lastPassAt === 'string' ? { lastPassAt: b.lastPassAt } : {}),
      consecutiveFailures: typeof b.consecutiveFailures === 'number' ? b.consecutiveFailures : 0,
      ...(b.lastConsidered && typeof b.lastConsidered === 'object' ? { lastConsidered: b.lastConsidered } : {}),
    },
    sessions: Array.isArray(r.sessions) ? r.sessions : [],
  };
}

export class JobTriageStateStore {
  readonly file: string;
  private state: TriageState;
  private lastWritten: string;
  private readonly log: (msg: string) => void;

  constructor(opts: { file: string; log?: (msg: string) => void }) {
    this.file = opts.file;
    this.log = opts.log ?? (() => {});
    let raw: unknown = null;
    try {
      if (fs.existsSync(this.file)) raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
    } catch (err) {
      // @silent-fallback-ok — an unreadable state file starts fresh (logged); bounds re-seed for the day.
      this.log(`[JobTriageStateStore] unreadable state, starting fresh: ${(err as Error).message}`);
    }
    this.state = normalize(raw);
    this.lastWritten = JSON.stringify(this.state);
  }

  /** Read-only snapshot (a deep copy). */
  snapshot(): TriageState {
    return JSON.parse(JSON.stringify(this.state)) as TriageState;
  }

  /** Mutate the state; persists only when the content changed. */
  update(fn: (s: TriageState) => void): void {
    fn(this.state);
    this.trim();
    this.persist();
  }

  private trim(): void {
    const s = this.state;
    for (const slug of Object.keys(s.fingerprints)) {
      if (s.fingerprints[slug].length > MAX_FINGERPRINTS_PER_SLUG) s.fingerprints[slug] = s.fingerprints[slug].slice(-MAX_FINGERPRINTS_PER_SLUG);
    }
    for (const slug of Object.keys(s.backup.routine)) {
      if (s.backup.routine[slug].length > MAX_ROUTINE_PER_SLUG) s.backup.routine[slug] = s.backup.routine[slug].slice(-MAX_ROUTINE_PER_SLUG);
    }
    if (s.sessions.length > MAX_SESSION_RECORDS) s.sessions = s.sessions.slice(-MAX_SESSION_RECORDS);
    const eps = Object.entries(s.episodes);
    if (eps.length > MAX_EPISODES) {
      eps.sort((a, b) => a[1].at.localeCompare(b[1].at));
      for (const [k] of eps.slice(0, eps.length - MAX_EPISODES)) delete s.episodes[k];
    }
  }

  private persist(): void {
    const text = JSON.stringify(this.state);
    if (text === this.lastWritten) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, text, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.lastWritten = text;
    } catch (err) {
      // @silent-fallback-ok — an unwritable state file keeps the in-memory bounds for this process; logged.
      this.log(`[JobTriageStateStore] write failed: ${(err as Error).message}`);
    }
  }
}

import { Cron } from 'croner';

export const JOB_SCHEDULE_OBSERVATION_INTERVAL_MS = 30_000;
const JOBS_PER_TICK = 32;
const MAX_REVISIT_TICKS = 8;
const HEARTBEAT_TIMEOUT_MS = JOB_SCHEDULE_OBSERVATION_INTERVAL_MS * 2;
const ROW_TIMEOUT_MS = JOB_SCHEDULE_OBSERVATION_INTERVAL_MS * MAX_REVISIT_TICKS;

export interface JobScheduleRegistration {
  schedule: string;
  generation: string;
  entries: number;
}

type State = 'upcoming' | 'due-unknown' | 'no-callback-observed' | 'stale' | 'unavailable';
interface Witness {
  due: number;
  grace: number;
  followingDue: number;
  entries: number;
}
interface Row {
  registration: JobScheduleRegistration;
  cron: Cron;
  armed?: Witness;
  previous?: { due: number; noEntry: boolean; entries: number; sample: number };
  observedAt: number;
  sampledAt: number;
  callbackInterval?: { from: number; through: number };
}

export interface JobScheduleCoverage {
  state: State | 'disabled' | 'paused' | 'not-placed';
  observedAt?: string;
  dueAt?: string;
  nextDueAt?: string;
  callbackEntered?: { from: string; through: string };
  previousWitness?: { state: 'no-callback-observed' | 'due-unknown'; dueAt: string; observedAt: string };
  reason?: 'observer-stale' | 'row-stale' | 'unverified-registration' | 'peer-unverified';
}

interface Sources {
  list(): readonly { slug: string }[];
  registration(slug: string): JobScheduleRegistration | null;
  wall?(): number;
  monotonic?(): number;
}

function date(ms: number): string {
  return new Date(ms).toISOString();
}

// RULE 3: EXEMPT — derives a read-only verdict from Instar-owned scheduler registration and callback counters. Croner is the same in-process schedule calculator used by the registration. No external system state is detected.
export class JobScheduleObserver {
  private readonly rows = new Map<string, Row>();
  private cursor = 0;
  private sweep: readonly { slug: string }[] = [];
  private heartbeat: { wall: number; mono: number; utcOffset: number } | null = null;
  private readonly wall: () => number;
  private readonly monotonic: () => number;

  constructor(private readonly sources: Sources) {
    this.wall = sources.wall ?? Date.now;
    this.monotonic = sources.monotonic ?? (() => performance.now());
  }

  tick(): void {
    const now = this.wall();
    const mono = this.monotonic();
    if (!this.heartbeat || this.discontinuous(now, mono)) this.clear();
    this.heartbeat = { wall: now, mono, utcOffset: new Date(now).getTimezoneOffset() };
    const jobs = this.sources.list();
    if (this.sweep !== jobs) {
      this.clearRows();
      this.sweep = jobs;
    }
    const limit = Math.min(jobs.length, JOBS_PER_TICK);
    for (let count = 0; count < limit; count++) {
      const job = jobs[this.cursor];
      this.cursor = (this.cursor + 1) % jobs.length;
      this.observe(job.slug, now, mono);
    }
  }

  clear(): void {
    this.clearRows();
    this.heartbeat = null;
  }

  private clearRows(): void {
    for (const row of this.rows.values()) row.cron.stop();
    this.rows.clear();
    this.cursor = 0;
  }

  private discontinuous(now: number, mono: number): boolean {
    if (!this.heartbeat) return true;
    const elapsed = mono - this.heartbeat.mono;
    return elapsed < 0 || elapsed > HEARTBEAT_TIMEOUT_MS
      || Math.abs(now - this.heartbeat.wall - elapsed) > 1_000
      || new Date(now).getTimezoneOffset() !== this.heartbeat.utcOffset;
  }

  private observe(slug: string, now: number, mono: number): void {
    const current = this.sources.registration(slug);
    let row = this.rows.get(slug);
    if (!current || row?.registration.generation !== current.generation || mono - (row?.sampledAt ?? mono) >= ROW_TIMEOUT_MS) {
      row?.cron.stop();
      this.rows.delete(slug);
      if (!current) return;
      try {
        row = { registration: current, cron: new Cron(current.schedule, { paused: true }), observedAt: now, sampledAt: mono };
        this.rows.set(slug, row);
      } catch {
        return;
      }
    }
    if (!row) return;
    if (row.registration.entries !== current.entries) {
      row.callbackInterval = { from: row.observedAt, through: now };
    }
    row.registration = current;
    row.observedAt = now;
    row.sampledAt = mono;

    const witness = row.armed;
    if (witness && now >= witness.due + witness.grace) {
      const later = row.cron.nextRun(new Date(witness.due))?.getTime();
      const nextLater = later === undefined ? undefined : row.cron.nextRun(new Date(later))?.getTime();
      const laterGrace = later === undefined || nextLater === undefined ? undefined : continuityGrace(nextLater - later);
      const laterDue = later !== undefined && laterGrace !== undefined && now >= later + laterGrace ? later : undefined;
      row.previous = {
        due: laterDue ?? witness.due,
        noEntry: laterDue === undefined && current.entries === witness.entries,
        entries: current.entries,
        sample: now,
      };
      row.armed = undefined;
    }
    if (!row.armed) {
      const [due, after] = row.cron.nextRuns(2, new Date(now)).map(instant => instant.getTime());
      if (due !== undefined && after !== undefined && due > now) {
        row.armed = { due, followingDue: after, grace: continuityGrace(after - due), entries: current.entries };
      }
    }
  }

  read(slug: string): JobScheduleCoverage {
    try {
      return this.readCurrent(slug);
    } catch {
      this.clear(); // The continuity of the underlying scheduler/clock is now unknown.
      return { state: 'unavailable', reason: 'unverified-registration' };
    }
  }

  private readCurrent(slug: string): JobScheduleCoverage {
    const now = this.wall();
    const mono = this.monotonic();
    const row = this.rows.get(slug);
    if (!row) return { state: 'unavailable', reason: 'unverified-registration' };
    const observedAt = date(row.previous?.sample ?? row.observedAt);
    if (this.discontinuous(now, mono)) return { state: 'stale', reason: 'observer-stale', observedAt };
    if (mono - row.sampledAt >= ROW_TIMEOUT_MS) return { state: 'stale', reason: 'row-stale', observedAt };
    const current = this.sources.registration(slug);
    if (!current || current.generation !== row.registration.generation) {
      return { state: 'unavailable', reason: 'unverified-registration' };
    }
    const awaiting = row.armed;
    const future = awaiting
      ? awaiting.due > now ? awaiting.due : awaiting.followingDue > now ? awaiting.followingDue : undefined
      : undefined;
    const interval = current.entries === row.registration.entries
      ? row.callbackInterval : { from: row.observedAt, through: now };
    const context = interval && { from: date(interval.from), through: date(interval.through) };
    const past = row.previous;
    const pastState = past?.noEntry && current.entries === past.entries ? 'no-callback-observed' : 'due-unknown';
    const extra = {
      ...(future === undefined ? {} : { nextDueAt: date(future) }),
      ...(context ? { callbackEntered: context } : {}),
    };
    if (awaiting && now >= awaiting.due && (!past || (awaiting.due > past.due && now >= awaiting.due + awaiting.grace))) {
      return {
        state: 'due-unknown', observedAt: date(now), dueAt: date(awaiting.due), ...extra,
        ...(past ? { previousWitness: { state: pastState, dueAt: date(past.due), observedAt: date(past.sample) } } : {}),
      };
    }
    if (past) return { state: pastState, observedAt, dueAt: date(past.due), ...extra };
    if (future !== undefined) return { state: 'upcoming', observedAt, ...extra };
    return { state: 'unavailable', observedAt, reason: 'unverified-registration', ...extra };
  }
}

export function continuityGrace(intervalMs: number): number {
  return Math.max(5 * 60_000, Math.min(intervalMs * 0.5, 60 * 60_000));
}

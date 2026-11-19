/**
 * The practice record (docs/specs/local-verify-borrowed-slices-count.md, F "The practice record"):
 * one file on the pairing run machine, `state/local-verify/borrowed-helpers.json`. Per helper and
 * lane it holds the four evidence items, the state (`practice`, `counting`, `suspended`,
 * `lapsed: <reason>`), the image and runner version they belong to, the practice period's start
 * and the recorded decision to count. It DECIDES WHETHER A HELPER'S PASSES COUNT.
 *
 * Per helper it also holds how often the helper is asked (borrowedAsk.ts), the spot re-run rate,
 * a recorded dry-run request (the dry-run task of stage 6 consumes it) and the main-verify
 * observer's rolling counters. Beside the helpers: the helper events of this machine and the ids
 * a coordinator has already told someone about (borrowedNotices.ts).
 *
 * A lost or unreadable file means practice from the start, by intent: the same holds for a file of
 * the first design (version 1) and for any single lane that does not read strictly.
 * The rules are in borrowedPractice.ts; this file is the I/O.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { BORROWED_PLAN, p90 } from './borrowedPlan.js';
import { freshAsk, parseAsk, type AskState } from './borrowedAsk.js';
import { HELPER_EVENT_LIMITS, parseHelperEvent, type HelperEvent } from './borrowedNotices.js';
import { PRACTICE_LANES, freshLane, parseLane, type LaneRecord, type PracticeLane, type SpotState } from './borrowedPractice.js';

export const BORROWED_STATE = Object.freeze({ keepRuns: 50, version: 2 });

export interface HelperRunSummary {
  at: number;
  /** At least one finished slice: only these runs count toward the measured figures. */
  counted: boolean;
  slicesSent: number;
  done: number;
  agree: number;
  disagree: number;
  helperMs: number;
  localMs: number;
  prepMs: number | null;
  vitestStartMs: number | null;
}

/** A recorded request to dry-run a helper. The dry-run task (stage 6 of the rework) consumes it. */
export interface DryRunIntent {
  requestedAt: number;
  lanes: PracticeLane[];
  by: string | null;
  state: 'requested' | 'stopped';
}

export interface HelperState {
  ask: AskState;
  spot: SpotState;
  lanes: Partial<Record<PracticeLane, LaneRecord>>;
  runs: HelperRunSummary[];
  dryRunIntent: DryRunIntent | null;
}

export const freshHelper = (): HelperState => ({ ask: freshAsk(), spot: { raisedVerifiesLeft: 0 }, lanes: {}, runs: [], dryRunIntent: null });

/** Measured throughput (local file-seconds per helper-second) after 5 counted runs, else null. */
export function measuredThroughput(runs: readonly HelperRunSummary[]): number | null {
  const c = runs.filter((r) => r.counted && r.helperMs > 0);
  if (c.length < BORROWED_PLAN.measuredAfterRuns) return null;
  const helper = c.reduce((n, r) => n + r.helperMs, 0);
  const local = c.reduce((n, r) => n + r.localMs, 0);
  return helper > 0 ? local / helper : null;
}

export function measuredPrepP90(runs: readonly HelperRunSummary[]): number | null {
  const c = runs.filter((r) => r.counted && r.prepMs !== null).map((r) => r.prepMs as number);
  return c.length >= BORROWED_PLAN.measuredAfterRuns ? p90(c) : null;
}

const MACHINE_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

function parseIntent(v: unknown): DryRunIntent | null {
  const x = v as Partial<DryRunIntent> | null;
  if (!x || typeof x !== 'object') return null;
  if (typeof x.requestedAt !== 'number' || !Number.isSafeInteger(x.requestedAt) || x.requestedAt < 0) return null;
  if (!Array.isArray(x.lanes) || x.lanes.length < 1 || x.lanes.length > 3 || !x.lanes.every((l) => (PRACTICE_LANES as readonly unknown[]).includes(l))) return null;
  if (!(x.by === null || (typeof x.by === 'string' && x.by.length <= 200))) return null;
  if (x.state !== 'requested' && x.state !== 'stopped') return null;
  return { requestedAt: x.requestedAt, lanes: [...new Set(x.lanes)], by: x.by, state: x.state };
}

/** One helper's stored state. A lane that does not read strictly is dropped (practice from the start for it). */
export function parseHelperState(v: unknown): HelperState {
  const h = freshHelper();
  if (!v || typeof v !== 'object' || Array.isArray(v)) return h;
  const x = v as Record<string, unknown>;
  h.ask = parseAsk(x.ask);
  const left = (x.spot as { raisedVerifiesLeft?: unknown } | null)?.raisedVerifiesLeft;
  if (typeof left === 'number' && Number.isSafeInteger(left) && left >= 0 && left <= 1000) h.spot = { raisedVerifiesLeft: left };
  if (x.lanes && typeof x.lanes === 'object' && !Array.isArray(x.lanes)) {
    for (const lane of PRACTICE_LANES) {
      const parsed = parseLane((x.lanes as Record<string, unknown>)[lane]);
      if (parsed) h.lanes[lane] = parsed;
    }
  }
  if (Array.isArray(x.runs)) h.runs = (x.runs as HelperRunSummary[]).filter((r) => !!r && typeof r === 'object' && typeof r.at === 'number').slice(-BORROWED_STATE.keepRuns);
  h.dryRunIntent = parseIntent(x.dryRunIntent);
  return h;
}

interface StoreFile { v: 2; helpers: Record<string, HelperState>; events: HelperEvent[]; told: string[] }

export class BorrowedPracticeStore {
  readonly file: string;
  private data: StoreFile;
  /** Why the file was not used at load (`absent`, `unreadable`, `version`), or null when it was read. */
  readonly loadedFresh: 'absent' | 'unreadable' | 'version' | null;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, 'state', 'local-verify', 'borrowed-helpers.json');
    this.data = { v: 2, helpers: {}, events: [], told: [] };
    let why: 'absent' | 'unreadable' | 'version' | null = null;
    let text: string | null = null;
    try { text = fs.readFileSync(this.file, 'utf-8'); } catch { why = 'absent'; } // @silent-fallback-ok: no file is practice from the start
    if (text !== null) {
      try {
        const raw = JSON.parse(text) as { v?: unknown; helpers?: unknown; events?: unknown; told?: unknown };
        if (raw.v !== BORROWED_STATE.version || !raw.helpers || typeof raw.helpers !== 'object' || Array.isArray(raw.helpers)) {
          why = 'version';
        } else {
          for (const [id, h] of Object.entries(raw.helpers as Record<string, unknown>)) {
            if (MACHINE_ID_RE.test(id)) this.data.helpers[id] = parseHelperState(h);
          }
          if (Array.isArray(raw.events)) this.data.events = raw.events.map(parseHelperEvent).filter((e): e is HelperEvent => e !== null).slice(-HELPER_EVENT_LIMITS.kept);
          if (Array.isArray(raw.told)) this.data.told = raw.told.filter((t): t is string => typeof t === 'string' && /^[0-9a-f]{32}$/.test(t)).slice(-HELPER_EVENT_LIMITS.kept * 2);
        }
      } catch { why = 'unreadable'; } // @silent-fallback-ok: an unreadable file is practice from the start, by intent
    }
    this.loadedFresh = why;
  }

  get(machineId: string): HelperState {
    let h = this.data.helpers[machineId];
    if (!h) { h = freshHelper(); this.data.helpers[machineId] = h; }
    return h;
  }

  /** The helper ids the file holds. */
  helperIds(): string[] { return Object.keys(this.data.helpers); }

  /** A lane's record, created in practice (from `now`) when the helper has none yet. */
  lane(machineId: string, lane: PracticeLane, now: number): LaneRecord {
    const h = this.get(machineId);
    let l = h.lanes[lane];
    if (!l) { l = freshLane(now); h.lanes[lane] = l; }
    return l;
  }

  /** A lane's record when one exists; never creates. */
  peekLane(machineId: string, lane: PracticeLane): LaneRecord | null {
    return this.data.helpers[machineId]?.lanes[lane] ?? null;
  }

  setLane(machineId: string, lane: PracticeLane, record: LaneRecord): void {
    this.get(machineId).lanes[lane] = record;
  }

  addRun(machineId: string, run: HelperRunSummary): void {
    const h = this.get(machineId);
    h.runs = [...h.runs, run].slice(-BORROWED_STATE.keepRuns);
  }

  events(): HelperEvent[] { return this.data.events.map((e) => ({ ...e })); }

  addEvent(e: HelperEvent): void {
    this.data.events = [...this.data.events, e].slice(-HELPER_EVENT_LIMITS.kept);
  }

  told(): Set<string> { return new Set(this.data.told); }

  markTold(ids: readonly string[]): void {
    const set = new Set(this.data.told);
    for (const id of ids) set.add(id);
    this.data.told = [...set].slice(-HELPER_EVENT_LIMITS.kept * 2);
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    SafeFsExecutor.atomicWriteJsonSync(this.file, this.data, { operation: 'local-verify:borrowed-helpers' }); /* state-registry: local-verify-borrowed-helpers */
  }

  snapshot(): Record<string, HelperState> {
    return JSON.parse(JSON.stringify(this.data.helpers)) as Record<string, HelperState>;
  }
}

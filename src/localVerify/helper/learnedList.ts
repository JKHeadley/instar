/**
 * A helper's learned exclude list (docs/specs/local-verify-borrowed-unit-slices.md, D).
 *
 * One list per helper, kept ON the helper (`state/local-verify/helper-learned.json`). Run machines
 * report observations through the signed `POST /local-verify/helper-learned` and read the list
 * from `GET /local-verify/helper-status`. The run machines' audit rows remain the source of truth
 * if the helper is reinstalled.
 *
 *  - Added when a file fails, or skips differently, on the helper while passing on the run machine
 *    in the same run, TWICE (two different runs). A dry-run observation (`source: dry-run`) adds
 *    from one: the dry run is a deliberate full comparison on a tree the run machine verified green.
 *  - Re-tried when the helper's Instar version changes, when the file's content changes, or every
 *    10th run of the helper; removed when that trial agrees.
 *  - Capped at the number of eligible unit files; more than a quarter of them (PRACTICE-PHASE
 *    DEFAULT, HELPER_LIMITS.incompatibleShare) reports the helper `incompatible`.
 *
 * The list is judgment within the D floor: efficiency only. It never decides anything about a verdict.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import { HELPER_LIMITS, type LearnedObservation } from './helperProtocol.js';

export interface LearnedEntry {
  file: string;
  /** The run machine that reported it. */
  runMachine: string;
  /** The runs that added it (two; one for a dry-run entry). */
  runs: string[];
  source: 'paired' | 'dry-run';
  addedAt: string;
  /** The helper's Instar version when added or last re-tried. */
  helperVersion: string;
  /** The file's content hash (git blob) when added or last re-tried; null when unknown. */
  blob: string | null;
  /** The helper run count at the last trial. */
  lastTrialRun: number;
}

interface Candidate { file: string; runMachine: string; run: string; at: string }

interface LearnedFile {
  v: 1;
  entries: LearnedEntry[];
  candidates: Candidate[];
  /** Runs this helper has served (distinct runAttemptIds that prepared), for the every-10th re-trial. */
  runsSeen: number;
  recentRuns: string[];
}

export type ObserveResult = 'added' | 'candidate' | 'removed' | 'capped' | 'noop';

const empty = (): LearnedFile => ({ v: 1, entries: [], candidates: [], runsSeen: 0, recentRuns: [] });
const CANDIDATES_MAX = 2_000;

export class HelperLearnedStore {
  private data: LearnedFile;
  private readonly file: string;

  constructor(stateDir: string, private readonly now: () => number = () => Date.now()) {
    this.file = path.join(stateDir, 'state', 'local-verify', 'helper-learned.json');
    this.data = this.load();
  }

  private load(): LearnedFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Partial<LearnedFile>;
      if (raw && raw.v === 1 && Array.isArray(raw.entries) && Array.isArray(raw.candidates)) {
        return {
          v: 1,
          entries: raw.entries.filter((e) => e && typeof e.file === 'string'),
          candidates: raw.candidates.filter((c) => c && typeof c.file === 'string'),
          runsSeen: typeof raw.runsSeen === 'number' && raw.runsSeen >= 0 ? raw.runsSeen : 0,
          recentRuns: Array.isArray(raw.recentRuns) ? raw.recentRuns.filter((r) => typeof r === 'string').slice(-50) : [],
        };
      }
    } catch { /* @silent-fallback-ok: an absent or unreadable list starts empty; the run machines' audit rows stay the source of truth */ }
    return empty();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    SafeFsExecutor.atomicWriteJsonSync(this.file, this.data, { operation: 'local-verify:helper-learned' });
  }

  entries(): LearnedEntry[] { return this.data.entries.map((e) => ({ ...e, runs: [...e.runs] })); }
  files(): Set<string> { return new Set(this.data.entries.map((e) => e.file)); }
  runsSeen(): number { return this.data.runsSeen; }

  /** Count a run the first time its runAttemptId prepares a tree here. */
  noteRun(runAttemptId: string): void {
    if (this.data.recentRuns.includes(runAttemptId)) return;
    this.data.recentRuns = [...this.data.recentRuns, runAttemptId].slice(-50);
    this.data.runsSeen++;
    this.save();
  }

  /** Apply one run machine observation. `eligibleCount` is the cap (eligible unit files in the current tree). */
  observe(o: LearnedObservation, ctx: { runMachine: string; runAttemptId: string; helperVersion: string; blob: string | null; eligibleCount: number }): ObserveResult {
    const at = new Date(this.now()).toISOString();
    const existing = this.data.entries.find((e) => e.file === o.file);
    if (o.kind === 'agree') {
      if (existing) {
        this.data.entries = this.data.entries.filter((e) => e !== existing);
        this.save();
        return 'removed';
      }
      const before = this.data.candidates.length;
      this.data.candidates = this.data.candidates.filter((c) => c.file !== o.file);
      if (this.data.candidates.length !== before) { this.save(); }
      return 'noop';
    }
    if (existing) {
      // A retrial that still differs: the entry stays, its trial markers move on.
      existing.helperVersion = ctx.helperVersion;
      existing.blob = ctx.blob ?? existing.blob;
      existing.lastTrialRun = this.data.runsSeen;
      this.save();
      return 'noop';
    }
    const add = (runs: string[]): ObserveResult => {
      if (this.data.entries.length >= Math.max(0, ctx.eligibleCount)) return 'capped';
      this.data.entries.push({ file: o.file, runMachine: ctx.runMachine, runs, source: o.source, addedAt: at, helperVersion: ctx.helperVersion, blob: ctx.blob, lastTrialRun: this.data.runsSeen });
      this.data.candidates = this.data.candidates.filter((c) => c.file !== o.file);
      this.save();
      return 'added';
    };
    if (o.source === 'dry-run') return add([ctx.runAttemptId]);
    const prior = this.data.candidates.find((c) => c.file === o.file && c.runMachine === ctx.runMachine && c.run !== ctx.runAttemptId);
    if (prior) return add([prior.run, ctx.runAttemptId]);
    if (!this.data.candidates.some((c) => c.file === o.file && c.run === ctx.runAttemptId)) {
      this.data.candidates.push({ file: o.file, runMachine: ctx.runMachine, run: ctx.runAttemptId, at });
      if (this.data.candidates.length > CANDIDATES_MAX) this.data.candidates = this.data.candidates.slice(-CANDIDATES_MAX);
      this.save();
    }
    return 'candidate';
  }

  /** Whether an entry is due a re-trial: version change, content change, or every 10th helper run. */
  retrialDue(e: LearnedEntry, ctx: { helperVersion: string; currentBlob: string | null }): boolean {
    if (e.helperVersion !== ctx.helperVersion) return true;
    if (ctx.currentBlob !== null && e.blob !== null && e.blob !== ctx.currentBlob) return true;
    return this.data.runsSeen - e.lastTrialRun >= HELPER_LIMITS.retrialEveryRuns;
  }

  /** More than a quarter of eligible files on the list: the helper agrees on too little to be useful. */
  incompatible(eligibleCount: number): boolean {
    return eligibleCount > 0 && this.data.entries.length / eligibleCount > HELPER_LIMITS.incompatibleShare;
  }

  /** Removed with the helper (`instar helper uninstall`). */
  clear(): void {
    this.data = empty();
    try { SafeFsExecutor.safeRmSync(this.file, { force: true, operation: 'local-verify:helper-learned-clear' }); } catch { /* @silent-fallback-ok: already absent */ }
  }
}

/**
 * A helper's learned exclude list (docs/specs/local-verify-borrowed-slices-count.md, D, amending
 * docs/specs/local-verify-borrowed-unit-slices.md, D).
 *
 * One list per helper, kept ON the helper (`state/local-verify/helper-learned.json`). Its run
 * machine reports what each comparison showed through the signed `POST /local-verify/helper-learned`
 * (keyed by the merge tree's hash: a comparison is about one tree on both sides) and reads the
 * list from `GET /local-verify/helper-status`. The run machine's audit rows remain the source of
 * truth if the helper is reinstalled.
 *
 * A file JOINS the list when:
 *  - the helper fails it and the run machine's final result is a pass, on the same tree, in two
 *    comparisons in a row (two different verifies; an agreeing comparison in between starts over);
 *  - its names-and-outcomes digest differs from the run machine's on the same tree while both
 *    sides pass: once;
 *  - the run machine's final result is a failure and the helper passed it (a confirmed wrong
 *    pass): once.
 *
 * It LEAVES when a later trial agrees. A trial is due when the file's content changes, when the
 * helper's RUNNER VERSION changes (helperRunnerVersion.ts; Instar's release number moves several
 * times a day and is not used), and otherwise every 10th verify this helper serves. A trial is
 * always compare-only: the run machine runs the file too.
 *
 * The first design's cap by eligible unit files and its "a quarter of files is incompatible" are
 * gone: whether a lane is worth sending is the dry run's "lane proven" figure (dryRunRecord.ts).
 *
 * The list is judgment within the D floor. It never decides anything about a verdict: it only
 * keeps files off this helper.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import { HELPER_LIMITS, type LearnedObservation, type LearnedObservationKind } from './helperProtocol.js';

export type LearnedReason = Exclude<LearnedObservationKind, 'agree'>;

export interface LearnedEntry {
  file: string;
  /** The run machine that reported it. */
  runMachine: string;
  /** Which rule put it on the list. */
  reason: LearnedReason;
  /** The verifies whose comparisons added it (two for a repeated helper failure, else one). */
  runs: string[];
  /** The merge tree of the comparison that added it. */
  treeHash: string;
  addedAt: string;
  /** The helper's runner version when added or last tried. */
  runnerVersion: string;
  /** The file's content hash (git blob) when added or last tried; null when unknown. */
  blob: string | null;
  /** The helper's verify count at the last trial. */
  lastTrialRun: number;
}

/** A first "helper failed, run machine passed" comparison, waiting for a second in a row. */
interface Candidate { file: string; runMachine: string; run: string; treeHash: string; at: string }

interface LearnedFile {
  v: 2;
  entries: LearnedEntry[];
  candidates: Candidate[];
  /** Verifies this helper has served (distinct runAttemptIds that prepared), for the every-10th trial. */
  runsSeen: number;
  recentRuns: string[];
}

/** `full`: the list is at its bound and the file was not added (audited by the caller). */
export type ObserveResult = 'added' | 'candidate' | 'removed' | 'full' | 'noop';

const empty = (): LearnedFile => ({ v: 2, entries: [], candidates: [], runsSeen: 0, recentRuns: [] });
const CANDIDATES_MAX = 2_000;
/** No lane has more files than the duration records allow; the list cannot name more files than exist. */
export const LEARNED_ENTRIES_MAX = 20_000;
const REASONS: readonly string[] = ['helper-failed-local-passed', 'digest-differs-both-pass', 'confirmed-wrong-pass'];

export interface ObserveCtx {
  runMachine: string;
  /** The verify the comparison belongs to. */
  runAttemptId: string;
  /** The merge tree both sides ran. */
  treeHash: string;
  runnerVersion: string;
  /** The file's content hash in that tree; null when the helper cannot read it. */
  blob: string | null;
}

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
      // A version 1 file (the first design's rules, never enabled anywhere) is not read: its
      // entries were added under other rules.
      if (raw && raw.v === 2 && Array.isArray(raw.entries) && Array.isArray(raw.candidates)) {
        return {
          v: 2,
          entries: raw.entries.filter((e) => e && typeof e.file === 'string' && REASONS.includes(e.reason) && Array.isArray(e.runs)).slice(0, LEARNED_ENTRIES_MAX),
          candidates: raw.candidates.filter((c) => c && typeof c.file === 'string' && typeof c.run === 'string').slice(-CANDIDATES_MAX),
          runsSeen: typeof raw.runsSeen === 'number' && raw.runsSeen >= 0 ? raw.runsSeen : 0,
          recentRuns: Array.isArray(raw.recentRuns) ? raw.recentRuns.filter((r) => typeof r === 'string').slice(-50) : [],
        };
      }
    } catch { /* @silent-fallback-ok: an absent or unreadable list starts empty; the run machine's audit rows stay the source of truth */ }
    return empty();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    SafeFsExecutor.atomicWriteJsonSync(this.file, this.data, { operation: 'local-verify:helper-learned' });
  }

  entries(): LearnedEntry[] { return this.data.entries.map((e) => ({ ...e, runs: [...e.runs] })); }
  files(): Set<string> { return new Set(this.data.entries.map((e) => e.file)); }
  /** Files with one "helper failed" comparison waiting for a second. */
  candidates(): string[] { return [...new Set(this.data.candidates.map((c) => c.file))]; }
  runsSeen(): number { return this.data.runsSeen; }

  /** Count a verify the first time its runAttemptId prepares a tree here. */
  noteRun(runAttemptId: string): void {
    if (this.data.recentRuns.includes(runAttemptId)) return;
    this.data.recentRuns = [...this.data.recentRuns, runAttemptId].slice(-50);
    this.data.runsSeen++;
    this.save();
  }

  /** Apply what one comparison of one file showed. */
  observe(o: LearnedObservation, ctx: ObserveCtx): ObserveResult {
    const at = new Date(this.now()).toISOString();
    const existing = this.data.entries.find((e) => e.file === o.file);
    if (o.kind === 'agree') {
      if (existing) {
        // A trial that agreed: the file leaves the list.
        this.data.entries = this.data.entries.filter((e) => e !== existing);
        this.data.candidates = this.data.candidates.filter((c) => c.file !== o.file);
        this.save();
        return 'removed';
      }
      // "In a row": an agreeing comparison ends a run of helper failures.
      const before = this.data.candidates.length;
      this.data.candidates = this.data.candidates.filter((c) => c.file !== o.file);
      if (this.data.candidates.length !== before) this.save();
      return 'noop';
    }
    if (existing) {
      // A trial that still differs: the entry stays, and its trial markers move on.
      existing.runnerVersion = ctx.runnerVersion;
      existing.blob = ctx.blob ?? existing.blob;
      existing.lastTrialRun = this.data.runsSeen;
      this.save();
      return 'noop';
    }
    const add = (runs: string[]): ObserveResult => {
      if (this.data.entries.length >= LEARNED_ENTRIES_MAX) return 'full';
      this.data.entries.push({ file: o.file, runMachine: ctx.runMachine, reason: o.kind as LearnedReason, runs, treeHash: ctx.treeHash, addedAt: at, runnerVersion: ctx.runnerVersion, blob: ctx.blob, lastTrialRun: this.data.runsSeen });
      this.data.candidates = this.data.candidates.filter((c) => c.file !== o.file);
      this.save();
      return 'added';
    };
    // A digest difference with both sides passing, and a confirmed wrong pass: once is enough.
    if (o.kind === 'digest-differs-both-pass' || o.kind === 'confirmed-wrong-pass') return add([ctx.runAttemptId]);
    // The helper failed and the run machine passed: the second comparison in a row, from another verify, adds it.
    const prior = this.data.candidates.filter((c) => c.file === o.file && c.runMachine === ctx.runMachine && c.run !== ctx.runAttemptId);
    if (prior.length >= HELPER_LIMITS.learnedJoinInARow - 1) return add([...prior.slice(-(HELPER_LIMITS.learnedJoinInARow - 1)).map((c) => c.run), ctx.runAttemptId]);
    if (!this.data.candidates.some((c) => c.file === o.file && c.run === ctx.runAttemptId)) {
      this.data.candidates.push({ file: o.file, runMachine: ctx.runMachine, run: ctx.runAttemptId, treeHash: ctx.treeHash, at });
      if (this.data.candidates.length > CANDIDATES_MAX) this.data.candidates = this.data.candidates.slice(-CANDIDATES_MAX);
      this.save();
    }
    return 'candidate';
  }

  /**
   * Whether an entry is due a trial: the helper's runner version changed, the file's content
   * changed, or this is the 10th verify since its last trial. An unknown content hash on either
   * side cannot show a change (the other two rules still apply).
   */
  retrialDue(e: LearnedEntry, ctx: { runnerVersion: string; currentBlob: string | null }): boolean {
    if (e.runnerVersion !== ctx.runnerVersion) return true;
    if (ctx.currentBlob !== null && e.blob !== null && e.blob !== ctx.currentBlob) return true;
    return this.data.runsSeen - e.lastTrialRun >= HELPER_LIMITS.retrialEveryRuns;
  }

  /** Removed with the helper (`instar helper uninstall`). */
  clear(): void {
    this.data = empty();
    try { SafeFsExecutor.safeRmSync(this.file, { force: true, operation: 'local-verify:helper-learned-clear' }); } catch { /* @silent-fallback-ok: already absent */ }
  }
}

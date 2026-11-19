/**
 * The trial of first parts (spec docs/specs/local-verify-likely-failing-first.md, section E
 * `alternate` and measures 5 and 6).
 *
 * - The coordinator assigns each pull request once, at random, to `with` or `without`, and keeps
 *   that for every later verify of it (`FirstPartGroups`, `state/local-verify/first-part-groups.json`).
 * - Each run machine set to `alternate` follows the first 5 verifies of each of three kinds with a
 *   comparison run (`FirstPartTrialState`, `state/local-verify/first-part-trial.json`, counts them),
 *   and `compareFirstPartRuns` says whether the two runs differ in a way first parts could explain.
 * - `minutesPerChange` is measure 5: machine-minutes per pull request to its first pass, grouped
 *   by the pull request's assignment.
 *
 * Nothing here decides a verify's verdict.
 */

import fs from 'node:fs';
import path from 'node:path';
import { FIRST_PART_LIMITS, type FirstPartGroup, type FirstPartSummary } from './firstPart.js';

// ── The assignment of pull requests ────────────────────────────────────

/**
 * The coordinator's assignment of pull requests to `with` or `without`. Drawn once per pull
 * request, when it is first queued, and never redrawn while remembered (the newest 5000). An
 * unreadable file starts empty: pull requests seen again are then drawn again, which the audit
 * row of each draw makes visible.
 */
export class FirstPartGroups {
  private prs: Map<number, { group: FirstPartGroup; at: number }> | null = null;

  constructor(
    readonly file: string,
    private readonly now: () => number,
    private readonly audit: (event: Record<string, unknown>) => void,
    private readonly random: () => number = Math.random,
  ) {}

  private load(): Map<number, { group: FirstPartGroup; at: number }> {
    if (this.prs) return this.prs;
    const prs = new Map<number, { group: FirstPartGroup; at: number }>();
    try {
      const size = fs.statSync(this.file).size;
      if (size <= FIRST_PART_LIMITS.listMaxBytes) {
        const doc = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as { v?: unknown; prs?: unknown };
        if (doc && doc.v === 1 && doc.prs && typeof doc.prs === 'object') {
          for (const [k, v] of Object.entries(doc.prs as Record<string, unknown>)) {
            const x = v as { group?: unknown; at?: unknown } | null;
            const pr = Number(k);
            if (Number.isSafeInteger(pr) && pr > 0 && x && (x.group === 'with' || x.group === 'without') && typeof x.at === 'number') prs.set(pr, { group: x.group, at: x.at });
          }
        } else this.audit({ event: 'first-part-groups-unreadable', reason: 'unparseable' });
      } else this.audit({ event: 'first-part-groups-unreadable', reason: 'oversized', bytes: size });
    } catch (e) {
      // @silent-fallback-ok: an absent file is the normal first state; anything else is audited and starts empty.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.audit({ event: 'first-part-groups-unreadable', reason: 'unreadable', detail: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
    this.prs = prs;
    return prs;
  }

  /** The assignment of `pr`, or null when it has none yet. */
  get(pr: number): FirstPartGroup | null {
    return this.load().get(pr)?.group ?? null;
  }

  /** The assignment of `pr`, drawn now (and saved) when it has none. */
  assign(pr: number): FirstPartGroup {
    const prs = this.load();
    const have = prs.get(pr);
    if (have) return have.group;
    const group: FirstPartGroup = this.random() < 0.5 ? 'with' : 'without';
    prs.set(pr, { group, at: this.now() });
    if (prs.size > FIRST_PART_LIMITS.groupsKept) {
      const order = [...prs.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      for (const [k] of order.slice(0, prs.size - FIRST_PART_LIMITS.groupsKept)) prs.delete(k);
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, prs: Object.fromEntries(prs) }), { mode: 0o600 }); /* state-registry: local-verify-likely-failing */
      fs.renameSync(tmp, this.file);
    } catch (e) {
      // @silent-fallback-ok: the draw holds in memory until a restart; the audit row below still records it.
      this.audit({ event: 'first-part-groups-write-failed', detail: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
    this.audit({ event: 'first-part-assigned', pr, group });
    return group;
  }
}

// ── The verdict check (measure 6) ──────────────────────────────────────

/** The three kinds of verify the verdict check samples. */
export type CompareKind = 'ended-first' | 'failed-later' | 'passed';
export const COMPARE_KINDS: readonly CompareKind[] = Object.freeze(['ended-first', 'failed-later', 'passed']);

/** Which kind a finished verify with first parts is; null when it is none of the three. */
export function compareKind(outcome: 'success' | 'failure' | 'error', s: FirstPartSummary | undefined): CompareKind | null {
  if (!s || !s.active || !s.lanes.some((l) => l.files > 0 && l.ms !== null)) return null;
  if (outcome === 'failure') return s.endedInFirstPart ? 'ended-first' : 'failed-later';
  return outcome === 'success' ? 'passed' : null;
}

export type FileOutcome = 'passed' | 'failed' | 'flaky';

export interface ComparedRun {
  outcome: 'success' | 'failure' | 'error';
  /** Every file the run reported, with what it did (`flaky`: failed, then passed alone). */
  files: Record<string, FileOutcome>;
}

export interface FirstPartComparison {
  first: 'success' | 'failure' | 'error';
  compare: 'success' | 'failure' | 'error';
  verdictDiffers: boolean;
  /** Files that ran in both runs. */
  ranInBoth: number;
  /** Of those: passed in both (a count), failed in both, and failed-then-passed-alone in either (named). */
  bothPassed: number;
  bothFailed: string[];
  flakyInEither: string[];
  /** Files that ran in both and passed in one, failed in the other. `known`: already known to be unreliable. */
  differing: Array<{ file: string; first: FileOutcome; compare: FileOutcome; known: boolean }>;
  /** Failures only one of the two runs reached, because the other had already stopped. Expected; not a difference. */
  onlyFirstReached: string[];
  onlyCompareReached: string[];
  /** The comparison run did not finish as a verdict (an infrastructure error): nothing can be concluded. */
  inconclusive: boolean;
  /** A difference the first parts could explain: the setting is switched off. */
  difference: boolean;
}

/**
 * Compare a verify that used first parts with the comparison run of the same merge commit.
 * A file is compared only when it ran in both. A file that failed and passed alone in either
 * run, or that is in `knownUnreliable`, is already known to be unreliable: its difference is
 * recorded and does not count. `difference` is true when a file not known to be unreliable
 * passed in one run and failed in the other, or when the verdicts differ and no such known file
 * explains it. A failure only one run reached is listed separately and is never a difference.
 * Pure.
 */
export function compareFirstPartRuns(first: ComparedRun, compare: ComparedRun, knownUnreliable: ReadonlySet<string>): FirstPartComparison {
  const out: FirstPartComparison = {
    first: first.outcome, compare: compare.outcome, verdictDiffers: first.outcome !== compare.outcome, ranInBoth: 0,
    bothPassed: 0, bothFailed: [], flakyInEither: [], differing: [], onlyFirstReached: [], onlyCompareReached: [], inconclusive: compare.outcome === 'error' || first.outcome === 'error', difference: false,
  };
  for (const [file, a] of Object.entries(first.files)) {
    const b = compare.files[file];
    if (b === undefined) { if (a === 'failed') out.onlyFirstReached.push(file); continue; }
    out.ranInBoth++;
    const known = knownUnreliable.has(file) || a === 'flaky' || b === 'flaky';
    if ((a === 'failed') !== (b === 'failed')) out.differing.push({ file, first: a, compare: b, known });
    else if (a === 'failed') out.bothFailed.push(file);
    else if (a === 'flaky' || b === 'flaky') out.flakyInEither.push(file);
    else out.bothPassed++;
  }
  for (const [file, b] of Object.entries(compare.files)) if (first.files[file] === undefined && b === 'failed') out.onlyCompareReached.push(file);
  out.differing.sort((x, y) => (x.file < y.file ? -1 : 1));
  out.bothFailed.sort();
  out.flakyInEither.sort();
  out.onlyFirstReached.sort();
  out.onlyCompareReached.sort();
  if (out.inconclusive) return out;
  const unexplained = out.differing.filter((d) => !d.known);
  // A verdict that differs with nothing in the files to explain it is also a difference, unless
  // the other run simply reached a failure this one never got to.
  const reachedOnly = out.onlyFirstReached.length > 0 || out.onlyCompareReached.length > 0;
  out.difference = unexplained.length > 0 || (out.verdictDiffers && out.differing.length === 0 && !reachedOnly);
  return out;
}

/** The run machine's count of comparisons, and whether a difference switched the setting off. */
export interface TrialCounts {
  done: Record<CompareKind, number>;
  started: Record<CompareKind, number>;
  switchedOff: { at: string; pr: number; headSha: string } | null;
}

const zero = (): Record<CompareKind, number> => ({ 'ended-first': 0, 'failed-later': 0, passed: 0 });

/** Whether a comparison of this kind may still start: under 5 finished and under 10 started, and no difference found yet. Pure. */
export function mayStartCompare(c: TrialCounts, kind: CompareKind): boolean {
  return c.switchedOff === null && c.done[kind] < FIRST_PART_LIMITS.compareEach && c.started[kind] < FIRST_PART_LIMITS.compareStartsEach;
}

/** The counts with their file. An unreadable file reads as "nothing may start" (the brake holds). */
export class FirstPartTrialState {
  private counts: TrialCounts | null = null;
  private unreadable = false;
  /** The counts were read from, or written to, the file: only then does its removal mean "start again". */
  private onDisk = false;

  constructor(readonly file: string, private readonly audit: (event: Record<string, unknown>) => void) {}

  private load(): TrialCounts {
    // Removing the file is how the trial is started again after a difference: seen without a restart.
    if (this.counts?.switchedOff && this.onDisk && !fs.existsSync(this.file)) { this.counts = null; this.unreadable = false; this.onDisk = false; }
    if (this.counts) return this.counts;
    const c: TrialCounts = { done: zero(), started: zero(), switchedOff: null };
    try {
      const doc = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as { v?: unknown; done?: unknown; started?: unknown; switchedOff?: unknown };
      const num = (o: unknown, k: CompareKind) => { const n = (o as Record<string, unknown> | null)?.[k]; return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null; };
      if (!doc || doc.v !== 1) throw new Error('not a trial state file');
      for (const k of COMPARE_KINDS) {
        const d = num(doc.done, k); const s = num(doc.started, k);
        if (d === null || s === null) throw new Error('counts missing');
        c.done[k] = d; c.started[k] = s;
      }
      const so = doc.switchedOff as { at?: unknown; pr?: unknown; headSha?: unknown } | null | undefined;
      if (so) c.switchedOff = { at: String(so.at), pr: typeof so.pr === 'number' ? so.pr : 0, headSha: String(so.headSha) };
      this.onDisk = true;
    } catch (e) {
      // @silent-fallback-ok: an absent file is the normal first state. Anything else holds every comparison (audited once).
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.unreadable = true;
        this.audit({ event: 'first-part-trial-unreadable', detail: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      }
    }
    this.counts = c;
    return c;
  }

  get(): TrialCounts { const c = this.load(); return { done: { ...c.done }, started: { ...c.started }, switchedOff: c.switchedOff }; }

  mayStart(kind: CompareKind): boolean { const c = this.load(); return !this.unreadable && mayStartCompare(c, kind); }

  /** Write the counts. False when they could not be saved: the caller then starts nothing. */
  private save(): boolean {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, ...this.load() }), { mode: 0o600 }); /* state-registry: local-verify-likely-failing */
      fs.renameSync(tmp, this.file);
      this.onDisk = true;
      return true;
    } catch (e) {
      // @silent-fallback-ok: reported to the caller, which then does not start a comparison.
      this.audit({ event: 'first-part-trial-write-failed', detail: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      return false;
    }
  }

  /** Count a comparison as started, durably, BEFORE it starts. False ⇒ do not start it. */
  noteStarted(kind: CompareKind): boolean {
    const c = this.load();
    c.started[kind]++;
    if (this.save()) return true;
    c.started[kind]--;
    return false;
  }

  noteDone(kind: CompareKind): void { this.load().done[kind]++; this.save(); }

  noteSwitchedOff(at: string, pr: number, headSha: string): void { this.load().switchedOff = { at, pr, headSha }; this.save(); }
}

// ── Measure 5: machine-minutes per change to its first pass ────────────

export interface ChangeVerify {
  pr: number;
  startedAt: string;
  finishedAt: string;
  outcome: 'success' | 'failure' | 'error';
}

export interface MinutesPerChange {
  /** Pull requests enrolled (their first verify fell inside the enrolment window). */
  enrolled: number;
  /** Machine-minutes per enrolled pull request, over each one's 7 days up to and including its first pass. */
  minutesPerChange: number | null;
  /** The share that reached a first pass within its 7 days. */
  reachedPass: number | null;
}

/**
 * Measure 5. Pull requests are enrolled by their FIRST verify inside `[from, to)` and grouped by
 * the assignment `groupOf` gives (the draw made when the pull request was first queued, never the
 * setting of a later verify); each is followed for the same 7 days from that first verify, on
 * every machine. Minutes count every verify of it that started inside those 7 days, up to and
 * including its first pass. A pull request with no assignment is left out. Pure.
 */
export function minutesPerChange(
  verifies: readonly ChangeVerify[],
  groupOf: (pr: number) => FirstPartGroup | null,
  window: { from: number; to: number; followMs?: number },
): Record<FirstPartGroup, MinutesPerChange> {
  const follow = window.followMs ?? 7 * 24 * 60 * 60_000;
  const byPr = new Map<number, Array<{ start: number; end: number; outcome: string }>>();
  for (const v of verifies) {
    const start = Date.parse(v.startedAt); const end = Date.parse(v.finishedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    const list = byPr.get(v.pr) ?? [];
    list.push({ start, end, outcome: v.outcome });
    byPr.set(v.pr, list);
  }
  const acc: Record<FirstPartGroup, { enrolled: number; minutes: number; passed: number }> = { with: { enrolled: 0, minutes: 0, passed: 0 }, without: { enrolled: 0, minutes: 0, passed: 0 } };
  for (const [pr, list] of byPr) {
    list.sort((a, b) => a.start - b.start);
    const first = list[0].start;
    if (first < window.from || first >= window.to) continue;
    const group = groupOf(pr);
    if (!group) continue;
    const a = acc[group];
    a.enrolled++;
    for (const v of list) {
      if (v.start - first > follow) break;
      a.minutes += (v.end - v.start) / 60_000;
      if (v.outcome === 'success') { a.passed++; break; }
    }
  }
  const row = (a: { enrolled: number; minutes: number; passed: number }): MinutesPerChange => ({
    enrolled: a.enrolled,
    minutesPerChange: a.enrolled ? Math.round((a.minutes / a.enrolled) * 10) / 10 : null,
    reachedPass: a.enrolled ? Math.round((a.passed / a.enrolled) * 1000) / 1000 : null,
  });
  return { with: row(acc.with), without: row(acc.without) };
}

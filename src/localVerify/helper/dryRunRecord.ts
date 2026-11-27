/**
 * The helper's own dry-run record (docs/specs/local-verify-borrowed-slices-count.md, C item 3).
 *
 * A waiting change (`headSha` different from `baseSha`) is refused `dry-run-not-done` until this
 * record shows a completed dry run of the requested lane on the helper's CURRENT sandbox image.
 * The helper does not take that on the run machine's word: the record is a file on the helper's
 * host, outside the sandbox, written only by the helper service, one entry per lane as that lane's
 * dry run finishes. So integration practice does not wait for the end-to-end dry run.
 *
 * "The image changes" means the pinned base image's digest or the sandbox settings' hash change
 * (`SandboxImageIdentity`). The daily re-creation of the sandbox from the same pinned image is not
 * a change, and does not touch this file.
 *
 * The file also holds each lane's dry run in progress (the files answered so far for one commit on
 * one image), because a dry run may take several idle periods and the service may restart between.
 *
 * "Lane proven" (spec D): a lane is proven for a helper when the dry run finished it with files
 * worth at least half of the lane's time passing. Each lane's record therefore also stores the
 * time of the files that passed and of all files answered, as the helper measured them, and the
 * share between the two. The record does not decide anything by itself: the run machine applies
 * the rule (`dryRunLaneProven`) when it plans which lanes to send.
 *
 * A missing or unreadable file means no dry run is done, by intent (refuse).
 */
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import { HELPER_LANES, SHA40_RE, isRequestFile, type HelperLane } from './helperProtocol.js';

/** What makes a sandbox "the same image": the pinned base image's digest and the hash of the sandbox settings. */
export interface SandboxImageIdentity { imageDigest: string; settingsHash: string }

export interface DryRunRecord {
  lane: HelperLane;
  imageDigest: string;
  settingsHash: string;
  /** The merged commit the dry run ran on. */
  commit: string;
  /** ISO time the lane's last file was answered. */
  finishedAt: string;
  /** Files of the lane the dry run answered, and how many of them passed on the helper. */
  files: number;
  passedFiles: number;
  /** Helper test time of all answered files, and of those that passed, in milliseconds. */
  totalMs: number;
  passedMs: number;
  /** `passedMs / totalMs`, rounded to 4 places; null when no time was measured at all. */
  passedShare: number | null;
}

/** One answered file of a dry run: its helper time and whether it passed there (collected, at least one test, none failed). */
export interface DryRunAnswered { file: string; ms: number; passed: boolean }

/** PRACTICE-PHASE DEFAULT (spec "Fixed limits", lane proven): files worth at least half the lane's time pass in the dry run. */
export const LANE_PROVEN_SHARE = 0.5;

/** Whether a lane's dry-run record shows the lane proven: at least half of its measured time passed. Unmeasured is not proven. */
export function dryRunLaneProven(r: Pick<DryRunRecord, 'passedShare'> | null): boolean {
  return !!r && r.passedShare !== null && r.passedShare >= LANE_PROVEN_SHARE;
}

/** file → [helper ms, passed 1 | 0] */
type DoneMap = Record<string, [number, 0 | 1]>;
interface DryRunProgress { lane: HelperLane; imageDigest: string; settingsHash: string; commit: string; done: DoneMap }

interface DryRunFile { v: 1; lanes: Partial<Record<HelperLane, DryRunRecord>>; progress: Partial<Record<HelperLane, DryRunProgress>> }

/** Bounded input: no lane has more files than the duration records allow (20,000). */
export const DRY_RUN_MAX_FILES = 20_000;

const ID_RE = /^[\x21-\x7e]{1,200}$/;
const isIdentity = (o: Record<string, unknown>): boolean => typeof o.imageDigest === 'string' && ID_RE.test(o.imageDigest) && typeof o.settingsHash === 'string' && ID_RE.test(o.settingsHash);
const isLane = (v: unknown): v is HelperLane => typeof v === 'string' && (HELPER_LANES as readonly string[]).includes(v);

function parseRecord(v: unknown, lane: HelperLane): DryRunRecord | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.lane !== lane || !isIdentity(o)) return null;
  if (typeof o.commit !== 'string' || !SHA40_RE.test(o.commit)) return null;
  if (typeof o.finishedAt !== 'string' || !Number.isFinite(Date.parse(o.finishedAt))) return null;
  const n = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!n(o.files) || !n(o.passedFiles) || !n(o.totalMs) || !n(o.passedMs) || o.passedFiles > o.files || o.passedMs > o.totalMs) return null;
  if (!(o.passedShare === null || (n(o.passedShare) && o.passedShare <= 1))) return null;
  return { lane, imageDigest: o.imageDigest as string, settingsHash: o.settingsHash as string, commit: o.commit, finishedAt: o.finishedAt,
    files: o.files, passedFiles: o.passedFiles, totalMs: o.totalMs, passedMs: o.passedMs, passedShare: o.passedShare as number | null };
}

function parseProgress(v: unknown, lane: HelperLane): DryRunProgress | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.lane !== lane || !isIdentity(o)) return null;
  if (typeof o.commit !== 'string' || !SHA40_RE.test(o.commit)) return null;
  if (!o.done || typeof o.done !== 'object' || Array.isArray(o.done)) return null;
  const entries = Object.entries(o.done as Record<string, unknown>);
  if (entries.length > DRY_RUN_MAX_FILES) return null;
  const done: DoneMap = {};
  for (const [f, v] of entries) {
    if (!isRequestFile(f) || !Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'number' || !Number.isFinite(v[0]) || v[0] < 0 || (v[1] !== 0 && v[1] !== 1)) return null;
    done[f] = [v[0], v[1]];
  }
  return { lane, imageDigest: o.imageDigest as string, settingsHash: o.settingsHash as string, commit: o.commit, done };
}

export class HelperDryRunStore {
  private readonly file: string;
  constructor(stateDir: string, private readonly now: () => number = () => Date.now()) {
    this.file = path.join(stateDir, 'state', 'local-verify', 'helper-dry-run.json');
  }

  private load(): DryRunFile {
    const empty: DryRunFile = { v: 1, lanes: {}, progress: {} };
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')); } catch { return empty; } // @silent-fallback-ok: no readable record means no dry run is done, which refuses every waiting change
    if (!raw || typeof raw !== 'object' || (raw as { v?: unknown }).v !== 1) return empty;
    const r = raw as { lanes?: unknown; progress?: unknown };
    const lanes = (r.lanes && typeof r.lanes === 'object' ? r.lanes : {}) as Record<string, unknown>;
    const progress = (r.progress && typeof r.progress === 'object' ? r.progress : {}) as Record<string, unknown>;
    for (const lane of HELPER_LANES) {
      const rec = parseRecord(lanes[lane], lane);
      if (rec) empty.lanes[lane] = rec;
      const p = parseProgress(progress[lane], lane);
      if (p) empty.progress[lane] = p;
    }
    return empty;
  }

  private save(f: DryRunFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    SafeFsExecutor.atomicWriteJsonSync(this.file, f, { operation: 'local-verify:helper-dry-run' });
  }

  /** The lane's record, whatever image it was made on, or null. */
  get(lane: HelperLane): DryRunRecord | null {
    return isLane(lane) ? this.load().lanes[lane] ?? null : null;
  }

  records(): DryRunRecord[] {
    const f = this.load();
    return HELPER_LANES.map((l) => f.lanes[l]).filter((x): x is DryRunRecord => !!x);
  }

  /**
   * Whether this lane's dry run is done ON THIS IMAGE: a record for the lane whose image digest
   * and settings hash both equal the current ones. A record for another lane, or for an older
   * digest or other settings, is not one.
   */
  doneFor(lane: HelperLane, image: SandboxImageIdentity): boolean {
    const r = this.get(lane);
    return !!r && r.imageDigest === image.imageDigest && r.settingsHash === image.settingsHash;
  }

  /**
   * Note the files one dry-run slice answered (with each file's helper time and whether it
   * passed), and write the lane's record once every file in `laneFiles` (the lane's files in that
   * commit that a helper may be sent) has been answered for this one commit on this one image.
   * Progress made on another commit or image is dropped: a dry run is one pass on one commit. A
   * file answered twice keeps its latest answer. Returns the record when this call completed the lane.
   */
  noteAnswered(lane: HelperLane, image: SandboxImageIdentity, commit: string, answered: readonly DryRunAnswered[], laneFiles: readonly string[]): DryRunRecord | null {
    if (!isLane(lane) || !SHA40_RE.test(commit) || laneFiles.length === 0 || laneFiles.length > DRY_RUN_MAX_FILES) return null;
    const f = this.load();
    const prev = f.progress[lane];
    const same = !!prev && prev.commit === commit && prev.imageDigest === image.imageDigest && prev.settingsHash === image.settingsHash;
    const inLane = new Set(laneFiles);
    const done: DoneMap = {};
    if (same) for (const [file, v] of Object.entries(prev!.done)) if (inLane.has(file)) done[file] = v;
    for (const a of answered) {
      if (!inLane.has(a.file)) continue;
      done[a.file] = [Number.isFinite(a.ms) && a.ms >= 0 ? Math.round(a.ms) : 0, a.passed ? 1 : 0];
    }
    const n = Object.keys(done).length;
    if (n < inLane.size) {
      f.progress[lane] = { lane, imageDigest: image.imageDigest, settingsHash: image.settingsHash, commit, done };
      this.save(f);
      return null;
    }
    let totalMs = 0; let passedMs = 0; let passedFiles = 0;
    for (const [ms, p] of Object.values(done)) { totalMs += ms; if (p === 1) { passedMs += ms; passedFiles++; } }
    const rec: DryRunRecord = {
      lane, imageDigest: image.imageDigest, settingsHash: image.settingsHash, commit, finishedAt: new Date(this.now()).toISOString(),
      files: n, passedFiles, totalMs, passedMs, passedShare: totalMs > 0 ? Math.round((passedMs / totalMs) * 10_000) / 10_000 : null,
    };
    f.lanes[lane] = rec;
    delete f.progress[lane];
    this.save(f);
    return rec;
  }

  /** How far a lane's dry run in progress is, for the status answer. */
  progress(lane: HelperLane): { commit: string; answered: number } | null {
    const p = this.load().progress[lane];
    return p ? { commit: p.commit, answered: Object.keys(p.done).length } : null;
  }

  /** `instar helper uninstall`. */
  clear(): void {
    try { SafeFsExecutor.safeRmSync(this.file, { force: true, operation: 'local-verify:helper-dry-run' }); } catch { /* @silent-fallback-ok: nothing to remove */ }
  }
}

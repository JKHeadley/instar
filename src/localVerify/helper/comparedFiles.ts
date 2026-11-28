/**
 * The files a helper has been compared on, per lane (docs/specs/local-verify-borrowed-slices-count.md,
 * D "A file this helper has never been compared on").
 *
 * A file the helper has never been compared on (a new test file, for example) is run by both
 * sides, compare-only, until one comparison agrees. The helper keeps the record of which files
 * have had an agreeing comparison (`state/local-verify/helper-compared.json`, on the helper,
 * beside its learned list) and its status answer reports it per lane, so the run machine can send
 * every other file compare-only. Unified by placement: one record per helper.
 *
 * The record belongs to one sandbox image and one runner version: when either changes, what was
 * compared before says nothing about the helper as it is now, and the record starts empty.
 *
 * A file enters only through an `agree` observation of the signed learned request, so the run
 * machine that reads the record is the one that wrote it; nothing a test runs can reach the file.
 * A missing or unreadable file means nothing has been compared (everything is sent compare-only).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import { HELPER_LANES, HELPER_LIMITS, isRequestFile, type HelperLane } from './helperProtocol.js';
import type { SandboxImageIdentity } from './dryRunRecord.js';

/** What a compared-on record belongs to. */
export interface ComparedKey extends SandboxImageIdentity { runnerVersion: string }

interface ComparedFile { v: 1; imageDigest: string; settingsHash: string; runnerVersion: string; lanes: Record<HelperLane, string[]> }

export interface ComparedSummary { count: number; digest: string }

const sameKey = (f: ComparedFile, k: ComparedKey): boolean => f.imageDigest === k.imageDigest && f.settingsHash === k.settingsHash && f.runnerVersion === k.runnerVersion;
const emptyLanes = (): Record<HelperLane, string[]> => ({ unit: [], integration: [], e2e: [] });

/** The digest of a set of file paths: sha256 over the sorted paths, one per line. Equal sets give equal digests. */
export function comparedDigest(files: readonly string[]): string {
  return crypto.createHash('sha256').update('instar-lv-helper-compared-v1\n').update([...new Set(files)].sort().join('\n')).digest('hex');
}

export class HelperComparedStore {
  private readonly file: string;
  private data: ComparedFile | null;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, 'state', 'local-verify', 'helper-compared.json');
    this.data = this.load();
  }

  private load(): ComparedFile | null {
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')); } catch { return null; } // @silent-fallback-ok: no readable record means nothing has been compared, so every file is sent compare-only
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    if (o.v !== 1 || typeof o.imageDigest !== 'string' || typeof o.settingsHash !== 'string' || typeof o.runnerVersion !== 'string') return null;
    const lanesRaw = (o.lanes && typeof o.lanes === 'object' ? o.lanes : {}) as Record<string, unknown>;
    const lanes = emptyLanes();
    for (const l of HELPER_LANES) {
      const list = lanesRaw[l];
      if (Array.isArray(list)) lanes[l] = [...new Set(list.filter(isRequestFile))].slice(0, HELPER_LIMITS.comparedFilesMax);
    }
    return { v: 1, imageDigest: o.imageDigest, settingsHash: o.settingsHash, runnerVersion: o.runnerVersion, lanes };
  }

  private save(): void {
    if (!this.data) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    SafeFsExecutor.atomicWriteJsonSync(this.file, this.data, { operation: 'local-verify:helper-compared' });
  }

  /**
   * Note files of one lane that an agreeing comparison covered, on this image and runner version.
   * A record made on another image or runner version is dropped first. Returns how many were new;
   * files past the lane's bound are not kept (the returned count shows it).
   */
  note(key: ComparedKey, lane: HelperLane, files: readonly string[]): number {
    if (!this.data || !sameKey(this.data, key)) this.data = { v: 1, imageDigest: key.imageDigest, settingsHash: key.settingsHash, runnerVersion: key.runnerVersion, lanes: emptyLanes() };
    const have = new Set(this.data.lanes[lane]);
    let added = 0;
    for (const f of files) {
      if (!isRequestFile(f) || have.has(f) || have.size >= HELPER_LIMITS.comparedFilesMax) continue;
      have.add(f);
      added++;
    }
    if (added > 0) {
      this.data.lanes[lane] = [...have].sort();
      this.save();
    }
    return added;
  }

  /** The files of one lane compared on this image and runner version (none when the record is for another). */
  files(key: ComparedKey | null, lane: HelperLane): string[] {
    if (!key || !this.data || !sameKey(this.data, key)) return [];
    return [...this.data.lanes[lane]];
  }

  /** Per lane, how many files have been compared and the digest of that set, for the status answer. */
  summary(key: ComparedKey | null): Record<HelperLane, ComparedSummary> {
    const out = {} as Record<HelperLane, ComparedSummary>;
    for (const l of HELPER_LANES) {
      const files = this.files(key, l);
      out[l] = { count: files.length, digest: comparedDigest(files) };
    }
    return out;
  }

  /** `instar helper uninstall`. */
  clear(): void {
    this.data = null;
    try { SafeFsExecutor.safeRmSync(this.file, { force: true, operation: 'local-verify:helper-compared' }); } catch { /* @silent-fallback-ok: nothing to remove */ }
  }
}

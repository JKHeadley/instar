/**
 * The durable, append-only difference ledger for the runtime-state scope change
 * (docs/specs/guard-runtime-state-scope.md §4).
 *
 *   <stateDir>/state/guard-scope-diff.jsonl            one row per distinct difference per day
 *   <stateDir>/state/guard-scope-diff.incomplete        created (O_EXCL) when the cap is hit
 *   <stateDir>/state/guard-scope-dispositions.jsonl     append-only dispositions, keyed by fingerprint
 *   <stateDir>/state/guard-scope-diff/archive/          the reviewed reset's archive
 *
 * Every write opens the file with O_APPEND, writes ONE line in one call and closes it, so
 * the server, the CLI and out-of-process children can all write without a read-modify-write
 * race. Counts, deduplication and dispositions are computed at read time. The ledger is
 * never rolled or rewritten in place.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { configuredRuntimeStateScopeMode, guardScopeStateDir, type RuntimeStateScopeMode } from './guardRuntimeScope.js';

export const GUARD_SCOPE_LEDGER_CAP_BYTES = 50 * 1024 * 1024;
export const LEDGER_FILE = 'guard-scope-diff.jsonl';
export const INCOMPLETE_FILE = 'guard-scope-diff.incomplete';
export const DISPOSITIONS_FILE = 'guard-scope-dispositions.jsonl';

export type DiffDirection = 'would-deny' | 'would-allow';
export type TargetClass = 'source-file' | 'checkout-root' | 'other';
export type Disposition = 'correct-refusal' | 'correct-allow' | 'needs-scope' | 'scope-bug';
export const DISPOSITIONS: readonly Disposition[] = ['correct-refusal', 'correct-allow', 'needs-scope', 'scope-bug'];

export interface DiffRowInput {
  direction: DiffDirection;
  verb: string;
  recursive: boolean;
  /** The new policy's reason (or `shadow-error`). */
  reason: string;
  caller: string;
  operation: string;
  samplePath: string;
  /**
   * The target's class. May be a function: it is then called only for a difference not yet
   * written today (it can run `git ls-files`, which must never run on a repeat).
   */
  targetClass: TargetClass | (() => TargetClass);
  /** Set for a row whose disposition is already decided by the spec (nuke → needs-scope, spec B). */
  presetDisposition?: { disposition: Disposition; note: string };
  detail?: string;
}

export interface DiffRow extends Omit<DiffRowInput, 'targetClass'> {
  targetClass: TargetClass;
  ts: string;
  day: string;
  fingerprint: string;
  shape: string;
  pid: number;
}

let ledgerCap = GUARD_SCOPE_LEDGER_CAP_BYTES;
/** @internal tests */
export function _setLedgerCapForTesting(bytes: number | null): void { ledgerCap = bytes ?? GUARD_SCOPE_LEDGER_CAP_BYTES; }

// Per-process, per-day suppression of repeats (bounds writes; not correctness-bearing).
const seenToday = new Set<string>();
let seenDay = '';
/** @internal tests */
export function _resetLedgerMemoryForTesting(): void { seenToday.clear(); seenDay = ''; }

export function ledgerPaths(dir: string): { dir: string; ledger: string; incomplete: string; dispositions: string; archive: string } {
  return {
    dir,
    ledger: path.join(dir, LEDGER_FILE),
    incomplete: path.join(dir, INCOMPLETE_FILE),
    dispositions: path.join(dir, DISPOSITIONS_FILE),
    archive: path.join(dir, 'guard-scope-diff', 'archive'),
  };
}

/**
 * The target's shape: an all-digit token (a pid, a timestamp) becomes `<n>`; a nonce-like
 * token (6+ alphanumerics mixing letters and digits) becomes `<id>`; remaining digit runs of 3+
 * become `<n>`.
 */
export function targetShape(p: string): string {
  return p
    .split('/')
    .map((c) => c.replace(/[A-Za-z0-9]{6,}/g, (tok) => (/^\d+$/.test(tok) ? '<n>' : /\d/.test(tok) ? '<id>' : tok)).replace(/\d{3,}/g, '<n>'))
    .join('/');
}

function stableCaller(frame: string): string {
  // Strip the absolute prefix so the same call site fingerprints the same everywhere.
  return frame.replace(/\(?\/[^\s()]*?\/(src|dist)\//, '$1/').replace(/:\d+\)?$/, '').trim();
}

export function diffFingerprint(r: Pick<DiffRowInput, 'direction' | 'verb' | 'recursive' | 'reason' | 'caller' | 'operation'> & { shape: string }): string {
  const key = JSON.stringify([r.direction, r.verb, r.recursive, r.reason, stableCaller(r.caller), r.operation, r.shape]);
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Append one line with O_APPEND in a single write. */
function appendLine(file: string, line: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a', 0o600);
  try { fs.writeSync(fd, line.endsWith('\n') ? line : `${line}\n`); }
  finally { fs.closeSync(fd); }
}

/**
 * True while the observation is incomplete. Fail-safe: only a marker that is provably
 * absent (ENOENT/ENOTDIR) counts as complete; a marker that cannot be checked (EACCES, any
 * other error), a marker of any kind (file or folder), or no resolvable ledger home counts
 * as incomplete, so `enforce` stays blocked.
 */
export function isObservationIncomplete(dir: string | null = guardScopeStateDir()): boolean {
  if (!dir) return true;
  try { fs.lstatSync(ledgerPaths(dir).incomplete); return true; }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return !(code === 'ENOENT' || code === 'ENOTDIR');
  }
}

/** Has this process already written this difference today? (No file access.) */
function seenKey(dir: string, input: Pick<DiffRowInput, 'direction' | 'verb' | 'recursive' | 'reason' | 'caller' | 'operation' | 'samplePath'>, now: Date): { key: string; day: string; shape: string; fingerprint: string } {
  const day = now.toISOString().slice(0, 10);
  if (day !== seenDay) { seenToday.clear(); seenDay = day; }
  const shape = targetShape(input.samplePath);
  const fingerprint = diffFingerprint({ ...input, shape });
  return { key: `${dir}\0${fingerprint}\0${day}`, day, shape, fingerprint };
}

/**
 * Record one difference. Returns `appended`, `suppressed` (already written today by this
 * process), `full` (cap reached; the incomplete marker exists) or throws on a write error
 * (the caller's fence records it).
 */
export function recordDiff(input: DiffRowInput, now: Date = new Date(), dir: string | null = guardScopeStateDir()): 'appended' | 'suppressed' | 'full' | 'no-home' {
  if (!dir) return 'no-home';
  // The suppression check comes FIRST and touches nothing: a repeat costs no stat, no
  // classification and no git spawn.
  const { key: dayKey, day, shape, fingerprint } = seenKey(dir, input, now);
  if (seenToday.has(dayKey)) return 'suppressed';
  const p = ledgerPaths(dir);
  if (isObservationIncomplete(dir)) { seenToday.add(dayKey); return 'full'; }
  let size = 0;
  try { size = fs.statSync(p.ledger).size; } catch { size = 0; } // @silent-fallback-ok — no ledger yet
  if (size >= ledgerCap) {
    markIncomplete(dir, now);
    seenToday.add(dayKey);
    return 'full';
  }
  // Mark seen before classifying: a classifier that throws must not be retried on every call.
  seenToday.add(dayKey);
  const targetClass = typeof input.targetClass === 'function' ? input.targetClass() : input.targetClass;
  const row: DiffRow = { ...input, targetClass, ts: now.toISOString(), day, fingerprint, shape, pid: process.pid };
  appendLine(p.ledger, JSON.stringify(row));
  return 'appended';
}

/** Create the incomplete marker exactly once (O_EXCL: a creation race is harmless). */
export function markIncomplete(dir: string | null = guardScopeStateDir(), now: Date = new Date()): boolean {
  if (!dir) return false;
  const p = ledgerPaths(dir);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const fd = fs.openSync(p.incomplete, 'wx', 0o600);
    try { fs.writeSync(fd, JSON.stringify({ since: now.toISOString(), capBytes: ledgerCap, pid: process.pid }) + '\n'); }
    finally { fs.closeSync(fd); }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/** Append a disposition for a fingerprint (last one wins at read time). */
export function appendDisposition(fingerprint: string, disposition: Disposition, note: string, by: string, dir: string | null = guardScopeStateDir()): void {
  if (!dir) throw new Error('no agent home: the ledger location cannot be resolved');
  if (!/^[0-9a-f]{16}$/.test(fingerprint)) throw new Error('fingerprint must be 16 hex characters');
  if (!DISPOSITIONS.includes(disposition)) throw new Error(`unknown disposition ${disposition}`);
  appendLine(ledgerPaths(dir).dispositions, JSON.stringify({ ts: new Date().toISOString(), fingerprint, disposition, note: String(note).slice(0, 500), by: String(by).slice(0, 120) }));
}

/**
 * The reviewed reset: archive the ledger and the incomplete marker under
 * `guard-scope-diff/archive/` (renames, never deletes) and start a fresh window.
 * Dispositions stay: they are keyed by fingerprint and remain true.
 */
export function resetObservationWindow(reviewedBy: string, now: Date = new Date(), dir: string | null = guardScopeStateDir()): { archivedTo: string } {
  if (!dir) throw new Error('no agent home: the ledger location cannot be resolved');
  if (!reviewedBy || !reviewedBy.trim()) throw new Error('a reviewed reset names who reviewed it');
  const p = ledgerPaths(dir);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dest = path.join(p.archive, stamp);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of [p.ledger, p.incomplete]) {
    try { fs.renameSync(f, path.join(dest, path.basename(f))); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  }
  appendLine(path.join(dest, 'reset.json'), JSON.stringify({ at: now.toISOString(), reviewedBy }));
  _resetLedgerMemoryForTesting();
  return { archivedTo: dest };
}

export interface LedgerDifference {
  fingerprint: string;
  direction: DiffDirection;
  verb: string;
  recursive: boolean;
  reason: string;
  caller: string;
  operation: string;
  shape: string;
  targetClass: TargetClass;
  samplePath: string;
  rows: number;
  days: number;
  firstSeen: string;
  lastSeen: string;
  disposition: Disposition | null;
  dispositionNote?: string;
}

export interface LedgerSummary {
  mode: RuntimeStateScopeMode;
  effectiveMode: RuntimeStateScopeMode;
  incomplete: boolean;
  ledgerBytes: number;
  capBytes: number;
  malformedRows: number;
  counts: {
    wouldDeny: number;
    wouldAllow: number;
    distinct: number;
    undisposed: number;
    byClass: Record<TargetClass, number>;
  };
  firstSeen: string | null;
  undisposed: LedgerDifference[];
}

const MAX_LISTED = 200;

/** Stream a JSONL file line by line (the ledger can reach 50 MB; it is never read whole). */
async function* streamLines(file: string): AsyncGenerator<string> {
  let stream: fs.ReadStream;
  try { await fs.promises.access(file); } catch { return; } // @silent-fallback-ok — absent file: no lines
  stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try { for await (const line of rl) yield line; }
  finally { rl.close(); stream.destroy(); }
}

/** Read the ledger and dispositions and compute the summary (counts, dedup, dispositions). */
export async function readLedgerSummary(dir: string | null = guardScopeStateDir()): Promise<LedgerSummary> {
  if (!dir) {
    const mode = configuredRuntimeStateScopeMode();
    return {
      mode, effectiveMode: 'report', incomplete: true, ledgerBytes: 0, capBytes: ledgerCap, malformedRows: 0,
      counts: { wouldDeny: 0, wouldAllow: 0, distinct: 0, undisposed: 0, byClass: { 'source-file': 0, 'checkout-root': 0, other: 0 } },
      firstSeen: null, undisposed: [],
    };
  }
  const p = ledgerPaths(dir);
  let ledgerBytes = 0;
  try { ledgerBytes = (await fs.promises.stat(p.ledger)).size; } catch { /* @silent-fallback-ok — no ledger yet: zero rows */ }
  const dispositions = new Map<string, { disposition: Disposition; note?: string }>();
  for await (const line of streamLines(p.dispositions)) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line) as { fingerprint?: string; disposition?: Disposition; note?: string };
      if (d.fingerprint && d.disposition && DISPOSITIONS.includes(d.disposition)) dispositions.set(d.fingerprint, { disposition: d.disposition, note: d.note });
    } catch { /* @silent-fallback-ok — a malformed disposition line decides nothing */ }
  }

  const diffs = new Map<string, LedgerDifference & { daySet: Set<string> }>();
  let malformed = 0;
  let wouldDeny = 0;
  let wouldAllow = 0;
  let firstSeen: string | null = null;
  for await (const line of streamLines(p.ledger)) {
    if (!line.trim()) continue;
    let r: DiffRow;
    try { r = JSON.parse(line) as DiffRow; } catch { malformed++; continue; }
    if (!r || typeof r.fingerprint !== 'string' || (r.direction !== 'would-deny' && r.direction !== 'would-allow')) { malformed++; continue; }
    if (r.direction === 'would-deny') wouldDeny++; else wouldAllow++;
    if (!firstSeen || r.ts < firstSeen) firstSeen = r.ts;
    const ex = diffs.get(r.fingerprint);
    if (ex) {
      ex.rows++;
      ex.daySet.add(r.day);
      if (r.ts < ex.firstSeen) ex.firstSeen = r.ts;
      if (r.ts > ex.lastSeen) ex.lastSeen = r.ts;
      if (r.targetClass === 'source-file') ex.targetClass = 'source-file';
      if (!ex.disposition && r.presetDisposition) { ex.disposition = r.presetDisposition.disposition; ex.dispositionNote = r.presetDisposition.note; }
    } else {
      diffs.set(r.fingerprint, {
        fingerprint: r.fingerprint, direction: r.direction, verb: r.verb, recursive: !!r.recursive, reason: r.reason,
        caller: r.caller, operation: r.operation, shape: r.shape, targetClass: r.targetClass ?? 'other', samplePath: r.samplePath,
        rows: 1, days: 0, daySet: new Set([r.day]), firstSeen: r.ts, lastSeen: r.ts,
        disposition: r.presetDisposition?.disposition ?? null, dispositionNote: r.presetDisposition?.note,
      });
    }
  }
  const byClass: Record<TargetClass, number> = { 'source-file': 0, 'checkout-root': 0, other: 0 };
  const all: LedgerDifference[] = [];
  for (const d of diffs.values()) {
    const set = dispositions.get(d.fingerprint);
    if (set) { d.disposition = set.disposition; d.dispositionNote = set.note; }
    const { daySet, ...rest } = d;
    rest.days = daySet.size;
    byClass[rest.targetClass]++;
    all.push(rest);
  }
  const undisposed = all.filter((d) => !d.disposition).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  const mode = configuredRuntimeStateScopeMode();
  const incomplete = isObservationIncomplete(dir);
  return {
    mode,
    effectiveMode: mode === 'enforce' && !incomplete ? 'enforce' : 'report',
    incomplete,
    ledgerBytes,
    capBytes: ledgerCap,
    malformedRows: malformed,
    counts: { wouldDeny, wouldAllow, distinct: all.length, undisposed: undisposed.length, byClass },
    firstSeen,
    undisposed: undisposed.slice(0, MAX_LISTED),
  };
}

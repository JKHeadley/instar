/**
 * Baseline results (docs/specs/local-verify-borrowed-slices-count.md, F "Baseline results" and
 * "Build decisions: the baseline file").
 *
 * The coordinator keeps, for its last three green `main` verifies, each test file's passed,
 * failed, skipped and to-do counts and the digest of its test names and outcomes, in
 * `state/local-verify/main-file-counts.json`. The pass definition and the dry run read it.
 *
 *  - It lives in the server's state folder, outside every run tree. Its hash is written to the
 *    audit log when the server writes it and checked when it is read: a mismatch means NO baseline.
 *  - A baseline is usable for a verify only if its commit is `baseSha` or an ancestor of it, and
 *    only for files whose content is the same in the merge tree (`selectBaselineRows`).
 *  - The coordinator sends the file to a peer when it changes; a peer stores the coordinator's
 *    copy and never writes its own.
 *  - A baseline a dry run is using is kept (pinned) until that dry run ends.
 *
 * A file that failed in its lane (and passed alone afterwards) has no row: a baseline row always
 * describes a clean run of the file.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export const MAIN_FILE_COUNTS_LIMITS = Object.freeze({
  /** The last three green main verifies. */
  baselines: 3,
  /** Baselines kept beyond those because a dry run is using them. */
  pinned: 2,
  /** Files per baseline (the duration records' own bound; about 5,500 today). */
  filesPerBaseline: 20_000,
  fileChars: 300,
  countMax: 1_000_000,
  /** The file is under 1 MB per baseline today; anything past this is refused unread. */
  maxBytes: 16 * 1024 * 1024,
});

/** One file's row: passed, failed, skipped, to-do, and the names-and-outcomes digest. */
export type FileCountsRow = [number, number, number, number, string];

export interface MainBaseline {
  /** The `main` commit the green verify ran on. */
  commit: string;
  /** The verify's finish time (ISO). */
  finishedAt: string;
  /** The machine that ran it. */
  machineId: string;
  files: Record<string, FileCountsRow>;
}

export interface MainFileCountsFile { v: 1; baselines: MainBaseline[]; pinned: string[] }

const SHA40 = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MACHINE_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const isIso = (s: unknown): s is string => typeof s === 'string' && s.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s));
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= MAIN_FILE_COUNTS_LIMITS.countMax;

export function isFileCountsRow(v: unknown): v is FileCountsRow {
  return Array.isArray(v) && v.length === 5 && isCount(v[0]) && isCount(v[1]) && isCount(v[2]) && isCount(v[3]) && typeof v[4] === 'string' && DIGEST.test(v[4]);
}

const isTestPath = (f: string): boolean => f.length >= 1 && f.length <= MAIN_FILE_COUNTS_LIMITS.fileChars && !f.startsWith('/') && !f.includes('..') && !f.includes('\\') && !f.includes('\0');

/**
 * A per-file counts map as a run child or a peer hands it over, strictly: a plain object of at
 * most 20,000 relative paths, each with a valid row. Anything else is null (no baseline from it).
 */
export function parseFileCounts(v: unknown): Record<string, FileCountsRow> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > MAIN_FILE_COUNTS_LIMITS.filesPerBaseline) return null;
  const out: Record<string, FileCountsRow> = {};
  for (const [f, row] of entries) {
    if (!isTestPath(f) || !isFileCountsRow(row)) return null;
    out[f] = [row[0], row[1], row[2], row[3], row[4]];
  }
  return out;
}

export function parseBaseline(v: unknown): MainBaseline | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const x = v as Record<string, unknown>;
  if (!Object.keys(x).every((k) => ['commit', 'finishedAt', 'machineId', 'files'].includes(k))) return null;
  if (typeof x.commit !== 'string' || !SHA40.test(x.commit) || !isIso(x.finishedAt)) return null;
  if (typeof x.machineId !== 'string' || !MACHINE_ID_RE.test(x.machineId)) return null;
  const files = parseFileCounts(x.files);
  return files ? { commit: x.commit, finishedAt: x.finishedAt, machineId: x.machineId, files } : null;
}

/** The whole file, strictly: version 1, bounded lists, exactly the known keys. */
export function parseMainFileCounts(v: unknown): MainFileCountsFile | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const x = v as Record<string, unknown>;
  if (x.v !== 1 || !Object.keys(x).every((k) => ['v', 'baselines', 'pinned'].includes(k))) return null;
  const L = MAIN_FILE_COUNTS_LIMITS;
  if (!Array.isArray(x.baselines) || x.baselines.length > L.baselines + L.pinned) return null;
  if (!Array.isArray(x.pinned) || x.pinned.length > L.pinned || !x.pinned.every((c) => typeof c === 'string' && SHA40.test(c))) return null;
  const baselines: MainBaseline[] = [];
  for (const b of x.baselines) {
    const p = parseBaseline(b);
    if (!p || baselines.some((o) => o.commit === p.commit)) return null;
    baselines.push(p);
  }
  return { v: 1, baselines, pinned: [...(x.pinned as string[])] };
}

export const sha256Hex = (bytes: string | Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex');

/**
 * Add one green main verify's baseline (newest first). The last three are kept, plus any older
 * one a dry run has pinned (at most two). A commit already present is replaced. Pure.
 */
export function withBaseline(file: MainFileCountsFile, b: MainBaseline): MainFileCountsFile {
  const L = MAIN_FILE_COUNTS_LIMITS;
  const rest = file.baselines.filter((o) => o.commit !== b.commit);
  const all = [b, ...rest];
  const kept = all.slice(0, L.baselines);
  const pinnedKept = all.slice(L.baselines).filter((o) => file.pinned.includes(o.commit)).slice(0, L.pinned);
  return { v: 1, baselines: [...kept, ...pinnedKept], pinned: file.pinned.filter((c) => [...kept, ...pinnedKept].some((o) => o.commit === c)) };
}

/** Pin a kept baseline for a dry run (so it outlives newer greens), or release it. Pure. */
export function withPin(file: MainFileCountsFile, commit: string, pinned: boolean): MainFileCountsFile | null {
  if (!pinned) {
    const next = file.pinned.filter((c) => c !== commit);
    const all = file.baselines;
    const head = all.slice(0, MAIN_FILE_COUNTS_LIMITS.baselines);
    return { v: 1, baselines: [...head, ...all.slice(MAIN_FILE_COUNTS_LIMITS.baselines).filter((o) => next.includes(o.commit))], pinned: next };
  }
  if (!file.baselines.some((o) => o.commit === commit)) return null;
  if (file.pinned.includes(commit)) return file;
  if (file.pinned.length >= MAIN_FILE_COUNTS_LIMITS.pinned) return null;
  return { ...file, pinned: [...file.pinned, commit] };
}

/**
 * The baseline a verify may use (spec "Build decisions"): the newest kept baseline whose commit
 * is `baseSha` or an ancestor of it. `isBaseOrAncestor` is the caller's git answer; anything but
 * `true` (false, or null for "could not tell") is not usable. Null: nothing counts on that verify.
 */
export function usableBaseline(baselines: readonly MainBaseline[], baseSha: string, isBaseOrAncestor: (commit: string) => boolean | null): MainBaseline | null {
  for (const b of baselines) {
    if (b.commit === baseSha || isBaseOrAncestor(b.commit) === true) return b;
  }
  return null;
}

/**
 * The baseline rows a verify may use for the given files: only files the baseline has, and only
 * those whose content in the merge tree is the same as at the baseline's commit. The two lookups
 * return the file's blob id (or any content hash) on each side; a missing or unreadable blob
 * (null) on either side means no row. Pure given its lookups.
 */
export function selectBaselineRows(
  baseline: MainBaseline | null,
  files: readonly string[],
  blobAtBaseline: (file: string) => string | null,
  blobInMergeTree: (file: string) => string | null,
): Map<string, FileCountsRow> {
  const out = new Map<string, FileCountsRow>();
  if (!baseline) return out;
  for (const f of files) {
    const row = Object.prototype.hasOwnProperty.call(baseline.files, f) ? baseline.files[f] : undefined;
    if (!row) continue;
    const a = blobAtBaseline(f);
    const b = blobInMergeTree(f);
    if (a === null || b === null || a !== b) continue;
    out.set(f, row);
  }
  return out;
}

export const MAIN_FILE_COUNTS_AUDIT_EVENT = 'main-file-counts-written';

/**
 * The hash of the last write as the audit log holds it: the newest `main-file-counts-written`
 * row, looked for in the active log and then in its rotated files. Null when there is none.
 */
export function lastAuditedHash(auditPath: string): string | null {
  for (const p of [auditPath, ...Array.from({ length: 9 }, (_, i) => `${auditPath}.${i + 1}`)]) {
    let text: string;
    try { text = fs.readFileSync(p, 'utf-8'); } catch { continue; } // @silent-fallback-ok: an absent log file holds no row
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes(MAIN_FILE_COUNTS_AUDIT_EVENT)) continue;
      try {
        const row = JSON.parse(lines[i]) as { event?: unknown; hash?: unknown };
        if (row.event === MAIN_FILE_COUNTS_AUDIT_EVENT && typeof row.hash === 'string' && DIGEST.test(row.hash)) return row.hash;
      } catch { /* @silent-fallback-ok: a torn line is skipped */ }
    }
  }
  return null;
}

export interface MainFileCountsStoreDeps {
  /** The agent's `.instar` directory. */
  stateDir: string;
  /** Appends one row to the Local Verify audit log. */
  audit(event: Record<string, unknown>): void;
  /** Override for tests; production reads the audit log's last written hash. */
  auditedHash?: () => string | null;
}

/**
 * The file on disk. Every write records the bytes' hash in the audit log; every read checks the
 * bytes against the last recorded hash. Unreadable, malformed, oversize or mismatching: no baseline.
 */
export class MainFileCountsStore {
  readonly file: string;
  private readonly auditPath: string;
  /** The hash this process last wrote or last verified against the audit log. */
  private expected: string | null | undefined = undefined;

  constructor(private readonly d: MainFileCountsStoreDeps) {
    this.file = path.join(d.stateDir, 'state', 'local-verify', 'main-file-counts.json');
    this.auditPath = path.join(d.stateDir, 'logs', 'local-verify.jsonl');
  }

  private expectedHash(): string | null {
    if (this.expected === undefined) this.expected = this.d.auditedHash ? this.d.auditedHash() : lastAuditedHash(this.auditPath);
    return this.expected;
  }

  /** The file with its hash, or null with the reason (`absent`, `oversize`, `hash-mismatch`, `no-audited-hash`, `malformed`). */
  read(): { ok: true; file: MainFileCountsFile; hash: string } | { ok: false; reason: 'absent' | 'oversize' | 'hash-mismatch' | 'no-audited-hash' | 'malformed' } {
    let bytes: Buffer;
    try {
      if (fs.statSync(this.file).size > MAIN_FILE_COUNTS_LIMITS.maxBytes) return { ok: false, reason: 'oversize' };
      bytes = fs.readFileSync(this.file);
    } catch { return { ok: false, reason: 'absent' }; } // @silent-fallback-ok: no file is no baseline
    const hash = sha256Hex(bytes);
    const want = this.expectedHash();
    if (want === null) return { ok: false, reason: 'no-audited-hash' };
    if (want !== hash) return { ok: false, reason: 'hash-mismatch' };
    let parsed: MainFileCountsFile | null = null;
    try { parsed = parseMainFileCounts(JSON.parse(bytes.toString('utf-8'))); } catch { parsed = null; } // @silent-fallback-ok: unparseable is no baseline
    return parsed ? { ok: true, file: parsed, hash } : { ok: false, reason: 'malformed' };
  }

  /** The kept baselines, newest first; empty when there is no trustworthy file. */
  baselines(): MainBaseline[] {
    const r = this.read();
    return r.ok ? r.file.baselines : [];
  }

  /** The current file's hash, or null when there is no trustworthy file. */
  hash(): string | null {
    const r = this.read();
    return r.ok ? r.hash : null;
  }

  /** Write the file and record its hash in the audit log. Returns the hash. */
  write(file: MainFileCountsFile, why: string): string {
    const text = JSON.stringify(file);
    const hash = sha256Hex(Buffer.from(text, 'utf-8'));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    SafeFsExecutor.atomicWriteFileSync(this.file, text, { operation: 'local-verify:main-file-counts', mode: 0o600 }); /* state-registry: local-verify-main-file-counts */
    this.expected = hash;
    this.d.audit({ event: MAIN_FILE_COUNTS_AUDIT_EVENT, hash, bytes: text.length, baselines: file.baselines.map((b) => b.commit), pinned: file.pinned, why });
    return hash;
  }

  /** Add a green main verify's baseline. A file that cannot be trusted is replaced, never merged into. */
  add(b: MainBaseline): string {
    const cur = this.read();
    return this.write(withBaseline(cur.ok ? cur.file : { v: 1, baselines: [], pinned: [] }, b), 'green-main');
  }

  /** Pin or release a baseline for a dry run (stage 6). False when the commit is not kept or no pin is free. */
  pin(commit: string, pinned: boolean): boolean {
    const cur = this.read();
    if (!cur.ok) return false;
    const next = withPin(cur.file, commit, pinned);
    if (!next) return false;
    if (next !== cur.file) this.write(next, pinned ? 'dry-run-pin' : 'dry-run-release');
    return true;
  }

  /** Peer side: store the coordinator's copy exactly as sent (already parsed), under this machine's own audit row. */
  replace(file: MainFileCountsFile): string {
    return this.write(file, 'from-coordinator');
  }

  /** Remove the file (tests, and a peer told the coordinator has none). */
  clear(): void {
    try { SafeFsExecutor.safeRmSync(this.file, { force: true, operation: 'local-verify:main-file-counts-clear' }); } catch { /* @silent-fallback-ok: an absent file is already clear */ }
    this.expected = null;
  }
}

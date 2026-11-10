/**
 * The engine checkpoint (context-budget-layered-summaries §9.3 step 3 and
 * step 8, §14 "Engine checkpoint", §18 "the engine checkpoint restoring a
 * transcript with scrub-triggering and oversize entries byte-exactly").
 *
 * A byte-exact copy of a session's pre-fold transcript: the IMMUTABLE restore
 * target for a rollback. Unscrubbed on purpose (a scrubbed transcript cannot
 * restore the original context), so it is:
 *  - mode 0600 under `state/context-archive/<topic>/checkpoints/` (dirs 0700),
 *  - never served (the file routes refuse `state/context-archive/`),
 *  - never backed up (`context-archive` is a never-backup segment),
 *  - never replicated (machine-local: an engine session resumes only on the
 *    machine whose transcript directory holds it),
 *  - a fold carrier: deleted when its fold COMMITS or ABORTS (an aborted
 *    fold never replaced the context); after a ROLLBACK it is kept for a
 *    grace period (default 24 h) and then pruned by the sentinel
 *    (`pruneSettledCheckpoints`); an orphan with no record is removed by the
 *    boot sweep.
 *
 * Restore (step 8): resume the recorded session when its transcript's last
 * entry id still equals the checkpoint's; otherwise MATERIALISE the
 * checkpoint as a new session transcript in the engine's transcript
 * directory (every compact `"sessionId":"<id>"` token, top-level or nested,
 * rewritten to the new id) and resume that. A materialise that rewrites NO
 * token is degraded (`session-id-not-found`): the engine wrote a form this
 * restore does not recognise, so the result would still carry the old id.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FoldCarrier, FoldState } from './FoldCoordinator.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CHECKPOINT_GRACE_MS = 24 * 60 * 60_000;

export interface EngineCheckpoint {
  schema: 'engine-checkpoint/1';
  topicKey: string;
  foldId: string;
  /** The engine's session id the transcript belongs to. */
  sessionId: string;
  /** Absolute path of the source transcript at checkpoint time. */
  sourcePath: string;
  /** Path of the checkpoint copy, relative to the archive root. */
  file: string;
  sha256: string;
  bytes: number;
  /** The `uuid` of the last transcript entry that has one (resume vs materialise). */
  lastEntryId: string | null;
  takenAt: number;
  /** Set when the fold settled without committing; the grace clock starts here. */
  settledAt?: number;
}

export function contextArchiveRoot(stateDir: string): string {
  return path.join(stateDir, 'state', 'context-archive');
}
function checkpointsDir(stateDir: string, topicKey: string): string {
  return path.join(contextArchiveRoot(stateDir), topicKey, 'checkpoints');
}
function pointerPath(stateDir: string, topicKey: string, foldId: string): string {
  return path.join(checkpointsDir(stateDir, topicKey), `${foldId}.json`);
}

/** The `uuid` of the last line that carries one (reads only the tail). */
export function lastEntryId(file: string, tailBytes = 1 << 20): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf-8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim();
      if (!l) continue;
      try {
        const e = JSON.parse(l) as { uuid?: unknown };
        if (typeof e.uuid === 'string' && e.uuid) return e.uuid;
      } catch { /* @silent-fallback-ok — a partial first line of the tail window is skipped */ }
    }
    // The last entry can be larger than the tail window (an oversize tool
    // result): read the whole file once before concluding there is none.
    if (start > 0) return lastEntryId(file, size);
    return null;
  } catch {
    return null; // @silent-fallback-ok — an unreadable transcript has no last entry; the caller materialises
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* @silent-fallback-ok — closing a read fd */ } }
  }
}

function sha256File(file: string): { sha256: string; bytes: number } {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  let bytes = 0;
  try {
    const buf = Buffer.alloc(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
      bytes += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: h.digest('hex'), bytes };
}

export type TakeResult = { ok: true; checkpoint: EngineCheckpoint } | { ok: false; reason: string };

/**
 * Take the checkpoint: copy the transcript byte-exactly, fsync, verify the
 * copy's hash against the source's, and write the pointer last (a crash
 * before the pointer leaves an unattributed file the boot sweep removes).
 */
export function takeEngineCheckpoint(
  stateDir: string,
  input: { topicKey: string; foldId: string; sessionId: string; transcriptPath: string },
  now: number = Date.now(),
): TakeResult {
  if (!SAFE_ID.test(input.topicKey) || !SAFE_ID.test(input.foldId) || !SAFE_ID.test(input.sessionId)) return { ok: false, reason: 'unsafe-id' };
  if (!fs.existsSync(input.transcriptPath)) return { ok: false, reason: 'no-transcript' };
  const dir = checkpointsDir(stateDir, input.topicKey);
  const copy = path.join(dir, `${input.foldId}.jsonl`);
  // The checkpoint is the IMMUTABLE restore target: a second take for the same
  // fold (a retried or crash-resumed step 3) must never replace it.
  if (fs.existsSync(copy) || fs.existsSync(pointerPath(stateDir, input.topicKey, input.foldId))) return { ok: false, reason: 'checkpoint-exists' };
  try {
    for (const d of [contextArchiveRoot(stateDir), path.dirname(dir), dir]) {
      fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(d).isSymbolicLink()) return { ok: false, reason: 'symlinked-archive-dir' };
      fs.chmodSync(d, 0o700);
    }
    const src = sha256File(input.transcriptPath);
    // Never write through a pre-planted temp file or link: remove it, then
    // copy with COPYFILE_EXCL (refuses an existing target).
    if (fs.existsSync(`${copy}.tmp`) || isLink(`${copy}.tmp`)) SafeFsExecutor.safeRmSync(`${copy}.tmp`, { force: true, operation: 'src/monitoring/engineCheckpoint.ts:take-stale-tmp' });
    fs.copyFileSync(input.transcriptPath, `${copy}.tmp`, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(`${copy}.tmp`, 0o600);
    const fd = fs.openSync(`${copy}.tmp`, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const dst = sha256File(`${copy}.tmp`);
    // The source can grow while it is copied (the engine appends); the copy is
    // valid only if it equals the source as hashed just before the copy.
    if (dst.sha256 !== src.sha256) {
      SafeFsExecutor.safeRmSync(`${copy}.tmp`, { force: true, operation: 'src/monitoring/engineCheckpoint.ts:take' });
      return { ok: false, reason: 'source-changed-during-copy' };
    }
    fs.renameSync(`${copy}.tmp`, copy);
    fsyncDir(dir);
    const checkpoint: EngineCheckpoint = {
      schema: 'engine-checkpoint/1',
      topicKey: input.topicKey,
      foldId: input.foldId,
      sessionId: input.sessionId,
      sourcePath: path.resolve(input.transcriptPath),
      file: path.relative(contextArchiveRoot(stateDir), copy),
      sha256: dst.sha256,
      bytes: dst.bytes,
      lastEntryId: lastEntryId(copy),
      takenAt: now,
    };
    writePointer(stateDir, checkpoint);
    return { ok: true, checkpoint };
  } catch (err) {
    return { ok: false, reason: `write-failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function isLink(p: string): boolean {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } // @silent-fallback-ok — absent path is not a link
}

function fsyncDir(dir: string): void {
  try { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch { /* @silent-fallback-ok — directory fsync is unsupported on some filesystems; the file itself is fsynced */ }
}

function writePointer(stateDir: string, c: EngineCheckpoint): void {
  const p = pointerPath(stateDir, c.topicKey, c.foldId);
  const fd = fs.openSync(`${p}.tmp`, 'w', 0o600);
  try { fs.writeSync(fd, JSON.stringify(c)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(`${p}.tmp`, p);
  fsyncDir(path.dirname(p));
}

export function readEngineCheckpoint(stateDir: string, topicKey: string, foldId: string): EngineCheckpoint | null {
  if (!SAFE_ID.test(topicKey) || !SAFE_ID.test(foldId)) return null;
  try {
    const c = JSON.parse(fs.readFileSync(pointerPath(stateDir, topicKey, foldId), 'utf-8')) as EngineCheckpoint;
    // The pointer may only name this fold's own copy (no path it could be steered to).
    const expected = path.join(topicKey, 'checkpoints', `${foldId}.jsonl`);
    return c?.schema === 'engine-checkpoint/1' && c.foldId === foldId && c.topicKey === topicKey && c.file === expected ? c : null;
  } catch {
    return null; // @silent-fallback-ok — no or torn pointer means no restorable checkpoint; the caller takes the degraded path
  }
}

/** The checkpoint copy on disk still hashes to its pointer. */
export function verifyEngineCheckpoint(stateDir: string, c: EngineCheckpoint): boolean {
  try {
    const f = path.join(contextArchiveRoot(stateDir), c.file);
    const h = sha256File(f);
    return h.sha256 === c.sha256 && h.bytes === c.bytes;
  } catch {
    return false; // @silent-fallback-ok — an unreadable copy fails verification; the caller takes rollback-degraded
  }
}

export type RestorePlan =
  | { mode: 'resume'; sessionId: string }
  | { mode: 'materialised'; sessionId: string; transcriptPath: string }
  | { mode: 'degraded'; reason: string };

/**
 * Restore (§9.3 step 8). `currentTranscriptPath` is the recorded session's
 * transcript now; `engineTranscriptDir` is where the engine looks for
 * transcripts (Claude Code: ~/.claude/projects/<project-slug>/). Never
 * modifies the checkpoint.
 */
export function restoreEngineCheckpoint(
  stateDir: string,
  c: EngineCheckpoint,
  opts: { currentTranscriptPath: string | null; engineTranscriptDir: string; newSessionId: () => string },
): RestorePlan {
  if (!verifyEngineCheckpoint(stateDir, c)) return { mode: 'degraded', reason: 'checkpoint-unverifiable' };
  if (opts.currentTranscriptPath && c.lastEntryId && lastEntryId(opts.currentTranscriptPath) === c.lastEntryId) {
    return { mode: 'resume', sessionId: c.sessionId };
  }
  const id = opts.newSessionId();
  if (!UUID.test(id)) return { mode: 'degraded', reason: 'bad-session-id' };
  const target = path.join(opts.engineTranscriptDir, `${id}.jsonl`);
  if (fs.existsSync(target)) return { mode: 'degraded', reason: 'target-exists' };
  try {
    fs.mkdirSync(opts.engineTranscriptDir, { recursive: true });
    // Byte-preserving: only the exact `"sessionId":"<recorded id>"` token is
    // rewritten (the recorded id is a validated SAFE_ID); numbers, escapes,
    // CRLF and any non-UTF-8 bytes elsewhere are carried over untouched.
    const src = fs.readFileSync(path.join(contextArchiveRoot(stateDir), c.file));
    const from = Buffer.from(`"sessionId":"${c.sessionId}"`);
    const to = Buffer.from(`"sessionId":"${id}"`);
    const parts: Buffer[] = [];
    let at = 0;
    for (let i = src.indexOf(from); i !== -1; i = src.indexOf(from, at)) {
      parts.push(src.subarray(at, i), to);
      at = i + from.length;
    }
    parts.push(src.subarray(at));
    if (parts.length === 1) return { mode: 'degraded', reason: 'session-id-not-found' };
    fs.writeFileSync(`${target}.tmp`, Buffer.concat(parts), { mode: 0o600 });
    fs.renameSync(`${target}.tmp`, target);
    return { mode: 'materialised', sessionId: id, transcriptPath: target };
  } catch (err) {
    return { mode: 'degraded', reason: `materialise-failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function removeCheckpoint(stateDir: string, topicKey: string, foldId: string): void {
  const dir = checkpointsDir(stateDir, topicKey);
  for (const f of [`${foldId}.jsonl`, `${foldId}.json`, `${foldId}.jsonl.tmp`, `${foldId}.json.tmp`]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) SafeFsExecutor.safeRmSync(p, { force: true, operation: 'src/monitoring/engineCheckpoint.ts:remove' });
  }
}

/** Every checkpoint on disk by (topic, fold), attributable or not. */
function scan(stateDir: string): Array<{ topicKey: string; foldId: string; pointer: EngineCheckpoint | null }> {
  const out: Array<{ topicKey: string; foldId: string; pointer: EngineCheckpoint | null }> = [];
  let topics: string[] = [];
  try { topics = fs.readdirSync(contextArchiveRoot(stateDir)); } catch { return out; } // @silent-fallback-ok — no archive root means no checkpoints
  for (const t of topics.filter((x) => SAFE_ID.test(x))) {
    let files: string[] = [];
    try { files = fs.readdirSync(checkpointsDir(stateDir, t)); } catch { continue; } // @silent-fallback-ok — topic without checkpoints
    const folds = new Set(files.map((f) => /^([A-Za-z0-9_-]{1,128})\.jsonl?(\.tmp)?$/.exec(f)?.[1]).filter((x): x is string => !!x));
    for (const foldId of folds) out.push({ topicKey: t, foldId, pointer: readEngineCheckpoint(stateDir, t, foldId) });
  }
  return out;
}

/**
 * The checkpoint as a fold carrier. On the terminal transition: a COMMITTED
 * or ABORTED fold's checkpoint is deleted; a ROLLED-BACK one is marked
 * settled and kept for the grace period (the sentinel prunes it). A
 * checkpoint with no record at all is an orphan and is removed.
 */
export function engineCheckpointCarrier(stateDir: string, recordState: (topicKey: string, foldId: string) => FoldState | null, now: () => number = Date.now): FoldCarrier {
  return {
    kind: 'engine-checkpoint',
    list: () => scan(stateDir).filter((e) => !e.pointer?.settledAt).map((e) => ({ topicKey: e.topicKey, foldId: e.foldId })),
    release: (topicKey, foldId) => {
      const state = recordState(topicKey, foldId);
      const c = readEngineCheckpoint(stateDir, topicKey, foldId);
      // committed: the fold took; aborted: the context was never replaced; no
      // record: an orphan. Only a ROLLED-BACK fold keeps it for the grace period.
      if (state === 'committed' || state === 'aborted' || state === null || !c) { removeCheckpoint(stateDir, topicKey, foldId); return; }
      if (!c.settledAt) writePointer(stateDir, { ...c, settledAt: now() });
    },
  };
}

/** The sentinel's grace pass: delete settled checkpoints older than the grace period. */
export function pruneSettledCheckpoints(stateDir: string, now: number = Date.now(), graceMs: number = CHECKPOINT_GRACE_MS): string[] {
  const pruned: string[] = [];
  for (const e of scan(stateDir)) {
    if (e.pointer?.settledAt !== undefined && now - e.pointer.settledAt >= graceMs) {
      removeCheckpoint(stateDir, e.topicKey, e.foldId);
      pruned.push(e.foldId);
    }
  }
  return pruned;
}

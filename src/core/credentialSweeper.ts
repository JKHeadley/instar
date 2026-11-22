/**
 * credentialSweeper — SEC-164 part 1 slice 1d: the session-record and log sweeper
 * (docs/specs/credential-scrub-at-rest.md §3.1–§3.3, §4.1–§4.4, §5, §6).
 *
 * Works only inside a fixed list of files the agent or its sessions write. Every 15 seconds it checks
 * files whose size or modification time changed, scans only complete lines past its checked-through
 * mark, and (with `inPlace` on) overwrites each live key in place at the same length. In dry run it
 * only records what it would mask. It never follows a link, never touches a file with more than one
 * hard link, and refuses the never-touch set (§5) by device and inode.
 *
 * Nothing here ever stores, logs or returns a key's value: records hold kinds, counts and a hashed
 * file name.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { findWallCredentialSpans, CREDENTIAL_REMOVED_MARKER, type OwnCredentialMatcher } from '../messaging/outbound-credential-guard.js';
import { maskJsonLine } from './credentialLineMask.js';
import type { CredentialScrubMode } from './outputCredentialScrub.js';
import type { LoadVerdict } from './machineLoadReport.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';

// ── Fixed limits (§3.1, §4.3) ────────────────────────────────────────────────
export const SWEEP_SLICE_BYTES = 1024 * 1024;
export const PLAIN_OVERLAP_BYTES = 16 * 1024;
export const IDLE_FINISHED_MS = 60_000;
export const PEM_MAX_LINES = 200;
const MB = 1024 * 1024;
/** Bytes a first pass may read per minute, by load verdict (§4.3). `Infinity` = no cap. */
export function firstPassBytesPerMinute(verdict: LoadVerdict): number {
  if (verdict === 'ok') return Number.POSITIVE_INFINITY;
  if (verdict === 'saturated' || verdict === 'impaired') return 20 * MB; // paused, with this floor
  return 200 * MB; // elevated or unknown
}
export const RETRY_MIN_MS = 15_000;
export const RETRY_MAX_MS = 30 * 60_000;
export const UNREADABLE_REPORT_MS = 5 * 60_000;
export const BREAKER_THROWS = 5;
export const BREAKER_COOLDOWN_MS = 30 * 60_000;

export type RootClass = 'claude-transcripts' | 'codex-transcripts' | 'logs' | 'local-verify-logs' | 'transcript-copies';
export type UnmeasuredReason = 'unreadable' | 'unscannable' | 'linked' | 'integrity-bound' | 'base64' | 'never-touch';

export interface SweepTarget { path: string; rootClass: RootClass; jsonl: boolean }

/** The hashed name the record and the status use, so no path is ever shown. */
export function hashedName(p: string): string {
  return crypto.createHash('sha256').update(p).digest('hex').slice(0, 16);
}

// ── The fixed list (§4.1) ────────────────────────────────────────────────────

/** `~/.claude`, `~/.claude-*` and `CLAUDE_CONFIG_DIR`, deduplicated. */
export function sweepConfigHomes(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string[] {
  const out = new Set<string>();
  try {
    for (const n of fs.readdirSync(home)) {
      if (n !== '.claude' && !n.startsWith('.claude-')) continue;
      const p = path.join(home, n);
      try { if (fs.lstatSync(p).isDirectory()) out.add(p); } catch { /* @silent-fallback-ok — a vanished home is not a root */ }
    }
  } catch { /* @silent-fallback-ok — an unreadable HOME has no config homes */ }
  if (env.CLAUDE_CONFIG_DIR) out.add(env.CLAUDE_CONFIG_DIR);
  return [...out];
}

/** Claude Code's encoded project folder name for a directory. */
export function encodedProjectName(projectDir: string): string {
  return projectDir.replace(/[/.]/g, '-');
}

function readHead(p: string, bytes = 64 * 1024): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch { return ''; } finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* @silent-fallback-ok — closing a read handle */ } }
}

/** The first `cwd` recorded in a transcript's first lines, or null. */
function recordedCwd(p: string): string | null {
  const m = readHead(p).match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`) as string; } catch { return null; }
}

function isInsideDir(child: string, dir: string): boolean {
  const c = path.resolve(child); const d = path.resolve(dir);
  return c === d || c.startsWith(d + path.sep);
}

/** True when `dir` is a real directory, not a link to one: a listed folder is never entered through a link. */
function realDir(dir: string): boolean {
  try { const st = fs.lstatSync(dir); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } // @silent-fallback-ok — missing is not a root
}

function listFiles(dir: string, accept: (name: string) => boolean): string[] {
  if (!realDir(dir)) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && accept(e.name))
      .map((e) => path.join(dir, e.name));
  } catch { return []; } // @silent-fallback-ok — a missing folder lists nothing
}

function listDirs(dir: string): string[] {
  if (!realDir(dir)) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  } catch { return []; } // @silent-fallback-ok — a missing folder lists nothing
}

export interface ListTargetsInput {
  projectDir: string;
  stateDir: string;
  configHomes: string[];
  codexHome?: string | null;
}

/** Every file on the fixed list (§4.1). Directories are never followed through links. */
export function listSweepTargets(input: ListTargetsInput): SweepTarget[] {
  const out: SweepTarget[] = [];
  const add = (p: string, rootClass: RootClass) => out.push({ path: p, rootClass, jsonl: p.endsWith('.jsonl') });
  const encoded = encodedProjectName(input.projectDir);
  // Claude Code transcripts: only this agent's project folders, confirmed by the recorded cwd.
  for (const homeDir of input.configHomes) {
    const projects = path.join(homeDir, 'projects');
    for (const dir of listDirs(projects)) {
      const name = path.basename(dir);
      if (name !== encoded && !name.startsWith(`${encoded}--worktrees-`)) continue;
      try { if (fs.lstatSync(dir).isSymbolicLink()) continue; } catch { continue; }
      const top = listFiles(dir, (n) => n.endsWith('.jsonl'));
      // Confirmed only when at least one transcript records a cwd, and every recorded cwd is inside the project.
      const cwds = top.map(recordedCwd).filter((c): c is string => c !== null);
      const confirmed = cwds.length > 0 && cwds.every((c) => isInsideDir(c, input.projectDir));
      if (!confirmed) continue;
      for (const f of top) add(f, 'claude-transcripts');
      for (const sub of listDirs(dir)) {
        if (path.basename(sub) === 'memory') continue; // the memory link is never entered
        try { if (fs.lstatSync(sub).isSymbolicLink()) continue; } catch { continue; }
        for (const f of listFiles(path.join(sub, 'subagents'), (n) => n.endsWith('.jsonl'))) add(f, 'claude-transcripts');
        for (const f of listFiles(path.join(sub, 'tool-results'), () => true)) add(f, 'claude-transcripts');
      }
    }
  }
  // Codex transcripts: only session files whose recorded working directory is inside the project.
  if (input.codexHome) {
    const sessions = path.join(input.codexHome, 'sessions');
    for (const y of listDirs(sessions)) for (const m of listDirs(y)) for (const d of listDirs(m)) {
      for (const f of listFiles(d, (n) => n.endsWith('.jsonl'))) {
        const cwd = recordedCwd(f);
        if (cwd !== null && isInsideDir(cwd, input.projectDir)) add(f, 'codex-transcripts');
      }
    }
  }
  // Logs.
  const instarLogs = path.join(input.stateDir, 'logs');
  for (const f of listFiles(instarLogs, (n) => (n.endsWith('.log') || n.endsWith('.err') || n.endsWith('.jsonl')) && n !== 'credential-scrub.jsonl')) add(f, 'logs');
  for (const f of listFiles(path.join(input.projectDir, 'logs'), (n) => n.endsWith('.log') || n.endsWith('.jsonl'))) add(f, 'logs');
  for (const f of listFiles(path.join(input.stateDir, 'hook-events'), (n) => n.endsWith('.jsonl'))) add(f, 'logs');
  for (const f of listFiles(input.stateDir, (n) => n.endsWith('.install.log'))) add(f, 'logs');
  // Local Verify run logs, two levels deep.
  const lv = path.join(input.stateDir, 'state', 'local-verify');
  for (const f of listFiles(lv, (n) => n.endsWith('.log'))) add(f, 'local-verify-logs');
  for (const d of listDirs(lv)) {
    for (const f of listFiles(d, (n) => n.endsWith('.log'))) add(f, 'local-verify-logs');
    for (const d2 of listDirs(d)) for (const f of listFiles(d2, (n) => n.endsWith('.log'))) add(f, 'local-verify-logs');
  }
  // Transcript copies.
  const copies = path.join(input.stateDir, 'state', 'transcript-checkpoints', 'copies');
  for (const o of listDirs(copies)) for (const s of listDirs(o)) {
    const f = path.join(s, 'copy.jsonl');
    try { if (fs.lstatSync(f).isFile()) add(f, 'transcript-copies'); } catch { /* @silent-fallback-ok — no copy yet */ }
  }
  return out;
}

// ── The never-touch set (§5) ─────────────────────────────────────────────────

/** Device and inode of every never-touch file that exists. Checked at run time against each target. */
export function neverTouchIdentities(projectDir: string, stateDir: string): Set<string> {
  const ids = new Set<string>();
  const candidates = [
    path.join(stateDir, 'config.json'),
    path.join(stateDir, 'security.jsonl'),
    path.join(stateDir, 'state', 'mandate-audit.jsonl'),
    path.join(projectDir, '.env'),
    ...listFiles(stateDir, (n) => /secret|vault/i.test(n)),
    ...listFiles(path.join(stateDir, 'secrets'), () => true),
    ...listFiles(projectDir, (n) => n === '.env' || n.startsWith('.env.')),
  ];
  for (const c of candidates) {
    try { const st = fs.statSync(c); ids.add(`${st.dev}:${st.ino}`); } catch { /* @silent-fallback-ok — absent files need no guard */ }
  }
  return ids;
}

// ── One file's state ─────────────────────────────────────────────────────────

export interface FileState {
  dev: number; ino: number; size: number; mtimeMs: number;
  /** Bytes scanned (dry run or on). */
  checkedThrough: number;
  /** Bytes scanned while masking in place. */
  maskedThrough: number;
  mode: CredentialScrubMode;
  revision: string;
  /** Why part of the file could not be measured, if it could not. */
  unmeasured?: UnmeasuredReason;
  /** A hash of the first `headLen` checked bytes, to notice a truncate-and-regrow on the same inode. */
  headSha?: string;
  headLen?: number;
  /** An idle tail (a last line with no newline) already scanned at this size and modification time. */
  tailScannedSize?: number;
  tailScannedMtime?: number;
}

export interface FilePassResult {
  bytesRead: number;
  masked: number;
  kinds: Record<string, number>;
  unmeasured: number;
  unscannable: number;
  wrote: number;
  skipped?: UnmeasuredReason | 'changed-during-write';
}

interface Edit { offset: number; original: Buffer; replacement: Buffer; kind?: string }

/** The same-length replacement for a plain-text span: line endings kept, every other byte overwritten. */
export function plainReplacement(original: Buffer): Buffer {
  const fill = Buffer.from(CREDENTIAL_REMOVED_MARKER + ' '.repeat(Math.max(0, original.length - CREDENTIAL_REMOVED_MARKER.length)), 'latin1');
  const out = Buffer.alloc(original.length);
  const shortSpan = original.length < CREDENTIAL_REMOVED_MARKER.length;
  let k = 0;
  for (let i = 0; i < original.length; i++) {
    const b = original[i]!;
    if (b === 0x0a || b === 0x0d) { out[i] = b; continue; }
    out[i] = shortSpan ? 0x2a : fill[k++] ?? 0x20;
  }
  return out;
}

/** UTF-16 index → byte offset within `text`, in the encoding the text was decoded with. */
function byteOffset(text: string, index: number, enc: 'utf8' | 'latin1'): number {
  return enc === 'latin1' ? index : Buffer.byteLength(text.slice(0, index), 'utf8');
}

/**
 * Find edits in a plain-text slice. Offsets are absolute. A slice that is not valid UTF-8 (a stray
 * Latin-1 or binary byte, or a character cut at the slice edge) is decoded as Latin-1 instead, where
 * one character is one byte, so an offset can never drift. Every edit is checked against the text it
 * came from before it is queued; a mismatch is dropped, never written.
 */
function plainEdits(buf: Buffer, base: number, own: OwnCredentialMatcher | null): { edits: Edit[]; kinds: Record<string, number> } {
  let enc: 'utf8' | 'latin1' = 'utf8';
  let text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) { enc = 'latin1'; text = buf.toString('latin1'); }
  const edits: Edit[] = [];
  const kinds: Record<string, number> = {};
  for (const s of findWallCredentialSpans(text, { ownCredentials: own })) {
    const start = byteOffset(text, s.start, enc);
    const end = byteOffset(text, s.end, enc);
    const original = buf.subarray(start, end);
    if (original.toString(enc) !== text.slice(s.start, s.end)) continue; // never write a span that does not map back exactly
    edits.push({ offset: base + start, original: Buffer.from(original), replacement: plainReplacement(original), kind: s.kind });
    kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
  }
  return { edits, kinds };
}

/** Find edits in complete JSON lines. Offsets are absolute. */
function jsonlEdits(buf: Buffer, base: number, own: OwnCredentialMatcher | null): { edits: Edit[]; kinds: Record<string, number>; unmeasured: number; unscannable: number } {
  const edits: Edit[] = [];
  const kinds: Record<string, number> = {};
  let unmeasured = 0; let unscannable = 0;
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x0a) continue;
    const line = buf.subarray(start, i + 1);
    if (line.length > 1) {
      const r = maskJsonLine(line, { apply: true, ownCredentials: own });
      unmeasured += r.unmeasured;
      if (r.unscannable) {
        // A non-JSON line in a JSONL file (a crash print, say) is scanned as text.
        const p = plainEdits(line, base + start, own);
        if (p.edits.length === 0) unscannable++;
        edits.push(...p.edits);
        for (const [k, v] of Object.entries(p.kinds)) kinds[k] = (kinds[k] ?? 0) + v;
      } else if (r.masked > 0) {
        // Compare byte by byte: each run of changed bytes is one edit.
        let j = 0;
        while (j < line.length) {
          if (line[j] === r.line[j]) { j++; continue; }
          const s0 = j;
          while (j < line.length && line[j] !== r.line[j]) j++;
          edits.push({ offset: base + start + s0, original: Buffer.from(line.subarray(s0, j)), replacement: Buffer.from(r.line.subarray(s0, j)) });
        }
        for (const k of r.kinds) kinds[k] = (kinds[k] ?? 0) + 1;
      }
    }
    start = i + 1;
  }
  return { edits, kinds, unmeasured, unscannable };
}

/** Where the scannable part of [from, size) ends: the last complete line, or the end once idle. */
function scanEnd(buf: Buffer, from: number, idle: boolean): number {
  if (idle) return from + buf.length;
  const lastNl = buf.lastIndexOf(0x0a);
  return lastNl < 0 ? from : from + lastNl + 1;
}

/** For plain text: hold a PEM BEGIN with no END back, up to 200 lines. Returns the safe end. */
function holdOpenPem(buf: Buffer, base: number, end: number): number {
  const text = buf.subarray(0, end - base).toString('latin1');
  const begin = text.lastIndexOf('-----BEGIN ');
  if (begin < 0) return end;
  const after = text.slice(begin);
  if (/-----END [^-]*-----/.test(after)) return end;
  const lines = after.split('\n').length;
  if (lines > PEM_MAX_LINES) return end; // past the bound: reported as unmeasured by the caller
  const lineStart = text.lastIndexOf('\n', begin) + 1;
  return base + lineStart;
}

export interface WriteIntent { path: string; dev: number; ino: number; offset: number; replacement: string /* base64 */; originalSha: string }

export interface PassDeps {
  apply: boolean;
  own: OwnCredentialMatcher | null;
  neverTouch: Set<string>;
  now: () => number;
  /** Byte budget for this file this pass. */
  budget: number;
  /** Record an intent before writing; resolve it after. Never holds the original value. */
  recordIntent: (i: WriteIntent) => void;
  clearIntent: (i: WriteIntent) => void;
}

/**
 * One pass over one file: scan from its checked-through mark to the last complete line (or the end,
 * once the file has been idle for a minute), and in apply mode overwrite each key in place. Never
 * throws for a single file's problem: it reports a reason instead.
 */
export function sweepFile(target: SweepTarget, prev: FileState | null, revision: string, mode: CredentialScrubMode, deps: PassDeps): { state: FileState | null; result: FilePassResult } {
  const result: FilePassResult = { bytesRead: 0, masked: 0, kinds: {}, unmeasured: 0, unscannable: 0, wrote: 0 };
  let lst: fs.Stats;
  try { lst = fs.lstatSync(target.path); } catch { return { state: prev, result: { ...result, skipped: 'unreadable' } }; }
  if (lst.isSymbolicLink() || !lst.isFile()) return { state: prev, result: { ...result, skipped: 'linked' } };
  if (lst.nlink > 1) return { state: prev, result: { ...result, skipped: 'linked' } };
  if (deps.neverTouch.has(`${lst.dev}:${lst.ino}`)) return { state: prev, result: { ...result, skipped: 'never-touch' } };

  // A new inode, a shrink, a rewritten head (truncated and regrown), a new detector revision, or a
  // switch into masking starts over.
  let checked = prev?.checkedThrough ?? 0;
  let maskedThrough = prev?.maskedThrough ?? 0;
  const sameFile = prev && prev.dev === lst.dev && prev.ino === lst.ino && lst.size >= prev.size
    && (!prev.headSha || prev.headSha === headHash(target.path, prev.headLen ?? 0));
  if (!sameFile || prev!.revision !== revision) { checked = 0; maskedThrough = 0; }
  // Switching into masking checks the file again from its masked-through mark (0 if never masked), so
  // a restart between modes cannot skip the backlog the dry run saw (§4.4).
  if (mode === 'on' && prev?.mode !== 'on') checked = maskedThrough;

  const state: FileState = { dev: lst.dev, ino: lst.ino, size: lst.size, mtimeMs: lst.mtimeMs, checkedThrough: checked, maskedThrough, mode, revision };
  if (checked >= lst.size) { stampHead(state, target.path); return { state, result }; }

  const idle = deps.now() - lst.mtimeMs >= IDLE_FINISHED_MS;
  let fd: number | null = null;
  const changed = () => ({ state: prev, result: { ...result, skipped: 'changed-during-write' as const } });
  try {
    // O_NOFOLLOW where available, read-write only when masking.
    const flags = (deps.apply ? fs.constants.O_RDWR : fs.constants.O_RDONLY) | (fs.constants.O_NOFOLLOW ?? 0);
    fd = fs.openSync(target.path, flags);
    const fst = fs.fstatSync(fd);
    if (fst.dev !== lst.dev || fst.ino !== lst.ino || fst.nlink > 1) return changed();
    let pos = checked;
    let markAt = -1; // an idle tail scanned past the last newline keeps its mark at the line start
    while (pos < fst.size && result.bytesRead < deps.budget) {
      const want = Math.min(SWEEP_SLICE_BYTES + (target.jsonl ? 0 : PLAIN_OVERLAP_BYTES), fst.size - pos);
      const buf = Buffer.alloc(want);
      const n = fs.readSync(fd, buf, 0, want, pos);
      if (n <= 0) break;
      const slice = buf.subarray(0, n);
      const atEof = pos + n >= fst.size;
      const lastNl = slice.lastIndexOf(0x0a);
      let end = scanEnd(slice, pos, idle && atEof);
      if (!target.jsonl) end = holdOpenPem(slice, pos, end);
      if (end <= pos) {
        // A line longer than one slice.
        if (target.jsonl) {
          // JSON lines are scanned whole once complete, up to LONG_LINE_MAX; a longer one is unmeasured.
          const nl = findNextNewline(fd, pos + n, Math.min(fst.size, pos + LONG_LINE_MAX));
          if (nl < 0) {
            if (fst.size - pos > LONG_LINE_MAX) { result.unscannable++; state.unmeasured = 'unscannable'; result.bytesRead += Math.min(LONG_LINE_MAX, fst.size - pos); }
            break;
          }
          const whole = Buffer.alloc(nl + 1 - pos);
          fs.readSync(fd, whole, 0, whole.length, pos);
          const r = scanSlice(whole, pos, true, deps.own);
          applyFound(r, result);
          if (deps.apply && !writeEdits(fd, target.path, lst, r.edits, deps)) return changed();
          result.bytesRead += whole.length;
          pos = nl + 1;
          continue;
        }
        if (n === SWEEP_SLICE_BYTES + PLAIN_OVERLAP_BYTES && lastNl < 0) {
          // Plain text: scan the slice, but keep only spans that start before the overlap; the overlap
          // gives a span reaching past the cut its full bytes. The next read starts at the cut (or after
          // the last kept span), so nothing is skipped and nothing is written twice.
          const cut = pos + n - PLAIN_OVERLAP_BYTES;
          const r = scanSlice(slice, pos, false, deps.own);
          const kept = r.edits.filter((e) => e.offset < cut);
          const keptKinds: Record<string, number> = {};
          for (const e of kept) if (e.kind) keptKinds[e.kind] = (keptKinds[e.kind] ?? 0) + 1;
          applyFound({ edits: kept, kinds: keptKinds, unmeasured: 0, unscannable: 0 }, result);
          if (deps.apply && kept.length > 0 && !writeEdits(fd, target.path, lst, kept, deps)) return changed();
          const next = Math.max(cut, ...kept.map((e) => e.offset + e.original.length));
          result.bytesRead += next - pos;
          pos = next;
          continue;
        }
        break;
      }
      const part = slice.subarray(0, end - pos);
      const r = scanSlice(part, pos, target.jsonl, deps.own);
      applyFound(r, result);
      if (deps.apply && r.edits.length > 0 && !writeEdits(fd, target.path, lst, r.edits, deps)) return changed();
      result.bytesRead += part.length;
      if (idle && atEof && end === pos + n && (lastNl < 0 || pos + lastNl + 1 < end)) markAt = lastNl < 0 ? pos : pos + lastNl + 1;
      pos = end;
    }
    state.checkedThrough = markAt >= 0 ? markAt : pos;
    if (markAt >= 0) { state.tailScannedSize = lst.size; state.tailScannedMtime = lst.mtimeMs; }
    if (deps.apply) state.maskedThrough = state.checkedThrough;
    stampHead(state, target.path);
    return { state, result };
  } catch {
    return { state: prev, result: { ...result, skipped: 'unreadable' } };
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* @silent-fallback-ok — closing a handle */ }
  }
}

/**
 * Whether a file needs no pass: its size and modification time are the ones last seen, and either every
 * byte was checked or only an idle tail remains that was already scanned at exactly this size and time.
 */
export function fileUnchanged(prev: FileState | null, size: number, mtimeMs: number): boolean {
  if (!prev || prev.size !== size || prev.mtimeMs !== mtimeMs) return false;
  return prev.checkedThrough >= size || (prev.tailScannedSize === size && prev.tailScannedMtime === mtimeMs);
}

/** Bytes still to check: none when only an already-scanned idle tail remains. */
export function bytesStillPending(state: FileState | null, size: number, mtimeMs: number): number {
  if (!state) return size;
  if (state.tailScannedSize === size && state.tailScannedMtime === mtimeMs) return 0;
  return Math.max(0, size - state.checkedThrough);
}

/** The largest single JSONL line scanned whole; a longer one is reported as unmeasured. */
export const LONG_LINE_MAX = 32 * 1024 * 1024;
const HEAD_BYTES = 256;

function headHash(p: string, len: number): string {
  if (len <= 0) return '';
  let fd: number | null = null;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const b = Buffer.alloc(len);
    const n = fs.readSync(fd, b, 0, len, 0);
    return crypto.createHash('sha256').update(b.subarray(0, n)).digest('hex').slice(0, 16);
  } catch { return ''; } finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* @silent-fallback-ok — closing a handle */ } }
}

/** Remember a hash of the checked head, so a truncate-and-regrow on the same inode is noticed. */
function stampHead(state: FileState, p: string): void {
  const len = Math.min(HEAD_BYTES, state.checkedThrough);
  state.headLen = len;
  state.headSha = headHash(p, len);
}

function findNextNewline(fd: number, from: number, size: number): number {
  const buf = Buffer.alloc(SWEEP_SLICE_BYTES);
  let pos = from;
  while (pos < size) {
    const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
    if (n <= 0) return -1;
    const i = buf.subarray(0, n).indexOf(0x0a);
    if (i >= 0) return pos + i;
    pos += n;
  }
  return -1;
}

function scanSlice(buf: Buffer, base: number, jsonl: boolean, own: OwnCredentialMatcher | null): { edits: Edit[]; kinds: Record<string, number>; unmeasured: number; unscannable: number } {
  if (jsonl) return jsonlEdits(buf, base, own);
  const p = plainEdits(buf, base, own);
  return { ...p, unmeasured: 0, unscannable: 0 };
}

function applyFound(r: { edits: Edit[]; kinds: Record<string, number>; unmeasured: number; unscannable: number }, result: FilePassResult): void {
  result.masked += r.edits.length;
  result.unmeasured += r.unmeasured;
  result.unscannable += r.unscannable;
  for (const [k, v] of Object.entries(r.kinds)) result.kinds[k] = (result.kinds[k] ?? 0) + v;
}

/**
 * Write each edit with a positioned write on the open handle. Before and after each write the inode is
 * unchanged, the file has not shrunk, and the bytes at the offset are the original (before) or the
 * replacement (after). A change in between leaves the file for the next pass. Returns false then.
 */
function writeEdits(fd: number, p: string, lst: fs.Stats, edits: Edit[], deps: PassDeps): boolean {
  for (const e of edits) {
    const before = fs.fstatSync(fd);
    if (before.ino !== lst.ino || before.dev !== lst.dev || before.size < e.offset + e.original.length) return false;
    const cur = Buffer.alloc(e.original.length);
    fs.readSync(fd, cur, 0, cur.length, e.offset);
    if (cur.equals(e.replacement)) continue; // already masked
    if (!cur.equals(e.original)) return false;
    const intent: WriteIntent = { path: p, dev: lst.dev, ino: lst.ino, offset: e.offset, replacement: e.replacement.toString('base64'), originalSha: crypto.createHash('sha256').update(e.original).digest('hex') };
    deps.recordIntent(intent);
    SafeFsExecutor.safeSameLengthWriteSync(fd, p, e.offset, e.replacement, { operation: 'credentialSweeper:mask' });
    const after = fs.fstatSync(fd);
    const check = Buffer.alloc(e.replacement.length);
    fs.readSync(fd, check, 0, check.length, e.offset);
    if (after.ino !== lst.ino || !check.equals(e.replacement)) return false;
    deps.clearIntent(intent);
  }
  return true;
}

/**
 * Re-apply an interrupted write after a restart (§3.3). Only when the file is still the same single-link
 * inode, outside the never-touch set, long enough, and the bytes at the offset still hash to the
 * original (then the replacement is written) or are already the replacement (then it is done). Any
 * other bytes mean the file changed, and it is left alone. A positioned write of a few bytes is not
 * torn by a process crash, so no partial state is guessed at. Returns true when the intent can be
 * cleared.
 */
export function reapplyIntent(i: WriteIntent, neverTouch: Set<string> = new Set()): boolean {
  let fd: number | null = null;
  try {
    const lst = fs.lstatSync(i.path);
    const replacement = Buffer.from(i.replacement, 'base64');
    if (lst.isSymbolicLink() || !lst.isFile() || lst.nlink > 1 || lst.dev !== i.dev || lst.ino !== i.ino) return true;
    if (neverTouch.has(`${lst.dev}:${lst.ino}`) || lst.size < i.offset + replacement.length) return true;
    fd = fs.openSync(i.path, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
    const cur = Buffer.alloc(replacement.length);
    const n = fs.readSync(fd, cur, 0, cur.length, i.offset);
    if (n !== cur.length || cur.equals(replacement)) return true;
    if (crypto.createHash('sha256').update(cur).digest('hex') !== i.originalSha) return true; // the file changed: leave it
    SafeFsExecutor.safeSameLengthWriteSync(fd, i.path, i.offset, replacement, { operation: 'credentialSweeper:reapply' });
    return true;
  } catch { return true; } finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* @silent-fallback-ok — closing a handle */ } }
}

/** The detector revision: changes when the shared patterns change or a configured credential is added. */
export function detectorRevision(patternsSource: string, ownCredentialCount: number): string {
  return crypto.createHash('sha256').update(`${patternsSource}|${ownCredentialCount}`).digest('hex').slice(0, 16);
}

/**
 * Transcript checkpoint replication (docs/specs/native-conversation-any-machine-access.md §3f).
 *
 * Every machine of the agent keeps a copy of every session's transcript, so a machine that is
 * asleep does not take the session behind a conversation away (message 141905). The source machine
 * copies new transcript rows as they are written, cut into CHECKPOINTS of whole redacted rows, and
 * each machine derives from the checkpoints it holds a manifest that states exactly how far its copy
 * reaches. Nothing presents a partial copy as the whole transcript.
 *
 *  - Whole rows only. A transcript file is one record per line and a secret holds no line break, so
 *    the source redacts row by row; the only thing held back between reads is a trailing row that is
 *    not complete yet. No redaction state is carried between reads.
 *  - Offsets and hashes describe the redacted rows. `fromOffset`, `toOffset`, `bytes` and `sha256` are
 *    positions in, and a hash of, the concatenated redacted rows a replica holds and can verify; the
 *    source file position travels separately as `sourceThroughOffset`: the end of the last whole row
 *    emitted, never the position read so far.
 *  - One transaction. A checkpoint and its `sourceThroughOffset` are written together in one atomic
 *    file write on the source (the source's outbox) before anything is emitted; a crash at any point
 *    resumes from that offset, which is a row boundary, with no gap and no repeat. Re-emitting a
 *    pending checkpoint is idempotent: the same seq and bytes produce the same record keys.
 *  - Audience. Each checkpoint carries `conversations` as the source knew them when it was cut. A read
 *    from a copy takes the union over the checkpoints held and resolves the audience at read time on
 *    the reading machine (transcriptAudience.ts), the currency refusal included.
 *  - A store of its own. Checkpoints ride the replicated journal (the same code as app conversations)
 *    under their own store key, and land on each machine in a copy store under `.instar/state/`
 *    (git-ignored, outside backups). No device or team route reads it: the only reads are the
 *    owner-only transcript route and the owner-only status route.
 *
 * Dark: `multiMachine.stateSync.sessionTranscripts.enabled` (default false). Spec dates: CMT-047.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { StoreFieldSchema } from './ReplicatedRecordEnvelope.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export const SESSION_TRANSCRIPTS_STORE_KEY = 'sessionTranscripts';
export const SESSION_TRANSCRIPT_CHECKPOINT_KIND = 'session-transcript-checkpoint';

/** Raw bytes of redacted rows per journal entry; base64 makes it ~53 KiB, under the 80 KiB line cap. */
export const CHECKPOINT_CHUNK_RAW_BYTES = 40 * 1024;
/** The largest window of source bytes read into one checkpoint (and so the largest row copied whole). */
export const CHECKPOINT_MAX_SOURCE_BYTES = 3 * 1024 * 1024;
/** Journal entries one tick may emit: under the journal's per-kind burst of 100. */
export const CHECKPOINT_CHUNKS_PER_TICK = 90;
/** Source bytes copied per machine per day before the copy waits for the next day. */
export const CHECKPOINT_DEFAULT_BYTES_PER_DAY = 256 * 1024 * 1024;
const MAX_CONVERSATIONS = 64;
/** The conversations list's UTF-8 size bound, so a chunk entry always fits the journal line cap. */
const MAX_CONVERSATIONS_BYTES = 8 * 1024;
/** Chunks waiting behind a missing checkpoint, per session, before later ones are no longer kept. */
export const MAX_WAITING_CHUNKS = 600;
const MAX_TOTAL_CHUNKS = Math.ceil((CHECKPOINT_MAX_SOURCE_BYTES * 2) / CHECKPOINT_CHUNK_RAW_BYTES);
const NL = 0x0a;

export interface CheckpointMeta {
  sessionId: string;
  /** The tmux session name the route is asked by. */
  session: string;
  sourceMachineId: string;
  seq: number;
  fromOffset: number;
  toOffset: number;
  sourceThroughOffset: number;
  rowCount: number;
  firstAt: string | null;
  lastAt: string | null;
  sha256: string;
  bytes: number;
  conversations: string[];
  /** The session served more conversations than one checkpoint can name: its audience cannot be read, so it is shown to no one. */
  conversationsOverflow: boolean;
  /** Cut at session end. */
  final: boolean;
  /** Rows larger than one checkpoint, replaced by a marker row that names their size. */
  withheldRows: number;
}

export interface CheckpointChunkData extends CheckpointMeta {
  index: number;
  total: number;
  /** base64 of this chunk's bytes of the redacted rows. */
  chunk: string;
}

const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const sid24 = (sessionId: string) => sha(sessionId).slice(0, 24);

export function checkpointRecordKey(sessionId: string, seq: number, sha256: string, index: number): string {
  return `tc-${sid24(sessionId)}-${seq}-${sha256.slice(0, 16)}-${index}`;
}

// ── Pure pieces ──────────────────────────────────────────────────────────────

/** Split a window of source bytes into whole rows (each with its line break) and the bytes they take. */
export function splitWholeRows(buf: Buffer): { rows: Buffer[]; consumed: number } {
  const rows: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== NL) continue;
    rows.push(buf.subarray(start, i + 1));
    start = i + 1;
  }
  return { rows, consumed: start };
}

/**
 * Remove this machine's own token and PIN from one row. A row with no secret in it is kept byte for
 * byte. A row that holds one is redacted inside its parsed JSON (string values, keys, and a number
 * equal to a secret), so a short numeric PIN inside some other number cannot break the row; a row
 * that does not parse is redacted as text. The result is always one line.
 */
export function redactRow(row: Buffer, secrets: ReadonlyArray<string | null | undefined>): Buffer {
  const vals = [...new Set(secrets.filter((v): v is string => typeof v === 'string' && v.length >= 4))].sort((a, b) => b.length - a.length);
  const text = row.toString('utf8');
  // A row with no secret is kept byte for byte. A row with a JSON escape goes through the parse, so a
  // secret written with \u escapes is found in its decoded form too.
  if (!vals.some((v) => text.includes(v)) && !text.includes('\\u')) return row;
  const scrub = (s: string) => { let o = s; for (const v of vals) o = o.split(v).join('[redacted]'); return o; };
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  let out: string;
  try {
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') return scrub(v);
      if (typeof v === 'number') return vals.includes(String(v)) ? '[redacted]' : v;
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [scrub(k), walk(x)]));
      return v;
    };
    out = JSON.stringify(walk(JSON.parse(body)));
  } catch {
    out = scrub(body).replace(/[\r\n]/g, ' '); // @silent-fallback-ok — a row that is not JSON is redacted as text
  }
  return Buffer.from(`${out}\n`, 'utf8');
}

/** The marker that stands in for a row larger than one checkpoint. */
export function withheldRowMarker(bytes: number): Buffer {
  return Buffer.from(`${JSON.stringify({ type: 'instar-row-withheld', reason: 'row-larger-than-a-checkpoint', bytes })}\n`, 'utf8');
}

function rowTimestamp(row: Buffer): string | null {
  const m = /"timestamp"\s*:\s*"([^"]{10,40})"/.exec(row.subarray(0, Math.min(row.length, 4096)).toString('utf8'))
    ?? /"timestamp"\s*:\s*"([^"]{10,40})"/.exec(row.toString('utf8'));
  return m ? m[1] : null;
}

/** Cut a checkpoint's redacted rows into journal-sized chunks. */
export function checkpointChunks(meta: CheckpointMeta, body: Buffer): Array<{ key: string; data: CheckpointChunkData }> {
  const total = Math.max(1, Math.ceil(body.length / CHECKPOINT_CHUNK_RAW_BYTES));
  return Array.from({ length: total }, (_, index) => ({
    key: checkpointRecordKey(meta.sessionId, meta.seq, meta.sha256, index),
    data: { ...meta, index, total, chunk: body.subarray(index * CHECKPOINT_CHUNK_RAW_BYTES, (index + 1) * CHECKPOINT_CHUNK_RAW_BYTES).toString('base64') },
  }));
}

const isInt = (v: unknown, min = 0) => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const isStr = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isAt = (v: unknown) => v === null || (typeof v === 'string' && v.length <= 64);
const FIELDS = ['sessionId', 'session', 'sourceMachineId', 'seq', 'fromOffset', 'toOffset', 'sourceThroughOffset', 'rowCount', 'firstAt', 'lastAt', 'sha256', 'bytes', 'conversations', 'conversationsOverflow', 'final', 'withheldRows', 'index', 'total', 'chunk'] as const;

/** Re-validates a received chunk; null for anything malformed. */
export function validateCheckpointChunk(raw: Readonly<Record<string, unknown>>): CheckpointChunkData | null {
  if (!isStr(raw.sessionId, 200) || !isStr(raw.session, 200) || !isStr(raw.sourceMachineId, 200)) return null;
  if (!isInt(raw.seq, 1) || !isInt(raw.fromOffset) || !isInt(raw.toOffset) || !isInt(raw.sourceThroughOffset) || !isInt(raw.rowCount) || !isInt(raw.bytes) || !isInt(raw.withheldRows)) return null;
  if ((raw.toOffset as number) - (raw.fromOffset as number) !== raw.bytes) return null;
  if (!isAt(raw.firstAt) || !isAt(raw.lastAt) || typeof raw.final !== 'boolean') return null;
  if (typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256)) return null;
  if (!Array.isArray(raw.conversations) || raw.conversations.length > MAX_CONVERSATIONS || !raw.conversations.every((c) => isStr(c, 256))) return null;
  if (Buffer.byteLength(JSON.stringify(raw.conversations), 'utf8') > MAX_CONVERSATIONS_BYTES || typeof raw.conversationsOverflow !== 'boolean') return null;
  if (!isInt(raw.total, 1) || (raw.total as number) > MAX_TOTAL_CHUNKS || !isInt(raw.index) || (raw.index as number) >= (raw.total as number)) return null;
  if (typeof raw.chunk !== 'string' || raw.chunk.length > 56_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw.chunk)) return null;
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) out[f] = raw[f];
  out.conversations = [...(raw.conversations as string[])];
  return out as unknown as CheckpointChunkData;
}

export const sessionTranscriptCheckpointSchema: StoreFieldSchema = {
  knownFields: FIELDS as unknown as ReadonlyArray<string>,
  validate(raw) { return validateCheckpointChunk(raw) as Record<string, unknown> | null; },
};

export const SESSION_TRANSCRIPTS_KIND_REGISTRATION = {
  kind: SESSION_TRANSCRIPT_CHECKPOINT_KIND,
  store: SESSION_TRANSCRIPTS_STORE_KEY,
  schema: sessionTranscriptCheckpointSchema,
} as const;

/** Keep every conversation, or say plainly that the list did not fit (fail closed on the read). */
export function boundConversations(list: readonly string[]): { conversations: string[]; conversationsOverflow: boolean } {
  const all = [...new Set(list)].sort();
  const fits = all.length <= MAX_CONVERSATIONS && all.every((c) => c.length > 0 && c.length <= 256)
    && Buffer.byteLength(JSON.stringify(all), 'utf8') <= MAX_CONVERSATIONS_BYTES;
  return fits ? { conversations: all, conversationsOverflow: false } : { conversations: [], conversationsOverflow: true };
}

// ── Durable small files ──────────────────────────────────────────────────────

/** Write a file so a reader sees the old content or the new, never part of either. */
function writeAtomic(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, typeof content === 'string' ? Buffer.from(content, 'utf8') : content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    const st = fs.statSync(file);
    if (st.size > 16 * 1024 * 1024) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T; // bounded-read: size checked above
  } catch { return null; } // @silent-fallback-ok — absent or torn state reads as none; the writer is atomic
}

function readRange(file: string, from: number, length: number): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const n = fs.readSync(fd, buf, got, length - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally { fs.closeSync(fd); }
}

/** The offset of the next line break at or after `from`, read in bounded pieces; -1 when none yet. */
function findLineBreak(file: string, from: number, size: number): number {
  const step = 1024 * 1024;
  for (let at = from; at < size; at += step) {
    const piece = readRange(file, at, Math.min(step, size - at));
    const i = piece.indexOf(NL);
    if (i >= 0) return at + i;
  }
  return -1;
}

// ── The source side ──────────────────────────────────────────────────────────

export interface SourceSession {
  sessionId: string;
  session: string;
  filePath: string | null;
  conversations: string[];
}

interface SourceState {
  v: 1;
  sessionId: string;
  session: string;
  seq: number;
  toOffset: number;
  sourceThroughOffset: number;
  finalAt: number | null;
  /** Session end was seen; the final checkpoint follows once every whole row is copied. */
  finalRequested: boolean;
  /** The checkpoint written in the same transaction as its offsets, until it is confirmed emitted. */
  pending: { meta: CheckpointMeta; body: string } | null;
}

export interface CheckpointSourceDeps {
  stateDir: string;
  machineId: string;
  /** This machine's own API token and dashboard PIN: removed from every row before it leaves. */
  secrets: () => ReadonlyArray<string | null | undefined>;
  /** Emit every chunk; resolves true only when all were accepted (and made durable where the journal can say). */
  emit: (chunks: Array<{ key: string; data: CheckpointChunkData }>) => Promise<boolean>;
  bytesPerDay?: number;
  chunksPerTick?: number;
  now?: () => Date;
  onEvidence?: (kind: 'fired' | 'held' | 'error', reason: string, context: Record<string, string | number | boolean | null>) => void;
}

export type SourceOutcome = 'idle' | 'copied' | 'pending' | 'budget' | 'error';

export class TranscriptCheckpointSource {
  private readonly dir: string;
  private chunkBudget = 0;
  private day = { key: '', bytes: 0 };
  private running = false;

  constructor(private readonly deps: CheckpointSourceDeps) {
    this.dir = path.join(deps.stateDir, 'state', 'transcript-checkpoints', 'source');
    const persisted = readJson<{ key: string; bytes: number }>(path.join(this.dir, '..', 'source-day.json'));
    if (persisted && typeof persisted.key === 'string' && isInt(persisted.bytes)) this.day = persisted;
  }

  private stateFile(sessionId: string): string { return path.join(this.dir, `${sid24(sessionId)}.json`); }
  private now(): Date { return this.deps.now?.() ?? new Date(); }

  /** The source's own record of a session: how far it has copied. */
  state(sessionId: string): SourceState | null {
    const s = readJson<SourceState>(this.stateFile(sessionId));
    return s && s.v === 1 && s.sessionId === sessionId ? s : null;
  }

  private save(s: SourceState): void {
    // A session end recorded by another call while this pass held the state is kept, not overwritten.
    if (!s.finalRequested && s.finalAt !== s.sourceThroughOffset && this.state(s.sessionId)?.finalRequested) s.finalRequested = true;
    writeAtomic(this.stateFile(s.sessionId), JSON.stringify(s));
  }

  private fresh(s: SourceSession): SourceState {
    return { v: 1, sessionId: s.sessionId, session: s.session, seq: 0, toOffset: 0, sourceThroughOffset: 0, finalAt: null, finalRequested: false, pending: null };
  }

  /** Remove the outbox records of sessions no longer listed whose final checkpoint went out over two weeks ago. */
  pruneFinished(listed: ReadonlySet<string>, olderThanMs = 14 * 24 * 60 * 60_000): number {
    let names: string[];
    try { names = fs.readdirSync(this.dir); } catch { return 0; } // @silent-fallback-ok — no outbox yet
    let removed = 0;
    const cutoff = this.now().getTime() - olderThanMs;
    for (const n of names.slice(0, 50_000)) {
      if (!n.endsWith('.json')) continue;
      const file = path.join(this.dir, n);
      const st = readJson<SourceState>(file);
      if (!st || st.pending || st.finalAt === null || st.finalAt !== st.sourceThroughOffset || listed.has(st.sessionId)) continue;
      try { if (fs.statSync(file).mtimeMs > cutoff) continue; } catch { continue; } // @silent-fallback-ok — gone already
      SafeFsExecutor.safeUnlinkSync(file, { operation: 'transcriptCheckpoints:prune-finished-outbox' });
      removed++;
    }
    return removed;
  }

  private dayBytesLeft(): number {
    const key = this.now().toISOString().slice(0, 10);
    if (this.day.key !== key) this.day = { key, bytes: 0 };
    return (this.deps.bytesPerDay ?? CHECKPOINT_DEFAULT_BYTES_PER_DAY) - this.day.bytes;
  }

  private spend(bytes: number): void {
    this.day.bytes += bytes;
    writeAtomic(path.join(this.dir, '..', 'source-day.json'), JSON.stringify(this.day));
  }

  /** One pass over the sessions recorded on this machine. Never throws. */
  async tick(sessions: SourceSession[], opts: { final?: ReadonlySet<string> } = {}): Promise<Record<string, SourceOutcome>> {
    const out: Record<string, SourceOutcome> = {};
    // Session end is recorded before anything else, so an end seen while a pass runs is never lost:
    // the next pass cuts the final checkpoint from the saved flag.
    for (const id of opts.final ?? []) {
      const s = sessions.find((x) => x.sessionId === id);
      if (!s) continue;
      const st = this.state(id) ?? this.fresh(s);
      if (!st.finalRequested) { st.finalRequested = true; this.save(st); }
    }
    if (this.running) return out;
    this.running = true;
    this.chunkBudget = this.deps.chunksPerTick ?? CHECKPOINT_CHUNKS_PER_TICK;
    try {
      for (const s of sessions) {
        try {
          out[s.sessionId] = await this.copySession(s, opts.final?.has(s.sessionId) === true);
        } catch (err) {
          // @silent-fallback-ok — not silent: recorded as 'copy-failed' evidence and returned as 'error'; the next tick retries this session.
          out[s.sessionId] = 'error';
          this.deps.onEvidence?.('error', 'copy-failed', { error: err instanceof Error ? err.name : 'unknown' });
        }
        if (this.chunkBudget <= 0) break;
      }
    } finally { this.running = false; }
    return out;
  }

  private async emitPending(st: SourceState): Promise<boolean> {
    if (!st.pending) return true;
    const body = Buffer.from(st.pending.body, 'base64');
    const chunks = checkpointChunks(st.pending.meta, body);
    if (chunks.length > this.chunkBudget) return false;
    this.chunkBudget -= chunks.length;
    const ok = await this.deps.emit(chunks);
    if (!ok) { this.deps.onEvidence?.('held', 'emit-not-confirmed', { seq: st.pending.meta.seq }); return false; }
    this.deps.onEvidence?.('fired', st.pending.meta.final ? 'checkpoint-final' : 'checkpoint', { seq: st.pending.meta.seq, bytes: st.pending.meta.bytes, rows: st.pending.meta.rowCount });
    st.pending = null;
    this.save(st);
    return true;
  }

  /** Cut the next checkpoint, record it with its offsets in one write, then emit it. */
  private async commit(st: SourceState, s: SourceSession, rows: Buffer[], sourceThroughOffset: number, final: boolean, withheld: number): Promise<boolean> {
    const body = Buffer.concat(rows);
    let firstAt: string | null = null;
    let lastAt: string | null = null;
    for (const r of rows) { const t = rowTimestamp(r); if (t) { firstAt ??= t; lastAt = t; } }
    const meta: CheckpointMeta = {
      sessionId: s.sessionId, session: s.session, sourceMachineId: this.deps.machineId, seq: st.seq + 1,
      fromOffset: st.toOffset, toOffset: st.toOffset + body.length, sourceThroughOffset, rowCount: rows.length,
      firstAt, lastAt, sha256: sha(body), bytes: body.length,
      ...boundConversations(s.conversations), final, withheldRows: withheld,
    };
    st.seq = meta.seq;
    st.toOffset = meta.toOffset;
    st.sourceThroughOffset = sourceThroughOffset;
    if (final) { st.finalAt = sourceThroughOffset; st.finalRequested = false; }
    st.pending = { meta, body: body.toString('base64') };
    this.save(st); // the one transaction: the checkpoint and its sourceThroughOffset together
    return this.emitPending(st);
  }

  private async copySession(s: SourceSession, final: boolean): Promise<SourceOutcome> {
    const st: SourceState = this.state(s.sessionId) ?? this.fresh(s);
    if (final && !st.finalRequested) { st.finalRequested = true; this.save(st); }
    if (!(await this.emitPending(st))) return 'pending';
    if (!s.filePath) return 'idle';
    let size: number;
    try { size = fs.statSync(s.filePath).size; } catch { return 'idle'; } // @silent-fallback-ok — no record yet
    if (size < st.sourceThroughOffset) {
      // The file was replaced or cut: nothing is re-sent; the copy keeps what it has and says so.
      this.deps.onEvidence?.('error', 'source-shrank', { size, through: st.sourceThroughOffset });
      return 'error';
    }
    let copied = false;
    let caughtUp = false;
    for (;;) {
      if (size <= st.sourceThroughOffset) { caughtUp = true; break; }
      if (this.chunkBudget <= 0) break;
      if (this.dayBytesLeft() <= 0) { this.deps.onEvidence?.('held', 'daily-budget', {}); return 'budget'; }
      const off = st.sourceThroughOffset;
      const window = readRange(s.filePath, off, Math.min(size - off, CHECKPOINT_MAX_SOURCE_BYTES));
      let { rows, consumed } = splitWholeRows(window);
      let withheld = 0;
      if (rows.length === 0) {
        // A trailing row still being written is held back; it is copied whole by a later read.
        if (window.length < CHECKPOINT_MAX_SOURCE_BYTES) { caughtUp = true; break; }
        const end = findLineBreak(s.filePath, off + window.length, size);
        if (end < 0) { caughtUp = true; break; }
        rows = [withheldRowMarker(end + 1 - off)];
        consumed = end + 1 - off;
        withheld = 1;
      } else {
        const secrets = this.deps.secrets();
        rows = rows.map((r) => redactRow(r, secrets));
      }
      if (!(await this.commit(st, s, rows, off + consumed, false, withheld))) return 'pending';
      this.spend(consumed);
      copied = true;
    }
    // Session end: once every whole row is copied, one final checkpoint says the copy is complete.
    if (st.finalRequested && caughtUp && st.finalAt !== st.sourceThroughOffset) {
      if (!(await this.commit(st, s, [], st.sourceThroughOffset, true, 0))) return 'pending';
      copied = true;
    } else if (st.finalRequested && caughtUp) { st.finalRequested = false; this.save(st); }
    return copied ? 'copied' : 'idle';
  }
}

// ── The copy store (every other machine) ─────────────────────────────────────

export interface CopyManifest {
  v: 1;
  sessionId: string;
  session: string;
  sourceMachineId: string;
  nextSeq: number;
  throughOffset: number;
  sourceThroughOffset: number;
  firstAt: string | null;
  throughAt: string | null;
  rowCount: number;
  withheldRows: number;
  complete: boolean;
  conversations: string[];
  /** Sticky: some checkpoint could not name every conversation; the copy is shown to no one. */
  conversationsOverflow?: boolean;
  updatedAt: string;
  problem?: string;
}

export interface CopyCoverage {
  sourceMachineId: string;
  throughOffset: number;
  throughAt: string | null;
  complete: boolean;
  /** Rows too large to copy, held as a marker naming their size (not shown as entries). */
  withheldRows: number;
  /** false: asked and it did not answer; null: not asked (the session is not recorded here). */
  sourceAwake: boolean | null;
  sentence: string;
  problem?: string;
}

const safeDir = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);

function hhmm(at: string | null): string | null {
  if (!at) return null;
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? null : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The plain sentence a read from a copy carries (§3f item 3). */
export function coverageSentence(m: Pick<CopyManifest, 'throughAt' | 'complete' | 'rowCount' | 'problem'> & { withheldRows?: number }, sourceAwake: boolean | null): string {
  const t = hhmm(m.throughAt);
  const machine = sourceAwake === true ? 'the machine that ran it is awake' : sourceAwake === false ? 'the machine that ran it is asleep' : 'the machine that ran it was not asked';
  const head = m.rowCount === 0 ? 'Nothing has been copied yet' : m.complete ? `Copied in full${t ? `, through ${t}` : ''}` : `Copied through ${t ?? 'an unknown time'}`;
  const tail = m.complete ? '' : '; later rows are not here yet';
  const problem = m.problem ? (m.problem.includes('has not arrived') ? ' A copied piece has not arrived, so the copy stops there.' : ' A copied piece did not check out, so the copy stops there.') : '';
  const withheld = m.withheldRows ? ` ${m.withheldRows === 1 ? 'One row was' : `${m.withheldRows} rows were`} too large to copy and ${m.withheldRows === 1 ? 'is' : 'are'} named by size only.` : '';
  return `${head}; ${machine}${tail}.${problem}${withheld}`;
}

export class TranscriptCopyStore {
  readonly root: string;
  private readonly now: () => Date;
  /** tmux name → the copies that carry it; built on the first lookup, kept current by assembly. */
  private index: Map<string, Array<{ origin: string; sessionId: string }>> | null = null;

  private remember(m: Pick<CopyManifest, 'session' | 'sourceMachineId' | 'sessionId'>): void {
    if (!this.index) return;
    const list = this.index.get(m.session) ?? [];
    if (!list.some((k) => k.origin === m.sourceMachineId && k.sessionId === m.sessionId)) list.push({ origin: m.sourceMachineId, sessionId: m.sessionId });
    this.index.set(m.session, list);
  }

  constructor(stateDir: string, opts: { now?: () => Date } = {}) {
    this.root = path.join(stateDir, 'state', 'transcript-checkpoints', 'copies');
    this.now = opts.now ?? (() => new Date());
  }

  private sessionDir(origin: string, sessionId: string): string { return path.join(this.root, safeDir(origin), sid24(sessionId)); }
  copyFile(m: Pick<CopyManifest, 'sourceMachineId' | 'sessionId'>): string { return path.join(this.sessionDir(m.sourceMachineId, m.sessionId), 'copy.jsonl'); }

  manifest(origin: string, sessionId: string): CopyManifest | null {
    const m = readJson<CopyManifest>(path.join(this.sessionDir(origin, sessionId), 'manifest.json'));
    return m && m.v === 1 && m.sourceMachineId === origin && m.sessionId === sessionId ? m : null;
  }

  /**
   * Land one received chunk. `sender` is the machine the journal entry came from: a checkpoint is
   * accepted only from the machine that ran the session. Returns what happened.
   */
  ingest(sender: string, raw: unknown): 'landed' | 'assembled' | 'old' | 'refused' {
    if (!raw || typeof raw !== 'object') return 'refused';
    const c = validateCheckpointChunk(raw as Record<string, unknown>);
    const origin = (raw as { origin?: unknown }).origin;
    if (!c || c.sourceMachineId !== sender || (origin !== undefined && origin !== sender)) return 'refused';
    const dir = this.sessionDir(sender, c.sessionId);
    const m = this.manifest(sender, c.sessionId);
    if (m && c.seq < m.nextSeq) return 'old';
    const chunkFile = path.join(dir, 'chunks', `${c.seq}-${c.sha256.slice(0, 16)}-${c.index}.json`);
    if (!fs.existsSync(chunkFile)) {
      // Behind a checkpoint that never arrives, later chunks are not kept past a bound: the copy says
      // it stops at the gap, and disk does not grow without limit.
      const waiting = (() => { try { return fs.readdirSync(path.join(dir, 'chunks')).length; } catch { return 0; } })(); // @silent-fallback-ok — none yet
      const nextSeq = m?.nextSeq ?? 1;
      if (waiting >= MAX_WAITING_CHUNKS && c.seq !== nextSeq) {
        const held = m ?? this.emptyManifest(sender, c.sessionId, c.session);
        if (!held.problem) { held.problem = `checkpoint ${nextSeq} has not arrived; later ones are not kept`; held.updatedAt = this.now().toISOString(); writeAtomic(path.join(dir, 'manifest.json'), JSON.stringify(held)); }
        return 'refused';
      }
      writeAtomic(chunkFile, JSON.stringify(c));
    }
    return this.assemble(sender, c.sessionId, c.session) ? 'assembled' : 'landed';
  }

  private emptyManifest(origin: string, sessionId: string, session: string): CopyManifest {
    return {
      v: 1, sessionId, session, sourceMachineId: origin, nextSeq: 1, throughOffset: 0, sourceThroughOffset: 0,
      firstAt: null, throughAt: null, rowCount: 0, withheldRows: 0, complete: false, conversations: [], updatedAt: this.now().toISOString(),
    };
  }

  /**
   * The copy file as the manifest committed it. Bytes past `throughOffset` (an append whose manifest
   * write never happened) are cut first, so a read never serves bytes the manifest does not cover.
   */
  committedCopyFile(m: CopyManifest): string {
    const file = this.copyFile(m);
    try {
      if (fs.statSync(file).size > m.throughOffset) {
        const fd = fs.openSync(file, 'r+');
        try { fs.ftruncateSync(fd, m.throughOffset); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
    } catch { /* @silent-fallback-ok — no copy file yet: the read finds nothing */ }
    return file;
  }

  /** Append every complete, verified checkpoint in seq order. The manifest is the commit point. */
  private assemble(origin: string, sessionId: string, session: string): boolean {
    const dir = this.sessionDir(origin, sessionId);
    const chunksDir = path.join(dir, 'chunks');
    let m: CopyManifest = this.manifest(origin, sessionId) ?? this.emptyManifest(origin, sessionId, session);
    let names: string[];
    try { names = fs.readdirSync(chunksDir); } catch { return false; } // @silent-fallback-ok — nothing landed yet
    const copy = this.copyFile(m);
    let assembled = false;
    for (;;) {
      const prefix = `${m.nextSeq}-`;
      const groups = new Map<string, Map<number, string>>();
      for (const n of names) {
        if (!n.startsWith(prefix) || !n.endsWith('.json')) continue;
        const [, hash, idx] = n.slice(0, -5).split('-');
        if (!groups.has(hash)) groups.set(hash, new Map());
        groups.get(hash)!.set(Number(idx), n);
      }
      let done: { meta: CheckpointChunkData; body: Buffer; files: string[] } | null = null;
      let failed = false;
      for (const files of groups.values()) {
        const first = readJson<CheckpointChunkData>(path.join(chunksDir, files.values().next().value as string));
        const parsed = first && validateCheckpointChunk(first as unknown as Record<string, unknown>);
        if (!parsed || files.size !== parsed.total) continue;
        const parts: Buffer[] = [];
        for (let i = 0; i < parsed.total; i++) {
          const one = readJson<CheckpointChunkData>(path.join(chunksDir, files.get(i) ?? ''));
          if (!one || one.sha256 !== parsed.sha256) { parts.length = 0; break; }
          parts.push(Buffer.from(one.chunk, 'base64'));
        }
        if (parts.length !== parsed.total) continue;
        const body = Buffer.concat(parts);
        if (body.length !== parsed.bytes || sha(body) !== parsed.sha256 || parsed.fromOffset !== m.throughOffset) { failed = true; continue; }
        done = { meta: parsed, body, files: [...files.values()] };
        break;
      }
      if (!done) {
        if (failed && !m.problem) { m.problem = `checkpoint ${m.nextSeq} did not check out`; m.updatedAt = this.now().toISOString(); writeAtomic(path.join(dir, 'manifest.json'), JSON.stringify(m)); }
        return assembled;
      }
      // Bytes past the manifest are a write the manifest never committed: cut them, then append.
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const fd = fs.openSync(copy, fs.existsSync(copy) ? 'r+' : 'w+', 0o600);
      try {
        fs.ftruncateSync(fd, m.throughOffset);
        if (done.body.length) fs.writeSync(fd, done.body, 0, done.body.length, m.throughOffset);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      const meta = done.meta;
      m = {
        ...m, session: meta.session, nextSeq: meta.seq + 1, throughOffset: meta.toOffset, sourceThroughOffset: meta.sourceThroughOffset,
        firstAt: m.firstAt ?? meta.firstAt, throughAt: meta.lastAt ?? m.throughAt, rowCount: m.rowCount + meta.rowCount,
        withheldRows: m.withheldRows + meta.withheldRows, complete: meta.final,
        conversations: [...new Set([...m.conversations, ...meta.conversations])].sort(),
        ...(m.conversationsOverflow || meta.conversationsOverflow ? { conversationsOverflow: true } : {}),
        updatedAt: this.now().toISOString(),
      };
      delete m.problem;
      writeAtomic(path.join(dir, 'manifest.json'), JSON.stringify(m));
      this.remember(m);
      for (const f of names.filter((n) => n.startsWith(prefix))) {
        SafeFsExecutor.safeUnlinkSync(path.join(chunksDir, f), { operation: 'transcriptCheckpoints:assembled-chunk' });
      }
      names = names.filter((n) => !n.startsWith(prefix));
      assembled = true;
    }
  }

  /** Every manifest this machine holds (bounded walk: two directory levels). */
  list(): CopyManifest[] {
    const out: CopyManifest[] = [];
    let origins: string[];
    try { origins = fs.readdirSync(this.root); } catch { return out; } // @silent-fallback-ok — no copies yet
    for (const o of origins.slice(0, 64)) {
      let sessions: string[];
      try { sessions = fs.readdirSync(path.join(this.root, o)); } catch { continue; } // @silent-fallback-ok — a stray file
      for (const s of sessions.slice(0, 20_000)) {
        const m = readJson<CopyManifest>(path.join(this.root, o, s, 'manifest.json'));
        if (m && m.v === 1) out.push(m);
      }
    }
    return out;
  }

  /** The newest copy of a session by its tmux name, from one machine or from any. */
  find(session: string, origin?: string): CopyManifest | null {
    let best: CopyManifest | null = null;
    if (!this.index) { this.index = new Map(); for (const m of this.list()) this.remember(m); }
    const candidates = (this.index.get(session) ?? []).map((k) => this.manifest(k.origin, k.sessionId)).filter((m): m is CopyManifest => !!m);
    for (const m of candidates) {
      if (m.session !== session || (origin && m.sourceMachineId !== origin) || m.rowCount === 0) continue;
      if (!best || String(m.throughAt ?? '') > String(best.throughAt ?? '')) best = m;
    }
    return best;
  }

  coverage(m: CopyManifest, sourceAwake: boolean | null): CopyCoverage {
    return {
      sourceMachineId: m.sourceMachineId, throughOffset: m.throughOffset, throughAt: m.throughAt, complete: m.complete, withheldRows: m.withheldRows,
      sourceAwake, sentence: coverageSentence(m, sourceAwake), ...(m.problem ? { problem: m.problem } : {}),
    };
  }

  /**
   * Catch up from the peer streams already on disk (a batch missed while the server was down). Each
   * line is read as a stream; landing a chunk twice changes nothing.
   */
  async catchUpFromJournal(stateDir: string): Promise<number> {
    const dir = path.join(stateDir, 'state', 'coherence-journal', 'peers');
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return 0; } // @silent-fallback-ok — no peers yet
    const re = new RegExp(`\\.${SESSION_TRANSCRIPT_CHECKPOINT_KIND}(?:\\.\\d+)?\\.jsonl$`);
    let landed = 0;
    for (const n of names) {
      if (!re.test(n) || n.includes('.quarantine.')) continue;
      const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, n), { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line) continue;
        try {
          const e = JSON.parse(line) as { kind?: string; machine?: string; data?: unknown };
          if (e.kind === SESSION_TRANSCRIPT_CHECKPOINT_KIND && typeof e.machine === 'string' && this.ingest(e.machine, e.data) !== 'refused') landed++;
        } catch { /* @silent-fallback-ok — a torn journal line is skipped, as every journal reader does */ }
      }
    }
    return landed;
  }
}

// ── The journal seam (server.ts and the e2e use this one function) ─────────

/**
 * The source's emit: every chunk through the generic replicated-record emitter, then a wait until the
 * journal has made the last one durable. Resolves false when any chunk was not accepted or the fsync
 * could not be confirmed, so the checkpoint stays pending and is re-emitted on the next pass.
 */
export function journalCheckpointEmit(
  emitter: { emit: (store: string, recordKey: string, build: (hlc: import('./HybridLogicalClock.js').HlcTimestamp, origin: string, observed: import('./HybridLogicalClock.js').HlcTimestamp | undefined) => Record<string, unknown> | null, opts?: { observed?: null }) => { outcome: string; seq?: number } },
  journal: { awaitDurableSeq: (kind: never, seq: number, timeoutMs?: number) => Promise<void> },
): CheckpointSourceDeps['emit'] {
  return async (chunks) => {
    let last = 0;
    for (const c of chunks) {
      // No witness: each record key is written once (immutable), so there is nothing to supersede.
      const r = emitter.emit(SESSION_TRANSCRIPTS_STORE_KEY, c.key, (hlc, origin) => ({ ...c.data, recordKey: c.key, hlc, op: 'put', origin }), { observed: null });
      if (r.outcome !== 'emitted') return false;
      if (typeof r.seq === 'number') last = Math.max(last, r.seq);
    }
    if (last > 0) {
      try { await journal.awaitDurableSeq(SESSION_TRANSCRIPT_CHECKPOINT_KIND as never, last, 10_000); } catch { return false; } // @silent-fallback-ok — kept pending, re-emitted next pass
    }
    return true;
  };
}

// ── Production wiring (server.ts calls this; the e2e runs the same function) ──

/** A session record as the state store holds it, reduced to what the copy pass reads. */
export interface WiredSessionRecord {
  id: string;
  status: string;
  endedAt?: string;
  claudeSessionId?: string;
  tmuxSession: string;
}

export interface TranscriptCopiesWiringDeps {
  stateDir: string;
  machineId: string;
  secrets: () => ReadonlyArray<string | null | undefined>;
  bytesPerDay?: number;
  emit: CheckpointSourceDeps['emit'];
  onEvidence?: CheckpointSourceDeps['onEvidence'];
  /** Every session recorded on this machine. */
  listSessions: () => WiredSessionRecord[];
  /** The transcript file and the conversations of one session, found as the 3d verb finds them. */
  describe: (rec: WiredSessionRecord) => { filePath: string | null; conversations: string[] };
  now?: () => Date;
}

/** The source, the copy store and the four seams server.ts hands on: tick, final, ingest, catch-up. */
export function wireTranscriptCopies(deps: TranscriptCopiesWiringDeps) {
  const now = deps.now ?? (() => new Date());
  const store = new TranscriptCopyStore(deps.stateDir, { now });
  const source = new TranscriptCheckpointSource({
    stateDir: deps.stateDir, machineId: deps.machineId, secrets: deps.secrets, bytesPerDay: deps.bytesPerDay,
    emit: deps.emit, onEvidence: deps.onEvidence, now,
  });
  let lastPrune = 0;
  const sessions = (only?: string): SourceSession[] => {
    const cutoff = now().getTime() - 48 * 60 * 60_000;
    return deps.listSessions()
      .filter((x) => (only ? x.id === only : x.status === 'running' || (x.endedAt ? Date.parse(x.endedAt) >= cutoff : false)))
      .slice(0, 200)
      .map((x) => ({ sessionId: x.claudeSessionId ?? x.id, session: x.tmuxSession, ...deps.describe(x) }));
  };
  return {
    store,
    source,
    copies: {
      store,
      status: () => ({
        machineId: deps.machineId,
        sessions: sessions().map((x) => { const st = source.state(x.sessionId); return { session: x.session, seq: st?.seq ?? 0, copiedThroughOffset: st?.sourceThroughOffset ?? 0, pending: !!st?.pending }; }),
      }),
    },
    /** One pass on the token-ledger poller's cadence; prunes finished outbox records once an hour. */
    tick: async (): Promise<void> => {
      const listed = sessions();
      await source.tick(listed);
      if (now().getTime() - lastPrune > 60 * 60_000) { lastPrune = now().getTime(); source.pruneFinished(new Set(listed.map((x) => x.sessionId))); }
    },
    /** Session end: recorded at once, the final checkpoint cut now or by the next pass. */
    final: (done: WiredSessionRecord): Promise<unknown> => source.tick(sessions(done.id), { final: new Set([done.claudeSessionId ?? done.id]) }),
    ingest: (sender: string, entries: ReadonlyArray<{ data: unknown }>): void => { for (const e of entries) store.ingest(sender, e.data); },
    catchUp: (): Promise<number> => store.catchUpFromJournal(deps.stateDir),
  };
}

// ── Agent awareness (Config and migration parity) ────────────────────────────

export const TRANSCRIPT_COPIES_AWARENESS_MARKER = '### Transcript copies on every machine';

export function transcriptCopiesAwareness(port: number): string {
  return `${TRANSCRIPT_COPIES_AWARENESS_MARKER}

When \`multiMachine.stateSync.sessionTranscripts\` is on (it ships off), every machine keeps a copy of every session's transcript, so the session behind a conversation stays readable while the machine that ran it sleeps. \`GET /sessions/NAME/transcript?machineId=ID\` answers from this machine's copy when that machine does not answer: \`via: "copy"\` with \`copy: { throughAt, complete, sentence }\`. I report the sentence as it is ("Copied through 14:02; the machine that ran it is asleep; later rows are not here yet.") and never call a partial copy the whole transcript.
- What each copy reaches, per session: \`curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/transcript-copies\` (coverage only, no text). A row larger than 3 MB is copied as a marker naming its size; the answer counts them in \`copy.withheldRows\` and the sentence says so.
- The same audience rule as the live read: owner only, and only where the owner may see every conversation the session served. No phone, member or guest reads a copy.
`;
}

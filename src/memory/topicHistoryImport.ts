/**
 * topicHistoryImport — restore recovered conversation history into TopicMemory
 * (docs/specs/topic-history-import.md).
 *
 * A machine that lost part of its message log can take the rows its peers
 * still hold and put them back WITHOUT touching the live log:
 *
 *   - every row is checked against the store's own schema and keyed by the
 *     §14 key rule (`deriveRowKey`), exactly as the live writer keys it;
 *   - accepted rows are published as one immutable batch file under
 *     `<stateDir>/topic-history-imports/` (tmp → fsync → rename → dir fsync),
 *     so a crash mid-write never leaves a half batch that replay would read;
 *   - each affected topic is re-sequenced in ONE SQLite transaction so its row
 *     ids ascend in message-time order (the id-ordered readers —
 *     `lastMessageIdByRow`, `messagePrecedes`, `countMessagesAfter` — then
 *     answer by time, not by when the import ran);
 *   - boot, `rebuild()` and the corruption rebuild re-apply every published
 *     batch through the same merge, so the restore survives a rebuild.
 *
 * The live log (`telegram-messages.jsonl`) is never written here, so no reader
 * that tails it as "what just happened" ever sees a recovered row as new.
 *
 * Authority only narrows: a recovered row is stored `forwarded = true` when its
 * source said so and `forwarded = unknown` otherwise, never `false`, so no
 * standing-authorization or approval reader counts it as a fresh operator
 * instruction.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { deriveRowKey } from './topicRowWriter.js';
import type { TopicMemory, TopicMessage } from './TopicMemory.js';

/** The directory, under the state dir, that holds published import batches. */
export const IMPORT_BATCH_DIRNAME = 'topic-history-imports';
/** The audit log, under the state dir. */
export const IMPORT_AUDIT_RELPATH = path.join('logs', 'topic-history-imports.jsonl');

/**
 * Bounds (spec "Bounds"; basis: external-constraint — published batches are read
 * whole, on every import and at boot; the real recovery file is 13,946 rows /
 * ~12 MiB, so these sit ~7x above it). `IMPORT_MAX_ROWS` bounds ONE request AND
 * the cumulative rows across every published batch, so repeated imports cannot
 * grow the boot-time read without bound.
 */
export const IMPORT_MAX_FILE_BYTES = 128 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 100_000;
/** The cumulative serialized bytes (text and every stored field) across every published batch (~10x headroom). */
export const IMPORT_MAX_TOTAL_BATCH_BYTES = 128 * 1024 * 1024;
/** A row stamped further than this into the future is refused (clock-skew allowance). */
export const IMPORT_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Why a row was refused. `app-message`: an app message (id `app:<eventId>`)
 * belongs to the app conversation store, which is where the live app path keeps
 * it (topicRowWriter: a platform-keyed app event is `not-this-channel` for
 * TopicMemory); keying it into a Telegram topic would put a ~1.7e15 message id
 * among ~1e5 Telegram ids and stall the message-id summary cursor.
 */
export type ImportRejectReason = 'malformed' | 'unroutable' | 'bad-id' | 'bad-field' | 'app-message';

/** One recovered row, keyed and normalized — the form a batch file stores. */
export interface ImportedRow {
  topicId: number;
  messageId: number;
  channelMessageId: string;
  /** The id exactly as the source carried it. */
  sourceId: string;
  text: string;
  fromUser: boolean;
  timestamp: string;
  sessionName: string | null;
  senderName?: string;
  senderUsername?: string;
  telegramUserId?: number;
  /** Only ever `true` (authority narrows: anything else is stored as unknown). */
  forwarded?: true;
  /** Free-text provenance from the recovery source, kept for the audit. */
  recoveredFrom?: string;
  importId: string;
}

export type ValidateResult =
  | { ok: true; row: Omit<ImportedRow, 'importId'> }
  | { ok: false; reason: ImportRejectReason; detail: string };

function optionalString(entry: Record<string, unknown>, key: string): string | undefined | false {
  const v = entry[key];
  if (v === undefined || v === null) return undefined;
  return typeof v === 'string' ? v : false;
}

/**
 * Admit one recovered row against the store's own schema, or refuse it with a
 * counted reason. Pure: never guesses a key, never coerces a wrong type.
 */
export function validateImportRow(raw: unknown, nowMs: number = Date.now()): ValidateResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'malformed', detail: 'not an object' };
  const e = raw as Record<string, unknown>;

  if (typeof e.messageId === 'string' && e.messageId.startsWith('app:')) {
    return { ok: false, reason: 'app-message', detail: 'app messages live in the app conversation store, not in Telegram topic history' };
  }

  const topicId = e.topicId;
  if (topicId === null || topicId === undefined) return { ok: false, reason: 'unroutable', detail: 'no topicId' };
  if (typeof topicId !== 'number' || !Number.isSafeInteger(topicId) || topicId <= 0) {
    return { ok: false, reason: 'unroutable', detail: `topicId is not a Telegram topic (${typeof topicId})` };
  }

  if (typeof e.text !== 'string' || e.text.length === 0) return { ok: false, reason: 'bad-field', detail: 'text missing or empty' };
  if (typeof e.fromUser !== 'boolean') return { ok: false, reason: 'bad-field', detail: 'fromUser is not a boolean' };
  if (typeof e.timestamp !== 'string') return { ok: false, reason: 'bad-field', detail: 'timestamp missing' };
  const at = Date.parse(e.timestamp);
  if (!Number.isFinite(at)) return { ok: false, reason: 'bad-field', detail: 'timestamp unreadable' };
  if (at > nowMs + IMPORT_FUTURE_SKEW_MS) return { ok: false, reason: 'bad-field', detail: 'timestamp is in the future' };

  if (e.conversationKey !== undefined && e.conversationKey !== null && e.conversationKey !== `telegram:${topicId}`) {
    return { ok: false, reason: 'bad-field', detail: 'conversationKey does not name this Telegram topic' };
  }

  const sessionName = e.sessionName === undefined ? null : e.sessionName;
  if (sessionName !== null && typeof sessionName !== 'string') return { ok: false, reason: 'bad-field', detail: 'sessionName is not a string' };
  const senderName = optionalString(e, 'senderName');
  const senderUsername = optionalString(e, 'senderUsername');
  const recoveredFrom = optionalString(e, 'recoveredFrom');
  if (senderName === false || senderUsername === false || recoveredFrom === false) {
    return { ok: false, reason: 'bad-field', detail: 'a sender or provenance field is not a string' };
  }
  let telegramUserId: number | undefined;
  if (e.telegramUserId !== undefined && e.telegramUserId !== null) {
    if (typeof e.telegramUserId !== 'number' || !Number.isSafeInteger(e.telegramUserId)) {
      return { ok: false, reason: 'bad-field', detail: 'telegramUserId is not an integer' };
    }
    telegramUserId = e.telegramUserId;
  }
  if (e.forwarded !== undefined && e.forwarded !== null && typeof e.forwarded !== 'boolean') {
    return { ok: false, reason: 'bad-field', detail: 'forwarded is not a boolean' };
  }

  // The key: the Telegram native id under the §14 key rule, exactly as the live writer keys it.
  if (typeof e.messageId !== 'number') {
    return { ok: false, reason: 'bad-id', detail: `messageId is not a Telegram message id (${typeof e.messageId})` };
  }
  const key = deriveRowKey({ channel: 'telegram', nativeId: e.messageId });
  if ('error' in key) return { ok: false, reason: 'bad-id', detail: key.error };

  return {
    ok: true,
    row: {
      topicId,
      messageId: key.messageId,
      channelMessageId: key.channelMessageId,
      sourceId: String(e.messageId),
      text: e.text,
      fromUser: e.fromUser,
      // Canonical ISO-8601 UTC: readers order by the timestamp TEXT.
      timestamp: new Date(at).toISOString(),
      sessionName: sessionName as string | null,
      ...(senderName ? { senderName } : {}),
      ...(senderUsername ? { senderUsername } : {}),
      ...(telegramUserId !== undefined ? { telegramUserId } : {}),
      // Authority narrows: only an explicit `true` survives; anything else is stored as unknown.
      ...(e.forwarded === true ? { forwarded: true as const } : {}),
      ...(recoveredFrom ? { recoveredFrom: recoveredFrom.slice(0, 300) } : {}),
    },
  };
}

/** The TopicMessage a batch row becomes in the store. */
export function importedRowToMessage(r: ImportedRow): TopicMessage & { channelMessageId: string } {
  return {
    messageId: r.messageId,
    topicId: r.topicId,
    text: r.text,
    fromUser: r.fromUser,
    timestamp: r.timestamp,
    sessionName: r.sessionName,
    ...(r.senderName ? { senderName: r.senderName } : {}),
    ...(r.senderUsername ? { senderUsername: r.senderUsername } : {}),
    ...(r.telegramUserId !== undefined ? { telegramUserId: r.telegramUserId } : {}),
    // undefined → stored NULL (unknown provenance, no authority).
    ...(r.forwarded === true ? { forwarded: true } : {}),
    channelMessageId: r.channelMessageId,
    // Labelled as restored: no reader treats it as this machine's own live row,
    // and the user corpus gives it no operator authority.
    origin: 'imported',
  };
}

/** The total order imported rows take among themselves: time, then key. */
export function compareImported(a: { timestamp: string; messageId: number }, b: { timestamp: string; messageId: number }): number {
  const ta = Date.parse(a.timestamp);
  const tb = Date.parse(b.timestamp);
  if (ta !== tb) return ta - tb;
  return a.messageId - b.messageId;
}

/**
 * Merge imported rows into a topic's live sequence. Live rows keep their exact
 * relative order; each imported row (taken in `compareImported` order) is placed
 * before the first live row whose time is strictly later. The result depends
 * only on the live sequence and the SET of imported rows, so importing in two
 * batches and replaying them all at once give the same order.
 */
export function mergeSequence<L extends { timestamp: string }, I extends { timestamp: string; messageId: number }>(
  live: L[],
  imported: I[],
): Array<{ kind: 'live'; row: L } | { kind: 'imported'; row: I }> {
  const sorted = [...imported].sort(compareImported);
  const out: Array<{ kind: 'live'; row: L } | { kind: 'imported'; row: I }> = [];
  let j = 0;
  for (const l of live) {
    const lt = Date.parse(l.timestamp);
    while (j < sorted.length && Date.parse(sorted[j].timestamp) < lt) out.push({ kind: 'imported', row: sorted[j++] });
    out.push({ kind: 'live', row: l });
  }
  while (j < sorted.length) out.push({ kind: 'imported', row: sorted[j++] });
  return out;
}

// ── Batch files ─────────────────────────────────────────────────────

/** A published batch name: `<importId>.r<rows>.jsonl`. */
const BATCH_NAME_RE = /^imp-[0-9-]+-[0-9a-f]{8}\.r(\d+)\.jsonl$/;

export function batchDir(stateDir: string): string {
  return path.join(stateDir, IMPORT_BATCH_DIRNAME);
}

export function newImportId(nowMs: number = Date.now()): string {
  const stamp = new Date(nowMs).toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', '');
  return `imp-${stamp}-${crypto.randomBytes(4).toString('hex')}`;
}

/** Publish one batch as an immutable file: write tmp, fsync, rename, fsync the directory. */
export function publishBatch(stateDir: string, importId: string, rows: ImportedRow[]): string {
  const dir = batchDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  // The row count rides in the published name, so replay can tell a batch that
  // lost lines (even at a line boundary, even all of them) from a whole one.
  const final = path.join(dir, `${importId}.r${rows.length}.jsonl`);
  const tmp = path.join(dir, `.${importId}.jsonl.tmp`);
  const buf = Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    // writeSync may write fewer bytes than asked: loop until the whole batch is on disk.
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, final);
  // Windows cannot open a directory for fsync; everywhere else a failure is a real I/O error and propagates.
  if (process.platform !== 'win32') {
    const dfd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  }
  return final;
}

function isImportedRow(v: unknown): v is ImportedRow {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.topicId === 'number' && typeof r.messageId === 'number' && Number.isSafeInteger(r.messageId)
    && typeof r.channelMessageId === 'string' && typeof r.text === 'string' && typeof r.timestamp === 'string'
    && typeof r.fromUser === 'boolean' && typeof r.importId === 'string';
}

/**
 * Every published batch row, grouped by topic and deduped by key (first
 * published wins). Temporary files (a write that never published) are skipped.
 */
export async function readPublishedBatches(stateDir: string): Promise<{ byTopic: Map<number, Map<number, ImportedRow>>; files: number; unreadable: number }> {
  const byTopic = new Map<number, Map<number, ImportedRow>>();
  const dir = batchDir(stateDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl') && !n.startsWith('.')).sort();
  } catch (err) {
    // Only a missing directory means "nothing was ever imported". Any other error
    // (permissions, I/O) propagates: an unreadable archive must never read as empty.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { byTopic, files: 0, unreadable: 0 };
    throw err;
  }
  let unreadable = 0;
  for (const name of names) {
    const declared = BATCH_NAME_RE.exec(name);
    // Only a published name is read: any other .jsonl file here supplies no history.
    if (!declared) { unreadable++; continue; }
    const fileKeys = new Set<string>();
    const fileRows: ImportedRow[] = [];
    let damaged = 0;
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, name), { encoding: 'utf-8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let v: unknown;
      try { v = JSON.parse(line); } catch {
        // @silent-fallback-ok — counted in `unreadable` and reported by the caller
        damaged++; continue;
      }
      if (!isImportedRow(v)) { damaged++; continue; }
      fileKeys.add(`${v.topicId}:${v.messageId}`);
      fileRows.push(v);
    }
    // A batch is whole only when it holds exactly its declared number of DISTINCT
    // rows (a publish never writes a key twice). A damaged batch is counted and
    // still contributes the rows it does hold, so a re-apply restores what it
    // can; a rebuild refuses on any damage before deleting anything.
    const declaredRows = Number(declared[1]);
    if (fileKeys.size !== declaredRows) damaged += Math.max(1, Math.abs(declaredRows - fileKeys.size));
    unreadable += damaged;
    for (const v of fileRows) {
      let t = byTopic.get(v.topicId);
      if (!t) { t = new Map(); byTopic.set(v.topicId, t); }
      if (!t.has(v.messageId)) t.set(v.messageId, v);
    }
  }
  return { byTopic, files: names.length, unreadable };
}

/** Let the event loop run between topics: one topic's merge is one synchronous transaction. */
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Append one line to the import audit log (no message text ever goes here). */
export function appendImportAudit(stateDir: string, record: Record<string, unknown>): void {
  const p = path.join(stateDir, IMPORT_AUDIT_RELPATH);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // fsynced like the batch it describes, so the record survives a power loss too.
  const fd = fs.openSync(p, 'a', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(record) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// ── Re-apply (boot, rebuild, corruption rebuild) ────────────────────

/**
 * Re-apply every published batch: a topic whose imported rows are all present
 * is left untouched (a read-only presence check — the normal boot); a topic
 * missing any is re-sequenced through `mergeTopicHistory`. Returns rows restored.
 */
export async function reapplyImportedHistory(tm: TopicMemory, stateDir: string): Promise<{ restored: number; topics: number; unreadable: number; failedTopics: number[] }> {
  const { byTopic, unreadable } = await readPublishedBatches(stateDir);
  let restored = 0;
  let topics = 0;
  const failedTopics: number[] = [];
  for (const [topicId, rows] of byTopic) {
    await yieldToLoop();
    try {
      const keys = [...rows.keys()];
      const present = tm.presentMessageKeys(topicId, keys);
      if (present.size === keys.length) continue;
      const r = tm.mergeTopicHistory(topicId, [...rows.values()].map(importedRowToMessage));
      restored += r.inserted;
      topics++;
    } catch (err) {
      // @silent-fallback-ok — counted, logged and returned; this topic's transaction rolled back whole, the other topics still restore, and the next boot retries it
      failedTopics.push(topicId);
      console.warn(`[TopicMemory] topic history import re-apply failed for topic ${topicId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (unreadable > 0) {
    console.warn(`[TopicMemory] topic history import re-apply: ${unreadable} unreadable batch line(s) skipped`);
  }
  return { restored, topics, unreadable, failedTopics };
}

// ── The import itself (the route's engine) ─────────────────────────

export interface ImportRequest {
  /** Rows already parsed (inline mode). */
  rows?: unknown[];
  /** An absolute path already resolved inside the state dir (file mode). */
  filePath?: string;
  source?: string;
  dryRun?: boolean;
}

export interface ImportReport {
  importId: string | null;
  dryRun: boolean;
  received: number;
  accepted: number;
  duplicate: number;
  rejected: Partial<Record<ImportRejectReason, number>>;
  perTopic: Record<string, { accepted: number; duplicate: number }>;
  merged?: { topics: number; inserted: number; slowestTopicMs: number; slowestTopicId: number | null };
  rejectedSamples: Array<{ reason: ImportRejectReason; detail: string }>;
}

export class ImportTooLargeError extends Error {
  constructor(detail: string) { super(detail); this.name = 'ImportTooLargeError'; }
}

async function readFileRows(filePath: string): Promise<{ rows: unknown[]; malformed: number }> {
  const st = fs.statSync(filePath);
  if (st.size > IMPORT_MAX_FILE_BYTES) throw new ImportTooLargeError(`file is ${st.size} bytes; the limit is ${IMPORT_MAX_FILE_BYTES}`);
  const rows: unknown[] = [];
  let malformed = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf-8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (rows.length + malformed >= IMPORT_MAX_ROWS) { rl.close(); throw new ImportTooLargeError(`more than ${IMPORT_MAX_ROWS} rows`); }
    try { rows.push(JSON.parse(line)); } catch {
      // @silent-fallback-ok — counted as a `malformed` rejection in the report
      malformed++;
    }
  }
  return { rows, malformed };
}

/** Merge each named topic from the published rows, yielding between topics. */
async function mergeTopics(tm: TopicMemory, published: { byTopic: Map<number, Map<number, ImportedRow>> }, topicIds: Set<number>): Promise<{ topics: number; inserted: number; slowestTopicMs: number; slowestTopicId: number | null }> {
  let inserted = 0;
  let topics = 0;
  // One topic's merge holds the event loop for its whole transaction; the slowest is reported.
  let slowestTopicMs = 0;
  let slowestTopicId: number | null = null;
  for (const topicId of topicIds) {
    const topicRows = published.byTopic.get(topicId);
    if (!topicRows) continue;
    await yieldToLoop();
    const startedAt = Date.now();
    const r = tm.mergeTopicHistory(topicId, [...topicRows.values()].map(importedRowToMessage));
    const tookMs = Date.now() - startedAt;
    if (slowestTopicId === null || tookMs > slowestTopicMs) { slowestTopicMs = tookMs; slowestTopicId = topicId; }
    inserted += r.inserted;
    topics++;
  }
  return { topics, inserted, slowestTopicMs, slowestTopicId };
}

/**
 * One import or rebuild at a time per process: an import's admission, publish
 * and merge are one critical section, and `TopicMemory.rebuild()` takes the same
 * lock so a merge can never land between its delete and its live replay.
 */
let historyChain: Promise<unknown> = Promise.resolve();

export function withTopicHistoryLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = historyChain.then(fn);
  historyChain = run.catch(() => undefined);
  return run;
}

export function runTopicHistoryImport(tm: TopicMemory, stateDir: string, req: ImportRequest, nowMs: () => number = Date.now): Promise<ImportReport> {
  return withTopicHistoryLock(() => doImport(tm, stateDir, req, nowMs));
}

async function doImport(tm: TopicMemory, stateDir: string, req: ImportRequest, nowMs: () => number): Promise<ImportReport> {
  const dryRun = req.dryRun === true;
  const source = typeof req.source === 'string' && req.source.trim() ? req.source.trim().slice(0, 120) : 'api';
  let raw: unknown[] = [];
  let malformed = 0;
  if (req.filePath) {
    const r = await readFileRows(req.filePath);
    raw = r.rows;
    malformed = r.malformed;
  } else if (Array.isArray(req.rows)) {
    if (req.rows.length > IMPORT_MAX_ROWS) throw new ImportTooLargeError(`more than ${IMPORT_MAX_ROWS} rows`);
    raw = req.rows;
  }

  const report: ImportReport = {
    importId: null, dryRun, received: raw.length + malformed, accepted: 0, duplicate: 0,
    rejected: {}, perTopic: {}, rejectedSamples: [],
  };
  const reject = (reason: ImportRejectReason, detail: string) => {
    report.rejected[reason] = (report.rejected[reason] ?? 0) + 1;
    if (report.rejectedSamples.length < 20) report.rejectedSamples.push({ reason, detail });
  };
  for (let i = 0; i < malformed; i++) reject('malformed', 'line is not JSON');

  // Validate, then dedupe within the batch by (topic, key).
  const now = nowMs();
  const candidates = new Map<number, Map<number, Omit<ImportedRow, 'importId'>>>();
  const bump = (topicId: number, field: 'accepted' | 'duplicate') => {
    const k = String(topicId);
    report.perTopic[k] ??= { accepted: 0, duplicate: 0 };
    report.perTopic[k][field]++;
    report[field]++;
  };
  for (const entry of raw) {
    const v = validateImportRow(entry, now);
    if (!v.ok) { reject(v.reason, v.detail); continue; }
    let t = candidates.get(v.row.topicId);
    if (!t) { t = new Map(); candidates.set(v.row.topicId, t); }
    if (t.has(v.row.messageId)) { bump(v.row.topicId, 'duplicate'); continue; }
    t.set(v.row.messageId, v.row);
  }

  // Dedupe against the store (key and channel id) and against already-published
  // batches (a batch published before a crash is re-applied, never re-accepted).
  const published = await readPublishedBatches(stateDir);
  const accepted = new Map<number, Array<Omit<ImportedRow, 'importId'>>>();
  // Topics holding a published row the store lacks (a merge that failed after its
  // batch was published): an identical retry re-merges them instead of answering "nothing to do".
  const heal = new Set<number>();
  for (const [topicId, rows] of candidates) {
    const list = [...rows.values()];
    const presentKeys = tm.presentMessageKeys(topicId, list.map((r) => r.messageId));
    const presentChannel = tm.presentChannelIds(topicId, list.map((r) => r.channelMessageId));
    const prior = published.byTopic.get(topicId);
    for (const r of list) {
      const inStore = presentKeys.has(r.messageId) || presentChannel.has(r.channelMessageId);
      if (inStore || prior?.has(r.messageId)) {
        if (!inStore) heal.add(topicId);
        bump(topicId, 'duplicate');
        continue;
      }
      bump(topicId, 'accepted');
      let a = accepted.get(topicId);
      if (!a) { a = []; accepted.set(topicId, a); }
      a.push(r);
    }
  }

  // Cumulative bounds over every published batch (checked on a dry run too, so it predicts a refusal).
  let publishedRows = 0;
  let publishedBytes = 0;
  for (const t of published.byTopic.values()) {
    publishedRows += t.size;
    for (const r of t.values()) publishedBytes += Buffer.byteLength(JSON.stringify(r), 'utf-8') + 1;
  }
  let acceptedBytes = 0;
  // Measured as the batch line will be written (the importId adds a fixed ~40 bytes).
  for (const list of accepted.values()) for (const r of list) acceptedBytes += Buffer.byteLength(JSON.stringify(r), 'utf-8') + 60;
  if (report.accepted > 0 && publishedRows + report.accepted > IMPORT_MAX_ROWS) {
    throw new ImportTooLargeError(`published imports would hold ${publishedRows + report.accepted} rows; the limit is ${IMPORT_MAX_ROWS}`);
  }
  if (report.accepted > 0 && publishedBytes + acceptedBytes > IMPORT_MAX_TOTAL_BATCH_BYTES) {
    throw new ImportTooLargeError(`published imports would hold ${publishedBytes + acceptedBytes} bytes; the limit is ${IMPORT_MAX_TOTAL_BATCH_BYTES}`);
  }

  if (dryRun) return report;

  if (report.accepted === 0) {
    if (heal.size > 0) report.merged = await mergeTopics(tm, published, heal);
    return report;
  }

  const importId = newImportId(now);
  report.importId = importId;
  const rows: ImportedRow[] = [];
  for (const list of accepted.values()) for (const r of list) rows.push({ ...r, importId });

  const perTopicAccepted = Object.fromEntries(Object.entries(report.perTopic).map(([k, v]) => [k, v.accepted]));
  // 1. The audit says what was accepted BEFORE anything is written.
  appendImportAudit(stateDir, {
    phase: 'accepted', importId, at: new Date(now).toISOString(), source,
    file: req.filePath ? path.basename(req.filePath) : null,
    received: report.received, accepted: report.accepted, duplicate: report.duplicate,
    rejected: report.rejected, perTopic: perTopicAccepted,
  });
  // 2. The batch is published atomically; from here a crash is healed by the next boot's re-apply.
  publishBatch(stateDir, importId, rows);
  // 3. Each affected topic is re-sequenced, every published row of that topic included.
  const all = await readPublishedBatches(stateDir);
  report.merged = await mergeTopics(tm, all, new Set([...accepted.keys(), ...heal]));
  // 4. The merge result.
  appendImportAudit(stateDir, { phase: 'merged', importId, at: new Date(nowMs()).toISOString(), ...report.merged });
  return report;
}

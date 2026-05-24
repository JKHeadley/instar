/**
 * TokenLedger — read-only token-usage observability.
 *
 * Reads Claude Code's per-session JSONL transcript files at
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, extracts
 * `assistant` lines that include `message.usage`, and rolls them up
 * into a SQLite database. Strictly read-only against the source
 * files (we only track byte offsets). The DB is dedupe-keyed on
 * `requestId`, so re-scanning is idempotent.
 *
 * No behavioral changes: the ledger never gates jobs, throttles
 * sessions, or otherwise reaches back into the runtime. It only
 * observes. Routes expose summaries to the dashboard.
 */
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { NativeModuleHealer } from '../memory/NativeModuleHealer.js';
import { parseCodexRollout, type ParsedCodexSession } from './CodexRolloutParser.js';

/**
 * Compute a small content fingerprint for a JSONL file. Used to detect
 * file rotation/replacement even when the OS reuses the same inode number
 * after unlink+recreate (Linux kernel behavior on tmpfs/ext4).
 */
function computeHeadHash(filePath: string, size: number): string {
  const len = Math.min(size, 256);
  if (len <= 0) return 'empty';
  const buf = Buffer.alloc(len);
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, len, 0);
    return crypto.createHash('sha256').update(buf.slice(0, len)).digest('hex').slice(0, 16);
  } catch {
    return 'unreadable';
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// ── Schema ────────────────────────────────────────────────────────────

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS token_events (
     request_id            TEXT PRIMARY KEY,
     uuid                  TEXT,
     session_id            TEXT NOT NULL,
     project_path          TEXT,
     ts                    INTEGER NOT NULL,
     model                 TEXT,
     input_tokens          INTEGER NOT NULL DEFAULT 0,
     output_tokens         INTEGER NOT NULL DEFAULT 0,
     cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
     cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
     service_tier          TEXT,
     attribution_key       TEXT NOT NULL DEFAULT 'unknown::pre-attribution'
   )`,
  `CREATE INDEX IF NOT EXISTS idx_token_events_session ON token_events(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_token_events_ts ON token_events(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_token_events_project ON token_events(project_path)`,
  // Attribution-key index (Phase 1 of burn-detection-and-self-heal spec): the
  // BurnDetector polls per-key rates every 60s; this index keeps that polling
  // cheap on agents with millions of historical events.
  `CREATE INDEX IF NOT EXISTS idx_token_events_key_ts ON token_events(attribution_key, ts)`,
  `CREATE TABLE IF NOT EXISTS file_offsets (
     file_path TEXT PRIMARY KEY,
     offset    INTEGER NOT NULL DEFAULT 0,
     inode     INTEGER,
     size      INTEGER,
     head_hash TEXT,
     last_read INTEGER NOT NULL
   )`,
  // Migration for installs that pre-date head_hash (idempotent).
  `ALTER TABLE file_offsets ADD COLUMN head_hash TEXT`,
  // Migration for installs that pre-date attribution_key (idempotent — duplicate-column
  // errors are swallowed in init below).
  `ALTER TABLE token_events ADD COLUMN attribution_key TEXT NOT NULL DEFAULT 'unknown::pre-attribution'`,
  // Codex (OpenAI) sessions live in a SEPARATE table — deliberately NOT
  // token_events. Codex's persisted rollouts report a CUMULATIVE per-session
  // total (one growing number), not Claude's per-request events, so they don't
  // fit the request-keyed token_events model. Keeping them separate also means
  // the BurnDetector (which reads token_events via summary()/byAttributionKey())
  // is provably unaffected by Codex ingest — this table is read-only
  // observability surfaced only through the /tokens Codex routes. Whether burn
  // detection should consume Codex usage is a separate, behavioural decision.
  `CREATE TABLE IF NOT EXISTS codex_token_sessions (
     session_id              TEXT PRIMARY KEY,
     project_path            TEXT,
     model                   TEXT,
     plan_type               TEXT,
     input_tokens            INTEGER NOT NULL DEFAULT 0,
     cached_input_tokens     INTEGER NOT NULL DEFAULT 0,
     output_tokens           INTEGER NOT NULL DEFAULT 0,
     reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
     total_tokens            INTEGER NOT NULL DEFAULT 0,
     primary_used_percent    REAL,
     secondary_used_percent  REAL,
     token_count_events      INTEGER NOT NULL DEFAULT 0,
     first_ts                INTEGER NOT NULL DEFAULT 0,
     last_ts                 INTEGER NOT NULL DEFAULT 0,
     updated_at              INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_codex_sessions_last_ts ON codex_token_sessions(last_ts)`,
  `CREATE INDEX IF NOT EXISTS idx_codex_sessions_project ON codex_token_sessions(project_path)`,
];

// ── Types ─────────────────────────────────────────────────────────────

export interface IngestLineResult {
  inserted: boolean;
  reason?: string;
}

export interface IngestFileResult {
  inserted: number;
  skipped: number;
}

export interface ScanAllResult {
  filesScanned: number;
  inserted: number;
}

export interface SummaryRow {
  totalTokens: number;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheCreate: number;
  eventCount: number;
  sessionsActive: number;
  oldestEventTs: number | null;
  newestEventTs: number | null;
}

export interface TopSessionRow {
  sessionId: string;
  projectPath: string | null;
  totalTokens: number;
  eventCount: number;
  firstTs: number;
  lastTs: number;
}

export interface ProjectRow {
  projectPath: string | null;
  totalTokens: number;
  eventCount: number;
  sessionCount: number;
}

export interface AttributionKeyRow {
  attributionKey: string;
  totalTokens: number;
  eventCount: number;
  firstTs: number;
  lastTs: number;
}

export interface OrphanRow {
  sessionId: string;
  projectPath: string | null;
  lastTs: number;
  totalTokens: number;
  idleMs: number;
}

export interface CodexSessionRow {
  sessionId: string;
  projectPath: string | null;
  model: string | null;
  planType: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  primaryUsedPercent: number | null;
  secondaryUsedPercent: number | null;
  tokenCountEvents: number;
  firstTs: number;
  lastTs: number;
}

export interface CodexSummaryRow {
  totalTokens: number;
  totalInput: number;
  totalCachedInput: number;
  totalOutput: number;
  totalReasoning: number;
  sessionCount: number;
  oldestTs: number | null;
  newestTs: number | null;
  /** Highest short-window subscription usage % across sessions (latest reading). */
  maxPrimaryUsedPercent: number | null;
  /** Highest long-window subscription usage % across sessions (latest reading). */
  maxSecondaryUsedPercent: number | null;
}

export interface CodexIngestResult {
  ingested: boolean;
  sessionId?: string;
  reason?: string;
}

export interface TokenLedgerOptions {
  /** SQLite DB path. Use `:memory:` for tests. */
  dbPath: string;
  /** Root directory of Claude Code project transcripts (e.g. `~/.claude/projects`). */
  claudeProjectsDir: string;
  /**
   * Skip JSONL files whose mtime is older than this many ms when scanning.
   * Bounds the work the ledger does on agents with deep history (Echo had
   * 119k files / 12GB which blocked the event loop). Pass 0 / undefined to
   * scan everything. Default: scan everything (caller decides).
   */
  maxFileAgeMs?: number;
  /**
   * Per-tick scan cap. After this many files have been processed in a single
   * scanAll call, the scan returns and resumes on the next poll. Prevents a
   * single tick from monopolising the event loop. Default 500.
   */
  maxFilesPerScan?: number;
  /**
   * Yield to the event loop every N files within a scan. Default 25.
   * Even with maxFilesPerScan, a 500-file batch on slow disks can block for
   * seconds without yielding.
   */
  yieldEveryNFiles?: number;
}

interface AssistantLine {
  type?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  uuid?: string;
  requestId?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      service_tier?: string;
    };
  };
}

// ── TokenLedger ───────────────────────────────────────────────────────

export class TokenLedger {
  private db: BetterSqliteDatabase;
  private claudeProjectsDir: string;
  private maxFileAgeMs: number;
  private maxFilesPerScan: number;
  private yieldEveryNFiles: number;
  // Cursor between scan calls — when a tick stops at the per-scan cap,
  // the next tick resumes from here instead of restarting the whole tree.
  private scanCursor: { dirIdx: number; fileIdx: number } = { dirIdx: 0, fileIdx: 0 };
  private stmts!: {
    insertEvent: ReturnType<BetterSqliteDatabase['prepare']>;
    getOffset: ReturnType<BetterSqliteDatabase['prepare']>;
    upsertOffset: ReturnType<BetterSqliteDatabase['prepare']>;
    upsertCodexSession: ReturnType<BetterSqliteDatabase['prepare']>;
  };

  constructor(opts: TokenLedgerOptions) {
    this.claudeProjectsDir = opts.claudeProjectsDir;
    this.maxFileAgeMs = opts.maxFileAgeMs && opts.maxFileAgeMs > 0 ? opts.maxFileAgeMs : 0;
    this.maxFilesPerScan = opts.maxFilesPerScan && opts.maxFilesPerScan > 0 ? opts.maxFilesPerScan : 500;
    this.yieldEveryNFiles = opts.yieldEveryNFiles && opts.yieldEveryNFiles > 0 ? opts.yieldEveryNFiles : 25;
    if (opts.dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    }
    // Open the SQLite handle through the native-module healer. On the
    // first NODE_MODULE_VERSION error from better-sqlite3 (Node was
    // upgraded after instar installed), the healer runs
    // `npm rebuild better-sqlite3` synchronously and retries the open
    // once. Without this, an ABI mismatch would surface here as
    // "token ledger unavailable" forever, and the /tokens/* endpoints
    // would silently return errors on every agent until the user
    // manually rebuilt. Heal events are persisted to
    // <stateDir>/native-module-heals.jsonl for observability.
    this.db = NativeModuleHealer.openWithHealSync(
      'TokenLedger',
      () => new Database(opts.dbPath),
    );
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    for (const ddl of SCHEMA) {
      try {
        this.db.exec(ddl);
      } catch (err) {
        // ALTER TABLE … ADD COLUMN is idempotent at the column level but
        // SQLite throws if the column already exists. Swallow that one
        // case; rethrow anything else.
        const msg = (err as Error).message || '';
        if (!/duplicate column name/i.test(msg)) throw err;
      }
    }
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.stmts = {
      insertEvent: this.db.prepare(`
        INSERT OR IGNORE INTO token_events
          (request_id, uuid, session_id, project_path, ts, model,
           input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
           service_tier, attribution_key)
        VALUES
          (@requestId, @uuid, @sessionId, @projectPath, @ts, @model,
           @inputTokens, @outputTokens, @cacheCreationTokens, @cacheReadTokens,
           @serviceTier, @attributionKey)
      `),
      getOffset: this.db.prepare(
        `SELECT offset, inode, size, head_hash FROM file_offsets WHERE file_path = ?`
      ),
      upsertOffset: this.db.prepare(`
        INSERT INTO file_offsets (file_path, offset, inode, size, head_hash, last_read)
        VALUES (@filePath, @offset, @inode, @size, @headHash, @lastRead)
        ON CONFLICT(file_path) DO UPDATE SET
          offset = excluded.offset,
          inode = excluded.inode,
          size = excluded.size,
          head_hash = excluded.head_hash,
          last_read = excluded.last_read
      `),
      // Codex sessions report a CUMULATIVE total per session, so re-ingesting a
      // grown rollout must REPLACE the prior totals (latest wins), not sum.
      // first_ts is preserved (earliest known); everything else takes the
      // newest reading. This makes re-scans idempotent without a byte cursor.
      upsertCodexSession: this.db.prepare(`
        INSERT INTO codex_token_sessions
          (session_id, project_path, model, plan_type,
           input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
           primary_used_percent, secondary_used_percent, token_count_events,
           first_ts, last_ts, updated_at)
        VALUES
          (@sessionId, @projectPath, @model, @planType,
           @inputTokens, @cachedInputTokens, @outputTokens, @reasoningOutputTokens, @totalTokens,
           @primaryUsedPercent, @secondaryUsedPercent, @tokenCountEvents,
           @firstTs, @lastTs, @updatedAt)
        ON CONFLICT(session_id) DO UPDATE SET
          project_path = excluded.project_path,
          model = excluded.model,
          plan_type = excluded.plan_type,
          input_tokens = excluded.input_tokens,
          cached_input_tokens = excluded.cached_input_tokens,
          output_tokens = excluded.output_tokens,
          reasoning_output_tokens = excluded.reasoning_output_tokens,
          total_tokens = excluded.total_tokens,
          primary_used_percent = excluded.primary_used_percent,
          secondary_used_percent = excluded.secondary_used_percent,
          token_count_events = excluded.token_count_events,
          first_ts = MIN(codex_token_sessions.first_ts, excluded.first_ts),
          last_ts = excluded.last_ts,
          updated_at = excluded.updated_at
      `),
    };
  }

  /**
   * Parse a single JSONL line and INSERT OR IGNORE into token_events.
   * Returns inserted=true only when a new row was added.
   */
  ingestLine(line: string): IngestLineResult {
    if (!line || !line.trim()) return { inserted: false, reason: 'empty' };
    let obj: AssistantLine;
    try {
      obj = JSON.parse(line) as AssistantLine;
    } catch {
      return { inserted: false, reason: 'malformed' };
    }
    if (obj.type !== 'assistant') return { inserted: false, reason: 'not-assistant' };
    const usage = obj.message?.usage;
    if (!usage) return { inserted: false, reason: 'no-usage' };
    if (!obj.requestId) return { inserted: false, reason: 'no-request-id' };
    if (!obj.sessionId) return { inserted: false, reason: 'no-session-id' };
    if (!obj.timestamp) return { inserted: false, reason: 'no-timestamp' };

    const ts = Date.parse(obj.timestamp);
    if (Number.isNaN(ts)) return { inserted: false, reason: 'bad-timestamp' };

    try {
      const result = this.stmts.insertEvent.run({
        requestId: obj.requestId,
        uuid: obj.uuid ?? null,
        sessionId: obj.sessionId,
        projectPath: obj.cwd ?? null,
        ts,
        model: obj.message?.model ?? null,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        serviceTier: usage.service_tier ?? null,
        // JSONL-source events do not carry attribution; Phase 2 will run an
        // AttributionResolver on the read side that maps these to a known
        // component when possible. Until then they sit under the default key.
        attributionKey: 'unknown::pre-attribution',
      });
      return { inserted: result.changes > 0, reason: result.changes > 0 ? undefined : 'duplicate' };
    } catch {
      return { inserted: false, reason: 'insert-error' };
    }
  }

  /**
   * Record a token event from a direct-API provider (Phase 1 of the
   * burn-detection-and-self-heal spec). The Claude CLI path already writes
   * JSONL that the ledger ingests; direct-API providers (e.g. the
   * AnthropicIntelligenceProvider) have no JSONL trail and must call this
   * method explicitly when an LLM call completes.
   *
   * Attribution-key shape (per spec): `<componentName>::<promptFingerprint>`.
   * The caller is the chokepoint that knows both pieces. Events with an
   * empty/missing attribution_key fall back to 'unknown::direct-api'.
   *
   * Idempotent on request_id (INSERT OR IGNORE).
   */
  recordEvent(event: {
    requestId: string;
    sessionId: string;
    projectPath?: string | null;
    ts: number;
    model?: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    serviceTier?: string | null;
    attributionKey?: string;
  }): IngestLineResult {
    if (!event.requestId) return { inserted: false, reason: 'no-request-id' };
    if (!event.sessionId) return { inserted: false, reason: 'no-session-id' };
    try {
      const result = this.stmts.insertEvent.run({
        requestId: event.requestId,
        uuid: null,
        sessionId: event.sessionId,
        projectPath: event.projectPath ?? null,
        ts: event.ts,
        model: event.model ?? null,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheCreationTokens: event.cacheCreationTokens ?? 0,
        cacheReadTokens: event.cacheReadTokens ?? 0,
        serviceTier: event.serviceTier ?? null,
        attributionKey: event.attributionKey && event.attributionKey.length > 0
          ? event.attributionKey
          : 'unknown::direct-api',
      });
      return { inserted: result.changes > 0, reason: result.changes > 0 ? undefined : 'duplicate' };
    } catch {
      return { inserted: false, reason: 'insert-error' };
    }
  }

  /**
   * Read a JSONL file from its persisted offset and ingest each new line.
   * If the inode changed (rotation/replacement), starts from offset 0.
   */
  ingestFile(filePath: string): IngestFileResult {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return { inserted: 0, skipped: 0 };
    }
    if (!stat.isFile()) return { inserted: 0, skipped: 0 };

    const prev = this.stmts.getOffset.get(filePath) as
      | { offset: number; inode: number | null; size: number | null; head_hash: string | null }
      | undefined;

    // Compute a small content fingerprint (first 256 bytes) to detect rotation
    // even when the OS reuses the same inode number on unlink+recreate (Linux).
    const headHash = computeHeadHash(filePath, stat.size);

    let startOffset = 0;
    const sameFile = prev
      && prev.inode === stat.ino
      && prev.offset <= stat.size
      && (prev.head_hash == null || prev.head_hash === headHash);
    if (sameFile) {
      startOffset = prev!.offset;
    }

    if (startOffset >= stat.size) {
      // Nothing new to read; still update the offset record (size/last_read).
      this.stmts.upsertOffset.run({
        filePath,
        offset: startOffset,
        inode: stat.ino,
        size: stat.size,
        headHash,
        lastRead: Date.now(),
      });
      return { inserted: 0, skipped: 0 };
    }

    let inserted = 0;
    let skipped = 0;
    let buffer = '';
    let bytesRead = 0;
    const fd = fs.openSync(filePath, 'r');
    try {
      const chunkSize = 64 * 1024;
      const buf = Buffer.alloc(chunkSize);
      let pos = startOffset;
      // Use a transaction for batch insert speed
      const txn = this.db.transaction(() => {
        // no-op: filled by closure below
      });
      // We can't easily push individual ingestLine calls into a single
      // prepared transaction without restructuring; instead wrap the
      // whole loop in BEGIN/COMMIT manually for performance.
      this.db.exec('BEGIN');
      try {
        while (pos < stat.size) {
          const n = fs.readSync(fd, buf, 0, Math.min(chunkSize, stat.size - pos), pos);
          if (n <= 0) break;
          bytesRead += n;
          pos += n;
          buffer += buf.slice(0, n).toString('utf8');
          let nl = buffer.indexOf('\n');
          while (nl !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            const r = this.ingestLine(line);
            if (r.inserted) inserted++;
            else skipped++;
            nl = buffer.indexOf('\n');
          }
        }
        // Trailing partial line (no newline yet) — leave for next pass
        // by NOT advancing offset past it. We compute the new offset as
        // startOffset + bytesRead - buffer.length so the unread tail is
        // re-read next time.
        const newOffset = startOffset + bytesRead - Buffer.byteLength(buffer, 'utf8');
        this.db.exec('COMMIT');
        this.stmts.upsertOffset.run({
          filePath,
          offset: newOffset,
          inode: stat.ino,
          size: stat.size,
          headHash,
          lastRead: Date.now(),
        });
      } catch (err) {
        try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }
      void txn;
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }

    return { inserted, skipped };
  }

  /**
   * Walk every `*.jsonl` under `claudeProjectsDir/<encoded-dir>/` and
   * incrementally ingest each one.
   *
   * Sync version retained for callers (and tests) that don't care about
   * event-loop yielding. Honors per-scan and age caps but does NOT yield.
   * Production callers should use {@link scanAllAsync} to keep the server
   * responsive on agents with large JSONL histories.
   */
  scanAll(): ScanAllResult {
    return this.scanInternal({ yieldFn: null });
  }

  /**
   * Async variant that yields to the event loop every N files. Use this
   * from the poller so a multi-thousand-file backfill cannot monopolise
   * the event loop and stall HTTP / health-check traffic.
   */
  async scanAllAsync(): Promise<ScanAllResult> {
    return this.scanInternal({
      yieldFn: () => new Promise<void>(resolve => setImmediate(resolve)),
    });
  }

  /**
   * Scan Codex (OpenAI) rollout files under `$CODEX_HOME/sessions` and upsert
   * the sessions belonging to this agent into codex_token_sessions. Read-only.
   *
   * Codex's session store is per-machine and GLOBAL (every Codex agent on the
   * box writes there), so we attribute by cwd: only rollouts whose working
   * directory is `projectDir` (or a subdirectory) are counted as ours. Without
   * a projectDir filter, all rollouts are ingested (project_path preserved for
   * downstream filtering). Cumulative-total semantics make this idempotent.
   */
  async scanCodexRolloutsAsync(opts: {
    projectDir?: string;
    codexHome?: string;
    limit?: number;
    maxFileAgeMs?: number;
  } = {}): Promise<{ filesScanned: number; ingested: number }> {
    let listAllRollouts: (codexHome?: string, limit?: number) => Promise<ReadonlyArray<{ path: string; mtime: number }>>;
    try {
      ({ listAllRollouts } = await import('../providers/adapters/openai-codex/observability/sessionPaths.js'));
    } catch {
      return { filesScanned: 0, ingested: 0 };
    }
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 500;
    const ageCutoff = opts.maxFileAgeMs && opts.maxFileAgeMs > 0 ? Date.now() - opts.maxFileAgeMs : 0;
    const targetDir = opts.projectDir ? path.resolve(opts.projectDir) : null;
    let rollouts: ReadonlyArray<{ path: string; mtime: number }>;
    try {
      rollouts = await listAllRollouts(opts.codexHome, limit);
    } catch {
      return { filesScanned: 0, ingested: 0 };
    }
    let filesScanned = 0;
    let ingested = 0;
    for (const { path: rolloutPath, mtime } of rollouts) {
      if (ageCutoff && mtime < ageCutoff) continue;
      filesScanned += 1;
      let content: string;
      try {
        content = fs.readFileSync(rolloutPath, 'utf-8');
      } catch {
        continue;
      }
      const parsed = parseCodexRollout(content);
      if (!parsed) continue;
      if (targetDir) {
        const cwd = parsed.cwd ? path.resolve(parsed.cwd) : null;
        if (!cwd || (cwd !== targetDir && !cwd.startsWith(targetDir + path.sep))) continue;
      }
      // mtime is the last-write time → use as last activity (token_count events
      // carry no per-event timestamp).
      if (this.ingestCodexSession(parsed, mtime).ingested) ingested += 1;
    }
    return { filesScanned, ingested };
  }

  private scanInternal(opts: { yieldFn: (() => Promise<void>) | null }): ScanAllResult;
  private scanInternal(opts: { yieldFn: () => Promise<void> }): Promise<ScanAllResult>;
  private scanInternal(opts: { yieldFn: (() => Promise<void>) | null }): ScanAllResult | Promise<ScanAllResult> {
    let projectDirs: string[];
    try {
      projectDirs = fs.readdirSync(this.claudeProjectsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => path.join(this.claudeProjectsDir, e.name))
        .sort();
    } catch {
      this.scanCursor = { dirIdx: 0, fileIdx: 0 };
      return opts.yieldFn ? Promise.resolve({ filesScanned: 0, inserted: 0 }) : { filesScanned: 0, inserted: 0 };
    }

    if (this.scanCursor.dirIdx >= projectDirs.length) {
      // The dir tree shrank or we previously finished a full pass; reset.
      this.scanCursor = { dirIdx: 0, fileIdx: 0 };
    }

    const ageCutoff = this.maxFileAgeMs > 0 ? Date.now() - this.maxFileAgeMs : 0;

    if (opts.yieldFn) {
      return this.scanLoopAsync(projectDirs, ageCutoff, opts.yieldFn);
    }
    return this.scanLoopSync(projectDirs, ageCutoff);
  }

  private scanLoopSync(projectDirs: string[], ageCutoff: number): ScanAllResult {
    let filesScanned = 0;
    let inserted = 0;
    while (this.scanCursor.dirIdx < projectDirs.length && filesScanned < this.maxFilesPerScan) {
      const dir = projectDirs[this.scanCursor.dirIdx];
      const files = this.listJsonlFiles(dir);
      while (this.scanCursor.fileIdx < files.length && filesScanned < this.maxFilesPerScan) {
        const fp = files[this.scanCursor.fileIdx];
        this.scanCursor.fileIdx++;
        if (!this.shouldScanFile(fp, ageCutoff)) continue;
        const r = this.ingestFile(fp);
        filesScanned++;
        inserted += r.inserted;
      }
      if (this.scanCursor.fileIdx >= files.length) {
        this.scanCursor.dirIdx++;
        this.scanCursor.fileIdx = 0;
      }
    }
    if (this.scanCursor.dirIdx >= projectDirs.length) {
      // Reached end of tree — restart on next call so new files get picked up.
      this.scanCursor = { dirIdx: 0, fileIdx: 0 };
    }
    return { filesScanned, inserted };
  }

  private async scanLoopAsync(
    projectDirs: string[],
    ageCutoff: number,
    yieldFn: () => Promise<void>,
  ): Promise<ScanAllResult> {
    let filesScanned = 0;
    let inserted = 0;
    while (this.scanCursor.dirIdx < projectDirs.length && filesScanned < this.maxFilesPerScan) {
      const dir = projectDirs[this.scanCursor.dirIdx];
      const files = this.listJsonlFiles(dir);
      while (this.scanCursor.fileIdx < files.length && filesScanned < this.maxFilesPerScan) {
        const fp = files[this.scanCursor.fileIdx];
        this.scanCursor.fileIdx++;
        if (!this.shouldScanFile(fp, ageCutoff)) continue;
        const r = this.ingestFile(fp);
        filesScanned++;
        inserted += r.inserted;
        if (filesScanned % this.yieldEveryNFiles === 0) {
          await yieldFn();
        }
      }
      if (this.scanCursor.fileIdx >= files.length) {
        this.scanCursor.dirIdx++;
        this.scanCursor.fileIdx = 0;
        await yieldFn();
      }
    }
    if (this.scanCursor.dirIdx >= projectDirs.length) {
      this.scanCursor = { dirIdx: 0, fileIdx: 0 };
    }
    return { filesScanned, inserted };
  }

  private listJsonlFiles(dir: string): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
      .map(e => path.join(dir, e.name))
      .sort();
  }

  private shouldScanFile(fp: string, ageCutoff: number): boolean {
    if (ageCutoff <= 0) return true;
    try {
      const st = fs.statSync(fp);
      return st.mtimeMs >= ageCutoff;
    } catch {
      return false;
    }
  }

  /** Aggregate totals (optionally restricted to events ≥ sinceMs). */
  summary({ sinceMs }: { sinceMs?: number } = {}): SummaryRow {
    const since = sinceMs ?? 0;
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens), 0) AS totalTokens,
           COALESCE(SUM(input_tokens), 0) AS totalInput,
           COALESCE(SUM(output_tokens), 0) AS totalOutput,
           COALESCE(SUM(cache_read_tokens), 0) AS totalCacheRead,
           COALESCE(SUM(cache_creation_tokens), 0) AS totalCacheCreate,
           COUNT(*) AS eventCount,
           COUNT(DISTINCT session_id) AS sessionsActive,
           MIN(ts) AS oldestEventTs,
           MAX(ts) AS newestEventTs
         FROM token_events
         WHERE ts >= ?`
      )
      .get(since) as SummaryRow;
    return {
      totalTokens: Number(row.totalTokens) || 0,
      totalInput: Number(row.totalInput) || 0,
      totalOutput: Number(row.totalOutput) || 0,
      totalCacheRead: Number(row.totalCacheRead) || 0,
      totalCacheCreate: Number(row.totalCacheCreate) || 0,
      eventCount: Number(row.eventCount) || 0,
      sessionsActive: Number(row.sessionsActive) || 0,
      oldestEventTs: row.oldestEventTs ?? null,
      newestEventTs: row.newestEventTs ?? null,
    };
  }

  /** Top sessions by total tokens, descending. */
  topSessions({ limit = 20, sinceMs }: { limit?: number; sinceMs?: number } = {}): TopSessionRow[] {
    const since = sinceMs ?? 0;
    const rows = this.db
      .prepare(
        `SELECT
           session_id AS sessionId,
           project_path AS projectPath,
           SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens) AS totalTokens,
           COUNT(*) AS eventCount,
           MIN(ts) AS firstTs,
           MAX(ts) AS lastTs
         FROM token_events
         WHERE ts >= ?
         GROUP BY session_id
         ORDER BY totalTokens DESC
         LIMIT ?`
      )
      .all(since, limit) as TopSessionRow[];
    return rows.map(r => ({
      sessionId: r.sessionId,
      projectPath: r.projectPath ?? null,
      totalTokens: Number(r.totalTokens) || 0,
      eventCount: Number(r.eventCount) || 0,
      firstTs: Number(r.firstTs) || 0,
      lastTs: Number(r.lastTs) || 0,
    }));
  }

  /** Aggregate by project (cwd). */
  byProject({ sinceMs }: { sinceMs?: number } = {}): ProjectRow[] {
    const since = sinceMs ?? 0;
    const rows = this.db
      .prepare(
        `SELECT
           project_path AS projectPath,
           SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens) AS totalTokens,
           COUNT(*) AS eventCount,
           COUNT(DISTINCT session_id) AS sessionCount
         FROM token_events
         WHERE ts >= ?
         GROUP BY project_path
         ORDER BY totalTokens DESC`
      )
      .all(since) as ProjectRow[];
    return rows.map(r => ({
      projectPath: r.projectPath ?? null,
      totalTokens: Number(r.totalTokens) || 0,
      eventCount: Number(r.eventCount) || 0,
      sessionCount: Number(r.sessionCount) || 0,
    }));
  }

  /**
   * Aggregate by attribution key (Phase 3 of burn-detection-and-self-heal
   * spec). Returns one row per key with totals, event count, and the time
   * window the key has been seen across the requested period.
   */
  byAttributionKey({ sinceMs, limit = 100 }: { sinceMs?: number; limit?: number } = {}): AttributionKeyRow[] {
    const since = sinceMs ?? 0;
    const rows = this.db
      .prepare(
        `SELECT
           attribution_key AS attributionKey,
           SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens) AS totalTokens,
           COUNT(*) AS eventCount,
           MIN(ts) AS firstTs,
           MAX(ts) AS lastTs
         FROM token_events
         WHERE ts >= ?
         GROUP BY attribution_key
         ORDER BY totalTokens DESC
         LIMIT ?`
      )
      .all(since, limit) as AttributionKeyRow[];
    return rows.map(r => ({
      attributionKey: r.attributionKey,
      totalTokens: Number(r.totalTokens) || 0,
      eventCount: Number(r.eventCount) || 0,
      firstTs: Number(r.firstTs) || 0,
      lastTs: Number(r.lastTs) || 0,
    }));
  }

  /** Sessions whose newest event is older than `idleMs` ago. */
  orphans({ idleMs }: { idleMs: number }): OrphanRow[] {
    const now = Date.now();
    const cutoff = now - idleMs;
    const rows = this.db
      .prepare(
        `SELECT
           session_id AS sessionId,
           project_path AS projectPath,
           MAX(ts) AS lastTs,
           SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens) AS totalTokens
         FROM token_events
         GROUP BY session_id
         HAVING lastTs < ?
         ORDER BY lastTs DESC`
      )
      .all(cutoff) as Array<{
        sessionId: string;
        projectPath: string | null;
        lastTs: number;
        totalTokens: number;
      }>;
    return rows.map(r => ({
      sessionId: r.sessionId,
      projectPath: r.projectPath ?? null,
      lastTs: Number(r.lastTs) || 0,
      totalTokens: Number(r.totalTokens) || 0,
      idleMs: now - Number(r.lastTs),
    }));
  }

  // ── Codex (OpenAI) sessions ─────────────────────────────────────────
  // Read-only observability for Codex's persisted rollouts. Stored in the
  // separate codex_token_sessions table; the BurnDetector never sees these.

  /**
   * Ingest one Codex rollout file. Reads the whole file (rollouts are small
   * relative to Claude transcripts), parses the cumulative session total, and
   * upserts a single row keyed on the Codex session UUID. Idempotent: re-ingest
   * of a grown rollout replaces the totals with the latest reading.
   *
   * `last_ts` is taken from the file mtime because Codex's token_count events
   * carry no per-event timestamp. Returns ingested=false (with a reason) for
   * unreadable/empty/usage-less rollouts — never throws.
   */
  ingestCodexRollout(filePath: string): CodexIngestResult {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return { ingested: false, reason: 'stat-failed' };
    }
    if (!stat.isFile()) return { ingested: false, reason: 'not-a-file' };
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return { ingested: false, reason: 'read-failed' };
    }
    const parsed = parseCodexRollout(content);
    if (!parsed) return { ingested: false, reason: 'no-usage' };
    return this.ingestCodexSession(parsed, stat.mtimeMs);
  }

  /**
   * Upsert an already-parsed Codex session. Exposed separately so callers (and
   * tests) can ingest without touching the filesystem. `lastTs` is the
   * last-activity time (file mtime); `firstTs` falls back to it when the
   * rollout lacked a session_meta timestamp, so first_ts is never 0.
   */
  ingestCodexSession(parsed: ParsedCodexSession, lastTs: number): CodexIngestResult {
    if (!parsed.sessionId) return { ingested: false, reason: 'no-session-id' };
    const now = Date.now();
    const firstTs = parsed.firstTs > 0 ? parsed.firstTs : lastTs;
    try {
      const result = this.stmts.upsertCodexSession.run({
        sessionId: parsed.sessionId,
        projectPath: parsed.cwd ?? null,
        model: parsed.model ?? null,
        planType: parsed.planType ?? null,
        inputTokens: parsed.inputTokens,
        cachedInputTokens: parsed.cachedInputTokens,
        outputTokens: parsed.outputTokens,
        reasoningOutputTokens: parsed.reasoningOutputTokens,
        totalTokens: parsed.totalTokens,
        primaryUsedPercent: parsed.primaryUsedPercent,
        secondaryUsedPercent: parsed.secondaryUsedPercent,
        tokenCountEvents: parsed.tokenCountEvents,
        firstTs,
        lastTs,
        updatedAt: now,
      });
      return { ingested: result.changes > 0, sessionId: parsed.sessionId, reason: result.changes > 0 ? undefined : 'no-change' };
    } catch {
      return { ingested: false, reason: 'upsert-error' };
    }
  }

  /** Aggregate Codex usage. Optionally filter to sessions active since `sinceMs`. */
  codexSummary({ sinceMs }: { sinceMs?: number } = {}): CodexSummaryRow {
    const since = sinceMs ?? 0;
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(total_tokens), 0) AS totalTokens,
           COALESCE(SUM(input_tokens), 0) AS totalInput,
           COALESCE(SUM(cached_input_tokens), 0) AS totalCachedInput,
           COALESCE(SUM(output_tokens), 0) AS totalOutput,
           COALESCE(SUM(reasoning_output_tokens), 0) AS totalReasoning,
           COUNT(*) AS sessionCount,
           MIN(first_ts) AS oldestTs,
           MAX(last_ts) AS newestTs,
           MAX(primary_used_percent) AS maxPrimaryUsedPercent,
           MAX(secondary_used_percent) AS maxSecondaryUsedPercent
         FROM codex_token_sessions
         WHERE last_ts >= ?`
      )
      .get(since) as Record<string, number | null>;
    return {
      totalTokens: Number(row.totalTokens) || 0,
      totalInput: Number(row.totalInput) || 0,
      totalCachedInput: Number(row.totalCachedInput) || 0,
      totalOutput: Number(row.totalOutput) || 0,
      totalReasoning: Number(row.totalReasoning) || 0,
      sessionCount: Number(row.sessionCount) || 0,
      oldestTs: row.oldestTs ?? null,
      newestTs: row.newestTs ?? null,
      maxPrimaryUsedPercent: row.maxPrimaryUsedPercent ?? null,
      maxSecondaryUsedPercent: row.maxSecondaryUsedPercent ?? null,
    };
  }

  /** Per-session Codex rows, biggest first. Optionally filter by recency. */
  codexSessions({ limit = 50, sinceMs }: { limit?: number; sinceMs?: number } = {}): CodexSessionRow[] {
    const since = sinceMs ?? 0;
    const rows = this.db
      .prepare(
        `SELECT
           session_id AS sessionId, project_path AS projectPath, model, plan_type AS planType,
           input_tokens AS inputTokens, cached_input_tokens AS cachedInputTokens,
           output_tokens AS outputTokens, reasoning_output_tokens AS reasoningOutputTokens,
           total_tokens AS totalTokens, primary_used_percent AS primaryUsedPercent,
           secondary_used_percent AS secondaryUsedPercent, token_count_events AS tokenCountEvents,
           first_ts AS firstTs, last_ts AS lastTs
         FROM codex_token_sessions
         WHERE last_ts >= ?
         ORDER BY total_tokens DESC
         LIMIT ?`
      )
      .all(since, limit) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      sessionId: String(r.sessionId),
      projectPath: (r.projectPath as string) ?? null,
      model: (r.model as string) ?? null,
      planType: (r.planType as string) ?? null,
      inputTokens: Number(r.inputTokens) || 0,
      cachedInputTokens: Number(r.cachedInputTokens) || 0,
      outputTokens: Number(r.outputTokens) || 0,
      reasoningOutputTokens: Number(r.reasoningOutputTokens) || 0,
      totalTokens: Number(r.totalTokens) || 0,
      primaryUsedPercent: r.primaryUsedPercent != null ? Number(r.primaryUsedPercent) : null,
      secondaryUsedPercent: r.secondaryUsedPercent != null ? Number(r.secondaryUsedPercent) : null,
      tokenCountEvents: Number(r.tokenCountEvents) || 0,
      firstTs: Number(r.firstTs) || 0,
      lastTs: Number(r.lastTs) || 0,
    }));
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // best-effort
    }
  }
}

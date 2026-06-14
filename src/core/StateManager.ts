/**
 * File-based state management.
 *
 * All state is stored as JSON files — no database dependency.
 * This is intentional: agent infrastructure should be portable
 * and not require running a DB server.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Session, JobState, ActivityEvent } from './types.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';

/**
 * Discriminate filesystem read errors into operator-actionable categories.
 *
 * Previously all read failures (EPERM, EACCES, ENOENT, JSON.parse errors)
 * were labeled "Corrupted ...". On macOS this misled operators: launchd-spawned
 * processes hitting ~/Documents without Full Disk Access produce EPERM, which
 * is a permissions issue, not file corruption. Surfacing the distinction lets
 * agents (and the feedback pipeline) route the report correctly instead of
 * chasing nonexistent corruption.
 */
function describeReadError(err: unknown, filePath: string): {
  reason: string;
  kind: 'permission' | 'parse' | 'io';
} {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const msg = err instanceof Error ? err.message : String(err);
  if (code === 'EPERM' || code === 'EACCES') {
    return {
      kind: 'permission',
      reason:
        `Permission denied reading ${filePath} (${code}). ` +
        `On macOS, launchd-spawned processes need Full Disk Access to read under ~/Documents. ` +
        `Underlying error: ${msg}`,
    };
  }
  if (err instanceof SyntaxError) {
    return {
      kind: 'parse',
      reason: `Corrupted state file ${filePath} (JSON parse failed): ${msg}`,
    };
  }
  return {
    kind: 'io',
    reason: `Failed to read ${filePath}${code ? ` (${code})` : ''}: ${msg}`,
  };
}

/** TTL for the listSessions read cache. Short enough that read-only staleness is
 *  negligible for the reaper/scheduler/sentinels (which poll on far longer cycles),
 *  long enough to collapse the many sub-second redundant calls into one disk read. */
const SESSIONS_CACHE_TTL_MS = 1000;

export class StateManager {
  private stateDir: string;
  private _readOnly: boolean = false;
  private _sessionPoolActive: boolean = false;
  private _machineId: string | null = null;
  private readonly _now: () => number;
  /** Memoized full session list — the fix for the systemic CPU hot-loop where
   *  `listSessions` re-read + re-parsed EVERY session file from disk on EVERY call,
   *  and is called each tick by the reaper + sentinels via `listRunningSessions`
   *  (O(sessions × pollers × tick-rate) disk reads). Invalidated on any session
   *  write so spawns/terminations remain instantly visible. */
  private _sessionsCache: Session[] | null = null;
  private _sessionsCacheAt = 0;

  constructor(stateDir: string, opts?: { now?: () => number }) {
    this.stateDir = stateDir;
    this._now = opts?.now ?? (() => Date.now());
  }

  /** The root the state tree hangs off (files live under `<baseDir>/state/...`).
   *  Exposed so sibling stores (e.g. PendingInjectStore) can colocate without
   *  re-plumbing the path through their own config. */
  get baseDir(): string {
    return this.stateDir;
  }

  /** Drop the listSessions cache so the next read reflects a just-written change. */
  private invalidateSessionsCache(): void {
    this._sessionsCache = null;
  }

  /**
   * Set the machine ID for this StateManager instance.
   * When set, all activity events are automatically stamped with the originating machineId
   * (Phase 4D — Gap 6: machine-prefixed state).
   */
  setMachineId(machineId: string): void {
    this._machineId = machineId;
  }

  /** Get the configured machine ID (null if not set). */
  get machineId(): string | null {
    return this._machineId;
  }

  /** Whether this StateManager is in read-only mode (standby machine). */
  get readOnly(): boolean {
    return this._readOnly;
  }

  /**
   * Set read-only mode. When true, all write operations throw.
   * Used on standby machines to prevent accidental state forks.
   */
  setReadOnly(readOnly: boolean): void {
    this._readOnly = readOnly;
  }

  /**
   * Whether the active-active session pool is enabled for this machine. When true, a
   * read-only standby is still permitted to write the PER-SESSION state of sessions it
   * legitimately OWNS (the pool's CAS ownership guarantees a single owner per session,
   * so a per-session file write can't fork shared cluster state). Shared-cluster writes
   * (set/delete/saveJobState/appendEvent) stay blocked on a standby regardless.
   * Default false → a pure one-awake standby remains fully read-only (unchanged).
   */
  setSessionPoolActive(active: boolean): void {
    this._sessionPoolActive = active;
  }

  /**
   * Guard that throws in read-only mode. `sessionScoped` marks a write that targets a
   * single owned session's own file (state/sessions/<id>.json) — permitted on a
   * read-only standby ONLY when the session pool is active (bug #9: a moved session's
   * owner-side resume must persist on the standby that now owns it; the pool path that
   * triggers it only fires for CAS-confirmed owned sessions). Shared-state writes pass
   * no opts and stay blocked.
   */
  private guardWrite(operation: string, opts?: { sessionScoped?: boolean }): void {
    if (!this._readOnly) return;
    if (opts?.sessionScoped && this._sessionPoolActive) return;
    throw new Error(`StateManager is read-only (this machine is on standby). Blocked: ${operation}`);
  }

  /**
   * PUBLIC guard entrypoint for coherence-journal appends (COHERENCE-JOURNAL-SPEC §3.1).
   *
   * The journal writer (`CoherenceJournal`) does its own file I/O — it is not a
   * StateManager method — so the read-only-standby decision is centralized HERE and the
   * flusher calls this before each append batch. Two deliberate properties:
   *
   * 1. Journal writes are permitted on a read-only standby INDEPENDENT of
   *    `_sessionPoolActive`. The `sessionScoped` exception above only opens when the
   *    pool is live; reusing it would silently disable the journal on exactly the
   *    quiet-standby topology the EXO artifact-stranding incident happened on. A
   *    standby observing its own placement/lifecycle events cannot fork shared state:
   *    journal streams are single-producer-per-machine by construction.
   *
   * 2. The permission is allowlisted to precisely the canonicalized journal prefix —
   *    own streams + meta/lock sidecars (`state/coherence-journal/`) and replica
   *    appends (`state/coherence-journal/peers/`, inside the first). A path escaping
   *    the prefix throws even when NOT read-only: the journal dir is the only thing
   *    this entrypoint will ever bless, so a bug constructing a stray path fails
   *    loudly here instead of writing somewhere surprising.
   */
  guardJournalWrite(targetPath: string): void {
    const journalRoot = path.resolve(this.stateDir, 'state', 'coherence-journal');
    const resolved = path.resolve(targetPath);
    if (resolved !== journalRoot && !resolved.startsWith(journalRoot + path.sep)) {
      throw new Error(
        `guardJournalWrite: path escapes the coherence-journal prefix: ${targetPath}`,
      );
    }
    // Inside the prefix: permitted in read-only mode (standby-safe by design).
  }

  /** Validate a key/ID contains only safe characters to prevent path traversal. */
  private validateKey(key: string, label: string = 'key'): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
      throw new Error(`Invalid ${label}: "${key}" — only alphanumeric, hyphens, and underscores allowed`);
    }
  }

  // ── Session State ───────────────────────────────────────────────

  getSession(sessionId: string): Session | null {
    this.validateKey(sessionId, 'sessionId');
    const filePath = path.join(this.stateDir, 'state', 'sessions', `${sessionId}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
      const { reason, kind } = describeReadError(err, filePath);
      console.warn(`[StateManager] getSession ${kind}: ${filePath}`);
      DegradationReporter.getInstance().report({
        feature: 'StateManager.getSession',
        primary: 'Load valid session state from JSON',
        fallback: 'Return null — session unavailable',
        reason,
        impact: 'Session data lost, may affect job scheduling',
      });
      return null;
    }
  }

  saveSession(session: Session): void {
    this.guardWrite('saveSession', { sessionScoped: true });
    this.validateKey(session.id, 'sessionId');
    // One-running-record-per-tmux invariant (ghost-record fix): registering a
    // record as live for a tmux name supersedes any OTHER record still marked
    // live for the same name. tmux session names are unique among live
    // sessions, so two live records for one name are definitionally stale —
    // crisis respawns leaked one ghost per respawn and the dashboard rendered
    // each as a separate "duplicate session" (2026-06-11 Mac Mini: 5 running
    // records all pointing at the single tmux session
    // echo-resource-limitation-mitigation). Enforced HERE because saveSession
    // is the single funnel every spawn site already passes through — the same
    // rationale as the journal funnel below.
    if (session.status === 'running' || session.status === 'starting') {
      this.supersedeStaleLiveRecords(session);
    }
    const filePath = path.join(this.stateDir, 'state', 'sessions', `${session.id}.json`);
    // Coherence-journal lifecycle funnel (COHERENCE-JOURNAL-SPEC §3.3): EVERY
    // session status transition passes through saveSession — deriving the
    // transition here (prev-on-disk vs next) means no call site can ever
    // forget to record one (eleven callsites exist; per-site wiring would
    // drift). Read-before-write is one small file on a non-hot path.
    const prevStatus = this.peekSessionStatus(filePath);
    this.atomicWrite(filePath, JSON.stringify(session, null, 2));
    this.invalidateSessionsCache(); // a write must be visible to the next list
    this.recordLifecycleTransition(prevStatus, session);
  }

  /**
   * Close every OTHER record still marked live for the same tmux session name
   * (ghost-record supersession). Each ghost is closed through saveSession
   * itself so the journal funnel records its completed transition — the
   * reentry terminates because a 'completed' save never enters this path.
   * Best-effort: a failure here must never endanger the spawn being saved.
   */
  private supersedeStaleLiveRecords(next: Session): void {
    try {
      const ghosts = this.listSessions().filter(
        (s) =>
          s.id !== next.id &&
          s.tmuxSession === next.tmuxSession &&
          (s.status === 'running' || s.status === 'starting'),
      );
      for (const ghost of ghosts) {
        this.saveSession({
          ...ghost,
          status: 'completed',
          endedAt: new Date().toISOString(),
          endedReason: 'superseded',
          supersededBy: next.id,
        });
      }
    } catch { /* @silent-fallback-ok: supersession is registry hygiene — it must never block the live spawn being registered */ }
  }

  /** Best-effort read of an existing session record's status (funnel diff input). */
  private peekSessionStatus(filePath: string): Session['status'] | undefined {
    try {
      if (!fs.existsSync(filePath)) return undefined;
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Session;
      return parsed?.status;
    } catch { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
      return undefined; // unreadable prev = treat as new (op-key dedupe absorbs repeats)
    }
  }

  /** Injected at server startup; absent (undefined) = journaling disabled, zero-cost no-op. */
  private coherenceJournal?: import('./CoherenceJournal.js').CoherenceJournal;

  /** Wire the coherence journal (COHERENCE-JOURNAL-SPEC §3.3). Server startup only. */
  setCoherenceJournal(journal: import('./CoherenceJournal.js').CoherenceJournal | undefined): void {
    this.coherenceJournal = journal;
  }

  /**
   * The wired journal handle, for callers that already hold the StateManager
   * (e.g. routes threading the §3.3 stop-funnel emits) — saves a parallel
   * plumbing path through every context object.
   */
  getCoherenceJournal(): import('./CoherenceJournal.js').CoherenceJournal | undefined {
    return this.coherenceJournal;
  }

  /**
   * Map a saveSession status diff onto journal lifecycle events. NEVER throws
   * into saveSession (the journal must not endanger the observed operation).
   * 'reaped' is NOT derived here — the reaper emits it explicitly alongside its
   * reap-log append (with reapLogRef), per the spec.
   */
  private recordLifecycleTransition(prev: Session['status'] | undefined, session: Session): void {
    if (!this.coherenceJournal) return;
    try {
      const next = session.status;
      if (prev === next) return; // metadata-only save, not a transition
      let journalStatus: 'created' | 'completed' | 'killed' | 'failed' | undefined;
      if (prev === undefined && (next === 'starting' || next === 'running')) journalStatus = 'created';
      else if (next === 'completed') journalStatus = 'completed';
      else if (next === 'killed') journalStatus = 'killed';
      else if (next === 'failed') journalStatus = 'failed';
      if (!journalStatus) return; // e.g. starting→running: not a lifecycle boundary
      // Best-effort topic linkage from the session-name convention; entries
      // without a topic are still sessionId-queryable.
      const m = /(?:^|[-_])(?:topic|telegram)[-_]?(\d+)(?:$|[-_])/.exec(session.name ?? '');
      const topic = m ? Number(m[1]) : undefined;
      this.coherenceJournal.emitLifecycle(
        {
          sessionId: session.id,
          status: journalStatus,
          ...(session.endedReason ? { reapReason: session.endedReason } : {}),
        },
        topic,
      );
    } catch {
      // Swallow: observability must not endanger the observed (§3.1).
    }
  }

  listSessions(filter?: { status?: Session['status'] }): Session[] {
    const all = this.readAllSessionsCached();
    const filtered = filter?.status ? all.filter(s => s.status === filter.status) : all;
    // Return shallow copies so a caller mutating a result can't corrupt the shared
    // cache; listSessions output is treated as a read-only snapshot by all consumers.
    return filtered.map(s => ({ ...s }));
  }

  /**
   * Read every session file (readdir + readFileSync + JSON.parse), memoized for
   * SESSIONS_CACHE_TTL_MS. THIS is the hot path: the reaper and every sentinel call
   * `listRunningSessions` → `listSessions` on each tick, so without the cache the
   * server re-read + re-parsed the FULL session directory many times per second
   * (the systemic ~30%-CPU `readFileUtf8` hot-loop). Writes invalidate the cache, so
   * a freshly spawned or removed session is visible on the very next call.
   */
  private readAllSessionsCached(): Session[] {
    if (this._sessionsCache && (this._now() - this._sessionsCacheAt) < SESSIONS_CACHE_TTL_MS) {
      return this._sessionsCache;
    }
    const dir = path.join(this.stateDir, 'state', 'sessions');
    if (!fs.existsSync(dir)) {
      this._sessionsCache = [];
      this._sessionsCacheAt = this._now();
      return this._sessionsCache;
    }
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const sessions: Session[] = [];
    for (const f of files) {
      try {
        sessions.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')));
      } catch (err) {
        const filePath = path.join(dir, f);
        const { reason, kind } = describeReadError(err, filePath);
        console.warn(`[StateManager] listSessions ${kind}: ${f}`);
        DegradationReporter.getInstance().report({
          feature: 'StateManager.listSessions',
          primary: 'List all sessions from state files',
          fallback: kind === 'permission' ? 'Skip unreadable session file' : 'Skip corrupted session file',
          reason,
          impact: 'Some sessions invisible to scheduler',
        });
      }
    }
    this._sessionsCache = sessions;
    this._sessionsCacheAt = this._now();
    return sessions;
  }

  removeSession(sessionId: string): boolean {
    this.guardWrite('removeSession', { sessionScoped: true });
    this.validateKey(sessionId, 'sessionId');
    const filePath = path.join(this.stateDir, 'state', 'sessions', `${sessionId}.json`);
    if (!fs.existsSync(filePath)) return false;
    try {
      SafeFsExecutor.safeUnlinkSync(filePath, { operation: 'src/core/StateManager.ts:166' });
      this.invalidateSessionsCache(); // removal must be visible to the next list
      return true;
    } catch {
      return false;
    }
  }

  // ── Job State ─────────────────────────────────────────────────

  getJobState(slug: string): JobState | null {
    this.validateKey(slug, 'job slug');
    const filePath = path.join(this.stateDir, 'state', 'jobs', `${slug}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
      const { reason, kind } = describeReadError(err, filePath);
      console.warn(`[StateManager] getJobState ${kind}: ${filePath}`);
      DegradationReporter.getInstance().report({
        feature: 'StateManager.getJobState',
        primary: 'Load job state from JSON',
        fallback: 'Return null — job state unavailable',
        reason,
        impact: 'Job scheduling may use stale data',
      });
      return null;
    }
  }

  saveJobState(state: JobState): void {
    this.guardWrite('saveJobState');
    this.validateKey(state.slug, 'job slug');
    const filePath = path.join(this.stateDir, 'state', 'jobs', `${state.slug}.json`);
    this.atomicWrite(filePath, JSON.stringify(state, null, 2));
  }

  // ── Activity Events ───────────────────────────────────────────

  appendEvent(event: ActivityEvent): void {
    this.guardWrite('appendEvent');
    try {
      // Auto-stamp machineId if configured (Phase 4D — Gap 6)
      const stamped = this._machineId && !event.machineId
        ? { ...event, machineId: this._machineId }
        : event;

      const date = new Date().toISOString().slice(0, 10);
      const dir = path.join(this.stateDir, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `activity-${date}.jsonl`);
      fs.appendFileSync(filePath, JSON.stringify(stamped) + '\n');
    } catch (err) {
      // @silent-fallback-ok — activity log write non-critical
      console.error(`[StateManager] Failed to append event: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  queryEvents(options: {
    since?: Date;
    type?: string;
    limit?: number;
  }): ActivityEvent[] {
    const logDir = path.join(this.stateDir, 'logs');
    if (!fs.existsSync(logDir)) return [];

    const files = fs.readdirSync(logDir)
      .filter(f => f.startsWith('activity-') && f.endsWith('.jsonl'))
      .sort()
      .reverse();

    const events: ActivityEvent[] = [];
    const limit = options.limit || 100;

    for (const file of files) {
      const lines = fs.readFileSync(path.join(logDir, file), 'utf-8')
        .split('\n')
        .filter(Boolean);

      for (const line of lines.reverse()) {
        let event: ActivityEvent;
        try {
          event = JSON.parse(line);
        } catch {
          // @silent-fallback-ok — JSONL line parse, skip corrupted
          continue; // Skip corrupted lines
        }

        if (options.since && new Date(event.timestamp) < options.since) {
          return events; // Past the time window
        }

        if (options.type && event.type !== options.type) continue;

        events.push(event);
        if (events.length >= limit) return events;
      }
    }

    return events;
  }

  // ── Generic Key-Value Store ───────────────────────────────────

  get<T>(key: string): T | null {
    this.validateKey(key, 'state key');
    const filePath = path.join(this.stateDir, 'state', `${key}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
      const { reason, kind } = describeReadError(err, filePath);
      console.warn(`[StateManager] get ${kind}: ${filePath}`);
      DegradationReporter.getInstance().report({
        feature: 'StateManager.get',
        primary: 'Load generic state file',
        fallback: 'Return null — state unavailable',
        reason,
        impact: 'Feature depending on this state may malfunction',
      });
      return null;
    }
  }

  set<T>(key: string, value: T): void {
    this.guardWrite('set');
    this.validateKey(key, 'state key');
    const filePath = path.join(this.stateDir, 'state', `${key}.json`);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    this.atomicWrite(filePath, JSON.stringify(value, null, 2));
  }

  delete(key: string): boolean {
    this.guardWrite('delete');
    this.validateKey(key, 'state key');
    const filePath = path.join(this.stateDir, 'state', `${key}.json`);
    if (!fs.existsSync(filePath)) return false;
    try {
      SafeFsExecutor.safeUnlinkSync(filePath, { operation: 'src/core/StateManager.ts:305' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Write a file atomically — write to .tmp then rename.
   * Prevents corruption from power loss or disk-full mid-write.
   */
  private atomicWrite(filePath: string, data: string): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = filePath + `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.writeFileSync(tmpPath, data);
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      // Clean up temp file on failure
      try { SafeFsExecutor.safeUnlinkSync(tmpPath, { operation: 'src/core/StateManager.ts:326' }); } catch { /* ignore */ }
      throw err;
    }
  }
}

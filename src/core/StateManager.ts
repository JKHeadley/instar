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
    const filePath = path.join(this.stateDir, 'state', 'sessions', `${session.id}.json`);
    this.atomicWrite(filePath, JSON.stringify(session, null, 2));
    this.invalidateSessionsCache(); // a write must be visible to the next list
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

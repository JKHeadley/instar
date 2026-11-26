/**
 * Who asked for a server restart.
 *
 * `state/restart-requested.json` is read by two consumers, the lifeline's
 * ServerSupervisor and the server's own ForegroundRestartWatcher. Every writer in
 * instar names itself in `requestedBy`. A flag written by hand (a session editing
 * config.json over ssh, then writing the flag so the change loads) carried no
 * name, and both consumers logged "Restart requested by undefined" (M5 Pro,
 * 2026-11-16 19:42:12Z: a 2m43s outage nobody could attribute from the machine).
 *
 * The restart still happens: refusing it would leave whatever the writer needed
 * unapplied with no one told. It is named plainly as unattributed, and every
 * consumed request, named or not, is appended to `logs/restart-requests.jsonl`,
 * where the next boot reads it back (`bootReadiness.previousRestart` on /health).
 *
 * The supported way for a session to ask is `POST /server/restart` with
 * `requestedBy` and `reason`, which refuses an empty requester.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface RestartRequestFlag {
  requestedAt?: unknown;
  requestedBy?: unknown;
  reason?: unknown;
  targetVersion?: unknown;
  previousVersion?: unknown;
  plannedRestart?: unknown;
  bypassHolds?: unknown;
  pid?: unknown;
}

export interface RestartRequester {
  attributed: boolean;
  /** `requestedBy`, or a plain label for a flag that names nobody. */
  label: string;
}

/** The label a hand-written flag gets; kept stable so logs can be searched for it. */
export const UNATTRIBUTED_RESTART_LABEL = 'an unattributed writer (no requestedBy in restart-requested.json)';

const MAX_FIELD = 200;

export function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // One line, bounded: this ends up in a log line and a JSON record.
  return trimmed.replace(/[\r\n\t]+/g, ' ').slice(0, MAX_FIELD);
}

export function describeRestartRequester(flag: RestartRequestFlag | null | undefined): RestartRequester {
  const by = cleanString(flag?.requestedBy);
  return by ? { attributed: true, label: by } : { attributed: false, label: UNATTRIBUTED_RESTART_LABEL };
}

export interface RestartRequestRecord {
  at: string;
  /** Which process consumed the flag. */
  consumer: 'supervisor' | 'foreground-watcher' | 'lifeline';
  serverOutcome?: 'kept' | 'stopped' | 'unknown';
  requestedBy: string | null;
  attributed: boolean;
  reason: string | null;
  targetVersion: string | null;
  requestedAt: string | null;
  /** The pid the writer stamped, when it stamped one. */
  writerPid: number | null;
  /**
   * `plannedRestart` and `bypassHolds` exactly as the request carried them: true or false when
   * it wrote a boolean, null when it wrote none. A planned request without `bypassHolds: true`
   * waits for a running verify; one with it does not, so these two say whether a restart was
   * forced past work in progress. Optional on read: records written before these fields have none.
   */
  plannedRestart?: boolean | null;
  bypassHolds?: boolean | null;
}

export function restartRequestsLogPath(stateDir: string): string {
  return path.join(stateDir, 'logs', 'restart-requests.jsonl');
}

/** Bounded so a restart loop cannot grow the file without limit. */
const MAX_LOG_BYTES = 256 * 1024;

export function buildRestartRequestRecord(
  flag: RestartRequestFlag | null | undefined,
  consumer: RestartRequestRecord['consumer'],
  now: Date = new Date(),
  options: Pick<RestartRequestRecord, 'serverOutcome'> = {},
): RestartRequestRecord {
  const who = describeRestartRequester(flag);
  const pid = flag?.pid;
  return {
    at: now.toISOString(),
    ...options,
    consumer,
    requestedBy: who.attributed ? who.label : null,
    attributed: who.attributed,
    reason: cleanString(flag?.reason),
    targetVersion: cleanString(flag?.targetVersion),
    requestedAt: cleanString(flag?.requestedAt),
    writerPid: typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    plannedRestart: typeof flag?.plannedRestart === 'boolean' ? flag.plannedRestart : null,
    bypassHolds: typeof flag?.bypassHolds === 'boolean' ? flag.bypassHolds : null,
  };
}

/** Append one consumed request. Never throws: a log failure must not block the restart. */
export function recordRestartRequest(
  stateDir: string,
  flag: RestartRequestFlag | null | undefined,
  consumer: RestartRequestRecord['consumer'],
  now: Date = new Date(),
  options: Pick<RestartRequestRecord, 'serverOutcome'> = {},
): RestartRequestRecord {
  const record = buildRestartRequestRecord(flag, consumer, now, options);
  try {
    const file = restartRequestsLogPath(stateDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) {
        const tail = fs.readFileSync(file, 'utf8').slice(-Math.floor(MAX_LOG_BYTES / 2));
        fs.writeFileSync(file, tail.slice(tail.indexOf('\n') + 1));
      }
    } catch { /* @silent-fallback-ok — no file yet */ }
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
  } catch (err) {
    // @silent-fallback-ok — the restart proceeds; the console line above it still names the requester.
    console.warn(`[restart-request] could not record the request: ${err instanceof Error ? err.message : String(err)}`);
  }
  return record;
}

/** The most recent consumed request, or null. Reads only the file's tail. */
export function readLastRestartRequest(stateDir: string): RestartRequestRecord | null {
  try {
    const file = restartRequestsLogPath(stateDir);
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(size, MAX_LOG_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]) as RestartRequestRecord;
          if (parsed && typeof parsed.at === 'string' && typeof parsed.attributed === 'boolean'
            && (parsed.consumer !== 'lifeline' || parsed.serverOutcome === 'stopped')) return parsed;
        } catch { /* @silent-fallback-ok — a torn first line from the tail cut */ }
      }
      return null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // @silent-fallback-ok — no record yet
    return null;
  }
}

/** How far back the by-request lookup reads: ~300 B per row, so this reaches well past a 4-hour episode. */
const FIND_TAIL_BYTES = 64 * 1024;

export interface RestartRequestLookup {
  /** The request's own `requestedAt` (cleaned), or null for an unattributed flag. */
  requestedAt: string | null;
  /** Rows older than this are not the request's (ISO or ms). */
  sinceMs: number;
}

export interface RestartRequestFind {
  record: RestartRequestRecord | null;
  /** Whether the tail reached back to `sinceMs`; a cut or unreadable ledger is not a negative answer. */
  coverage: 'full' | 'cut' | 'unreadable';
}

/**
 * planned-restart-keeps-lead §1 step 3 — did a consumer record THIS request? Both consumers write a row
 * before they unlink the file, so a row is the state "a kill follows". Matches the request's
 * `requestedAt`; an unattributed flag (no `requestedAt`) matches an unattributed row written since the
 * episode opened. Reads a bounded tail and reports whether it reached `sinceMs`.
 */
export function findRestartRequestRecord(stateDir: string, lookup: RestartRequestLookup): RestartRequestFind {
  try {
    const file = restartRequestsLogPath(stateDir);
    if (!fs.existsSync(file)) return { record: null, coverage: 'full' };
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    let text: string;
    try {
      const len = Math.min(size, FIND_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    let oldestAt = Infinity;
    let found: RestartRequestRecord | null = null;
    for (const line of lines) {
      let row: RestartRequestRecord;
      try { row = JSON.parse(line) as RestartRequestRecord; } catch { continue; } // @silent-fallback-ok: a torn first line from the tail cut
      if (!row || typeof row.at !== 'string') continue;
      if (row.consumer === 'lifeline') continue;
      const at = Date.parse(row.at);
      if (!Number.isFinite(at)) continue;
      oldestAt = Math.min(oldestAt, at);
      if (at < lookup.sinceMs) continue;
      const matches = lookup.requestedAt !== null
        ? row.requestedAt === lookup.requestedAt
        : row.attributed === false || row.requestedAt == null;
      if (matches && (!found || Date.parse(found.at) < at)) found = row;
    }
    const coverage: RestartRequestFind['coverage'] = size <= FIND_TAIL_BYTES || oldestAt <= lookup.sinceMs ? 'full' : 'cut';
    return { record: found, coverage };
  } catch {
    return { record: null, coverage: 'unreadable' }; // @silent-fallback-ok: the caller treats an unreadable ledger as "row present"
  }
}

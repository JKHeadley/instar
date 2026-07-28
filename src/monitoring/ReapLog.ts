/**
 * ReapLog — durable, JSON-encoded audit of every session reap and every
 * skipped-reap (UNIFIED-SESSION-LIFECYCLE §P4).
 *
 * The pull-surface answer to "why did my session vanish?": one line per reap
 * (`sessionReaped`) and one per refused/skipped terminate (`reapBlocked`), so a
 * dropped kill (not-lease-holder / protected / a KEEP / in-flight) is never
 * invisible. Mirrors `sentinel-events.jsonl`: append-only JSONL under
 * `logs/`, written with JSON.stringify (never raw concat — closes
 * newline-injection of user-controlled session names / reasons).
 *
 * Read-only from the API (`GET /sessions/reap-log`, Bearer-auth). The log never
 * gates or mutates a session — it only records.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Read only the last `maxBytes` of a file and return its non-empty lines,
 * newest last. Bounded by construction: an arbitrarily large log is never
 * loaded whole (the readFileSync-whole-file pattern that froze the event loop
 * on a 142MB reap-log, 2026-07-03). If the read starts mid-file (the file is
 * larger than `maxBytes`), the first — possibly partial — line is dropped so a
 * torn record is never mis-parsed. Never throws; an absent/unreadable file
 * yields [].
 */
function tailLines(filePath: string, maxBytes: number): string[] {
  let fd: number | undefined;
  try {
    const size = fs.statSync(filePath).size;
    if (size === 0) return [];
    const readBytes = Math.min(size, maxBytes);
    const start = size - readBytes;
    const buf = Buffer.allocUnsafe(readBytes);
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, readBytes, start);
    const text = buf.toString('utf-8');
    const lines = text.split('\n');
    // Dropped: a leading partial line when we didn't read from byte 0.
    if (start > 0 && lines.length > 0) lines.shift();
    return lines.filter((l) => l.trim().length > 0);
  } catch {
    return []; // @silent-fallback-ok — absent/unreadable ⇒ no rows.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* fd already gone */
      }
    }
  }
}

/**
 * Terminal + initial outcomes of a reap-notice delivery attempt
 * (reap-notify spec R1.3). Records are APPENDED as pairs: one at enqueue
 * (`enqueued`) and one at terminal state — append-only JSONL, latest record
 * per noticeId wins on read.
 */
export type ReapNotifyOutcome =
  | 'enqueued'
  | 'sent'
  | 'send-failed-escalated'
  | 'no-topic'
  | 'enqueue-failed';

const NOTIFY_OUTCOMES: ReadonlySet<string> = new Set([
  'enqueued',
  'sent',
  'send-failed-escalated',
  'no-topic',
  'enqueue-failed',
]);

export interface ReapLogEntry {
  ts: string;
  /** 'reaped' = a kill happened; 'skipped' = a terminate was refused/no-op;
   *  'notify' = a reap-notice delivery outcome record (reap-notify spec R1.3). */
  type: 'reaped' | 'skipped' | 'notify';
  session: string;
  tmuxSession: string;
  /** The reason the killer requested (e.g. 'idle-zombie', 'age-limit'). */
  reason: string;
  /** What actually happened: terminal/recovery-bounce, skipped:<authority-reason>,
   *  or notify:<outcome>. */
  disposition: 'terminal' | 'recovery-bounce' | `skipped:${string}` | `notify:${string}`;
  origin?: 'operator' | 'autonomous';
  /** UNTRUSTED caller-supplied provenance claim (REMOTE-SESSION-CLOSE-SPEC §2.3)
   *  — e.g. 'remote-dashboard' from a relayed close. A label any token holder
   *  could set; recorded as a signal for the audit trail, NEVER consulted in
   *  authority decisions (those read `origin`, which is route-stamped). */
  viaClaim?: string;
  /** For 'skipped': why the authority refused (protected / not-lease-holder / a KEEP / in-flight). */
  skipped?: string;
  machine?: string;
  /** Which billing lane the reaped session ran on (june15-headless-spawn-reroute
   *  PR2, finding O4). 'rerouted-interactive' = the subscription lane;
   *  'headless' = the legacy `claude -p` SDK-pot lane. Absent on legacy records /
   *  non-claude spawns where the field was never stamped. */
  launchLane?: 'headless' | 'rerouted-interactive';
  /** Reaped entries: true when the kill interrupted evidenced work
   *  (reap-notify spec R2.1 — any non-marker work evidence). */
  midWork?: boolean;
  /** Reaped entries: the clamped work-evidence names that drove midWork. */
  workEvidence?: string[];
  /**
   * Reaped entries: which evidence SOURCE drove the revival-eligibility tag
   * (autonomous-registration-guarantee spec, GAP-B D3). Default (absent) ⇒
   * `'state-file'` — the registered-run path, back-compat for older rows.
   * `'commitment'` ⇒ the GAP-B backstop fired (a fresh qualifying open
   * commitment + recent-user-message corroboration on an UNregistered run).
   * PII constraint (D3): this field + at most the commitment id may be logged —
   * NEVER userRequest/agentResponse (this JSONL is world-readable).
   */
  evidenceSource?: 'state-file' | 'commitment';
  /** Notify entries: the notice this outcome record belongs to. */
  noticeId?: string;
  /** Notify entries: the topic the notice targets (absent for lifeline-only). */
  topicId?: number;
  /** Notify entries: the outcome this record asserts. */
  outcome?: ReapNotifyOutcome;
}

/** Rotate the reap-log once it crosses this many bytes. The current file is
 *  renamed to `<path>.1` (O(1), no data rewrite) and a fresh file started, so
 *  the on-disk log can NEVER grow unbounded — even if some future caller floods
 *  it past the transition-dedup below. One backup generation is retained;
 *  `read()` merges its tail so recent history survives a rotation boundary. */
const MAX_LOG_BYTES = 16 * 1024 * 1024;
/** `read()` only ever pulls the last this-many bytes of a log file, so a large
 *  reap-log can never be slurped whole into memory (the 142MB readFileSync +
 *  split that blocked the event loop, 2026-07-03). Generous vs the default
 *  `limit` of 200 rows (~300 B/row ⇒ ~6.5k rows fit in 2 MB). */
const TAIL_READ_BYTES = 2 * 1024 * 1024;
/** Cap on the in-memory transition-dedup map. Live session names are bounded
 *  (dozens); this is a safety ceiling so a pathological churn of distinct names
 *  can't grow the map without bound. Oldest entries are pruned first. */
const MAX_SKIP_STATE = 2000;

/** Optional overrides for the self-limiting caps — primarily so tests can
 *  trigger rotation without writing 16MB. Production uses the module defaults. */
export interface ReapLogOptions {
  maxLogBytes?: number;
  tailReadBytes?: number;
  maxSkipState?: number;
}

export class ReapLog {
  private readonly logPath: string;
  private readonly machineId?: () => string | undefined;
  private readonly maxLogBytes: number;
  private readonly tailReadBytes: number;
  private readonly maxSkipState: number;
  /** session name → last-LOGGED skip signature (`${reason}::${skipped}`).
   *  A `recordSkipped` whose signature equals the session's last-logged one is
   *  the SAME permanent veto being re-evaluated at tick speed (open-commitment,
   *  not-lease-holder, protected …) — it is NOT re-appended. This is the
   *  primary cure for the reaper self-inflicted log flood (3218 open-commitment
   *  + 1608 not-lease-holder repeat rows ⇒ 142MB, 2026-07-03): mirror the
   *  reaper-audit "log on transition, not every tick" pattern. Cleared when the
   *  session is reaped so a same-named successor logs its first skip fresh. */
  private readonly skipState = new Map<string, string>();
  /** Cheap running estimate of the current log's byte size, so rotation is
   *  decided WITHOUT a statSync on every append. Seeded from the real size on
   *  first append, then advanced by each write; re-synced on rotation. -1 =
   *  not yet seeded. */
  private approxSize = -1;

  constructor(stateDir: string, machineId?: () => string | undefined, opts: ReapLogOptions = {}) {
    this.logPath = path.join(stateDir, '..', 'logs', 'reap-log.jsonl');
    this.machineId = machineId;
    this.maxLogBytes = opts.maxLogBytes ?? MAX_LOG_BYTES;
    this.tailReadBytes = opts.tailReadBytes ?? TAIL_READ_BYTES;
    this.maxSkipState = opts.maxSkipState ?? MAX_SKIP_STATE;
  }

  recordReaped(e: {
    session: string;
    tmuxSession: string;
    reason: string;
    disposition?: 'terminal' | 'recovery-bounce';
    origin?: 'operator' | 'autonomous';
    viaClaim?: string;
    launchLane?: 'headless' | 'rerouted-interactive';
    midWork?: boolean;
    workEvidence?: string[];
    evidenceSource?: 'state-file' | 'commitment';
  }): void {
    this.append({
      ts: new Date().toISOString(),
      type: 'reaped',
      session: e.session,
      tmuxSession: e.tmuxSession,
      reason: e.reason,
      disposition: e.disposition ?? 'terminal',
      origin: e.origin,
      ...(e.viaClaim ? { viaClaim: e.viaClaim } : {}),
      machine: this.machineId?.(),
      ...(e.launchLane ? { launchLane: e.launchLane } : {}),
      ...(e.midWork !== undefined ? { midWork: e.midWork } : {}),
      ...(e.workEvidence && e.workEvidence.length > 0 ? { workEvidence: e.workEvidence } : {}),
      ...(e.evidenceSource ? { evidenceSource: e.evidenceSource } : {}),
    });
    // The session is gone — drop its skip-dedup state so a same-named successor
    // logs its first skip fresh and the map never leaks reaped names.
    this.forgetSkip(e.session);
  }

  /**
   * Append one reap-notice delivery outcome record (reap-notify spec R1.3).
   * Written as PAIRS by the notify path: once at enqueue (`enqueued`) and
   * once at terminal state. Append-only; consumers take the latest record
   * per noticeId as the current state.
   */
  recordNotify(e: {
    noticeId: string;
    topicId: number | null;
    outcome: ReapNotifyOutcome;
    /** Plain detail for the audit trail (e.g. the send error class). */
    detail?: string;
  }): void {
    this.append({
      ts: new Date().toISOString(),
      type: 'notify',
      session: e.noticeId,
      tmuxSession: '-',
      reason: e.detail ?? e.outcome,
      disposition: `notify:${e.outcome}`,
      machine: this.machineId?.(),
      noticeId: e.noticeId,
      ...(e.topicId !== null && e.topicId !== undefined ? { topicId: e.topicId } : {}),
      outcome: e.outcome,
    });
  }

  recordSkipped(e: {
    session: string;
    tmuxSession: string;
    reason: string;
    skipped: string;
    origin?: 'operator' | 'autonomous';
  }): void {
    // Log-on-transition: a reaper evaluates a permanently-vetoed session
    // (open-commitment, not-lease-holder, protected, …) on EVERY tick and would
    // emit an identical `skipped` row each time — 5k+ repeat rows ⇒ a 142MB log
    // that froze the event loop when read (2026-07-03). Only append when the
    // skip STATE changes for this session; a re-evaluation with the same
    // (reason, skipped) is the same veto and is dropped. The reaper keeps
    // evaluating every tick, so the moment the veto lifts (commitment closes,
    // lease moves) the state changes and the next skip — or the reap — logs.
    const sig = `${e.reason}::${e.skipped}`;
    if (this.skipState.get(e.session) === sig) return;
    this.rememberSkip(e.session, sig);
    this.append({
      ts: new Date().toISOString(),
      type: 'skipped',
      session: e.session,
      tmuxSession: e.tmuxSession,
      reason: e.reason,
      disposition: `skipped:${e.skipped}`,
      skipped: e.skipped,
      origin: e.origin,
      machine: this.machineId?.(),
    });
  }

  /** Record a session's last-logged skip signature, enforcing the map ceiling
   *  (oldest-first prune — Map preserves insertion order). Re-inserting an
   *  existing key does not reorder it, which is fine: churny NEW names are the
   *  growth risk, and those get pruned. */
  private rememberSkip(session: string, sig: string): void {
    this.skipState.set(session, sig);
    while (this.skipState.size > this.maxSkipState) {
      const oldest = this.skipState.keys().next().value;
      if (oldest === undefined) break;
      this.skipState.delete(oldest);
    }
  }

  /** Forget a session's skip state — call when the session is gone (reaped) so a
   *  same-named successor logs its first skip fresh and the map can't leak. */
  private forgetSkip(session: string): void {
    this.skipState.delete(session);
  }

  private append(entry: ReapLogEntry): void {
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      const line = JSON.stringify(entry) + '\n';
      this.rotateIfNeeded(Buffer.byteLength(line));
      fs.appendFileSync(this.logPath, line);
      if (this.approxSize >= 0) this.approxSize += Buffer.byteLength(line);
    } catch {
      // never throw from the audit sink
    }
  }

  /** Roll the log to `<path>.1` (single retained generation) once it would cross
   *  MAX_LOG_BYTES, so the file can never grow unbounded. Rename is O(1) — no
   *  data rewrite on the append hot path (rewriting a large file synchronously
   *  here would reintroduce the very event-loop stall we're removing). Seeds the
   *  cheap size estimate from the real file size on first use. */
  private rotateIfNeeded(incomingBytes: number): void {
    if (this.approxSize < 0) {
      try {
        this.approxSize = fs.statSync(this.logPath).size;
      } catch {
        this.approxSize = 0; // absent file ⇒ empty
      }
    }
    if (this.approxSize + incomingBytes <= this.maxLogBytes) return;
    try {
      fs.renameSync(this.logPath, `${this.logPath}.1`); // overwrites a prior .1
    } catch {
      // @silent-fallback-ok — if the roll fails the append still proceeds; the
      // read path is tail-bounded so an oversize file is a perf hit, never a
      // correctness failure.
    }
    this.approxSize = 0;
  }

  /** Read the most-recent `limit` entries (newest last), tolerating partial/corrupt lines.
   *  Only the last TAIL_READ_BYTES of each file are ever read, so a large log can
   *  never be slurped whole into memory (the readFileSync-whole-file freeze). If
   *  the current file's tail doesn't yield enough rows and a rotated `.1` backup
   *  exists, its tail is merged so recent history survives a rotation boundary. */
  read(limit = 200): ReapLogEntry[] {
    const wanted = limit > 0 ? limit : Number.MAX_SAFE_INTEGER;
    let lines = tailLines(this.logPath, this.tailReadBytes);
    if (lines.length < wanted) {
      // Backfill from the rotated generation (older lines first).
      const older = tailLines(`${this.logPath}.1`, this.tailReadBytes);
      if (older.length > 0) lines = older.concat(lines);
    }
    const tail = limit > 0 ? lines.slice(-limit) : lines;
    const out: ReapLogEntry[] = [];
    for (const line of tail) {
      try {
        out.push(this.normalizeEntry(JSON.parse(line) as Partial<ReapLogEntry>));
      } catch {
        // skip a corrupt/partial line rather than failing the whole read
      }
    }
    return out;
  }

  private normalizeEntry(entry: Partial<ReapLogEntry>): ReapLogEntry {
    // Whitelist the type — unknown types coerce to 'reaped' (legacy behavior),
    // but 'notify' and 'skipped' pass through (reap-notify spec R1.3: the new
    // type MUST survive normalization or notify records vanish on read).
    const type =
      entry.type === 'skipped' ? 'skipped' : entry.type === 'notify' ? 'notify' : 'reaped';
    const skipped = typeof entry.skipped === 'string' ? entry.skipped : undefined;
    const outcome =
      typeof entry.outcome === 'string' && NOTIFY_OUTCOMES.has(entry.outcome)
        ? (entry.outcome as ReapNotifyOutcome)
        : undefined;
    let disposition = entry.disposition;
    if (!disposition) {
      disposition =
        type === 'skipped'
          ? `skipped:${skipped ?? 'unknown'}`
          : type === 'notify'
            ? `notify:${outcome ?? 'unknown'}`
            : 'terminal';
    }

    const launchLane =
      entry.launchLane === 'headless' || entry.launchLane === 'rerouted-interactive'
        ? entry.launchLane
        : undefined;
    const workEvidence = Array.isArray(entry.workEvidence)
      ? entry.workEvidence.filter((v): v is string => typeof v === 'string')
      : undefined;

    return {
      ts: typeof entry.ts === 'string' ? entry.ts : new Date(0).toISOString(),
      type,
      session: typeof entry.session === 'string' ? entry.session : 'unknown',
      tmuxSession: typeof entry.tmuxSession === 'string' ? entry.tmuxSession : 'unknown',
      reason: typeof entry.reason === 'string' ? entry.reason : 'unknown',
      disposition,
      origin: entry.origin,
      skipped,
      machine: entry.machine,
      ...(launchLane ? { launchLane } : {}),
      ...(typeof entry.midWork === 'boolean' ? { midWork: entry.midWork } : {}),
      ...(workEvidence && workEvidence.length > 0 ? { workEvidence } : {}),
      ...(typeof entry.noticeId === 'string' ? { noticeId: entry.noticeId } : {}),
      ...(typeof entry.topicId === 'number' ? { topicId: entry.topicId } : {}),
      ...(outcome ? { outcome } : {}),
    };
  }
}

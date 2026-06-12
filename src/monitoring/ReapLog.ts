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
  /** Notify entries: the notice this outcome record belongs to. */
  noticeId?: string;
  /** Notify entries: the topic the notice targets (absent for lifeline-only). */
  topicId?: number;
  /** Notify entries: the outcome this record asserts. */
  outcome?: ReapNotifyOutcome;
}

export class ReapLog {
  private readonly logPath: string;
  private readonly machineId?: () => string | undefined;

  constructor(stateDir: string, machineId?: () => string | undefined) {
    this.logPath = path.join(stateDir, '..', 'logs', 'reap-log.jsonl');
    this.machineId = machineId;
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
    });
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

  private append(entry: ReapLogEntry): void {
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      fs.appendFileSync(this.logPath, JSON.stringify(entry) + '\n');
    } catch {
      // never throw from the audit sink
    }
  }

  /** Read the most-recent `limit` entries (newest last), tolerating partial/corrupt lines. */
  read(limit = 200): ReapLogEntry[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.logPath, 'utf-8');
    } catch {
      // @silent-fallback-ok — no log file yet means no reaps recorded; an empty
      // list is the correct answer, not a degraded one.
      return [];
    }
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
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

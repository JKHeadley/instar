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

export interface ReapLogEntry {
  ts: string;
  /** 'reaped' = a kill happened; 'skipped' = a terminate was refused/no-op. */
  type: 'reaped' | 'skipped';
  session: string;
  tmuxSession: string;
  /** The reason the killer requested (e.g. 'idle-zombie', 'age-limit'). */
  reason: string;
  /** What actually happened: terminal/recovery-bounce, or skipped:<authority-reason>. */
  disposition: 'terminal' | 'recovery-bounce' | `skipped:${string}`;
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
    const type = entry.type === 'skipped' ? 'skipped' : 'reaped';
    const skipped = typeof entry.skipped === 'string' ? entry.skipped : undefined;
    let disposition = entry.disposition;
    if (!disposition) {
      disposition = type === 'skipped'
        ? `skipped:${skipped ?? 'unknown'}`
        : 'terminal';
    }

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
    };
  }
}

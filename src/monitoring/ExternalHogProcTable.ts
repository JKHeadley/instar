/**
 * ExternalHogProcTable — the whole-table `ps` parser of the External-Hog sentinel
 * (CMT-1901, docs/specs/external-hog-zombie-autokill-sentinel.md §1).
 *
 * Parses the output of `ps -o pid=,ppid=,uid=,lstart=,time=,comm=` (no header) into rows the
 * sampler uses to build the ProcTree + the per-pid cumulative-CPU-time map. This parser is
 * LOAD-BEARING for kill eligibility (the CPU-delta pivots on `time=`), so it is REGISTERED in
 * SCRAPE_PARSERS with a captured realness fixture (§Testing) — it must survive the real
 * structural bytes: a `[dd-]hh:mm:ss` day-prefix time (the ~24h anchor case), an `lstart`
 * value with embedded spaces + space-padded day-of-month, a `comm` with embedded spaces, a
 * `<defunct>` row, and a short/permission-denied row.
 *
 * Fail-closed: a row whose pid/ppid/uid can't be parsed is SKIPPED (an unidentifiable process
 * is not a candidate); a row whose `time=` is malformed keeps the row but sets
 * `cputimeSeconds: undefined` → the CPU-delta yields UNKNOWN → alert-never-kill.
 */

import { parseProcTimeToSeconds } from '../core/SessionManager.js';

export interface ProcTableRow {
  readonly pid: number;
  readonly ppid: number;
  readonly uid: number;
  /** The `lstart` value (5 whitespace tokens joined) — an OPAQUE identity token (pid-reuse
   *  guard), never parsed as a date. */
  readonly startTime: string;
  /** Cumulative (user+system) CPU seconds from `time=`, or `undefined` if unparseable. */
  readonly cputimeSeconds: number | undefined;
  /** The command (last field; may contain spaces). Attacker-controllable — treated as data. */
  readonly comm: string;
}

/** A `time=` value: optional `dd-`, then `[[hh:]mm:]ss[.ff]` — at most TWO colon groups
 *  (`hh:mm:ss`). Bounded to the real ps format (the round-9 reviewer noted an unbounded
 *  `(\d+:)*` was cosmetically lax though unreachable via t[8]; this closes it, strictly toward
 *  fail-closed). */
const PROC_TIME_RE = /^(\d+-)?(\d+:){0,2}\d+(\.\d+)?$/;

/**
 * Parse `ps -o pid=,ppid=,uid=,lstart=,time=,comm=` output into rows. Column layout per line:
 *   pid ppid uid  <Dow Mon DD HH:MM:SS YYYY>  time  comm...
 * The first 3 fields are numeric, `lstart` is exactly 5 whitespace tokens (the space-padded
 * day-of-month collapses under a whitespace-run split), `time` is one token, and `comm` is the
 * remainder. Splitting on whitespace RUNS makes the space-padding and column alignment robust.
 */
export function parseProcTable(psOutput: string): ProcTableRow[] {
  if (typeof psOutput !== 'string') return [];
  const rows: ProcTableRow[] = [];
  for (const rawLine of psOutput.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const t = line.split(/\s+/);
    // Need pid ppid uid (3) + lstart (5) + time (1) + >=1 comm token = >=10 tokens.
    if (t.length < 10) continue;

    const pid = toPosInt(t[0]);
    const ppid = toInt(t[1]);
    const uid = toInt(t[2]);
    if (pid === null || ppid === null || uid === null) continue; // unidentifiable → skip

    const startTime = t.slice(3, 8).join(' ');
    const timeTok = t[8]!;
    const cputimeSeconds = PROC_TIME_RE.test(timeTok) ? parseProcTimeToSeconds(timeTok) : undefined;
    const comm = t.slice(9).join(' ');

    rows.push({ pid, ppid, uid, startTime, cputimeSeconds, comm });
  }
  return rows;
}

function toInt(s: string | undefined): number | null {
  if (s === undefined || !/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isInteger(n) ? n : null;
}

function toPosInt(s: string | undefined): number | null {
  const n = toInt(s);
  return n !== null && n > 0 ? n : null;
}

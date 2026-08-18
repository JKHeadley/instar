/**
 * StandDownAudit — the coalescing append-only audit sink for stand-down
 * transitions (spec: docs/specs/duplicate-session-standdown.md §Observability).
 *
 * WHY COALESCING IS LOAD-BEARING. A model that reacts to an exit-2 block by
 * retrying the call produces one blocked-call row per attempt. Left raw, a single
 * muzzled session writes thousands of near-identical rows and the JSONL stops
 * being readable evidence. The rule: the FIRST blocked/refused row per
 * (session, tool) lands, then every Nth, and the episode's terminal row carries
 * the true totals — so no count is ever lost, only the rows between.
 *
 * THE dryRun EXEMPTION. dryRun would-block rows are EXEMPT from coalescing. They
 * are the soak's false-positive evidence and the operator's flip criterion needs
 * the per-call context coalescing would drop. In enforce mode the episode
 * counters carry the totals, so the exemption costs nothing where it matters.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface StandDownAuditDeps {
  /** Agent home — `logs/standdown.jsonl` hangs off it. */
  stateDir: string;
  now?: () => number;
  /** Rotate when the file exceeds this many bytes (mirrors the reap-log bound). */
  maxBytes?: number;
  log?: (msg: string) => void;
}

/** Rows after the first that are dropped before another lands. */
const COALESCE_EVERY = 25;

export class StandDownAudit {
  readonly #deps: StandDownAuditDeps;
  readonly #now: () => number;
  readonly #maxBytes: number;
  /** (session::tool) → rows suppressed since the last emitted one. */
  #suppressed = new Map<string, number>();

  constructor(deps: StandDownAuditDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
    this.#maxBytes = deps.maxBytes ?? 5_000_000;
  }

  get logPath(): string { return path.join(this.#deps.stateDir, 'logs', 'standdown.jsonl'); }

  /** A lifecycle transition — never coalesced (they are rare and each is meaning). */
  transition(row: Record<string, unknown>): void {
    this.#append({ kind: 'transition', ...row });
  }

  /**
   * A blocked tool call or refused send. Coalesced in enforce mode, EXEMPT in
   * dryRun. `key` is the coalescing bucket — (session, tool) for blocks,
   * (session, topic) for refusals.
   */
  enforcement(row: {
    transition: 'blocked-call' | 'refused-send';
    sessionName: string;
    topicId?: number;
    tool?: string;
    dryRun: boolean;
    episodeId?: string;
    [k: string]: unknown;
  }): void {
    if (row.dryRun) {
      // The soak's evidence — every row lands, with its per-call context.
      this.#append({ kind: 'enforcement', ...row });
      return;
    }
    const key = `${row.sessionName}::${row.tool ?? row.topicId ?? '-'}`;
    const suppressed = this.#suppressed.get(key) ?? 0;
    if (suppressed === 0) {
      this.#suppressed.set(key, 1);
      this.#append({ kind: 'enforcement', ...row, coalesced: false });
      return;
    }
    if (suppressed % COALESCE_EVERY === 0) {
      // Exactly COALESCE_EVERY - 1 rows were dropped since the last emitted one
      // (this row itself emits). The docstring promises exact accounting, so the
      // number must be exact — an off-by-one in an audit invites distrust of the
      // rows that are right.
      this.#append({ kind: 'enforcement', ...row, coalesced: true, suppressedSinceLast: COALESCE_EVERY - 1 });
    }
    this.#suppressed.set(key, suppressed + 1);
  }

  /** Reset a bucket when its episode ends, so a later episode starts loud. */
  endEpisode(sessionName: string): void {
    for (const k of [...this.#suppressed.keys()]) if (k.startsWith(`${sessionName}::`)) this.#suppressed.delete(k);
  }

  /** Suppressed-row counts, for the terminal episode row + `GET /standdown`. */
  suppressedCounts(): Record<string, number> {
    return Object.fromEntries(this.#suppressed);
  }

  #append(row: Record<string, unknown>): void {
    try {
      const dir = path.dirname(this.logPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      try {
        const st = fs.statSync(this.logPath);
        if (st.size > this.#maxBytes) fs.renameSync(this.logPath, `${this.logPath}.1`);
      } catch { /* no file yet — nothing to rotate */ }
      fs.appendFileSync(this.logPath, `${JSON.stringify({ ts: new Date(this.#now()).toISOString(), ...row })}\n`, 'utf-8');
    } catch (err) {
      // Observability never endangers the observed.
      this.#deps.log?.(`[standdown-audit] append failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

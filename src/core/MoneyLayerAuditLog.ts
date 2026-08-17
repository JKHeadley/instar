/**
 * MoneyLayerAuditLog — the two audit channels of the money-layer enable surface
 * (docs/specs/money-layer-operator-enable-surface.md §7).
 *
 * TWO CHANNELS SHARING ONE FILE, DISTINGUISHED BY INTERFACE, NOT CONVENTION:
 *
 *  - `authority()` — enable/disable/mirror/freeze/unfreeze: writes that change
 *    what may spend. Carries authority fields.
 *  - `auditOnly()` — plan rendered, PIN attempt failed, probe result, state
 *    transition, restart requested/observed: a distinct handle offering ONLY
 *    `append` and `read`. No update, no delete, no rewrite — structurally
 *    ABSENT FROM THE TYPE rather than refused at runtime, and no authority
 *    fields. A caller holding one handle cannot reach the other (T14).
 *
 * Durability: a SINGLE process-local writer, serialized through one append
 * queue in the one server process the single-instance lock already guarantees,
 * issuing one `write()` per record to an `O_APPEND` descriptor. Cross-process
 * atomicity is NOT relied upon at all — `O_APPEND` atomicity for large records
 * is filesystem-dependent, and this design does not need it. Records are
 * size-bounded; an oversize record is truncated with an explicit marker rather
 * than split.
 *
 * TAMPER EVIDENCE IS OUT OF SCOPE, and that is a scope statement rather than an
 * oversight: append-only *by interface* is not append-only *on disk*. This is an
 * operator trust record against accident and against the agent — not a forensic
 * record against a local administrator, who is the operator.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Every row type, with its PRE-GATE readability declared here once (§2's
 * enumerated sensitivity table). Enumerated rather than described by category,
 * so a new row type must make a deliberate choice instead of inheriting one.
 */
export const MONEY_AUDIT_ROW_TYPES = {
  'plan-rendered': { channel: 'audit', pregate: true },
  'enable-committed': { channel: 'authority', pregate: true },
  'disable-committed': { channel: 'authority', pregate: true },
  'mirror-config-committed': { channel: 'authority', pregate: true },
  'enable-source-transition': { channel: 'audit', pregate: true },
  'lifecycle-transition': { channel: 'audit', pregate: true },
  'restart-requested': { channel: 'audit', pregate: true },
  'restart-initiated': { channel: 'audit', pregate: true },
  'restart-observed-ready': { channel: 'audit', pregate: true },
  'config-inspect': { channel: 'audit', pregate: true },
  // Freeze/unfreeze are AUTHORITY rows (they change what may spend) but are
  // partially pre-gate readable: an operator must be able to see WHY spending
  // stopped. Timing history is withheld — see redactForPregate().
  freeze: { channel: 'authority', pregate: 'redacted' },
  unfreeze: { channel: 'authority', pregate: 'redacted' },
  // Withheld pre-gate.
  'pin-attempt-failed': { channel: 'audit', pregate: false }, // attempt timing is an attack signal
  'caps-adjusted': { channel: 'authority', pregate: false },
  'door-armed': { channel: 'authority', pregate: false },
  'probe-result': { channel: 'audit', pregate: false }, // reveals enforcement timing
  spend: { channel: 'audit', pregate: false },
} as const;

export type MoneyAuditRowType = keyof typeof MONEY_AUDIT_ROW_TYPES;

export interface MoneyAuditRow {
  ts: string;
  type: MoneyAuditRowType;
  channel: 'authority' | 'audit';
  actor: string;
  detail: Record<string, unknown>;
}

/** Rows are size-bounded; an oversize record is TRUNCATED with a marker, never split. */
export const MAX_ROW_BYTES = 8 * 1024;

/** The append-only handle for non-authority records. `append` and `read` only — by TYPE. */
export interface AuditOnlyHandle {
  append(type: MoneyAuditRowType, actor: string, detail: Record<string, unknown>): void;
  read(limit?: number): MoneyAuditRow[];
}

/** The authority handle. Same append shape, but its rows change what may spend. */
export interface AuthorityHandle {
  append(type: MoneyAuditRowType, actor: string, detail: Record<string, unknown>): void;
  read(limit?: number): MoneyAuditRow[];
}

export class MoneyLayerAuditLog {
  private readonly filePath: string;
  private readonly now: () => number;
  /** The single process-local append queue — one write() per record, serialized. */
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: { stateDir: string; now?: () => number; filePath?: string }) {
    const stateSub = path.join(opts.stateDir, 'state');
    fs.mkdirSync(stateSub, { recursive: true });
    this.filePath = opts.filePath ?? path.join(stateSub, 'money-layer-audit.jsonl');
    this.now = opts.now ?? (() => Date.now());
  }

  path(): string {
    return this.filePath;
  }

  /**
   * The AUTHORITY handle. Appends are SYNCHRONOUS and THROW on failure, because
   * an authority write is coupled to a trusted append: money state never
   * changes without its record (§7). Freeze is the named exception and calls
   * `appendBestEffort` instead.
   */
  authority(): AuthorityHandle {
    return {
      append: (type, actor, detail) => this.appendSync(type, 'authority', actor, detail),
      read: (limit) => this.readAll(limit),
    };
  }

  /**
   * The AUDIT-ONLY handle. Structurally cannot write authority rows: the
   * channel is fixed to 'audit' here and the returned object exposes nothing
   * else (T14).
   */
  auditOnly(): AuditOnlyHandle {
    return {
      append: (type, actor, detail) => this.appendSync(type, 'audit', actor, detail),
      read: (limit) => this.readAll(limit),
    };
  }

  /**
   * FREEZE ONLY (§7's named exception): the marker write is authoritative and
   * proceeds; the audit row is best-effort. Refusing a freeze because its row
   * could not be written would let a logging failure disable the emergency
   * stop, which inverts the priority — stopping spend matters more than
   * recording that we stopped it.
   *
   * Returns TRUE when the row landed on the authoritative channel, FALSE when
   * the caller must tell the operator the record is PROVISIONAL.
   */
  appendBestEffort(type: MoneyAuditRowType, actor: string, detail: Record<string, unknown>): boolean {
    try {
      this.appendSync(type, 'authority', actor, detail);
      return true;
    } catch (err) {
      // @silent-fallback-ok: NOT silent — it logs the failure with full context
      // AND returns false so the caller tells the operator the record is
      // provisional. Degrading here is the deliberate priority inversion: a
      // logging failure must not disable the emergency stop.
      // Written to the ORDINARY server log, explicitly marked NON-AUTHORITATIVE.
      // It is not an audit-channel row and must never be presented as one.
      console.error(
        `[money-audit NON-AUTHORITATIVE] ${type} by ${actor} — audit append failed (${String(err)}); ` +
          `the freeze APPLIED and its record is provisional: ${JSON.stringify(detail)}`,
      );
      return false;
    }
  }

  /**
   * Flush the append queue. Called before the supervisor handoff, which is the
   * one point where an unflushed buffer would lose the evidence that the
   * operator asked for a restart (§4/§7).
   */
  async flush(): Promise<void> {
    await this.queue;
  }

  /**
   * Read every row, oldest-first. A truncated trailing line from an unclean
   * exit is SKIPPED with a logged warning rather than failing the whole log; no
   * record is ever rewritten to "repair" it.
   */
  readAll(limit?: number): MoneyAuditRow[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      // @silent-fallback-ok: an absent log is an empty history, not an error.
      return [];
    }
    const rows: MoneyAuditRow[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const row = JSON.parse(t) as MoneyAuditRow;
        if (typeof row?.type === 'string' && typeof row?.ts === 'string') rows.push(row);
      } catch {
        console.warn('[money-audit] skipping a malformed/truncated audit line (not repaired)');
      }
    }
    return typeof limit === 'number' && limit > 0 ? rows.slice(-limit) : rows;
  }

  private appendSync(type: MoneyAuditRowType, channel: 'authority' | 'audit', actor: string, detail: Record<string, unknown>): void {
    const declared = MONEY_AUDIT_ROW_TYPES[type];
    if (!declared) throw new Error(`unknown money audit row type '${type}'`);
    if (declared.channel !== channel) {
      // A caller holding one handle cannot write the other's rows (T14).
      throw new Error(`row type '${type}' belongs to the '${declared.channel}' channel, not '${channel}'`);
    }
    const row: MoneyAuditRow = { ts: new Date(this.now()).toISOString(), type, channel, actor, detail };
    let line = `${JSON.stringify(row)}\n`;
    if (Buffer.byteLength(line, 'utf-8') > MAX_ROW_BYTES) {
      const truncated: MoneyAuditRow = {
        ...row,
        detail: { truncated: true, note: 'record exceeded MAX_ROW_BYTES and was truncated rather than split' },
      };
      line = `${JSON.stringify(truncated)}\n`;
    }
    // One write() per record to an O_APPEND descriptor, then fsync — an
    // authority write's record must be durable before the write is reported.
    const fd = fs.openSync(this.filePath, 'a', 0o600);
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}

/**
 * Sensitivity filtering for a PRE-GATE reader, applied BEFORE pagination (§2).
 * Cursors over the result are opaque and encode no offset over the UNFILTERED
 * set — otherwise a pre-gate reader could infer the volume and timing of hidden
 * spend and freeze rows from gaps in the sequence, which is exactly the
 * information the split exists to withhold.
 */
export function filterRowsForPregate(rows: readonly MoneyAuditRow[]): MoneyAuditRow[] {
  const out: MoneyAuditRow[] = [];
  for (const row of rows) {
    const declared = MONEY_AUDIT_ROW_TYPES[row.type];
    if (!declared) continue; // an unknown row type is withheld, never leaked
    if (declared.pregate === true) out.push(row);
    else if (declared.pregate === 'redacted') out.push(redactForPregate(row));
  }
  return out;
}

/**
 * A freeze/unfreeze row as a pre-gate reader sees it: keyRef, caller and reason
 * — NO timestamp. A stop the operator cannot see the cause of is worse than one
 * they can; only freeze TIMING HISTORY stays withheld.
 */
export function redactForPregate(row: MoneyAuditRow): MoneyAuditRow {
  const d = row.detail ?? {};
  return {
    ...row,
    ts: '',
    detail: {
      keyRef: d.keyRef,
      caller: d.caller ?? row.actor,
      reason: d.reason,
      redacted: 'timing withheld pre-gate',
    },
  };
}

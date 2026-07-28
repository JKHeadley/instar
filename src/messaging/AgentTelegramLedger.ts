/**
 * AgentTelegramLedger — append-only audit trail for the agent-to-agent Telegram comms
 * primitive (spec MENTOR-LIVE-READINESS §Fix 2a "Round-trip audit ledger" + Codey's
 * round-2 design point: separate sent + received JSONLs so Stage-B forensics can
 * reconstruct the round trip from the ledger files alone, OR from Telegram chat history
 * alone via the visible `corr=` field).
 *
 * Conventions:
 * - Append-only JSONL (atomic at line granularity on POSIX for `<PIPE_BUF` writes —
 *   the same rationale the original mentor-outbox used; documented so a future reviewer
 *   doesn't "fix" it to atomicWriteFileSync, which is wrong for append).
 * - **No secrets in any row** (round-2 adversarial F5 — and the SendAuditRow shape
 *   explicitly excludes the bot token; the ReceiveAuditRow only captures routing-level
 *   marker fields, never the body).
 * - Default paths: `{stateDir}/a2a-sent.jsonl` + `{stateDir}/a2a-received.jsonl`. The
 *   caller may override (per-agent isolation, tests).
 *
 * I/O is the only side-effect; everything else is pure data.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { SendAuditRow, RouteDropReason } from './AgentTelegramComms.js';

/** Audit row written by the recipient wiring on every a2a event that was either routed
 *  to a role-handler or dropped. NO row is written when the message is `no-marker`
 *  (fall-through to normal user handling) — that would log every user message. */
export interface ReceiveAuditRow {
  localTs: string;
  direction: 'received';
  decision: 'routed' | 'dropped';
  /** When `dropped`, the reason code from the routing matrix (see RouteDropReason). */
  dropReason?: RouteDropReason | 'agent-marker-malformed';
  /** Parsed marker fields — present when the parse succeeded, undefined for malformed. */
  fromAgent?: string;
  toAgent?: string;
  role?: string;
  id?: string;
  corr?: string;
  ts?: number;
  /** Telegram-side identifiers, when resolved. */
  telegramFromBotId?: string;
  telegramSenderChatId?: string;
  topicId?: number;
  /** First 200 chars of the raw inbound (post-marker-strip on route; raw on drop) so
   *  forensic readers can reconstruct what happened from the ledger alone. NEVER the
   *  full body for routed rows — the body went to the role-handler. */
  rawPrefix?: string;
}

export interface AgentTelegramLedgerPaths {
  sentPath: string;
  receivedPath: string;
}

export function defaultLedgerPaths(stateDir: string): AgentTelegramLedgerPaths {
  return {
    sentPath: path.join(stateDir, 'a2a-sent.jsonl'),
    receivedPath: path.join(stateDir, 'a2a-received.jsonl'),
  };
}

/**
 * Append-only JSONL audit ledger. Both `appendSent` and `appendReceived` are synchronous
 * + best-effort: they NEVER throw (an audit-write failure must not crash a tick). Writes
 * use `fs.appendFileSync` because atomic-write-replace is wrong for append-only files
 * (see the documented rationale in the module header).
 */
export class AgentTelegramLedger {
  private readonly sentPath: string;
  private readonly receivedPath: string;

  constructor(paths: AgentTelegramLedgerPaths) {
    this.sentPath = paths.sentPath;
    this.receivedPath = paths.receivedPath;
  }

  appendSent(row: SendAuditRow): void {
    this.appendLine(this.sentPath, row);
  }

  appendReceived(row: ReceiveAuditRow): void {
    this.appendLine(this.receivedPath, row);
  }

  private appendLine(target: string, row: unknown): void {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.appendFileSync(target, JSON.stringify(row) + '\n', 'utf-8');
    } catch (err) {
      // Best-effort audit: an audit-write failure must not crash a tick. Log but swallow.
      // (Spec §Fix 2a "every drop path writes an audit row" — silent drops make Stage-B
      // forensics painful, but a CRASHED tick is worse. We accept this trade-off.)
      // eslint-disable-next-line no-console
      console.warn(`[a2a-ledger] append failed (non-fatal) at ${target}:`, err instanceof Error ? err.message : String(err));
    }
  }
}

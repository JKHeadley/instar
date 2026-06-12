/**
 * RemoteCloseAudit — the RELAYING machine's own record of every relayed
 * session-close order (REMOTE-SESSION-CLOSE-SPEC §2.3).
 *
 * The owning machine's reap-log is the authoritative record of the KILL; this
 * JSONL is the record of the ORDER. "A session must never disappear without a
 * trace naming where the order came from" must hold at BOTH ends — without
 * this, a compromised relayer's kill sweep leaves no local manifest.
 *
 * Append-only history; writes are best-effort (an audit hiccup must not block
 * the close path) but a failed append logs loudly — an auditless destructive
 * relay is worth a console line.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface RemoteCloseAuditEntry {
  ts: string;
  targetMachineId: string;
  targetNickname?: string;
  sessionUuid: string;
  sessionName?: string;
  /** What the relay observed: the peer's word, or the transport failure class.
   *  'unknown' = timeout (the peer may be mid-kill — delivery honesty). */
  outcome:
    | 'closed'
    | 'already-closed'
    | 'unreachable'
    | 'url-rejected'
    | 'unauthorized'
    | 'peer-error'
    | 'unknown';
  /** Peer HTTP status when one was received. */
  peerStatus?: number;
}

export class RemoteCloseAudit {
  private readonly filePath: string;

  constructor(stateDir: string, private readonly log: (msg: string) => void = console.log) {
    this.filePath = path.join(stateDir, '..', 'logs', 'remote-close-audit.jsonl');
  }

  record(entry: Omit<RemoteCloseAuditEntry, 'ts'>): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      /* state-registry: remote-close-audit */
      fs.appendFileSync(this.filePath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
    } catch (err) {
      // Loud, not silent: an unauditable destructive relay deserves a trace
      // even when the audit file itself is the thing failing.
      this.log(`[remote-close] AUDIT APPEND FAILED (order still relayed): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Read the tail (observability/tests). */
  read(limit = 100): RemoteCloseAuditEntry[] {
    try {
      const lines = fs.readFileSync(this.filePath, 'utf-8').trim().split('\n').filter(Boolean);
      return lines.slice(-limit).map((l) => JSON.parse(l) as RemoteCloseAuditEntry);
    } catch {
      // @silent-fallback-ok — absent/corrupt audit reads as empty history.
      return [];
    }
  }
}

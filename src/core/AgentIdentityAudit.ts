/**
 * AgentIdentityAudit — the durable, key-free record of everything that happens to this
 * machine's AGENT identity: mint refusals, adoption transitions (with the observed set
 * `k of n active` and the adoption mode), mirror repairs, CLI actions, and the §2 detector's
 * verdict transitions.
 *
 * Spec: docs/specs/a2a-single-agent-identity.md §1.2 (audit), §Observability.
 *
 * File: `<stateDir>/logs/agent-identity.jsonl` (machine-local; the pool-wide read is
 * `GET /agent-identity/audit?scope=pool`, which merges online machines' rows).
 *
 * NEVER KEY MATERIAL. Every row passes a byte-scan before it is written: any field that looks
 * like a key (`privateKey`, `sealed`, `publicKey`, a 32/44-char base64 value, a PEM block) is
 * refused and the row is replaced by a `redacted-row` marker naming the offending key, so a
 * careless caller cannot leak a key through the audit path. Fingerprints (32 hex) are fine.
 */

import fs from 'node:fs';
import path from 'node:path';

export const AGENT_IDENTITY_AUDIT_FILE = path.join('logs', 'agent-identity.jsonl');

export type AgentIdentityAuditEvent =
  | 'mint-refused'
  | 'posture-not-provisioned'
  | 'adoption-observe'
  | 'adoption-refused'
  | 'adoption-requested'
  | 'adoption-installed'
  | 'adoption-heartbeat'
  | 'adoption-escalated'
  | 'adoption-resolved'
  | 'identity-served'
  | 'identity-serve-refused'
  | 'identity-reloaded'
  | 'identity-lost'
  | 'mirror-repaired'
  | 'cli-adopt'
  | 'cli-init-standalone'
  | 'coherence-verdict'
  | 'coherence-item-raised'
  | 'coherence-item-resolved'
  | 'coherence-item-readopted'
  | 'coherence-cannot-tell-escalated';

export interface AgentIdentityAuditRow {
  ts: string;
  event: AgentIdentityAuditEvent;
  machineId?: string | null;
  [k: string]: unknown;
}

const FORBIDDEN_KEYS = /^(privateKey|privateKeyPem|secret|sealed|ciphertext|publicKey|key|seed|passphrase)$/i;
const BASE64_KEY_SHAPE = /^[A-Za-z0-9+/]{43}=?$|^[A-Za-z0-9+/]{86}==?$/;
const PEM_SHAPE = /-----BEGIN [A-Z ]*KEY-----/;

/** Return the first path that looks like key material, or null when the row is clean. */
export function findKeyMaterial(value: unknown, at = ''): string | null {
  if (typeof value === 'string') {
    if (PEM_SHAPE.test(value) || BASE64_KEY_SHAPE.test(value.trim())) return at || '<root>';
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return at || '<root>';
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const p = at ? `${at}.${k}` : k;
    if (FORBIDDEN_KEYS.test(k)) return p;
    const found = findKeyMaterial(v, p);
    if (found) return found;
  }
  return null;
}

export class AgentIdentityAudit {
  readonly filePath: string;
  private readonly now: () => Date;

  constructor(stateDir: string, deps: { now?: () => Date } = {}) {
    this.filePath = path.join(stateDir, AGENT_IDENTITY_AUDIT_FILE);
    this.now = deps.now ?? (() => new Date());
  }

  /** Append one row. Never throws: an audit write failure is logged, not fatal. */
  append(event: AgentIdentityAuditEvent, fields: Record<string, unknown> = {}): void {
    let row: AgentIdentityAuditRow = { ts: this.now().toISOString(), event, ...fields };
    const leak = findKeyMaterial(fields);
    if (leak) {
      row = { ts: row.ts, event, redacted: true, refusedField: leak, note: 'row refused: it carried key-shaped material' };
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, JSON.stringify(row) + '\n');
    } catch (err) {
      // @silent-fallback-ok: the audit is observability — a failed append must never take an
      // identity operation down. Logged so a broken audit is visible.
      console.warn(`[agent-identity] audit append failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Read the newest rows (bounded). `since` is an ISO lower bound on `ts`. */
  read(opts: { limit?: number; since?: string } = {}): AgentIdentityAuditRow[] {
    const limit = Math.max(1, Math.min(2000, opts.limit ?? 200));
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      // @silent-fallback-ok — no audit file yet (or unreadable) reads as zero rows; the read route reports the count honestly and never fabricates history.
      return [];
    }
    const sinceMs = opts.since ? Date.parse(opts.since) : NaN;
    const rows: AgentIdentityAuditRow[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as AgentIdentityAuditRow;
        if (Number.isFinite(sinceMs) && Date.parse(r.ts) < sinceMs) continue;
        rows.push(r);
      } catch {
        /* a torn last line is skipped */
      }
    }
    return rows.slice(-limit);
  }
}

/**
 * PasskeyNonceLedger — the receiver's durable record of every `passkey-cell` mandate nonce it has
 * seen (spec docs/specs/agent-held-google-passkey.md §3.2 / §3.3).
 *
 * Two states, written before acting:
 *   - `received`  — the nonce was accepted for processing; for a revoke the APPLIED CUTOFF (the
 *                   grant instances it covers) is written in the SAME atomic write, so a duplicate
 *                   or a re-signed copy re-applies that stored cutoff rather than recomputing it (a
 *                   later legitimate re-grant is never removed by a replay);
 *   - `applied`   — set only after the action's read-back succeeded. Only `applied` answers
 *                   "applied", so a duplicate from an outbox never looks like a failure.
 * A third state, `dismissed`, records an operator's PIN-gated dismissal of an unconfirmed revoke
 * request so re-delivery never re-raises it.
 *
 * Retention: ordinary nonces are pruned once past `expiresAt` plus skew; REVOKE nonces are kept at
 * least 60 days (a revoke is exempt from expiry and may be re-delivered for weeks).
 *
 * Machine-local BY DESIGN: `<stateDir>/state/passkey-nonces.json`, atomic writes, 0600.
 */
import fs from 'node:fs';
import path from 'node:path';

export const PASSKEY_NONCES_FILE = path.join('state', 'passkey-nonces.json');
export const REVOKE_NONCE_RETENTION_MS = 60 * 24 * 60 * 60_000;

export type NonceState = 'received' | 'applied' | 'dismissed';

export interface NonceRecord {
  nonce: string;
  op: string;
  /** `<canonicalEmail>@<targetMachineId>` — the cell the op addressed. */
  cellKey: string;
  issuerMachineId: string;
  state: NonceState;
  receivedAt: string;
  appliedAt?: string;
  dismissedAt?: string;
  /** Mandate expiry (ISO); drives pruning for non-revoke ops. */
  expiresAt: string;
  /** For a revoke: the cutoff applied on first acceptance (null = "every instance present"). */
  appliedCutoffSeq?: number | null;
  /** For a re-signed revoke: the nonce it replaces (deduplicated on it). */
  replacesNonce?: string;
}

interface LedgerFile { version: 1; nonces: Record<string, NonceRecord> }

export interface PasskeyNonceLedgerOptions { stateDir: string; now?: () => number }

export class PasskeyNonceLedger {
  private readonly file: string;
  private readonly now: () => number;

  constructor(opts: PasskeyNonceLedgerOptions) {
    this.file = path.join(opts.stateDir, PASSKEY_NONCES_FILE);
    this.now = opts.now ?? Date.now;
  }

  get(nonce: string): NonceRecord | null {
    const r = this.read().nonces[nonce];
    return r ? { ...r } : null;
  }

  has(nonce: string): boolean { return !!this.read().nonces[nonce]; }

  /**
   * Record a nonce as RECEIVED (with the revoke cutoff in the same write). Returns false when the
   * nonce — or, for a re-signed revoke, the nonce it replaces — was already seen (a replay).
   */
  receive(input: { nonce: string; op: string; cellKey: string; issuerMachineId: string; expiresAt: string; appliedCutoffSeq?: number | null; replacesNonce?: string }): { recorded: boolean; existing?: NonceRecord } {
    const data = this.read();
    const existing = data.nonces[input.nonce]
      ?? (input.replacesNonce ? Object.values(data.nonces).find((r) => r.nonce === input.replacesNonce || r.replacesNonce === input.replacesNonce) : undefined);
    if (existing) return { recorded: false, existing: { ...existing } };
    data.nonces[input.nonce] = {
      nonce: input.nonce, op: input.op, cellKey: input.cellKey, issuerMachineId: input.issuerMachineId,
      state: 'received', receivedAt: new Date(this.now()).toISOString(), expiresAt: input.expiresAt,
      ...(input.appliedCutoffSeq !== undefined ? { appliedCutoffSeq: input.appliedCutoffSeq } : {}),
      ...(input.replacesNonce ? { replacesNonce: input.replacesNonce } : {}),
    };
    this.write(data);
    return { recorded: true };
  }

  /** Flip to APPLIED after the read-back succeeded. Idempotent. */
  markApplied(nonce: string): boolean {
    const data = this.read();
    const r = data.nonces[nonce];
    if (!r) return false;
    if (r.state === 'applied') return true;
    r.state = 'applied';
    r.appliedAt = new Date(this.now()).toISOString();
    this.write(data);
    return true;
  }

  /** Operator dismissed an unconfirmed revoke request (PIN-gated by the caller). */
  dismiss(nonce: string): boolean {
    const data = this.read();
    const r = data.nonces[nonce];
    if (!r) return false;
    if (r.state === 'applied') return false; // an applied revoke cannot be un-applied by dismissal
    r.state = 'dismissed';
    r.dismissedAt = new Date(this.now()).toISOString();
    this.write(data);
    return true;
  }

  /** Revokes left `received` (crash between write and read-back) — the boot sweep finishes them. */
  receivedRevokes(): NonceRecord[] {
    return Object.values(this.read().nonces).filter((r) => r.op === 'revoke' && r.state === 'received').map((r) => ({ ...r }));
  }

  /** Prune: non-revoke nonces past expiry + skew; revoke nonces after 60 days from receipt. */
  prune(skewMs = 2 * 60_000): number {
    const data = this.read();
    const now = this.now();
    let removed = 0;
    for (const [k, r] of Object.entries(data.nonces)) {
      const isRevoke = r.op === 'revoke';
      const cutoff = isRevoke
        ? Date.parse(r.receivedAt) + REVOKE_NONCE_RETENTION_MS
        : Date.parse(r.expiresAt) + skewMs;
      if (Number.isFinite(cutoff) && now > cutoff) { delete data.nonces[k]; removed += 1; }
    }
    if (removed > 0) this.write(data);
    return removed;
  }

  private read(): LedgerFile {
    if (!fs.existsSync(this.file)) return { version: 1, nonces: {} };
    let parsed: Partial<LedgerFile>;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<LedgerFile>;
    } catch (err) {
      // A corrupt replay ledger FAILS CLOSED at the caller: with no readable ledger, no mandate can be
      // proven fresh, so verification refuses rather than treating an unknown nonce as new.
      throw new Error(`passkey-nonces-unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (parsed.version !== 1 || !parsed.nonces || typeof parsed.nonces !== 'object') throw new Error('passkey-nonces-unreadable: unexpected shape');
    return { version: 1, nonces: parsed.nonces };
  }

  private write(data: LedgerFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

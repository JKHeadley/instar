/**
 * PasskeyGrantStore — the machine-local authority record for agent-held Google passkeys
 * (spec docs/specs/agent-held-google-passkey.md §3.2).
 *
 * A grant authorizes mint + load for exactly ONE (account × machine) cell on THIS machine. No
 * wildcard. Authority is LOCAL: a grant exists here only because it was written here — by the
 * PIN route, by a verified `passkey-cell` mandate, or by a backup restore (subject to the revoke
 * high-water rule). Replicated copies elsewhere are display only.
 *
 * Every grant instance carries a monotonic `localSeq`. A revoke names the instances it covers by
 * sequence (`localSeq ≤ revokesGrantSeq`), never by clock, so a re-grant issued after the revoke
 * was signed survives it — unless the issuer did not know the target's sequence, in which case the
 * revoke covers every instance present when it is applied (restrictive; the operator re-grants).
 *
 * The revoke high-water mark (the largest `localSeq` ever revoked here) lives OUTSIDE the backup
 * manifest, under `<stateDir>/secrets/passkeys/revoke-hwm.json`, so a restore can never roll a
 * revoked grant back to life (§6).
 *
 * Machine-local BY DESIGN (§12, FD2): `<stateDir>/state/passkey-grants.json`, atomic writes, 0600.
 * No credential material is ever stored here — grants are authority, the credential lives in the
 * PasskeyCredentialStore.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export const PASSKEY_GRANTS_FILE = path.join('state', 'passkey-grants.json');
export const PASSKEY_REVOKE_HWM_FILE = path.join('secrets', 'passkeys', 'revoke-hwm.json');

export interface PasskeyGrant {
  /** Canonical (lower-cased, trimmed) account email. */
  canonicalEmail: string;
  /** The machine this grant authorizes — always THIS machine for a locally held grant. */
  machineId: string;
  /** The VERIFIED principal who granted (operator uid / issuer machine), never a content name. */
  grantedBy: string;
  grantedAt: string;
  /** Monotonic per-machine grant-instance sequence. */
  localSeq: number;
  /** How the grant arrived: the local PIN route, a verified passkey-cell mandate, or a restore. */
  origin: 'local-pin' | 'mandate' | 'restore';
  /** Google's creation timestamp for the passkey once known (names the entry for removal). */
  googleCreatedAt?: string;
  status: 'active' | 'revoked';
  revokedAt?: string;
  revokedBy?: string;
  /** The revoke nonce that covered this instance (audit link to the nonce ledger). */
  revokeNonce?: string;
}

/** A non-secret local copy of a grant THIS machine issued to a PEER (so a revoke can name it). */
export interface IssuedPeerGrant {
  canonicalEmail: string;
  targetMachineId: string;
  issuedAt: string;
  nonce: string;
  /** The target's `localSeq` once it acknowledged the grant. */
  targetLocalSeq?: number;
  googleCreatedAt?: string;
}

interface GrantsFile {
  version: 1;
  nextSeq: number;
  grants: PasskeyGrant[];
  issuedPeerGrants: IssuedPeerGrant[];
}

interface HighWaterFile { version: 1; revokedThroughSeq: number; updatedAt: string }

export interface PasskeyGrantStoreOptions {
  stateDir: string;
  machineId: string;
  now?: () => number;
}

export interface RevokeResult {
  /** Grant instances this revoke covered (status flipped to revoked). */
  covered: PasskeyGrant[];
  /** The cutoff actually applied (largest localSeq covered), for the nonce ledger's stored cutoff. */
  appliedCutoffSeq: number | null;
  /** True when no active instance existed — idempotent no-op. */
  nothingToRevoke: boolean;
}

export function canonicalEmail(value: string): string {
  return String(value ?? '').trim().toLowerCase();
}

export class PasskeyGrantStore {
  private readonly file: string;
  private readonly hwmFile: string;
  private readonly machineId: string;
  private readonly now: () => number;

  constructor(opts: PasskeyGrantStoreOptions) {
    this.file = path.join(opts.stateDir, PASSKEY_GRANTS_FILE);
    this.hwmFile = path.join(opts.stateDir, PASSKEY_REVOKE_HWM_FILE);
    this.machineId = opts.machineId;
    this.now = opts.now ?? Date.now;
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  list(): PasskeyGrant[] { return this.read().grants.map((g) => ({ ...g })); }

  /** The ACTIVE grant for a cell on this machine, or null. */
  get(email: string): PasskeyGrant | null {
    const key = canonicalEmail(email);
    const g = this.read().grants.find((x) => x.canonicalEmail === key && x.machineId === this.machineId && x.status === 'active');
    return g ? { ...g } : null;
  }

  has(email: string): boolean { return this.get(email) !== null; }

  listIssuedPeerGrants(): IssuedPeerGrant[] { return this.read().issuedPeerGrants.map((g) => ({ ...g })); }

  /** The largest localSeq ever revoked on this machine (0 when none). */
  revokeHighWater(): number {
    try {
      if (!fs.existsSync(this.hwmFile)) return 0;
      const parsed = JSON.parse(fs.readFileSync(this.hwmFile, 'utf8')) as Partial<HighWaterFile>;
      return Number.isSafeInteger(parsed.revokedThroughSeq) ? (parsed.revokedThroughSeq as number) : 0;
    } catch {
      // @silent-fallback-ok — an unreadable high-water file is treated as 0; the marker only ever
      // RAISES the bar on a restore, and a missing bar is the same as a fresh machine. Logged by
      // the caller that surfaces restore verdicts, never decided from here.
      return 0;
    }
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  /**
   * Grant the cell (email × THIS machine). Exactly one ACTIVE instance per cell: an existing active
   * grant is returned unchanged (idempotent); a previously revoked cell gets a NEW instance with a
   * fresh, higher `localSeq` — which is what lets a later legitimate re-grant survive an older revoke.
   */
  grant(input: { email: string; grantedBy: string; origin: PasskeyGrant['origin']; googleCreatedAt?: string }): { grant: PasskeyGrant; created: boolean } {
    const key = canonicalEmail(input.email);
    if (!key) throw new Error('passkey-grant-email-required');
    const grantedBy = String(input.grantedBy ?? '').trim();
    if (!grantedBy) throw new Error('passkey-grant-principal-required');
    const data = this.read();
    const existing = data.grants.find((g) => g.canonicalEmail === key && g.machineId === this.machineId && g.status === 'active');
    if (existing) return { grant: { ...existing }, created: false };
    const grant: PasskeyGrant = {
      canonicalEmail: key,
      machineId: this.machineId,
      grantedBy,
      grantedAt: new Date(this.now()).toISOString(),
      localSeq: data.nextSeq,
      origin: input.origin,
      ...(input.googleCreatedAt ? { googleCreatedAt: String(input.googleCreatedAt) } : {}),
      status: 'active',
    };
    data.nextSeq += 1;
    data.grants.push(grant);
    this.write(data);
    return { grant: { ...grant }, created: true };
  }

  /** Record Google's creation timestamp on the active grant once the mint reports it. */
  setGoogleCreatedAt(email: string, googleCreatedAt: string): boolean {
    const key = canonicalEmail(email);
    const data = this.read();
    const g = data.grants.find((x) => x.canonicalEmail === key && x.machineId === this.machineId && x.status === 'active');
    if (!g) return false;
    g.googleCreatedAt = String(googleCreatedAt);
    this.write(data);
    return true;
  }

  /**
   * Revoke the cell's grant instances with `localSeq ≤ cutoffSeq`. With `cutoffSeq` absent the
   * revoke covers EVERY instance present now (the issuer did not know the target's sequence —
   * restrictive by design). Raises the revoke high-water mark. Idempotent.
   */
  revoke(input: { email: string; revokedBy: string; nonce: string; cutoffSeq?: number | null }): RevokeResult {
    const key = canonicalEmail(email(input.email));
    const revokedBy = String(input.revokedBy ?? '').trim();
    if (!revokedBy) throw new Error('passkey-revoke-principal-required');
    const data = this.read();
    const cutoff = Number.isSafeInteger(input.cutoffSeq) ? (input.cutoffSeq as number) : null;
    const covered: PasskeyGrant[] = [];
    const at = new Date(this.now()).toISOString();
    for (const g of data.grants) {
      if (g.canonicalEmail !== key || g.machineId !== this.machineId || g.status !== 'active') continue;
      if (cutoff !== null && g.localSeq > cutoff) continue;
      g.status = 'revoked';
      g.revokedAt = at;
      g.revokedBy = revokedBy;
      g.revokeNonce = String(input.nonce);
      covered.push({ ...g });
    }
    if (covered.length === 0) return { covered: [], appliedCutoffSeq: null, nothingToRevoke: true };
    const appliedCutoffSeq = Math.max(...covered.map((g) => g.localSeq));
    this.write(data);
    this.raiseHighWater(appliedCutoffSeq);
    return { covered, appliedCutoffSeq, nothingToRevoke: false };
  }

  /** Keep a local, non-secret copy of a grant issued to a peer (so a revoke can always name it). */
  recordIssuedPeerGrant(entry: IssuedPeerGrant): void {
    const data = this.read();
    const key = canonicalEmail(entry.canonicalEmail);
    const idx = data.issuedPeerGrants.findIndex((g) => g.canonicalEmail === key && g.targetMachineId === entry.targetMachineId);
    const row: IssuedPeerGrant = { ...entry, canonicalEmail: key };
    if (idx >= 0) data.issuedPeerGrants[idx] = { ...data.issuedPeerGrants[idx], ...row };
    else data.issuedPeerGrants.push(row);
    this.write(data);
  }

  /** Drop a peer-grant copy once the peer's revoke is applied and acknowledged. */
  forgetIssuedPeerGrant(email: string, targetMachineId: string): boolean {
    const data = this.read();
    const key = canonicalEmail(email);
    const before = data.issuedPeerGrants.length;
    data.issuedPeerGrants = data.issuedPeerGrants.filter((g) => !(g.canonicalEmail === key && g.targetMachineId === targetMachineId));
    if (data.issuedPeerGrants.length === before) return false;
    this.write(data);
    return true;
  }

  /**
   * Restore-time guard (§6): a grant carried in from a backup with `localSeq` at or below the local
   * revoke high-water mark is DROPPED — the revoke outlives the restore. Returns what was kept.
   */
  admitRestoredGrants(candidates: PasskeyGrant[]): { kept: PasskeyGrant[]; dropped: PasskeyGrant[] } {
    const hwm = this.revokeHighWater();
    const data = this.read();
    const kept: PasskeyGrant[] = [];
    const dropped: PasskeyGrant[] = [];
    for (const c of candidates) {
      if (c.machineId !== this.machineId || c.status !== 'active' || !Number.isSafeInteger(c.localSeq) || c.localSeq <= hwm) { dropped.push(c); continue; }
      if (data.grants.some((g) => g.canonicalEmail === c.canonicalEmail && g.machineId === this.machineId && g.status === 'active')) { dropped.push(c); continue; }
      const row: PasskeyGrant = { ...c, canonicalEmail: canonicalEmail(c.canonicalEmail), origin: 'restore' };
      data.grants.push(row);
      data.nextSeq = Math.max(data.nextSeq, row.localSeq + 1);
      kept.push(row);
    }
    if (kept.length > 0) this.write(data);
    return { kept, dropped };
  }

  // ── File I/O ──────────────────────────────────────────────────────────────

  private read(): GrantsFile {
    if (!fs.existsSync(this.file)) return { version: 1, nextSeq: 1, grants: [], issuedPeerGrants: [] };
    let parsed: Partial<GrantsFile>;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<GrantsFile>;
    } catch (err) {
      // A corrupt authority file FAILS CLOSED: no grants are readable, and no write may clobber it.
      throw new Error(`passkey-grants-unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (parsed.version !== 1 || !Array.isArray(parsed.grants)) throw new Error('passkey-grants-unreadable: unexpected shape');
    return {
      version: 1,
      nextSeq: Number.isSafeInteger(parsed.nextSeq) && (parsed.nextSeq as number) > 0 ? (parsed.nextSeq as number) : 1 + Math.max(0, ...parsed.grants.map((g) => Number(g.localSeq) || 0)),
      grants: parsed.grants,
      issuedPeerGrants: Array.isArray(parsed.issuedPeerGrants) ? parsed.issuedPeerGrants : [],
    };
  }

  private write(data: GrantsFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* @silent-fallback-ok — mode was set at create; a chmod race on an already-0600 file changes nothing */ }
  }

  private raiseHighWater(seq: number): void {
    const current = this.revokeHighWater();
    if (seq <= current) return;
    fs.mkdirSync(path.dirname(this.hwmFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.hwmFile}.${process.pid}.tmp`;
    const body: HighWaterFile = { version: 1, revokedThroughSeq: seq, updatedAt: new Date(this.now()).toISOString() };
    fs.writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.hwmFile);
  }

  /** Test/maintenance helper: remove the store files through the audited fs funnel. */
  static removeFiles(stateDir: string): void {
    for (const rel of [PASSKEY_GRANTS_FILE, PASSKEY_REVOKE_HWM_FILE]) {
      const p = path.join(stateDir, rel);
      if (fs.existsSync(p)) SafeFsExecutor.safeUnlinkSync(p, { operation: 'PasskeyGrantStore.removeFiles' });
    }
  }
}

function email(value: string): string { return String(value ?? ''); }

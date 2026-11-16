import { createHash, randomBytes } from 'node:crypto';

/**
 * DashboardSessionStore (docs/specs/dashboard-scoped-session-token.md, SEC-002b).
 *
 * The dashboard's PRIMARY bearer after a PIN unlock: a short-lived, revocable, OPAQUE session token
 * issued in place of the agent's master API token. The security properties live here as SERVER-SIDE
 * state keyed by the (hashed) token — never in signed claims a holder could alter:
 *
 *   - **Per-token TTL** (`ttlMs`): a token is valid for a bounded window; the client refreshes before
 *     it lapses so a live session never drops.
 *   - **Absolute lifetime cap** (`absoluteMaxMs`): refresh is refused once the FAMILY passes its
 *     absolute deadline (set at the original unlock), so a stolen token cannot slide itself forward
 *     forever — "expires" actually bounds a thief.
 *   - **Session family**: every token refreshed from one unlock shares a `familyId`; `revokeFamily`
 *     (owner logout), token rotation and the absolute cap invalidate the whole family at once, so a
 *     thief's independently-refreshed successor dies too.
 *   - **Invalidation listeners**: open WS/SSE connections register a listener and are closed the
 *     moment their family is invalidated (a connection authenticated at connect-time must not outlive
 *     revocation).
 *
 * Tokens are opaque random bytes, stored only as a SHA-256 digest. Clock-injected for tests.
 */

export interface DashboardSessionStoreOptions {
  now?: () => number;
  /** Per-token validity window. Default 24h. */
  ttlMs?: number;
  /** Absolute family lifetime from the original unlock. Default 7 days. Refresh refused past it. */
  absoluteMaxMs?: number;
  /** Hard cap on tracked tokens (bounded state on a public endpoint). Default 512. */
  maxTokens?: number;
}

export interface DashboardSessionToken {
  token: string;
  expiresAt: string;
  familyId: string;
  familyExpiresAt: string;
}

interface TokenEntry { familyId: string; expiresAtMs: number; }
interface FamilyEntry { absoluteMaxMs: number; revoked: boolean; }

export class DashboardSessionStore {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly absoluteMaxMs: number;
  private readonly maxTokens: number;
  private readonly tokens = new Map<string, TokenEntry>();
  private readonly families = new Map<string, FamilyEntry>();
  /** familyId → set of listeners to call when the family is invalidated (open streams close). */
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(options: DashboardSessionStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60_000;
    this.absoluteMaxMs = options.absoluteMaxMs ?? 7 * 24 * 60 * 60_000;
    this.maxTokens = options.maxTokens ?? 512;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 60_000) throw new Error('dashboard-session-invalid-ttl');
    if (!Number.isSafeInteger(this.absoluteMaxMs) || this.absoluteMaxMs < this.ttlMs) throw new Error('dashboard-session-invalid-absolute');
    if (!Number.isSafeInteger(this.maxTokens) || this.maxTokens < 1 || this.maxTokens > 8192) throw new Error('dashboard-session-invalid-capacity');
  }

  /** Mint the FIRST token of a new family (called on a successful PIN unlock). */
  issue(): DashboardSessionToken {
    this.prune();
    const familyId = randomBytes(16).toString('hex');
    const absoluteMaxMs = this.now() + this.absoluteMaxMs;
    this.families.set(familyId, { absoluteMaxMs, revoked: false });
    return this.mint(familyId, absoluteMaxMs);
  }

  /** Verify a bearer is a live session token: exists, not expired, family not revoked, within the cap. */
  verify(token: string | undefined): boolean {
    const e = this.lookup(token);
    return e !== null;
  }

  /** Exchange a still-valid token for a fresh successor in the same family. Returns null if the token
   *  is invalid OR the family has passed its absolute cap (then the PIN is required again). */
  refresh(token: string | undefined): DashboardSessionToken | null {
    const e = this.lookup(token);
    if (!e) return null;
    const fam = this.families.get(e.familyId);
    if (!fam || fam.revoked) return null;
    if (this.now() >= fam.absoluteMaxMs) return null; // absolute cap: no indefinite sliding
    // consume the presented token, mint a successor
    this.tokens.delete(this.digest(token as string));
    return this.mint(e.familyId, fam.absoluteMaxMs);
  }

  /** Invalidate the WHOLE family of a token (owner logout). Closes its open streams. */
  revokeFamily(token: string | undefined): void {
    const key = token ? this.digest(token) : null;
    const entry = key ? this.tokens.get(key) : undefined;
    if (!entry) return;
    this.invalidateFamily(entry.familyId);
  }

  /** Invalidate EVERY family (PIN rotation / shutdown). Closes all open streams. */
  revokeAll(): void {
    for (const familyId of [...this.families.keys()]) this.invalidateFamily(familyId);
    this.tokens.clear();
    this.families.clear();
  }

  /** Register a listener fired when THIS token's family is invalidated (for an open WS/SSE). Returns
   *  an unregister function. If the token is already invalid, the listener fires immediately. */
  onFamilyInvalidated(token: string | undefined, listener: () => void): () => void {
    const e = this.lookup(token);
    if (!e) { try { listener(); } catch { /* listener errors never propagate */ } return () => {}; }
    let set = this.listeners.get(e.familyId);
    if (!set) { set = new Set(); this.listeners.set(e.familyId, set); }
    set.add(listener);
    return () => { set!.delete(listener); if (set!.size === 0) this.listeners.delete(e.familyId); };
  }

  size(): number { return this.tokens.size; }

  private mint(familyId: string, absoluteMaxMs: number): DashboardSessionToken {
    while (this.tokens.size >= this.maxTokens) {
      const oldest = this.tokens.keys().next().value as string | undefined;
      if (!oldest) break;
      this.tokens.delete(oldest);
    }
    // `dst_` prefix so authMiddleware routes it to the dashboard-session branch (like `mps_` for
    // memory sessions) and never tries the master-token compare against it.
    const token = 'dst_' + randomBytes(32).toString('base64url');
    // a token never outlives its family's absolute cap
    const expiresAtMs = Math.min(this.now() + this.ttlMs, absoluteMaxMs);
    this.tokens.set(this.digest(token), { familyId, expiresAtMs });
    return {
      token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      familyId,
      familyExpiresAt: new Date(absoluteMaxMs).toISOString(),
    };
  }

  /** Returns the token entry iff the token is live (not expired, family present + not revoked + within cap). */
  private lookup(token: string | undefined): TokenEntry | null {
    if (!token || token.length > 256) return null;
    const key = this.digest(token);
    const e = this.tokens.get(key);
    if (!e) return null;
    const now = this.now();
    if (e.expiresAtMs <= now) { this.tokens.delete(key); return null; }
    const fam = this.families.get(e.familyId);
    if (!fam || fam.revoked || now >= fam.absoluteMaxMs) { this.tokens.delete(key); return null; }
    return e;
  }

  private invalidateFamily(familyId: string): void {
    const fam = this.families.get(familyId);
    if (fam) fam.revoked = true;
    for (const [key, e] of this.tokens) if (e.familyId === familyId) this.tokens.delete(key);
    const set = this.listeners.get(familyId);
    if (set) {
      for (const l of [...set]) { try { l(); } catch { /* never propagate */ } }
      this.listeners.delete(familyId);
    }
  }

  private prune(): void {
    const now = this.now();
    for (const [key, e] of this.tokens) {
      const fam = this.families.get(e.familyId);
      if (e.expiresAtMs <= now || !fam || fam.revoked || now >= fam.absoluteMaxMs) this.tokens.delete(key);
    }
    for (const [familyId, fam] of this.families) {
      if (now >= fam.absoluteMaxMs || fam.revoked) {
        let anyToken = false;
        for (const e of this.tokens.values()) if (e.familyId === familyId) { anyToken = true; break; }
        if (!anyToken) { this.families.delete(familyId); this.listeners.delete(familyId); }
      }
    }
  }

  private digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}

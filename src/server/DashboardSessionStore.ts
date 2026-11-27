import { createHash, randomBytes } from 'node:crypto';

/**
 * DashboardSessionStore (docs/specs/dashboard-scoped-session-token.md, SEC-002b;
 * revocation completeness: docs/specs/dashboard-scoped-session-revocation.md, SEC-044 + SEC-045).
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
 *     (owner logout), token rotation and the absolute cap invalidate the whole family at once.
 *   - **Invalidation listeners**: open WS/SSE connections register a listener and are closed the
 *     moment their family is invalidated (a connection authenticated at connect-time must not outlive
 *     revocation).
 *
 * Revocation-completeness invariant (SEC-045): *while a family is alive, every token digest ever
 * issued in it resolves to that family, and the family's streams close no later than its deadline.*
 * Held by:
 *   - **Strict reuse detection**: refresh of an already-CONSUMED (tombstoned) token is treated as a
 *     fork and invalidates the whole family (standard refresh-token rotation). No idempotency window —
 *     it would hand the live successor to a thief and let it shadow the rotation chain.
 *   - **Tombstone on EVERY live-map removal while the family lives** (consume / TTL-expiry /
 *     capacity-eviction), so the owner's `revokeFamily(oldToken)` still resolves the family even if
 *     their unconsumed token expired or was evicted.
 *   - **Bounded memory**: a per-family tombstone cap (fail-safe `invalidateFamily` of the OFFENDING
 *     family on breach, never a global "heaviest") and a live-family COUNT cap bound aggregate state.
 *   - **Scheduled deadline enforcement**: `prune()` is public and the server runs it on a timer so a
 *     family's streams close at its deadline without waiting for the next unlock.
 *
 * Tokens are opaque random bytes, stored only as a SHA-256 digest. Clock-injected for tests.
 */

export interface DashboardSessionStoreOptions {
  now?: () => number;
  /** Per-token validity window. Default 24h. */
  ttlMs?: number;
  /** Absolute family lifetime from the original unlock. Default 7 days. Refresh refused past it. */
  absoluteMaxMs?: number;
  /** Hard cap on tracked LIVE tokens (bounded state on a public endpoint). Default 512. */
  maxTokens?: number;
  /** Max tombstones a single family may accrue before a fail-safe invalidation. Default 8×maxTokens. */
  perFamilyTombstoneCap?: number;
  /** Max concurrent live families; a new unlock past this invalidates the OLDEST. Default maxTokens. */
  maxFamilies?: number;
}

export interface DashboardSessionToken {
  token: string;
  expiresAt: string;
  familyId: string;
  familyExpiresAt: string;
}

interface TokenEntry { familyId: string; expiresAtMs: number; }
interface FamilyEntry { absoluteMaxMs: number; revoked: boolean; tombstones: number; }

export class DashboardSessionStore {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly absoluteMaxMs: number;
  private readonly maxTokens: number;
  private readonly perFamilyTombstoneCap: number;
  private readonly maxFamilies: number;
  private readonly tokens = new Map<string, TokenEntry>();
  private readonly families = new Map<string, FamilyEntry>();
  /** digest → familyId of a SPENT token (tombstone): powers strict reuse detection + old-token revoke. */
  private readonly consumed = new Map<string, string>();
  /** familyId → set of listeners to call when the family is invalidated (open streams close). */
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(options: DashboardSessionStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60_000;
    this.absoluteMaxMs = options.absoluteMaxMs ?? 7 * 24 * 60 * 60_000;
    this.maxTokens = options.maxTokens ?? 512;
    this.perFamilyTombstoneCap = options.perFamilyTombstoneCap ?? 8 * this.maxTokens;
    this.maxFamilies = options.maxFamilies ?? this.maxTokens;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 60_000) throw new Error('dashboard-session-invalid-ttl');
    if (!Number.isSafeInteger(this.absoluteMaxMs) || this.absoluteMaxMs < this.ttlMs) throw new Error('dashboard-session-invalid-absolute');
    if (!Number.isSafeInteger(this.maxTokens) || this.maxTokens < 1 || this.maxTokens > 8192) throw new Error('dashboard-session-invalid-capacity');
    if (!Number.isSafeInteger(this.perFamilyTombstoneCap) || this.perFamilyTombstoneCap < 1) throw new Error('dashboard-session-invalid-tombstone-cap');
    if (!Number.isSafeInteger(this.maxFamilies) || this.maxFamilies < 1 || this.maxFamilies > 8192) throw new Error('dashboard-session-invalid-family-cap');
  }

  /** Mint the FIRST token of a new family (called on a successful PIN unlock). */
  issue(): DashboardSessionToken {
    this.prune();
    // Family-COUNT bound: a new unlock past the cap invalidates (and drops) the OLDEST family,
    // closing its streams. Bounds aggregate memory that per-family caps alone do not.
    while (this.families.size >= this.maxFamilies) {
      const oldest = this.families.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.invalidateFamily(oldest);
      this.families.delete(oldest);
      this.listeners.delete(oldest);
    }
    const familyId = randomBytes(16).toString('hex');
    const absoluteMaxMs = this.now() + this.absoluteMaxMs;
    this.families.set(familyId, { absoluteMaxMs, revoked: false, tombstones: 0 });
    return this.mint(familyId, absoluteMaxMs);
  }

  /** Verify a bearer is a live session token: exists, not expired, family not revoked, within the cap. */
  verify(token: string | undefined): boolean {
    return this.lookup(token) !== null;
  }

  /** Exchange a still-valid token for a fresh successor in the same family.
   *  STRICT reuse detection: a re-presented CONSUMED token invalidates the whole family and returns
   *  null (standard refresh-token rotation — no idempotency window). Returns null for an invalid token
   *  or a family past its absolute cap (PIN required again). */
  refresh(token: string | undefined): DashboardSessionToken | null {
    const key = token ? this.digest(token) : null;
    // Strict reuse: the token was already spent → fork → kill the family.
    if (key) {
      const tombstonedFamily = this.consumed.get(key);
      if (tombstonedFamily !== undefined) { this.invalidateFamily(tombstonedFamily); return null; }
    }
    const e = this.lookup(token);
    if (!e || !key) return null;
    const fam = this.families.get(e.familyId);
    if (!fam || fam.revoked || this.now() >= fam.absoluteMaxMs) return null;
    // Consume the presented token: remove it from the live map and tombstone it (its family is alive),
    // so the anchor survives and a later re-presentation is caught as reuse.
    this.tokens.delete(key);
    this.tombstone(key, e.familyId, fam);
    // Per-family cap checked BEFORE minting: a breach invalidates THIS (offending) family and mints
    // nothing, so a refresh never returns a token this same call then revokes.
    if (fam.tombstones > this.perFamilyTombstoneCap) { this.invalidateFamily(e.familyId); return null; }
    return this.mint(e.familyId, fam.absoluteMaxMs);
  }

  /** Invalidate the WHOLE family of a token (owner logout). Resolves the family via the LIVE map OR
   *  the tombstone, so a logout with an already-consumed/expired/evicted token still ends the family. */
  revokeFamily(token: string | undefined): void {
    const key = token ? this.digest(token) : null;
    if (!key) return;
    const familyId = this.tokens.get(key)?.familyId ?? this.consumed.get(key);
    if (familyId === undefined) return;
    this.invalidateFamily(familyId);
  }

  /** Invalidate EVERY family (PIN rotation / shutdown). Closes all open streams. */
  revokeAll(): void {
    for (const familyId of [...this.families.keys()]) this.invalidateFamily(familyId);
    this.tokens.clear();
    this.families.clear();
    this.consumed.clear();
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

  /**
   * identity-security-piece1c: the family a live token belongs to, so the owner-PIN budget is keyed
   * on the family (a refresh mints a new token in the same family and must not grant fresh guesses).
   */
  familyIdForToken(token: string | undefined): string | null {
    if (!token) return null;
    const e = this.tokens.get(this.digest(token));
    return e ? e.familyId : null;
  }

  /** True iff the token's FAMILY is still alive — resolved via the LIVE map OR a tombstone, so a stream
   *  whose token merely ROTATED (the old token is now consumed, but the family lives) is NOT closed.
   *  This is the per-delivery stream-liveness check: `verify()` (live-token-only) would over-close a
   *  healthy stream every refresh cycle; this closes a stream only when its family is actually revoked
   *  or past its absolute deadline. */
  familyLiveForToken(token: string | undefined): boolean {
    if (!token || token.length > 256) return false;
    const key = this.digest(token);
    const familyId = this.tokens.get(key)?.familyId ?? this.consumed.get(key);
    if (familyId === undefined) return false;
    const fam = this.families.get(familyId);
    return !!fam && !fam.revoked && this.now() < fam.absoluteMaxMs;
  }

  size(): number { return this.tokens.size; }
  /** Live tombstone count — test/observability only. */
  tombstoneCount(): number { return this.consumed.size; }
  /** Live family count — test/observability only. */
  familyCount(): number { return this.families.size; }

  /** Public so the server can run it on a timer (scheduled deadline enforcement): a family past its
   *  absolute cap is invalidated (streams closed) and dropped without waiting for the next unlock. */
  prune(): void {
    const now = this.now();
    // Expire live tokens; tombstone those whose family is still alive (keep the revocation anchor).
    for (const [key, e] of this.tokens) {
      const fam = this.families.get(e.familyId);
      if (!fam || fam.revoked || now >= fam.absoluteMaxMs) { this.tokens.delete(key); continue; }
      if (e.expiresAtMs <= now) { this.tokens.delete(key); this.tombstone(key, e.familyId, fam); }
    }
    // Families past their absolute deadline: invalidate (close streams) THEN drop. Also clean up
    // already-revoked families whose state is no longer needed.
    for (const [familyId, fam] of this.families) {
      if (now >= fam.absoluteMaxMs && !fam.revoked) this.invalidateFamily(familyId);
      if (fam.revoked || now >= fam.absoluteMaxMs) {
        for (const [key, fid] of this.consumed) if (fid === familyId) this.consumed.delete(key);
        this.families.delete(familyId);
        this.listeners.delete(familyId);
      }
    }
    // Drop orphan tombstones whose family is gone.
    for (const [key, fid] of this.consumed) if (!this.families.has(fid)) this.consumed.delete(key);
  }

  private mint(familyId: string, absoluteMaxMs: number): DashboardSessionToken {
    while (this.tokens.size >= this.maxTokens) {
      const oldest = this.tokens.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const evicted = this.tokens.get(oldest)!;
      this.tokens.delete(oldest);
      // Tombstone the capacity-evicted token if its family is still alive, so revocation keeps working.
      const ef = this.families.get(evicted.familyId);
      if (ef && !ef.revoked && this.now() < ef.absoluteMaxMs) this.tombstone(oldest, evicted.familyId, ef);
    }
    // `dst_` prefix so authMiddleware routes it to the dashboard-session branch (like `mps_` for
    // memory sessions) and never tries the master-token compare against it.
    const token = 'dst_' + randomBytes(32).toString('base64url');
    const expiresAtMs = Math.min(this.now() + this.ttlMs, absoluteMaxMs);
    this.tokens.set(this.digest(token), { familyId, expiresAtMs });
    return {
      token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      familyId,
      familyExpiresAt: new Date(absoluteMaxMs).toISOString(),
    };
  }

  /** Record a spent digest as a tombstone of its family (idempotent); bumps the family's count. */
  private tombstone(digest: string, familyId: string, fam: FamilyEntry): void {
    if (this.consumed.has(digest)) return;
    this.consumed.set(digest, familyId);
    fam.tombstones++;
  }

  /** Returns the token entry iff the token is live. On a removal of a still-alive family's token
   *  (TTL expiry), tombstones it first so the revocation anchor survives. */
  private lookup(token: string | undefined): TokenEntry | null {
    if (!token || token.length > 256) return null;
    const key = this.digest(token);
    const e = this.tokens.get(key);
    if (!e) return null;
    const now = this.now();
    const fam = this.families.get(e.familyId);
    if (!fam || fam.revoked || now >= fam.absoluteMaxMs) { this.tokens.delete(key); return null; }
    if (e.expiresAtMs <= now) { this.tokens.delete(key); this.tombstone(key, e.familyId, fam); return null; }
    return e;
  }

  private invalidateFamily(familyId: string): void {
    const fam = this.families.get(familyId);
    if (fam) { fam.revoked = true; fam.tombstones = 0; }
    for (const [key, e] of this.tokens) if (e.familyId === familyId) this.tokens.delete(key);
    for (const [key, fid] of this.consumed) if (fid === familyId) this.consumed.delete(key);
    const set = this.listeners.get(familyId);
    if (set) {
      for (const l of [...set]) { try { l(); } catch { /* never propagate */ } }
      this.listeners.delete(familyId);
    }
  }

  private digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}

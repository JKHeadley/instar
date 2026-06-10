/**
 * MandateStore — persists Coordination Mandates and verifies their authorship.
 *
 * A mandate is valid only if its `authProof` verifies (threat-model T1/T2): the proof
 * is produced ONLY by the PIN-gated issuance path (the human-authenticated surface,
 * Justin's decision A on issuance), so an agent holding only its Bearer token cannot
 * mint or widen a mandate. The proof covers the AUTHORED, immutable fields; `revoked`
 * is a store-managed flag (a later mutation), so it is excluded from the proof and
 * checked separately on every gate evaluation.
 *
 * The signer/verifier are INJECTED (like the other signed stores): tests use a
 * deterministic stub; production uses an HMAC over the server's issuance secret.
 *
 * Trust boundary (stated, not hidden): integrity of the on-disk mandate + revocation
 * flag against an attacker with LOCAL write access is the same trust root as today
 * (threat-model T12, out of scope) — the proof stops a forged/edited AUTHORED mandate;
 * local-file tamper of server-managed state is the baseline trust boundary.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Authority, CoordinationMandate, UserAuthorityGrant } from './types.js';

/** Deterministic, key-sorted serialization so the proof survives JSON round-trips
 *  and key reordering. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/**
 * Canonical bytes the authProof covers — the AUTHORED fields only (proof + revoked excluded).
 *
 * BACKWARD-COMPAT (non-negotiable): `grants` is appended to the byte sequence ONLY
 * when it is present AND non-empty. A mandate with no grants (the pre-extension shape,
 * `grants` undefined OR `[]`) therefore canonicalizes to the EXACT same bytes as before
 * this extension existed — so every previously-signed mandate's stored `authProof`
 * keeps verifying. When grants ARE present, they extend the canonical bytes (each grant
 * as a field-ordered tuple), so the proof covers them and a grant cannot be forged or
 * added without re-signing through the PIN-gated path.
 */
export function canonicalMandate(m: Omit<CoordinationMandate, 'authProof' | 'revoked'>): string {
  const base: unknown[] = [
    m.id, m.scope, m.agents,
    m.authorities.map((a) => [a.action, a.bounds, a.requiresCondition ?? '']),
    m.author, m.createdAt, m.expiresAt,
  ];
  // Append-only-when-non-empty: no grants → identical bytes to a pre-extension mandate.
  if (Array.isArray(m.grants) && m.grants.length > 0) {
    base.push(m.grants.map((g) => [g.floorAction, g.grantedTo, g.authorizedBy, g.expiresAt, g.bounds ?? {}]));
  }
  return stableStringify(base);
}

export interface MandateStoreDeps {
  /** Absolute path to the mandates JSON file. */
  filePath: string;
  /** Sign the canonical mandate bytes (HMAC over the issuance secret in production). */
  sign: (canonical: string) => string;
  /** Verify a proof against the canonical mandate bytes. */
  verifySig: (canonical: string, proof: string) => boolean;
  now?: () => number;
  /** Mandate id generator (default: random). Injected for deterministic tests. */
  genId?: () => string;
}

export interface IssueMandateInput {
  scope: string;
  agents: [string, string];
  authorities: Authority[];
  author: string;
  expiresAt: string;
  id?: string;
  createdAt?: string;
  /** Optional user→agent authority grants signed into the mandate at issuance. */
  grants?: UserAuthorityGrant[];
}

export class MandateStore {
  private readonly d: MandateStoreDeps;
  constructor(deps: MandateStoreDeps) {
    this.d = deps;
  }

  private nowIso(): string {
    return new Date(this.d.now ? this.d.now() : Date.now()).toISOString();
  }

  private readAll(): CoordinationMandate[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.d.filePath, 'utf8'));
      return Array.isArray(raw) ? (raw as CoordinationMandate[]) : [];
    } catch { /* @silent-fallback-ok — mandates file may not exist yet; an empty store is DENY-BY-DEFAULT (the safe state) */ return []; }
  }

  private writeAll(mandates: CoordinationMandate[]): void {
    fs.mkdirSync(path.dirname(this.d.filePath), { recursive: true });
    fs.writeFileSync(this.d.filePath, JSON.stringify(mandates, null, 2));
  }

  /**
   * Issue (author) a mandate. ONLY the PIN-gated route should call this. Signs the
   * authored bytes, persists, returns the mandate.
   */
  issue(input: IssueMandateInput): CoordinationMandate {
    const id = input.id ?? (this.d.genId ? this.d.genId() : `mandate-${Math.random().toString(36).slice(2, 10)}`);
    const createdAt = input.createdAt ?? this.nowIso();
    // Defense-in-depth (second-pass hardening): grants issued WITH the mandate are
    // validated + expiry-clamped the SAME way addGrants() validates them, so a grant
    // can never outlive the mandate that carries it regardless of caller. The HTTP
    // issue route drops grants today; this keeps the library contract uniformly safe
    // for any future caller, not relying solely on the query-side clamp.
    if (input.grants && input.grants.length > 0) {
      const mandateExpiryMs = Date.parse(input.expiresAt);
      for (const g of input.grants) {
        if (!g || typeof g.floorAction !== 'string' || !g.floorAction
          || typeof g.grantedTo !== 'string' || !g.grantedTo
          || typeof g.authorizedBy !== 'string' || !g.authorizedBy
          || typeof g.expiresAt !== 'string' || isNaN(Date.parse(g.expiresAt))) {
          throw new Error('each grant needs a non-empty floorAction, grantedTo, authorizedBy, and a valid ISO expiresAt');
        }
        if (Date.parse(g.expiresAt) > mandateExpiryMs) {
          throw new Error(`grant expiresAt (${g.expiresAt}) must be <= mandate expiresAt (${input.expiresAt})`);
        }
      }
    }
    const authored: Omit<CoordinationMandate, 'authProof' | 'revoked'> = {
      id, scope: input.scope, agents: input.agents, authorities: input.authorities,
      author: input.author, createdAt, expiresAt: input.expiresAt,
      // Append-only-when-non-empty: never set `grants` for a no-grant issuance, so the
      // canonical bytes (and thus the proof) are byte-for-byte identical to before this
      // extension existed.
      ...(input.grants && input.grants.length > 0 ? { grants: input.grants } : {}),
    };
    const mandate: CoordinationMandate = {
      ...authored,
      revoked: null,
      authProof: this.d.sign(canonicalMandate(authored)),
    };
    const all = this.readAll().filter((m) => m.id !== id);
    all.push(mandate);
    this.writeAll(all);
    return mandate;
  }

  /**
   * Add user→agent authority grant(s) to an existing mandate and RE-SIGN it so the
   * `authProof` covers the new grants (the only path that can sign a grant in — the
   * PIN-gated route is the sole caller). Grants are validated and clamped against the
   * mandate's own expiry: a grant's `expiresAt` may never exceed the mandate's.
   *
   * Returns `{ ok: false }` with a reason for a missing/revoked mandate or an invalid
   * grant; `{ ok: true, mandate }` on success. Never partially applies.
   */
  addGrants(
    id: string,
    grants: UserAuthorityGrant[],
  ): { ok: true; mandate: CoordinationMandate } | { ok: false; reason: string } {
    const all = this.readAll();
    const idx = all.findIndex((m) => m.id === id);
    if (idx < 0) return { ok: false, reason: 'mandate not found' };
    const existing = all[idx];
    if (existing.revoked) return { ok: false, reason: 'mandate is revoked' };
    if (!Array.isArray(grants) || grants.length === 0) return { ok: false, reason: 'no grants provided' };

    const mandateExpiry = Date.parse(existing.expiresAt);
    for (const g of grants) {
      if (!g || typeof g.floorAction !== 'string' || !g.floorAction
        || typeof g.grantedTo !== 'string' || !g.grantedTo
        || typeof g.authorizedBy !== 'string' || !g.authorizedBy
        || typeof g.expiresAt !== 'string' || isNaN(Date.parse(g.expiresAt))) {
        return { ok: false, reason: 'each grant needs non-empty floorAction, grantedTo, authorizedBy, and a valid ISO expiresAt' };
      }
      // A grant can NEVER outlive the delegation that carries it.
      if (Date.parse(g.expiresAt) > mandateExpiry) {
        return { ok: false, reason: `grant expiresAt (${g.expiresAt}) must be <= mandate expiresAt (${existing.expiresAt})` };
      }
    }

    const mergedGrants = [...(existing.grants ?? []), ...grants];
    const authored: Omit<CoordinationMandate, 'authProof' | 'revoked'> = {
      id: existing.id, scope: existing.scope, agents: existing.agents,
      authorities: existing.authorities, author: existing.author,
      createdAt: existing.createdAt, expiresAt: existing.expiresAt,
      grants: mergedGrants,
    };
    const resigned: CoordinationMandate = {
      ...authored,
      revoked: existing.revoked,
      authProof: this.d.sign(canonicalMandate(authored)),
    };
    all[idx] = resigned;
    this.writeAll(all);
    return { ok: true, mandate: resigned };
  }

  /** Verify a mandate's authorship proof (T1/T2). */
  verifyAuthorship(m: CoordinationMandate): boolean {
    const { authProof, revoked, ...authored } = m;
    return this.d.verifySig(canonicalMandate(authored), authProof);
  }

  get(id: string): CoordinationMandate | undefined {
    return this.readAll().find((m) => m.id === id);
  }

  list(): CoordinationMandate[] {
    return this.readAll();
  }

  /** Revoke a mandate (idempotent). Returns the updated mandate, or undefined if absent. */
  revoke(id: string, reason: string): CoordinationMandate | undefined {
    const all = this.readAll();
    const idx = all.findIndex((m) => m.id === id);
    if (idx < 0) return undefined;
    if (!all[idx].revoked) {
      all[idx].revoked = { at: this.nowIso(), reason };
      this.writeAll(all);
    }
    return all[idx];
  }
}

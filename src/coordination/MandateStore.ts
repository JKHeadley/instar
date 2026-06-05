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
import type { Authority, CoordinationMandate } from './types.js';

/** Deterministic, key-sorted serialization so the proof survives JSON round-trips
 *  and key reordering. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/** Canonical bytes the authProof covers — the AUTHORED fields only (proof + revoked excluded). */
export function canonicalMandate(m: Omit<CoordinationMandate, 'authProof' | 'revoked'>): string {
  return stableStringify([
    m.id, m.scope, m.agents,
    m.authorities.map((a) => [a.action, a.bounds, a.requiresCondition ?? '']),
    m.author, m.createdAt, m.expiresAt,
  ]);
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
    const authored: Omit<CoordinationMandate, 'authProof' | 'revoked'> = {
      id, scope: input.scope, agents: input.agents, authorities: input.authorities,
      author: input.author, createdAt, expiresAt: input.expiresAt,
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

/**
 * servedAccount — which subscription account actually served a usage row
 * (docs/specs/quota-pacing-spend-by-account.md §1).
 *
 * The transcript's root folder is the SLOT (config home) the process ran in. Which account
 * sat in that slot at the row's time is answered, with the basis recorded:
 *   1. credential re-pointing in use (the credential ledger is seeded and not in unknown mode):
 *      the slot's assignment, verified at or before the row (`ledger-verified`), never verified
 *      before it (`ledger-unverified`), or changed since the row / since the session started
 *      (`slot-changed`, account null);
 *   2. otherwise the enrollment home, judged against the identity-check log at the row's time:
 *      `enrollment-confirmed`, `enrollment-drifted` (account null) or `identity-unconfirmed`.
 *      Codex slots are never identity-checked, so they are always `identity-unconfirmed`;
 *   3. a root no pool account owns (`unknown-root`) or one two accounts share (`ambiguous-root`).
 *
 * Pure apart from the injected views; a measurement only — nothing decides on it.
 */
import { CLAUDE_CODE_FRAMEWORK } from '../core/frameworkFacts.js';
import path from 'node:path';
import type { IdentityCheckLog } from './IdentityCheckLog.js';
import { identityKey } from './quotaPacing.js';

export type ServedBasis =
  | 'ledger-verified' | 'ledger-unverified' | 'slot-changed'
  | 'enrollment-confirmed' | 'enrollment-drifted' | 'identity-unconfirmed'
  | 'unknown-root' | 'ambiguous-root' | 'no-transcript' | 'off' | 'before-attribution';

/** Bases whose served account counts toward size-of-a-point and confirmed mismatches. */
export const CONFIRMED_BASES: ReadonlySet<ServedBasis> = new Set(['ledger-verified', 'enrollment-confirmed']);

export interface ServedAttribution {
  slot: string | null;
  accountId: string | null;
  identity: string | null;
  basis: ServedBasis;
}

export interface ServedPoolAccount { id: string; framework: string; configHome: string; provider: string; email?: string | null }

export interface ServedLedgerView {
  isUnknownMode(): boolean;
  isSeeded(): boolean;
  version: number;
  getAssignment(slot: string): { slot: string; accountId: string; since: string; lastVerifiedAt: string | null; quarantined: boolean } | null;
  getJournal(): ReadonlyArray<{ op: string; phase: string; slots: string[]; detail?: string; at: string }>;
}

export interface ServedResolverDeps {
  pool: () => ReadonlyArray<ServedPoolAccount>;
  ledger?: () => ServedLedgerView | null;
  checks?: IdentityCheckLog | null;
  /** The poll interval: the identity-check grace is 3 of these (default 15 minutes). */
  pollIntervalMs?: number;
}

export interface ResolveInput {
  root: string;
  kind: 'claude' | 'codex';
  ts: number;
  /** When the row's session began (binding validFrom, else its first row); null when unknown. */
  sessionStartTs: number | null;
}

const ms = (s: string | null | undefined): number => (typeof s === 'string' && s ? Date.parse(s) : NaN);

export class ServedAccountResolver {
  private bySlot = new Map<string, ServedPoolAccount[]>();
  private poolSignature = '';
  private ledgerVersion = -1;

  constructor(private readonly deps: ServedResolverDeps) {}

  /** Rebuild the slot map when the pool's account list changed (called at the start of each scan tick). */
  refresh(): void {
    let accounts: ReadonlyArray<ServedPoolAccount> = [];
    try { accounts = this.deps.pool(); } catch { /* @silent-fallback-ok: an unreadable pool leaves every root unknown-root for this tick */ accounts = []; }
    const sig = accounts.map((a) => `${a.id}|${a.framework}|${a.configHome}|${a.email ?? ''}`).sort().join('\n');
    const ledgerVersion = this.deps.ledger?.()?.version ?? -1;
    if (sig === this.poolSignature && ledgerVersion === this.ledgerVersion) return;
    this.poolSignature = sig;
    this.ledgerVersion = ledgerVersion;
    const map = new Map<string, ServedPoolAccount[]>();
    for (const a of accounts) {
      if (!a.configHome || !path.isAbsolute(a.configHome)) continue;
      const key = path.resolve(a.configHome);
      map.set(key, [...(map.get(key) ?? []), a]);
    }
    this.bySlot = map;
  }

  private emailOf(accountId: string): { provider: string; email: string | null } | null {
    for (const list of this.bySlot.values()) for (const a of list) if (a.id === accountId) return { provider: a.provider, email: a.email ?? null };
    try {
      const a = this.deps.pool().find((x) => x.id === accountId);
      return a ? { provider: a.provider, email: a.email ?? null } : null;
    } catch { /* @silent-fallback-ok: pool unreadable, so the email stays unknown and attribution says so */ return null; }
  }

  resolve(input: ResolveInput): ServedAttribution {
    const slot = path.resolve(input.root);
    const ledger = this.deps.ledger?.() ?? null;
    if (ledger && ledger.isSeeded() && !ledger.isUnknownMode()) {
      const a = ledger.getAssignment(slot);
      if (a && a.accountId) return this.fromLedger(slot, a, ledger, input);
    }
    const owners = this.bySlot.get(slot) ?? [];
    if (owners.length === 0) return { slot, accountId: null, identity: null, basis: 'unknown-root' };
    if (owners.length > 1) return { slot, accountId: null, identity: null, basis: 'ambiguous-root' };
    const owner = owners[0];
    if (input.kind === 'codex' || owner.framework !== CLAUDE_CODE_FRAMEWORK || !this.deps.checks) {
      return { slot, accountId: owner.id, identity: null, basis: 'identity-unconfirmed' };
    }
    const grace = 3 * (this.deps.pollIntervalMs ?? 15 * 60_000);
    const iv = this.deps.checks.at(slot, input.ts, grace);
    if (!iv) return { slot, accountId: owner.id, identity: null, basis: 'identity-unconfirmed' };
    if (iv.result === 'drifted') return { slot, accountId: null, identity: null, basis: 'enrollment-drifted' };
    return { slot, accountId: owner.id, identity: iv.identity, basis: 'enrollment-confirmed' };
  }

  private fromLedger(slot: string, a: NonNullable<ReturnType<ServedLedgerView['getAssignment']>>, ledger: ServedLedgerView, input: ResolveInput): ServedAttribution {
    const since = ms(a.since);
    // A process keeps the credentials it loaded: a session that began before this tenant
    // entered the slot (or a row that predates it) ran under someone else.
    const startedBefore = input.sessionStartTs != null && Number.isFinite(since) && input.sessionStartTs < since;
    if (Number.isFinite(since) && (input.ts < since || startedBefore)) {
      return { slot, accountId: null, identity: null, basis: 'slot-changed' };
    }
    if (a.quarantined) return { slot, accountId: a.accountId, identity: null, basis: 'ledger-unverified' };
    const verifiedAt = ms(a.lastVerifiedAt);
    let verifiedBefore = Number.isFinite(verifiedAt) && verifiedAt <= input.ts;
    if (!verifiedBefore) {
      // The journal keeps recent entries: any reconcile/verified entry for this slot between
      // `since` and the row also certifies it.
      for (const e of ledger.getJournal()) {
        const at = ms(e.at);
        if (!Number.isFinite(at) || at > input.ts || (Number.isFinite(since) && at < since)) continue;
        if (!e.slots.some((s) => path.resolve(s) === slot)) continue;
        if (e.op === 'reconcile' || e.phase === 'verified') { verifiedBefore = true; break; }
      }
    }
    if (!verifiedBefore) return { slot, accountId: a.accountId, identity: null, basis: 'ledger-unverified' };
    const who = this.emailOf(a.accountId);
    return { slot, accountId: a.accountId, identity: who ? identityKey(who.provider, who.email) : null, basis: 'ledger-verified' };
  }
}

/**
 * CredentialLocationLedger — the bookkeeping core of live credential re-pointing.
 *
 * Spec: docs/specs/live-credential-repointing-rebalancer.md §2.2.
 *
 * A machine-local durable ledger (`<stateDir>/credential-locations.json`) that records,
 * for each config-home SLOT, which pool account's credential currently lives there. It is
 * the single source of truth for "which account is in which home" once live re-pointing is
 * enabled — every consumer that today treats a pool account's enrollment `configHome` as its
 * live location instead resolves through `slotOf(accountId)` / `tenantOf(slot)` here.
 *
 * This module is Step 2 of Increment A: the bookkeeping + durability + seeding/recovery core.
 * It performs NO keychain writes itself — the staged swap executor (§2.3, Step 5) and the
 * write funnel (§2.2, Step 4) are separate. The identity oracle it seeds/recovers from is the
 * `IdentityOracle` interface (Step 3 implements it against the Anthropic OAuth profile endpoint,
 * `/api/oauth/profile`, routed through the existing intelligence-provider chokepoint).
 *
 * Durability posture (the §2.2 contract — NOT SubscriptionPool's posture):
 *   - missing file        → NEVER-SEEDED (mode 'ok', empty assignments). Reads return null →
 *                           consumers fall back to today's enrollment-home behavior. This is
 *                           normal, not a degradation.
 *   - corrupt/unparseable → UNKNOWN MODE (fail-closed for moves: every mutation refuses;
 *                           fail-open-LOUD for reads: reads return null AND one HIGH attention
 *                           item names the degradation). Recovery is a fresh `seedFromOracle()`.
 *                           This is deliberately NOT a silent fresh-start (No Silent Degradation):
 *                           a quiet reset here could place a session onto the wrong account.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The on-disk schema version this module writes. Bumped only on a breaking shape change. */
export const CREDENTIAL_LEDGER_SCHEMA_VERSION = 1;

/** Which account's credential currently lives in a given config-home slot. */
export interface CredentialAssignment {
  /** Config-home path acting as the slot, e.g. `~/.claude` or an enrollment home. */
  slot: string;
  /** Pool account id whose credential currently sits in this slot. */
  accountId: string;
  /** ISO — when this assignment was last recorded (a swap/seed into this slot). */
  since: string;
  /** ISO — last identity-oracle confirmation of this slot's tenant; null = never verified. */
  lastVerifiedAt: string | null;
  /** Excluded from balancing — oracle was unavailable, or a divergence was detected. */
  quarantined: boolean;
}

/** One journal entry — in-flight swap phases + the last N completed (pruned at commit). */
export interface CredentialLedgerJournalEntry {
  /** Monotonic sequence within the ledger (== the version at write time). */
  seq: number;
  /** The operation this entry belongs to. */
  op: 'seed' | 'swap' | 'set-default' | 'quarantine' | 'unquarantine' | 'restore' | 'reconcile';
  /** The phase of that operation (swap is multi-phase per §2.3; others are single-shot). */
  phase: 'begin' | 'staged' | 'exchanged' | 'verified' | 'done' | 'aborted';
  /** Slots this entry touched (ordered). */
  slots: string[];
  /** Free-text detail (never a credential — names/ids/reasons only). */
  detail?: string;
  /** ISO timestamp. */
  at: string;
}

export interface CredentialLocationLedgerStore {
  version: number;
  assignments: CredentialAssignment[];
  journal: CredentialLedgerJournalEntry[];
}

/**
 * Result of probing a slot's CURRENT credential blob for its owning account.
 * Implemented in Step 3 against `GET /api/oauth/profile` (the Anthropic OAuth profile endpoint).
 *
 * CONTRACT (§2.11): `email` set === identity-confirmed; `unavailable:true` for EVERY other
 * outcome (timeout/401/403/429/5xx/missing-or-empty-or-nonstring email/unparseable). The
 * oracle NEVER reports a "mismatch" — an unverifiable slot is quarantine-never-repair, never
 * a guess.
 */
export interface IdentityOracleResult {
  email?: string;
  unavailable?: boolean;
  reason?: string;
}

export interface IdentityOracle {
  /** Resolve which account email the credential blob currently in `slot` belongs to. */
  resolveSlotTenant(slot: string): Promise<IdentityOracleResult>;
}

/** Narrow view of the subscription pool the ledger needs (satisfied by SubscriptionPool). */
export interface LedgerPoolAccount {
  id: string;
  email?: string;
  configHome: string;
  framework?: string;
}
export interface LedgerPoolView {
  list(): LedgerPoolAccount[];
}

/** Attention-item shape (mirrors AgentWorktreeDetector.AttentionItemInput). */
export interface CredentialLedgerAttentionInput {
  id: string;
  title: string;
  summary: string;
  description?: string;
  category: string;
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  sourceContext?: string;
}

export interface CredentialLocationLedgerDeps {
  /** Agent stateDir (e.g. `.instar`). The ledger lives at `<stateDir>/credential-locations.json`. */
  stateDir: string;
  /** The subscription pool — used to map a probed email → accountId during seed/recovery. */
  pool: LedgerPoolView;
  /** Identity oracle for seeding/recovery (Step 3 implementation). */
  oracle: IdentityOracle;
  /** Emit a HIGH attention item (typically telegramAdapter.createAttentionItem). */
  emitAttention?: (item: CredentialLedgerAttentionInput) => void | Promise<void>;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
}

/** Thrown when a mutation is attempted while the ledger is in UNKNOWN mode (fail-closed). */
export class CredentialLedgerUnknownModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialLedgerUnknownModeError';
  }
}

/** Outcome of a seed/recovery probe for one slot (returned for caller observability + tests). */
export interface SeedSlotOutcome {
  slot: string;
  result: 'assigned' | 'unavailable' | 'ambiguous' | 'unknown-email';
  accountId?: string;
  email?: string;
  reason?: string;
}

/** Outcome of a periodic NON-DESTRUCTIVE identity re-verification (auditIdentities) for one slot. */
export interface IdentityAuditOutcome {
  slot: string;
  /**
   * - `refreshed` — healthy slot re-confirmed; lastVerifiedAt stamped fresh (the core fix).
   * - `recovered` — a quarantined/tenant-less slot now resolves cleanly; assignment restored + unquarantined.
   * - `diverged-quarantined` — a healthy slot's credential now belongs to a DIFFERENT account (confirmed login change) → quarantined.
   * - `unverifiable-quarantined` — a healthy slot's email became ambiguous/unknown → quarantined.
   * - `unavailable-held` — oracle unavailable/threw; a healthy slot is HELD (never quarantined on a transient probe failure).
   * - `still-quarantined` — an already-quarantined slot still can't be cleanly resolved.
   */
  result:
    | 'refreshed'
    | 'recovered'
    | 'diverged-quarantined'
    | 'unverifiable-quarantined'
    | 'unavailable-held'
    | 'still-quarantined';
  accountId?: string;
  email?: string;
  reason?: string;
}

/** Aggregate report of one auditIdentities pass (returned + retained for the status surface). */
export interface IdentityAuditReport {
  at: string;
  outcomes: IdentityAuditOutcome[];
  refreshed: number;
  recovered: number;
  quarantined: number;
  /** Held (transient) + still-quarantined — slots the pass could not freshly confirm. */
  unresolved: number;
}

const MAX_COMPLETED_JOURNAL = 50;
const NON_CLAUDE_FRAMEWORKS = new Set(['codex-cli', 'gemini-cli', 'pi-cli']);

/** A claude-code account is the implicit default (framework undefined or 'claude-code'). */
function isClaudeCodeAccount(a: LedgerPoolAccount): boolean {
  return !a.framework || a.framework === 'claude-code';
}

export class CredentialLocationLedger {
  private readonly storePath: string;
  private readonly pool: LedgerPoolView;
  private readonly oracle: IdentityOracle;
  private readonly emitAttention?: (item: CredentialLedgerAttentionInput) => void | Promise<void>;
  private readonly now: () => string;

  private store: CredentialLocationLedgerStore;
  /** UNKNOWN mode — set when the on-disk ledger was present but corrupt. Fail-closed for moves. */
  private unknownMode = false;
  /** Dedupe the UNKNOWN-mode attention item so a re-read storm raises it once. */
  private unknownAttentionRaised = false;
  /** Last NON-DESTRUCTIVE identity audit pass (auditIdentities) — surfaced in status. */
  private lastAuditReport: IdentityAuditReport | null = null;
  /** In-memory index: accountId → slot (rebuilt on every mutation/load). */
  private slotByAccount = new Map<string, string>();
  /** In-memory index: slot → accountId. */
  private accountBySlot = new Map<string, string>();

  constructor(deps: CredentialLocationLedgerDeps) {
    this.storePath = path.join(deps.stateDir, 'credential-locations.json');
    this.pool = deps.pool;
    this.oracle = deps.oracle;
    this.emitAttention = deps.emitAttention;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.store = this.load();
    this.reindex();
    if (this.unknownMode) void this.raiseUnknownModeAttention();
  }

  // ─── Load / save (atomic tmp+rename — the SubscriptionPool.save pattern) ──────────

  private load(): CredentialLocationLedgerStore {
    if (!fs.existsSync(this.storePath)) {
      // NEVER-SEEDED — not corrupt. Empty ledger; reads fall back to enrollment homes.
      return { version: 0, assignments: [], journal: [] };
    }
    try {
      const data = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
      if (
        data &&
        typeof data.version === 'number' &&
        Array.isArray(data.assignments) &&
        Array.isArray(data.journal)
      ) {
        return data as CredentialLocationLedgerStore;
      }
      // Present but wrong shape → corrupt.
      this.unknownMode = true;
    } catch {
      // Present but unparseable → corrupt. NOT a silent fresh-start: UNKNOWN mode is entered
      // and a HIGH attention item is raised by the constructor. (No Silent Degradation.)
      this.unknownMode = true;
    }
    return { version: 0, assignments: [], journal: [] };
  }

  private save(): void {
    try {
      const dir = path.dirname(this.storePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${this.storePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.store, null, 2) + '\n');
      fs.renameSync(tmpPath, this.storePath);
    } catch {
      // @silent-fallback-ok — a persistence failure leaves the in-memory store authoritative
      // for this process; the next mutation retries the write. The ledger is bookkeeping, not
      // a credential, so an unwritten entry never strands a login — at worst a recovery probe
      // re-derives it. Surfacing every transient fs hiccup would be noise, not signal.
    }
  }

  private reindex(): void {
    this.slotByAccount.clear();
    this.accountBySlot.clear();
    for (const a of this.store.assignments) {
      // Tenant-less quarantine markers (accountId === '') carry no resolvable tenant — a
      // seed refusal / unavailable probe records the slot as quarantined-unknown, and a read
      // of it must be null (caller falls back), never the empty string.
      if (!a.accountId) continue;
      this.slotByAccount.set(a.accountId, a.slot);
      this.accountBySlot.set(a.slot, a.accountId);
    }
  }

  // ─── Sync in-memory reads (never disk/parse per spawn; never throw) ───────────────

  /** Current slot holding `accountId`'s credential, or null (UNKNOWN mode / never-seeded). */
  slotOf(accountId: string): string | null {
    if (this.unknownMode) return null;
    return this.slotByAccount.get(accountId) ?? null;
  }

  /** Account currently tenanting `slot`, or null (UNKNOWN mode / never-seeded). */
  tenantOf(slot: string): string | null {
    if (this.unknownMode) return null;
    return this.accountBySlot.get(slot) ?? null;
  }

  isUnknownMode(): boolean {
    return this.unknownMode;
  }

  /** True when the ledger has at least one assignment (has been seeded). */
  isSeeded(): boolean {
    return !this.unknownMode && this.store.assignments.length > 0;
  }

  getAssignments(): readonly CredentialAssignment[] {
    return this.store.assignments.slice();
  }

  getAssignment(slot: string): CredentialAssignment | null {
    return this.store.assignments.find((a) => a.slot === slot) ?? null;
  }

  getJournal(): readonly CredentialLedgerJournalEntry[] {
    return this.store.journal.slice();
  }

  get version(): number {
    return this.store.version;
  }

  // ─── Mutations (single-writer; refuse in UNKNOWN mode — fail-closed for moves) ─────

  private assertMutable(op: string): void {
    if (this.unknownMode) {
      throw new CredentialLedgerUnknownModeError(
        `ledger is in UNKNOWN mode (corrupt on-disk state) — ${op} refused; recover via seedFromOracle()`,
      );
    }
  }

  /** Record (or re-point) `slot`'s tenant to `accountId`. Single-writer; bumps version. */
  recordAssignment(slot: string, accountId: string, opts?: { verifiedAt?: string | null; op?: CredentialLedgerJournalEntry['op']; source?: string }): CredentialAssignment {
    this.assertMutable('recordAssignment');
    const at = this.now();
    const existing = this.store.assignments.find((a) => a.slot === slot);
    // A slot's tenant changing means the previous tenant is no longer authoritative
    // elsewhere. Preserve every enumerated SLOT, though: silently dropping the old
    // slot made later repairs unable to address it. A duplicate claim is vacated to
    // a tenant-less quarantine marker until a live probe/verified swap fills it.
    this.store.assignments = this.store.assignments
      .filter((a) => a.slot !== slot)
      .map((a) => a.accountId === accountId
        ? { ...a, accountId: '', lastVerifiedAt: null, quarantined: true }
        : a);
    const assignment: CredentialAssignment = {
      slot,
      accountId,
      since: existing && existing.accountId === accountId ? existing.since : at,
      lastVerifiedAt: opts?.verifiedAt !== undefined ? opts.verifiedAt : (existing?.lastVerifiedAt ?? null),
      quarantined: false,
    };
    this.store.assignments.push(assignment);
    this.bumpAndJournal({
      op: opts?.op ?? 'swap',
      phase: 'done',
      slots: [slot],
      detail: `tenant=${accountId}${opts?.source ? ` source=${opts.source}` : ''}`,
    });
    this.reindex();
    this.save();
    return assignment;
  }

  /** Mark a slot quarantined (excluded from balancing) — oracle unavailable / divergence. */
  quarantineSlot(slot: string, reason: string): void {
    this.assertMutable('quarantineSlot');
    const a = this.store.assignments.find((x) => x.slot === slot);
    if (a) {
      a.quarantined = true;
    } else {
      // Quarantine a slot we have no confirmed tenant for: record a tenant-less quarantine
      // marker so the slot is durably excluded until a clean probe clears it.
      this.store.assignments.push({ slot, accountId: '', since: this.now(), lastVerifiedAt: null, quarantined: true });
    }
    this.bumpAndJournal({ op: 'quarantine', phase: 'done', slots: [slot], detail: reason });
    this.reindex();
    this.save();
  }

  /** Lift a quarantine after a clean re-probe. */
  unquarantineSlot(slot: string): void {
    this.assertMutable('unquarantineSlot');
    const a = this.store.assignments.find((x) => x.slot === slot);
    if (a) {
      a.quarantined = false;
      this.bumpAndJournal({ op: 'unquarantine', phase: 'done', slots: [slot] });
      this.reindex();
      this.save();
    }
  }

  /** Stamp a slot's lastVerifiedAt after an identity-oracle confirmation. */
  markVerified(slot: string, at?: string): void {
    this.assertMutable('markVerified');
    const a = this.store.assignments.find((x) => x.slot === slot);
    if (a) {
      a.lastVerifiedAt = at ?? this.now();
      this.save();
    }
  }

  /** Append a journal entry for an in-flight swap phase (used by the executor in Step 5). */
  appendJournal(entry: Omit<CredentialLedgerJournalEntry, 'seq' | 'at'> & { at?: string }): CredentialLedgerJournalEntry {
    this.assertMutable('appendJournal');
    return this.bumpAndJournal(entry);
  }

  private bumpAndJournal(entry: Omit<CredentialLedgerJournalEntry, 'seq' | 'at'> & { at?: string }): CredentialLedgerJournalEntry {
    this.store.version += 1;
    const full: CredentialLedgerJournalEntry = {
      seq: this.store.version,
      op: entry.op,
      phase: entry.phase,
      slots: entry.slots ?? [],
      ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
      at: entry.at ?? this.now(),
    };
    this.store.journal.push(full);
    this.pruneJournal();
    return full;
  }

  /** Keep all non-terminal (in-flight) entries + the last MAX_COMPLETED_JOURNAL terminal ones. */
  private pruneJournal(): void {
    const terminal = (p: CredentialLedgerJournalEntry['phase']) => p === 'done' || p === 'aborted';
    const inFlight = this.store.journal.filter((e) => !terminal(e.phase));
    const completed = this.store.journal.filter((e) => terminal(e.phase));
    const keptCompleted = completed.slice(-MAX_COMPLETED_JOURNAL);
    this.store.journal = [...inFlight, ...keptCompleted].sort((a, b) => a.seq - b.seq);
  }

  // ─── Seeding / recovery via the identity oracle (§2.2) ────────────────────────────

  /**
   * Derive each slot's tenant by probing its CURRENT credential via the oracle, then mapping
   * email → accountId through the pool. Clears UNKNOWN mode on a clean pass. Per §2.2:
   *   - oracle unavailable for a slot → quarantine that slot (never guess), continue.
   *   - email maps to exactly one claude-code account → record the assignment (verified now).
   *   - ambiguous (≥2 accounts share the email) or unknown email → REFUSE auto-assign for that
   *     slot + raise an attention item; never guess.
   * Slots = the distinct enrollment `configHome`s of claude-code pool accounts.
   */
  async seedFromOracle(): Promise<SeedSlotOutcome[]> {
    const claudeAccounts = this.pool.list().filter(isClaudeCodeAccount);
    const slots = Array.from(new Set(claudeAccounts.map((a) => a.configHome))).filter(Boolean);
    const outcomes: SeedSlotOutcome[] = [];

    // A clean slate for the rebuild; UNKNOWN mode is cleared as soon as we begin a real probe
    // pass (the rebuild is the recovery path the spec names).
    this.store = { version: this.store.version, assignments: [], journal: this.store.journal };
    this.unknownMode = false;
    this.unknownAttentionRaised = false;
    this.bumpAndJournal({ op: 'seed', phase: 'begin', slots, detail: `${slots.length} slot(s)` });

    for (const slot of slots) {
      let result: IdentityOracleResult;
      try {
        result = await this.oracle.resolveSlotTenant(slot);
      } catch (err) {
        // An oracle that THROWS is treated identically to unavailable (§2.11 — never a guess,
        // never a mismatch). This is loud at the slot level (quarantine), not a silent swallow.
        result = { unavailable: true, reason: `oracle threw: ${(err as Error)?.message ?? 'unknown'}` };
      }

      if (result.unavailable || !result.email) {
        this.store.assignments.push({ slot, accountId: '', since: this.now(), lastVerifiedAt: null, quarantined: true });
        outcomes.push({ slot, result: 'unavailable', reason: result.reason ?? 'oracle unavailable' });
        continue;
      }

      const matches = claudeAccounts.filter((a) => a.email && a.email === result.email);
      if (matches.length === 1) {
        this.store.assignments.push({
          slot,
          accountId: matches[0].id,
          since: this.now(),
          lastVerifiedAt: this.now(),
          quarantined: false,
        });
        outcomes.push({ slot, result: 'assigned', accountId: matches[0].id, email: result.email });
      } else if (matches.length > 1) {
        // Ambiguous — two pool records, one email (legal under multi-grant). Never guess.
        this.store.assignments.push({ slot, accountId: '', since: this.now(), lastVerifiedAt: null, quarantined: true });
        outcomes.push({ slot, result: 'ambiguous', email: result.email, reason: `${matches.length} pool accounts share ${result.email}` });
        await this.raiseSeedRefusalAttention(slot, 'ambiguous', `${matches.length} accounts share ${result.email}`);
      } else {
        // Probed email matches no pool account.
        this.store.assignments.push({ slot, accountId: '', since: this.now(), lastVerifiedAt: null, quarantined: true });
        outcomes.push({ slot, result: 'unknown-email', email: result.email, reason: `no pool account for ${result.email}` });
        await this.raiseSeedRefusalAttention(slot, 'unknown-email', `no pool account for ${result.email}`);
      }
    }

    this.bumpAndJournal({ op: 'seed', phase: 'done', slots, detail: `${outcomes.filter((o) => o.result === 'assigned').length} assigned` });
    this.reindex();
    this.save();
    return outcomes;
  }

  /**
   * Periodic, NON-DESTRUCTIVE identity re-verification (the §2.4 scheduled identity audit).
   *
   * Unlike `seedFromOracle()` — which WIPES + rebuilds the whole ledger — this re-probes each
   * EXISTING tracked slot and updates ONLY its verification/quarantine state. It is the missing
   * piece that keeps a healthy slot's `lastVerifiedAt` FRESH: without a periodic re-stamp the
   * rebalancer's `targetVerifiedRecent` gate (default 6h) decays every slot to "not recently
   * verified", leaving every objective (wall-rescue AND use-it-or-lose-it drain) with zero
   * eligible targets — a permanently-inert optimizer. It ALSO lets a slot that has since become
   * resolvable EXIT quarantine.
   *
   * Safety direction (§2.11 never-guess / quarantine-never-repair):
   *   - oracle unavailable/throws → HOLD: NEVER quarantine a currently-healthy slot on a
   *     transient probe failure (that would itself induce the inert-rebalancer failure this
   *     method exists to prevent). An already-quarantined slot stays quarantined.
   *   - email → exactly one pool account:
   *       · matches the slot's current healthy tenant → markVerified (refresh — the core fix).
   *       · slot is quarantined / tenant-less → RECOVER: record the assignment verified-now and
   *         lift the quarantine.
   *       · matches a DIFFERENT account than the recorded healthy tenant → a CONFIRMED login
   *         divergence (the oracle never guesses a mismatch — an `email` is identity-confirmed)
   *         → quarantine (safe direction).
   *   - ambiguous / unknown-email on a currently-healthy slot → quarantine (its login became
   *     unrecognizable); an already-quarantined slot stays quarantined.
   *
   * This NEVER triggers a credential swap — it only refreshes the ledger verification state the
   * rebalancer reads on its next pass. No-op in UNKNOWN mode (recovery is seedFromOracle's job).
   */
  async auditIdentities(): Promise<IdentityAuditReport> {
    const at = this.now();
    const outcomes: IdentityAuditOutcome[] = [];
    if (this.unknownMode) {
      const empty: IdentityAuditReport = { at, outcomes, refreshed: 0, recovered: 0, quarantined: 0, unresolved: 0 };
      this.lastAuditReport = empty;
      return empty;
    }

    const claudeAccounts = this.pool.list().filter(isClaudeCodeAccount);
    // Snapshot the slot list up-front: the mutators below rewrite `assignments`.
    const slots = this.getAssignments().map((a) => a.slot);

    for (const slot of slots) {
      const existing = this.store.assignments.find((x) => x.slot === slot);
      if (!existing) continue; // disappeared mid-pass (defensive) — nothing to re-verify.

      let result: IdentityOracleResult;
      try {
        result = await this.oracle.resolveSlotTenant(slot);
      } catch (err) {
        result = { unavailable: true, reason: `oracle threw: ${(err as Error)?.message ?? 'unknown'}` };
      }

      if (result.unavailable || !result.email) {
        // HOLD — a transient probe failure must never demote a healthy slot.
        outcomes.push({
          slot,
          result: existing.quarantined ? 'still-quarantined' : 'unavailable-held',
          reason: result.reason ?? 'oracle unavailable',
        });
        continue;
      }

      const matches = claudeAccounts.filter((a) => a.email && a.email === result.email);
      if (matches.length === 1) {
        const matchId = matches[0].id;
        if (!existing.quarantined && existing.accountId === matchId) {
          this.markVerified(slot, at);
          outcomes.push({ slot, result: 'refreshed', accountId: matchId, email: result.email });
        } else if (existing.quarantined || existing.accountId === '') {
          // A quarantined / tenant-less slot now resolves cleanly → recover + un-quarantine.
          this.recordAssignment(slot, matchId, { verifiedAt: at, op: 'restore' });
          outcomes.push({ slot, result: 'recovered', accountId: matchId, email: result.email });
        } else {
          // Healthy slot, but the confirmed email belongs to a DIFFERENT account → divergence.
          this.quarantineSlot(slot, `audit: slot diverged — now ${result.email} (${matchId}), recorded tenant ${existing.accountId}`);
          outcomes.push({ slot, result: 'diverged-quarantined', accountId: matchId, email: result.email, reason: `diverged from ${existing.accountId}` });
        }
      } else if (matches.length > 1) {
        if (existing.quarantined) {
          outcomes.push({ slot, result: 'still-quarantined', email: result.email, reason: `ambiguous (${matches.length})` });
        } else {
          this.quarantineSlot(slot, `audit: ambiguous — ${matches.length} accounts share ${result.email}`);
          outcomes.push({ slot, result: 'unverifiable-quarantined', email: result.email, reason: `ambiguous (${matches.length})` });
        }
      } else {
        if (existing.quarantined) {
          outcomes.push({ slot, result: 'still-quarantined', email: result.email, reason: 'unknown-email' });
        } else {
          this.quarantineSlot(slot, `audit: unknown email ${result.email} — no pool account`);
          outcomes.push({ slot, result: 'unverifiable-quarantined', email: result.email, reason: 'unknown-email' });
        }
      }
    }

    const report: IdentityAuditReport = {
      at,
      outcomes,
      refreshed: outcomes.filter((o) => o.result === 'refreshed').length,
      recovered: outcomes.filter((o) => o.result === 'recovered').length,
      quarantined: outcomes.filter((o) => o.result === 'diverged-quarantined' || o.result === 'unverifiable-quarantined').length,
      unresolved: outcomes.filter((o) => o.result === 'unavailable-held' || o.result === 'still-quarantined').length,
    };
    this.lastAuditReport = report;
    return report;
  }

  /** The last NON-DESTRUCTIVE identity audit pass, or null if none has run. */
  getLastAuditReport(): IdentityAuditReport | null {
    return this.lastAuditReport;
  }

  // ─── Attention (LOUD degradation surfaces) ───────────────────────────────────────

  private async raiseUnknownModeAttention(): Promise<void> {
    if (this.unknownAttentionRaised || !this.emitAttention) return;
    this.unknownAttentionRaised = true;
    try {
      await this.emitAttention({
        id: 'credential-ledger-unknown-mode',
        title: 'Credential location ledger is in UNKNOWN mode',
        summary:
          'The credential-locations ledger on disk was unreadable. Credential swaps are refused (fail-closed) and credential reads fall back to enrollment homes until a fresh identity-oracle probe rebuilds it.',
        description:
          'Recovery: re-seed via the identity oracle (POST /credentials/locations re-probe, or seedFromOracle()). No credential was moved while in this state.',
        category: 'credential-repointing',
        priority: 'HIGH',
        sourceContext: 'credential-location-ledger',
      });
    } catch {
      // @silent-fallback-ok — the attention emitter is best-effort; a delivery failure must
      // not throw out of the ledger constructor and crash boot. The UNKNOWN-mode posture
      // (reads-null + mutations-refuse) is still in force regardless of whether the notice
      // was delivered, so the safety behavior does not depend on this emit.
    }
  }

  private async raiseSeedRefusalAttention(slot: string, kind: 'ambiguous' | 'unknown-email', detail: string): Promise<void> {
    if (!this.emitAttention) return;
    try {
      await this.emitAttention({
        id: `credential-ledger-seed-refusal:${kind}:${slot}`,
        title: `Credential ledger could not auto-assign a slot (${kind})`,
        summary: `Seeding refused to guess the tenant of ${slot}: ${detail}. The slot is quarantined (excluded from balancing) until resolved.`,
        category: 'credential-repointing',
        priority: 'HIGH',
        sourceContext: 'credential-location-ledger',
      });
    } catch {
      // @silent-fallback-ok — best-effort notice; the quarantine (the actual safety action) is
      // already durably recorded in the ledger whether or not the notice is delivered.
    }
  }
}

/**
 * The boot-seed decision (B3a). Pure + isolated so the wiring decision is unit-testable without
 * booting server.ts. Returns true ONLY when the re-pointing feature is enabled AND the ledger is
 * not already seeded — `isSeeded()` is false for BOTH never-seeded and UNKNOWN (corrupt) mode, so
 * a true result also covers the named recovery path, and a seeded ledger is always skipped (so the
 * boot-seed is idempotent across restarts). The actual seed (`seedFromOracle()`) is non-destructive
 * and already unit-tested; this guard is the new logic the wiring introduced.
 */
export function shouldBootSeedCredentialLedger(enabled: boolean, isSeeded: boolean): boolean {
  return enabled && !isSeeded;
}

/**
 * The periodic identity-audit gating decision (B3c). Pure + isolated so the scheduled-audit wiring
 * is unit-testable without booting server.ts. Returns true ONLY when ALL hold:
 *   - `enabled` — the re-pointing dev-gate is on (strict no-op / no oracle probe on the dark fleet);
 *   - `isSeeded` — there is a ledger to re-verify (boot-seed + recovery is seedFromOracle's job);
 *   - NOT `unknownMode` — a corrupt ledger refuses mutations (auditIdentities is a no-op there anyway);
 *   - NOT `inFlight` — the prior pass has not finished (reentrancy guard; a slow oracle never overlaps).
 * The audit (`auditIdentities()`) is non-destructive (verification state only; zero credential moves)
 * and unit-tested; this guard is the new logic the scheduled wiring introduced.
 */
export function shouldRunIdentityAudit(
  enabled: boolean,
  isSeeded: boolean,
  unknownMode: boolean,
  inFlight: boolean,
): boolean {
  return enabled && isSeeded && !unknownMode && !inFlight;
}

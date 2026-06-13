/**
 * CredentialSwapExecutor — the staged, identity-verified, repair-safe credential exchange
 * (Step 5b of live credential re-pointing, spec §2.3).
 *
 * `swap(slotA, slotB)` EXCHANGES (never copies) the two slots' Claude credentials so the §0.d
 * "exactly one home per credential" invariant holds by construction. Every destructive step is
 * journaled (the durable `CredentialSwapJournal`) so a crash mid-swap is decidable, and every
 * keychain write goes through the per-slot funnel lock + the machine-local single-mover mutex so a
 * swap can never interleave with a token-refresh write (Step 4b) or another swap on the same slot.
 *
 * The load-bearing safety properties (each earned in spec review):
 *   - Staging is a COPY (not a move): slot A is untouched until the first exchange write, so a
 *     crash before that write unwinds to a true no-op (§2.3.2).
 *   - Verify is on ACCOUNT IDENTITY (the oracle), never token bytes — rotation makes bytes
 *     unstable, and "repair from a stale memory copy on a byte mismatch" would manufacture the
 *     very stranding this exists to prevent (§2.3.4).
 *   - Oracle-UNAVAILABLE is NOT identity-MISMATCH: an unreachable oracle quarantines the slot and
 *     STOPS — it never triggers a destructive repair (§2.3.4). Repair is reserved for a CONFIRMED
 *     mismatch with a reachable oracle.
 *   - Staging is RETAINED through the delayed re-verify (~90s) — it is the heal source for an
 *     in-flight client refresh that lands after commit (§2.3.5/§2.3.6).
 *
 * Ships DARK: nothing calls `swap()` until the feature gate is enabled. Boot-recovery of an
 * in-flight journal row is Step 5c.
 */

import { CredentialLocationLedger, type LedgerPoolView } from './CredentialLocationLedger.js';
import type { IdentityOracle } from './CredentialLocationLedger.js';
import { CredentialWriteFunnel, credentialWriteFunnel } from './CredentialWriteFunnel.js';
import { CredentialSwapJournal, type SwapJournalEntry } from './CredentialSwapJournal.js';
import {
  type KeychainIO,
  SecurityKeychainIO,
  stagingService,
  assertStagingDisjoint,
  slotService,
} from './CredentialKeychainIO.js';
import { credentialSlotKey } from './OAuthRefresher.js';

/** A credential blob and the parsed fields the swap needs (NEVER logged). */
interface ParsedBlob {
  raw: string;
  accessToken: string;
  refreshToken: string;
}

export interface SwapAttentionInput {
  id: string;
  title: string;
  summary: string;
  category: string;
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  sourceContext?: string;
}

/** Optional best-effort exchange of the two homes' `oauthAccount` metadata blocks (§2.3.3). */
export interface MetadataStore {
  read(slot: string): unknown | null;
  write(slot: string, block: unknown): boolean;
}

export interface CredentialSwapExecutorDeps {
  ledger: CredentialLocationLedger;
  oracle: IdentityOracle;
  journal: CredentialSwapJournal;
  /** Maps a probed email → accountId (satisfied by SubscriptionPool). */
  pool: LedgerPoolView;
  funnel?: CredentialWriteFunnel;
  keychain?: KeychainIO;
  metadata?: MetadataStore;
  emitAttention?: (item: SwapAttentionInput) => void | Promise<void>;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
  now?: () => string;
  /** Generate a swapId deriving from NO token bytes. */
  genSwapId?: () => string;
  /** Delay before the post-commit re-verify (§2.3.6). Default 90_000ms. */
  reVerifyDelayMs?: number;
  /** Schedule the delayed re-verify. Default setTimeout; tests inject a synchronous runner. */
  scheduleReVerify?: (fn: () => void | Promise<void>, delayMs: number) => void;
}

export type SwapReason =
  | 'unknown-slot'
  | 'same-slot'
  | 'tenant-quarantined'
  | 'tenant-missing'
  | 'ledger-unknown-mode'
  | 'swap-in-flight'
  | 'slot-busy'
  | 'precondition-blob'
  | 'staging-failed'
  | 'exchange-write-failed'
  | 'verify-quarantined'
  | 'internal-error';

export interface SwapOutcome {
  ok: boolean;
  swapId?: string;
  reason?: SwapReason;
  /** Slots quarantined during verify (oracle-unavailable / unrepairable mismatch). */
  quarantined?: string[];
  detail?: string;
}

export type RecoveryResolution =
  | 'completed' // both slots already at the intended post-swap state → committed, staging freed
  | 'aborted-noop' // both slots still pre-swap → nothing took, staging freed
  | 're-driven' // genuinely partial → re-applied the move (adopt-on-newer), verified, committed
  | 'deferred-oracle-unavailable' // oracle down → slot quarantined, staging retained, re-probe later
  | 'quarantined' // unrecoverable (escrow/blob lost, or re-drive still mismatched) → quarantined, staging retained
  | 'busy'; // a live swap held the locks → retry on the next sweep

export interface RecoveryOutcome {
  swapId: string;
  resolution: RecoveryResolution;
  quarantined?: string[];
}

let swapSeq = 0;

/** Bound on how many times a lock-contended delayed re-verify re-schedules before deferring to
 *  boot-recovery / the §2.4 audit (staging is retained throughout, so deferring is safe). */
const MAX_REVERIFY_RESCHEDULES = 5;

export class CredentialSwapExecutor {
  private readonly ledger: CredentialLocationLedger;
  private readonly oracle: IdentityOracle;
  private readonly journal: CredentialSwapJournal;
  private readonly pool: LedgerPoolView;
  private readonly funnel: CredentialWriteFunnel;
  private readonly keychain: KeychainIO;
  private readonly metadata?: MetadataStore;
  private readonly emitAttention?: (item: SwapAttentionInput) => void | Promise<void>;
  private readonly logger: { log: (m: string) => void; warn: (m: string) => void };
  private readonly now: () => string;
  private readonly genSwapId: () => string;
  private readonly reVerifyDelayMs: number;
  private readonly scheduleReVerify: (fn: () => void | Promise<void>, delayMs: number) => void;

  constructor(deps: CredentialSwapExecutorDeps) {
    this.ledger = deps.ledger;
    this.oracle = deps.oracle;
    this.journal = deps.journal;
    this.pool = deps.pool;
    this.funnel = deps.funnel ?? credentialWriteFunnel;
    this.keychain = deps.keychain ?? new SecurityKeychainIO();
    this.metadata = deps.metadata;
    this.emitAttention = deps.emitAttention;
    this.logger = deps.logger ?? { log: () => {}, warn: () => {} };
    this.now = deps.now ?? (() => new Date().toISOString());
    this.genSwapId = deps.genSwapId ?? (() => `${Date.now().toString(36)}-${(swapSeq++).toString(36)}`);
    this.reVerifyDelayMs = deps.reVerifyDelayMs ?? 90_000;
    this.scheduleReVerify =
      deps.scheduleReVerify ??
      ((fn, delayMs) => {
        const t = setTimeout(() => void fn(), delayMs);
        (t as { unref?: () => void }).unref?.();
      });
  }

  /** Map an oracle-probed email to the pool account id that owns it (null if unknown/ambiguous). */
  private accountForEmail(email: string): string | null {
    const matches = this.pool.list().filter((a) => a.email && a.email.toLowerCase() === email.toLowerCase());
    return matches.length === 1 ? matches[0].id : null;
  }

  private parseBlob(raw: string | null): ParsedBlob | null {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown; refreshToken?: unknown } };
      const oauth = parsed?.claudeAiOauth;
      const accessToken = oauth?.accessToken;
      const refreshToken = oauth?.refreshToken;
      if (typeof accessToken !== 'string' || !accessToken) return null;
      if (typeof refreshToken !== 'string' || !refreshToken) return null;
      return { raw, accessToken, refreshToken };
    } catch {
      return null; // @silent-fallback-ok: unparseable blob → precondition failure (no destructive action)
    }
  }

  /**
   * Verify a slot now holds `expectedAccountId`'s credential, by ACCOUNT IDENTITY (oracle).
   * Returns 'ok' | 'mismatch' | 'unavailable' — and CRITICALLY treats every non-confirming oracle
   * outcome as 'unavailable', never 'mismatch' (§2.3.4 — an oracle outage must not trigger repair).
   */
  private async verifySlotIdentity(slot: string, expectedAccountId: string): Promise<'ok' | 'mismatch' | 'unavailable'> {
    const res = await this.oracle.resolveSlotTenant(slot);
    if (res.unavailable || !res.email) return 'unavailable';
    const probedAccount = this.accountForEmail(res.email);
    if (probedAccount === null) return 'unavailable'; // unknown/ambiguous email is NOT a confirmed mismatch
    return probedAccount === expectedAccountId ? 'ok' : 'mismatch';
  }

  /**
   * Exchange the two slots' credentials. Returns a structured outcome; never throws on a normal
   * failure path. See the file header for the safety properties.
   */
  async swap(slotA: string, slotB: string): Promise<SwapOutcome> {
    // ── Step 1: preconditions (exact ledger membership BEFORE any path expansion) ──
    if (slotA === slotB) return { ok: false, reason: 'same-slot' };
    // An UNKNOWN-mode ledger (corrupt on-disk state) fails CLOSED for moves. getAssignment() is NOT
    // unknownMode-guarded (unlike slotOf/tenantOf), so without this a corrupt ledger that still has
    // populated assignments would pass preconditions and then THROW at the commit recordAssignment —
    // AFTER the keychain was already exchanged. Refuse upfront so nothing destructive starts.
    if (this.ledger.isUnknownMode()) return { ok: false, reason: 'ledger-unknown-mode' };
    const asgnA = this.ledger.getAssignment(slotA);
    const asgnB = this.ledger.getAssignment(slotB);
    if (!asgnA || !asgnB) return { ok: false, reason: 'unknown-slot' };
    if (asgnA.quarantined || asgnB.quarantined) return { ok: false, reason: 'tenant-quarantined' };
    const accountA = asgnA.accountId;
    const accountB = asgnB.accountId;
    if (!accountA || !accountB) return { ok: false, reason: 'tenant-missing' };

    const svcA = slotService(slotA);
    const svcB = slotService(slotB);
    const keyA = credentialSlotKey(slotA);
    const keyB = credentialSlotKey(slotB);

    // The whole swap runs under the single-mover mutex (one swap at a time) AND both per-slot
    // locks (canonical order, deadlock-free) so it cannot interleave with a refresh or a swap.
    // The try/catch maps any UNEXPECTED throw (e.g. the ledger entering UNKNOWN mode mid-commit) to a
    // structured outcome — honoring the "never throws on a normal path" contract; the journal+staging
    // left behind (phase `exchanged`, staging retained) are reconciled by boot recovery (Step 5c).
    try {
      const moverResult = await this.funnel.withSingleMover(async () => {
        const lockResult = await this.funnel.withSlotLocks([keyA, keyB], () =>
          this.doSwapLocked(slotA, slotB, svcA, svcB, accountA, accountB),
        );
        if (!lockResult.ran) {
          return { ok: false, reason: 'slot-busy' as SwapReason };
        }
        return lockResult.value as SwapOutcome;
      });
      if (!moverResult.ran) {
        return { ok: false, reason: 'swap-in-flight' };
      }
      return moverResult.value as SwapOutcome;
    } catch (err) {
      this.logger.warn(
        `[CredentialSwapExecutor] swap ${slotA} <-> ${slotB} threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { ok: false, reason: 'internal-error' };
    }
  }

  /** The destructive body — runs while holding the single-mover mutex + both per-slot locks. */
  private async doSwapLocked(
    slotA: string,
    slotB: string,
    svcA: string,
    svcB: string,
    accountA: string,
    accountB: string,
  ): Promise<SwapOutcome> {
    // Read both blobs fresh; parse; confirm a refresh token. Nothing destructive yet.
    let blobA = this.parseBlob(await this.keychain.read(svcA));
    let blobB = this.parseBlob(await this.keychain.read(svcB));
    if (!blobA || !blobB) return { ok: false, reason: 'precondition-blob' };

    // ── Step 1a: source-slot CAS re-read immediately before the destructive write ──
    // The live client could have refreshed (rotated) either slot between the read above and the
    // write below. Re-read; if changed and the new blob parses, ADOPT it (it is the client's
    // freshest rotated copy) — never carry a blob older than what is currently on disk. A changed
    // blob that no longer parses aborts the swap (do not stage garbage). The same-tenant guarantee
    // is structural (a client refresh rotates the token but never changes the account) and is
    // re-confirmed by step 4's oracle verify.
    const reA = this.parseBlob(await this.keychain.read(svcA));
    const reB = this.parseBlob(await this.keychain.read(svcB));
    if (!reA || !reB) return { ok: false, reason: 'precondition-blob' };
    if (reA.raw !== blobA.raw) blobA = reA;
    if (reB.raw !== blobB.raw) blobB = reB;

    // ── Step 2: staging escrow — COPY blob A to the disjoint staging namespace, journal begin ──
    const swapId = this.genSwapId();
    assertStagingDisjoint(swapId);
    const stagingRef = stagingService(swapId);
    const stagedOk = await this.keychain.write(stagingRef, blobA.raw);
    if (!stagedOk) return { ok: false, reason: 'staging-failed' };
    this.journal.begin({ swapId, slotA, slotB, accountA, accountB, stagingRef });

    // ── Step 3: the exchange — write B→slotA, A→slotB (keychain first) ──
    const wroteA = await this.keychain.write(svcA, blobB.raw);
    const wroteB = await this.keychain.write(svcB, blobA.raw);
    if (!wroteA || !wroteB) {
      // A write failed mid-exchange. Recovery (5c) heals from the journal+staging; surface honestly.
      this.journal.advance(swapId, 'exchanged', 'partial-exchange-write-failed');
      await this.raiseAttention(swapId, [slotA, slotB], 'a credential exchange write failed mid-swap — recovery will reconcile from staging');
      return { ok: false, swapId, reason: 'exchange-write-failed' };
    }
    // Metadata (oauthAccount blocks) follow the credential — best-effort, repairable, never quarantine.
    this.exchangeMetadataBestEffort(slotA, slotB, swapId);
    this.journal.advance(swapId, 'exchanged');

    // ── Step 4: verify on ACCOUNT IDENTITY (oracle). unavailable→quarantine; mismatch→repair-once→quarantine ──
    const quarantined: string[] = [];
    // slotA should now hold accountB; slotB should now hold accountA.
    await this.verifyOrQuarantine(slotA, accountB, blobB.raw, swapId, quarantined);
    await this.verifyOrQuarantine(slotB, accountA, blobA.raw, swapId, quarantined, stagingRef);

    if (quarantined.length > 0) {
      // At least one slot could not be confirmed. The other slot (if confirmed) is left consistent;
      // staging is retained for recovery. The swap did NOT cleanly complete.
      this.journal.advance(swapId, 'committed', `quarantined: ${quarantined.join(',')}`);
      return { ok: false, swapId, reason: 'verify-quarantined', quarantined };
    }

    // ── Step 5: commit — update the ledger; journal committed; staging RETAINED ──
    this.ledger.recordAssignment(slotA, accountB, { verifiedAt: this.now() });
    this.ledger.recordAssignment(slotB, accountA, { verifiedAt: this.now() });
    this.journal.advance(swapId, 'committed');

    // ── Step 6: schedule the delayed re-verify, then staging delete ──
    this.scheduleReVerify(
      () => this.delayedReVerify(swapId, slotA, slotB, accountA, accountB, stagingRef),
      this.reVerifyDelayMs,
    );

    return { ok: true, swapId };
  }

  /** Verify a slot; on mismatch attempt ONE repair from the known-good blob, then quarantine. */
  private async verifyOrQuarantine(
    slot: string,
    expectedAccount: string,
    expectedBlobRaw: string,
    swapId: string,
    quarantined: string[],
    repairFromStaging?: string,
  ): Promise<void> {
    const v = await this.verifySlotIdentity(slot, expectedAccount);
    if (v === 'ok') return;
    if (v === 'unavailable') {
      // §2.3.4: an unreachable oracle is NOT a mismatch. Quarantine + stop; the scheduled re-probe
      // (§2.4) clears it when the oracle returns. NEVER repair on unavailable.
      this.ledger.quarantineSlot(slot, `swap ${swapId}: identity oracle unavailable at verify`);
      quarantined.push(slot);
      await this.raiseAttention(swapId, [slot], 'identity oracle unavailable verifying a swapped slot — slot quarantined, will re-probe');
      return;
    }
    // Confirmed mismatch with a reachable oracle → ONE repair from the known-good blob (the in-memory
    // expected blob, or re-read from staging), then re-verify; still wrong → quarantine.
    const repairRaw = repairFromStaging ? (await this.keychain.read(repairFromStaging)) ?? expectedBlobRaw : expectedBlobRaw;
    await this.keychain.write(slotService(slot), repairRaw);
    const v2 = await this.verifySlotIdentity(slot, expectedAccount);
    if (v2 === 'ok') return;
    this.ledger.quarantineSlot(slot, `swap ${swapId}: identity mismatch after repair`);
    quarantined.push(slot);
    await this.raiseAttention(swapId, [slot], 'a swapped slot failed identity verification after one repair — slot quarantined');
  }

  /**
   * §2.3.6: re-verify ~90s post-commit; on clean, delete staging + journal done. The mutating tail
   * (staging delete, quarantine) is a step-6 recovery WRITE, so per spec §2.3 (line 471) it MUST
   * take the single-mover mutex + both per-slot locks — otherwise it races a concurrent swap/refresh
   * on these slots. If a move is in flight (mover/lock busy), do NOT act on a stale view: re-schedule
   * (bounded) and leave staging (the heal source) in place.
   */
  private async delayedReVerify(
    swapId: string,
    slotA: string,
    slotB: string,
    accountA: string,
    accountB: string,
    stagingRef: string,
    attempt = 0,
  ): Promise<void> {
    const keyA = credentialSlotKey(slotA);
    const keyB = credentialSlotKey(slotB);
    const mover = await this.funnel.withSingleMover(async () => {
      const locked = await this.funnel.withSlotLocks([keyA, keyB], async () => {
        const vA = await this.verifySlotIdentity(slotA, accountB);
        const vB = await this.verifySlotIdentity(slotB, accountA);
        if (vA === 'ok' && vB === 'ok') {
          await this.keychain.delete(stagingRef);
          this.journal.advance(swapId, 'done');
          this.ledger.markVerified(slotA);
          this.ledger.markVerified(slotB);
          return;
        }
        // A drift (an in-flight client write-back landed) or an oracle blip. Keep staging (the heal
        // source) and quarantine the unconfirmed slot(s); the always-on identity audit (§2.4) + a
        // later recovery pass reconcile. Do NOT blind-overwrite — that could clobber a newer rotated blob.
        const drifted: string[] = [];
        if (vA !== 'ok') { this.ledger.quarantineSlot(slotA, `swap ${swapId}: re-verify drift`); drifted.push(slotA); }
        if (vB !== 'ok') { this.ledger.quarantineSlot(slotB, `swap ${swapId}: re-verify drift`); drifted.push(slotB); }
        await this.raiseAttention(swapId, drifted, 'a swapped slot drifted at the delayed re-verify — quarantined, staging retained for recovery');
      });
      return locked.ran;
    });
    if (!mover.ran || mover.value === false) {
      // A move was in flight (single-mover held) or a per-slot lock was busy → we did NOT act.
      // Re-schedule rather than acting on a stale view; staging stays (safe — it is the heal source).
      if (attempt < MAX_REVERIFY_RESCHEDULES) {
        this.scheduleReVerify(
          () => this.delayedReVerify(swapId, slotA, slotB, accountA, accountB, stagingRef, attempt + 1),
          this.reVerifyDelayMs,
        );
      } else {
        this.logger.warn(
          `[CredentialSwapExecutor] swap ${swapId} re-verify gave up after ${attempt} reschedules (slots contended) — staging retained for boot-recovery`,
        );
      }
    }
  }

  /**
   * Boot-recovery sweep (spec §2.3 "Boot-recovery window" + Step 5c). For every in-flight swap left
   * in the journal by a crash, resolve it against the on-disk + oracle truth under the single-mover
   * mutex + per-slot locks (recovery WRITES take the locks, like any swap). Safe at every server
   * start; a NO-OP when the journal has no in-flight swaps. Returns one outcome per swap.
   *
   * Journal-driven: every in-flight swap names its `stagingRef`, so this resolves staging for all
   * KNOWN swaps. A staging entry whose journal row was LOST (a corrupt journal) is not enumerated
   * here — it is harmless (the disjoint namespace is never read by a client) and is a documented
   * residual for a keychain-enumeration sweep, not a recovery hazard.
   */
  async recoverInFlight(): Promise<RecoveryOutcome[]> {
    // A corrupt ledger would make recovery's own recordAssignment throw exactly like the swap
    // precondition (2nd-pass concern 2). Re-seed from the oracle first; if that cannot clear it the
    // ledger raises its own HIGH attention item and `commitRecovered` skips the write (the slot is
    // left for a later sweep after a clean re-seed) rather than throwing.
    if (this.ledger.isUnknownMode()) {
      try {
        await this.ledger.seedFromOracle();
      } catch {
        // @silent-fallback-ok: the ledger surfaces its own UNKNOWN-mode attention item.
      }
    }
    const outcomes: RecoveryOutcome[] = [];
    for (const swap of this.journal.inFlight()) {
      outcomes.push(await this.recoverOne(swap));
    }
    return outcomes;
  }

  private async recoverOne(swap: SwapJournalEntry): Promise<RecoveryOutcome> {
    const keyA = credentialSlotKey(swap.slotA);
    const keyB = credentialSlotKey(swap.slotB);
    const mover = await this.funnel.withSingleMover(async () => {
      const locked = await this.funnel.withSlotLocks([keyA, keyB], () => this.resolveInFlightSwap(swap));
      return locked.ran ? locked.value : ({ swapId: swap.swapId, resolution: 'busy' } as RecoveryOutcome);
    });
    if (!mover.ran) return { swapId: swap.swapId, resolution: 'busy' };
    return mover.value as RecoveryOutcome;
  }

  private async resolveInFlightSwap(swap: SwapJournalEntry): Promise<RecoveryOutcome> {
    const { swapId, slotA, slotB, accountA, accountB, stagingRef } = swap;
    // Intended end state: slotA holds accountB, slotB holds accountA.
    const vA = await this.verifySlotIdentity(slotA, accountB);
    const vB = await this.verifySlotIdentity(slotB, accountA);
    if (vA === 'unavailable' || vB === 'unavailable') {
      const q: string[] = [];
      if (vA === 'unavailable') { this.ledger.quarantineSlot(slotA, `recovery ${swapId}: oracle unavailable`); q.push(slotA); }
      if (vB === 'unavailable') { this.ledger.quarantineSlot(slotB, `recovery ${swapId}: oracle unavailable`); q.push(slotB); }
      await this.raiseAttention(swapId, q, 'boot recovery: identity oracle unavailable — slot quarantined, staging retained, will re-probe');
      return { swapId, resolution: 'deferred-oracle-unavailable', quarantined: q };
    }
    if (vA === 'ok' && vB === 'ok') {
      // The exchange completed (or the client healed it) before the crash. Finish it.
      this.commitRecovered(swap);
      await this.keychain.delete(stagingRef);
      this.journal.advance(swapId, 'done', 'recovery: both slots already at intended post-swap state');
      return { swapId, resolution: 'completed' };
    }
    // Not the intended state. Is it the clean PRE-swap state (nothing took)?
    const preA = await this.verifySlotIdentity(slotA, accountA);
    const preB = await this.verifySlotIdentity(slotB, accountB);
    if (preA === 'ok' && preB === 'ok') {
      await this.keychain.delete(stagingRef);
      this.journal.advance(swapId, 'aborted', 'recovery: pre-swap state, no exchange took');
      return { swapId, resolution: 'aborted-noop' }; // ledger already reflects pre-swap
    }
    // Genuinely partial (a crash between the two exchange writes) → re-drive with adopt-on-newer.
    return this.reDriveRecovery(swap);
  }

  /** Idempotently record the intended post-swap assignments; skips writing if the ledger is corrupt. */
  private commitRecovered(swap: SwapJournalEntry): void {
    if (this.ledger.isUnknownMode()) return; // can't write; a later sweep retries after a clean re-seed
    this.ledger.recordAssignment(swap.slotA, swap.accountB, { verifiedAt: this.now() });
    this.ledger.recordAssignment(swap.slotB, swap.accountA, { verifiedAt: this.now() });
  }

  /**
   * Reconstruct a partially-exchanged swap. accountA's credential = the staging escrow; accountB's
   * credential lives at whichever slot currently identity-verifies as accountB (its CURRENT bytes,
   * adopt-on-newer). Write accountB→slotA, accountA(escrow)→slotB, re-verify. If either blob cannot
   * be located, quarantine BOTH and retain staging — never guess.
   */
  private async reDriveRecovery(swap: SwapJournalEntry): Promise<RecoveryOutcome> {
    const { swapId, slotA, slotB, accountA, accountB, stagingRef } = swap;
    const svcA = slotService(slotA);
    const svcB = slotService(slotB);
    const stagedA = await this.keychain.read(stagingRef);
    let blobBLoc: string | null = null;
    if ((await this.verifySlotIdentity(slotA, accountB)) === 'ok') blobBLoc = svcA;
    else if ((await this.verifySlotIdentity(slotB, accountB)) === 'ok') blobBLoc = svcB;
    const blobB = blobBLoc ? await this.keychain.read(blobBLoc) : null;
    if (!stagedA || !blobB) {
      this.ledger.quarantineSlot(slotA, `recovery ${swapId}: unrecoverable partial — escrow/accountB blob missing`);
      this.ledger.quarantineSlot(slotB, `recovery ${swapId}: unrecoverable partial — escrow/accountB blob missing`);
      await this.raiseAttention(swapId, [slotA, slotB], 'boot recovery: a partial swap could not be reconstructed — slots quarantined, staging retained');
      return { swapId, resolution: 'quarantined', quarantined: [slotA, slotB] };
    }
    await this.keychain.write(svcA, blobB); // slotA ← accountB (no-op overwrite if already there)
    await this.keychain.write(svcB, stagedA); // slotB ← accountA (escrow)
    const vA = await this.verifySlotIdentity(slotA, accountB);
    const vB = await this.verifySlotIdentity(slotB, accountA);
    if (vA === 'ok' && vB === 'ok') {
      this.commitRecovered(swap);
      await this.keychain.delete(stagingRef);
      this.journal.advance(swapId, 'done', 'recovery: re-driven and verified');
      return { swapId, resolution: 're-driven' };
    }
    const q: string[] = [];
    if (vA !== 'ok') { this.ledger.quarantineSlot(slotA, `recovery ${swapId}: re-drive verify failed`); q.push(slotA); }
    if (vB !== 'ok') { this.ledger.quarantineSlot(slotB, `recovery ${swapId}: re-drive verify failed`); q.push(slotB); }
    await this.raiseAttention(swapId, q, 'boot recovery: a re-driven swap still failed verification — slot quarantined, staging retained');
    return { swapId, resolution: 'quarantined', quarantined: q };
  }

  private exchangeMetadataBestEffort(slotA: string, slotB: string, swapId: string): void {
    if (!this.metadata) return;
    try {
      const blockA = this.metadata.read(slotA);
      const blockB = this.metadata.read(slotB);
      const okA = this.metadata.write(slotA, blockB);
      const okB = this.metadata.write(slotB, blockA);
      if (!okA || !okB) {
        void this.raiseAttention(swapId, [slotA, slotB], 'credential exchanged OK but the account metadata write failed — repairable, not a credential issue');
      }
    } catch {
      void this.raiseAttention(swapId, [slotA, slotB], 'credential exchanged OK but the account metadata exchange threw — repairable metadata only');
    }
  }

  private async raiseAttention(swapId: string, slots: string[], summary: string): Promise<void> {
    if (!this.emitAttention) return;
    try {
      await this.emitAttention({
        id: `credential-swap:${swapId}`,
        title: 'Credential swap needs attention',
        summary,
        category: 'credential-swap',
        priority: 'HIGH',
        sourceContext: `credential-swap:${slots.join(',')}`,
      });
    } catch {
      // @silent-fallback-ok: attention emission is best-effort; the journal + ledger remain authoritative.
    }
  }
}

/**
 * CredentialSwapExecutor — Step 5 of live credential re-pointing (spec §2.3).
 *
 * The staged exchange that MOVES a credential between two config-home slots WITHOUT restarting
 * the sessions reading those slots (E3: the `claude` client re-reads its store on the next API
 * call). `swap(slotA, slotB)` EXCHANGES the two slots' credentials — never copies — so the §0.d
 * invariant ("one lineage per readable config home") holds by construction for the swap itself.
 *
 * Ships DARK + dry-run for EVERYONE (incl. dev). `subscriptionPool.credentialRepointing` is a
 * `DARK_GATE_EXCLUSIONS` `destructive` entry (`enabled:false` + `dryRun:true`); with the feature
 * off the executor performs ZERO real keychain/config writes (a strict no-op verdict), and with
 * `dryRun` on it runs the full decision loop and AUDITS what it WOULD do without writing. Going
 * live needs a deliberate `enabled:true` AND `dryRun:false` flip (the two-flag gate).
 *
 * ── The staged-exchange mechanism (spec §2.3 steps, each audited) ──
 *  1.  Preconditions: BOTH slots resolve by EXACT membership in the ledger's enumerated slot set
 *      BEFORE any path expansion (a value not `===` a known slot is rejected — `../`/`~`/absolute
 *      traversal can never reach a keychain service, since the value is validated against the
 *      ledger, not the filesystem); neither tenant quarantined; no swap in flight (single-mover);
 *      both blobs re-read fresh, parse, and carry refresh tokens.
 *  1a. Source-slot CAS: immediately before staging/overwriting each slot, RE-READ its on-disk
 *      blob and compare to the step-1 read. If it changed and the new blob parses + identity-
 *      matches the SAME tenant → ADOPT the newer blob (the client's rotated copy); never carry a
 *      blob older than what is on disk. A different-tenant blob is a clobber-race → ABORT.
 *  2.  Staging escrow: COPY (never move) blob A (the 1a re-read, freshest) into a DISJOINT
 *      `instar-credential-swap-staging-<swapId>` keychain entry; journal `begin` BEFORE the first
 *      destructive write. The staging namespace is guaranteed disjoint from every
 *      `claudeCredentialService(home)` output, so no `claude` client / poller ever reads a staged
 *      copy. Staging is RETAINED until step 6's delayed re-verify passes.
 *  3.  The exchange: write blob B → slot A, write blob A (from staging) → slot B — KEYCHAIN FIRST,
 *      then config (`oauthAccount` blocks; default slot config = `~/.claude.json`, home-root).
 *  4.  Verify on ACCOUNT IDENTITY via the oracle (NOT token bytes, NOT auth-status). match→commit;
 *      identity-MISMATCH→repair-from-staging then re-verify, still-wrong→quarantine;
 *      oracle-UNAVAILABLE→QUARANTINE-NEVER-REPAIR (an outage must never trigger a destructive
 *      repair). The system NEVER writes a credential into a slot it cannot identity-verify.
 *  5.  Commit: journal `committed`, ledger assignments updated — staging RETAINED (a client
 *      write-back between commit and step-6 could clobber slot B's only copy; staging is the heal
 *      source for that window).
 *  6.  Delayed re-verify ~90s after commit (oracle identity of both slots); only on pass →
 *      DELETE staging + journal `done`. (90s covers the sub-2-min in-flight refresh; the at-expiry
 *      write-back is the always-on §2.4 audit's job.)
 *
 * ── Crash-safety ── A crash at ANY boundary is decidable from the journal + the two slots' on-disk
 * reads: before step 3's first write nothing destructive happened (staging is a COPY, slot A
 * untouched) → unwind is a no-op; after `begin` and before `done`, staging is the escrow and
 * recovery applies the adopt-on-newer rule (never a blind staging overwrite). `recover()` acquires
 * the single-mover mutex (recovery WRITES race the boot balancer otherwise) and resolves every
 * in-flight journal row; the balancer's first pass is gated on `recoveryBarrier` WITH a bounded
 * hang-timeout (a wedged recovery write must not freeze the balancer forever — on timeout the
 * unresolved slots are quarantined BEFORE the barrier lifts, so the balancer structurally cannot
 * select them).
 *
 * ── Concurrency ── Every swap runs inside `funnel.withSingleMover(() => funnel.withSlotLocks([A,B],
 * …))` so two swaps never overlap and a swap can never interleave with a refresh on the same slot
 * (the Step-4b funnel guards both). All `security` keychain calls go through the async
 * execFile-based `KeychainCredentialExec` with a 10s timeout — NEVER `execFileSync` (a locked
 * keychain ACL prompt would wedge the event loop). The credential WRITE path routes through the
 * funnel; the executor never calls `defaultCredentialStore.write` / `provider.writeCredentials`,
 * so the §2.2 unfunneled-write lint stays clean.
 *
 * ── No token material on any surface ── audit records, journal details, attention items, and the
 * swap-result reference accounts by id / slot only; every free-text error string is scrubbed
 * through `redactToken` before it reaches any persisted/served/notified surface.
 */

import { execFile } from 'node:child_process';
import { credentialSlotKey, claudeCredentialService, expandHome, type ClaudeOauth } from './OAuthRefresher.js';
import type { CredentialWriteFunnel } from './CredentialWriteFunnel.js';
import type { CredentialLocationLedger } from './CredentialLocationLedger.js';
import { redactToken } from '../monitoring/CredentialProvider.js';

const SECURITY_CALL_TIMEOUT_MS = 10_000;
/** Disjoint from every `claudeCredentialService(home)` output (`Claude Code-credentials[-<8hex>]`). */
const STAGING_SERVICE_PREFIX = 'instar-credential-swap-staging-';
const DEFAULT_REVERIFY_DELAY_MS = 90_000;
/** Hang-timeout barrier: a wedged recovery write must not freeze the balancer forever. */
const DEFAULT_RECOVERY_BARRIER_TIMEOUT_MS = 60_000;

// ─── Keychain exec surface (async execFile + 10s timeout; injectable for tests) ──────────────────

/**
 * The async keychain access surface. A slot's credential lives at the keychain service
 * `claudeCredentialService(slot)`; a staged escrow copy lives at `instar-credential-swap-staging-*`.
 * Reads/writes/deletes ALL go through async `execFile` with a 10s timeout — never the SYNC
 * `defaultCredentialStore` (a locked keychain could wedge the event loop) and never
 * `provider.writeCredentials` (the §2.2 lint forbids both outside the funnel; this surface is the
 * funnel-routed Step-5 owner). The default impl uses macOS `security`; tests inject an in-memory map.
 */
export interface KeychainCredentialExec {
  /** Read the raw JSON blob at a keychain SERVICE name (slot service or a staging service). null = absent. */
  readService(service: string): Promise<string | null>;
  /** Write (upsert) the raw JSON blob at a keychain SERVICE name. */
  writeService(service: string, rawJson: string): Promise<void>;
  /** Delete a keychain entry at a SERVICE name (used to remove staging after step 6). */
  deleteService(service: string): Promise<void>;
}

/** Default macOS keychain exec — async `execFile`, 10s timeout. Non-darwin: a per-service file. */
export const defaultKeychainExec: KeychainCredentialExec = {
  readService(service: string): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        execFile(
          'security',
          ['find-generic-password', '-s', service, '-w'],
          { timeout: SECURITY_CALL_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
          (err, stdout) => {
            if (err) {
              resolve(null); // @silent-fallback-ok: no keychain entry (or timeout) → treated as absent; the caller's CAS/precondition decides, never a guess
              return;
            }
            const raw = (stdout ?? '').toString().trim();
            resolve(raw || null);
          },
        );
      } catch {
        resolve(null); // @silent-fallback-ok: spawn failed → absent; never throws into the swap loop
      }
    });
  },
  writeService(service: string, rawJson: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        execFile(
          'security',
          ['add-generic-password', '-U', '-a', process.env.USER ?? 'instar', '-s', service, '-w', rawJson],
          { timeout: SECURITY_CALL_TIMEOUT_MS },
          (err) => (err ? reject(err) : resolve()),
        );
      } catch (err) {
        reject(err as Error);
      }
    });
  },
  deleteService(service: string): Promise<void> {
    return new Promise((resolve) => {
      try {
        execFile(
          'security',
          ['delete-generic-password', '-s', service],
          { timeout: SECURITY_CALL_TIMEOUT_MS },
          () => resolve(), // delete is best-effort: a missing entry is success (idempotent cleanup)
        );
      } catch {
        resolve(); // @silent-fallback-ok: spawn failed on a best-effort delete → leave the (harmless, disjoint) staging entry for the boot-recovery orphan sweep
      }
    });
  },
};

// ─── Config-block exchange surface (oauthAccount metadata; keychain-second per §2.3 step 3) ──────

/**
 * The `oauthAccount` config metadata exchange. The credential keychain blob is the record of
 * truth; config follows (keychain-first/config-second). The DEFAULT slot's canonical config file
 * is `~/.claude.json` (home-root). Injectable so tests assert the ordering; a config-write failure
 * after a successful keychain exchange is a REPAIRABLE metadata condition (never a quarantine).
 */
export interface ConfigBlockExchange {
  /** Move/exchange the two slots' `oauthAccount` config blocks. Resolves on success. */
  exchange(slotA: string, slotB: string): Promise<void>;
}

/** No-op config exchange (the metadata follow is wired in Step 6's census re-routing). */
export const noopConfigBlockExchange: ConfigBlockExchange = {
  async exchange(): Promise<void> {
    /* metadata-follow wired in Step 6 (census #1/#8); the keychain exchange is the record of truth */
  },
};

// ─── Identity resolution (oracle + pool, composed by the host) ───────────────────────────────────

/** Identity verdict for a slot: the confirmed accountId, or unavailable (never a guess). */
export type SlotIdentity =
  | { accountId: string }
  | { unavailable: true; reason: string };

/**
 * Resolve which pool account currently tenants a slot, by reading its blob via the oracle and
 * mapping email→accountId through the pool. Composed by the host from `CredentialIdentityOracle`
 * + the pool; injected so the executor's verify/adopt/repair/quarantine boundary is unit-testable
 * without a live oracle. CONTRACT: an unreachable/slow/5xx/429/ambiguous oracle → `unavailable`
 * (quarantine-never-repair upstream), NEVER a wrong accountId.
 */
export type ResolveSlotIdentity = (slot: string) => Promise<SlotIdentity>;

// ─── Result / audit shapes ───────────────────────────────────────────────────────────────────────

export type SwapOutcome =
  | 'swapped' // committed; staging retained pending the delayed re-verify
  | 'dry-run' // full decision loop ran, zero writes (dryRun on)
  | 'disabled' // feature off — strict no-op
  | 'skipped' // funnel busy (single-mover / slot lock) — transient, retry
  | 'precondition-failed' // a slot is not a known ledger member / quarantined / unparseable
  | 'clobber-race' // source-slot CAS saw a DIFFERENT-tenant blob → aborted, nothing overwritten
  | 'quarantined'; // identity verify could not confirm a slot (mismatch-unrepairable or oracle-unavailable)

export interface SwapResult {
  outcome: SwapOutcome;
  /** Credential-free human reason (scrubbed). */
  reason: string;
  /** The swap id (present once a swap was attempted past preconditions). */
  swapId?: string;
  /** Slot(s) quarantined by this attempt, if any. */
  quarantinedSlots?: string[];
}

/** One audited step (no token material — scrubbed at emit). */
export interface SwapAuditRecord {
  swapId: string;
  step: string;
  slotA: string;
  slotB: string;
  detail?: string;
  at: string;
}

export interface CredentialSwapExecutorDeps {
  funnel: CredentialWriteFunnel;
  ledger: CredentialLocationLedger;
  keychain?: KeychainCredentialExec;
  configExchange?: ConfigBlockExchange;
  /** Compose oracle + pool: slot → confirmed accountId | unavailable. */
  resolveIdentity: ResolveSlotIdentity;
  /** Feature gate (DARK_GATE_EXCLUSIONS destructive). */
  config?: { enabled?: boolean; dryRun?: boolean };
  /** Single audit chokepoint — every step routes here (scrubbed). */
  emitAudit?: (record: SwapAuditRecord) => void;
  /** HIGH attention on a quarantine (the blast-radius surface). */
  emitAttention?: (item: { id: string; title: string; summary: string; category: string; priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW'; sourceContext?: string }) => void | Promise<void>;
  /**
   * Census #8 cache-bust hook. Invoked at commit with the slots whose tenant just changed. The
   * server wires this to `InUseAccountResolver.bustCache()` so a default-slot (`~/.claude`) swap
   * invalidates the stale in-use badge immediately — the keychain-first/config-second window is
   * exactly when a re-probe would re-cache the wrong tenant. Best-effort; never throws into commit.
   */
  onSlotsChanged?: (slots: string[]) => void;
  now?: () => number;
  nowIso?: () => string;
  /** Delay before the step-6 re-verify (ms; default 90_000). Tests inject a small value. */
  reverifyDelayMs?: number;
  /** Recovery-barrier hang-timeout (ms; default 60_000). */
  recoveryBarrierTimeoutMs?: number;
  /** Random/sequence swap-id source (derives from NO token bytes). */
  swapIdFactory?: () => string;
}

/** A parsed credential blob plus the raw JSON we round-trip (preserving every field). */
interface SlotBlob {
  raw: string;
  oauth: ClaudeOauth;
}

export class CredentialSwapExecutor {
  private readonly funnel: CredentialWriteFunnel;
  private readonly ledger: CredentialLocationLedger;
  private readonly keychain: KeychainCredentialExec;
  private readonly configExchange: ConfigBlockExchange;
  private readonly resolveIdentity: ResolveSlotIdentity;
  private readonly config: { enabled: boolean; dryRun: boolean };
  private readonly emitAudit?: (record: SwapAuditRecord) => void;
  private readonly emitAttention?: CredentialSwapExecutorDeps['emitAttention'];
  private readonly onSlotsChanged?: (slots: string[]) => void;
  private readonly now: () => number;
  private readonly nowIso: () => string;
  private readonly reverifyDelayMs: number;
  private readonly recoveryBarrierTimeoutMs: number;
  private readonly swapIdFactory: () => string;

  /** Resolves once boot-recovery has resolved every in-flight journal row (or the barrier timed out). */
  private recoveryResolve: (() => void) | null = null;
  private readonly recoveryBarrier: Promise<void>;
  private recoveryDone = false;
  private seq = 0;

  constructor(deps: CredentialSwapExecutorDeps) {
    this.funnel = deps.funnel;
    this.ledger = deps.ledger;
    this.keychain = deps.keychain ?? defaultKeychainExec;
    this.configExchange = deps.configExchange ?? noopConfigBlockExchange;
    this.resolveIdentity = deps.resolveIdentity;
    this.config = { enabled: deps.config?.enabled ?? false, dryRun: deps.config?.dryRun ?? true };
    this.emitAudit = deps.emitAudit;
    this.emitAttention = deps.emitAttention;
    this.onSlotsChanged = deps.onSlotsChanged;
    this.now = deps.now ?? (() => Date.now());
    this.nowIso = deps.nowIso ?? (() => new Date(this.now()).toISOString());
    this.reverifyDelayMs = deps.reverifyDelayMs ?? DEFAULT_REVERIFY_DELAY_MS;
    this.recoveryBarrierTimeoutMs = deps.recoveryBarrierTimeoutMs ?? DEFAULT_RECOVERY_BARRIER_TIMEOUT_MS;
    this.swapIdFactory = deps.swapIdFactory ?? (() => `${Date.now().toString(36)}-${(this.seq++).toString(36)}`);
    this.recoveryBarrier = new Promise<void>((resolve) => {
      this.recoveryResolve = resolve;
    });
  }

  /**
   * The balancer's first pass awaits THIS before selecting any pair — so a recovery WRITE can't
   * race a fresh swap on a different slot pair (round-2 unmutexed write-write find). Bounded by a
   * hang-timeout: a wedged recovery write must not freeze the balancer forever.
   */
  awaitRecoveryComplete(): Promise<void> {
    return this.recoveryBarrier;
  }

  isRecoveryComplete(): boolean {
    return this.recoveryDone;
  }

  // ── Audit / scrub chokepoint ────────────────────────────────────────────────────────────────

  /** SINGLE emit chokepoint — every record is scrubbed of token material here (§2.9). */
  private audit(swapId: string, step: string, slotA: string, slotB: string, detail?: string): void {
    if (!this.emitAudit) return;
    this.emitAudit({ swapId, step, slotA, slotB, detail: detail ? scrub(detail) : undefined, at: this.nowIso() });
  }

  /** Census #8: fire the cache-bust hook (best-effort — a consumer error never breaks commit). */
  private notifySlotsChanged(slots: string[]): void {
    if (!this.onSlotsChanged) return;
    try {
      this.onSlotsChanged(slots);
    } catch {
      // @silent-fallback-ok — the cache-bust is an observability nicety (a stale in-use badge
      // self-corrects at TTL expiry). A throwing consumer must never roll back or break the
      // already-committed swap, which is the load-bearing operation; the slots are exchanged
      // whether or not the badge was busted.
    }
  }

  private stagingService(swapId: string): string {
    return `${STAGING_SERVICE_PREFIX}${swapId}`;
  }

  // ── The swap (spec §2.3) ──────────────────────────────────────────────────────────────────────

  /**
   * EXCHANGE the credentials of two slots. Returns a verdict; never throws into the caller for an
   * expected condition (precondition fail / clobber-race / quarantine / busy lock are all results).
   */
  async swap(slotA: string, slotB: string): Promise<SwapResult> {
    // DARK: feature off → strict no-op (zero writes). This is the dark-ship inertness guarantee.
    if (!this.config.enabled) {
      return { outcome: 'disabled', reason: 'credential re-pointing is disabled (dark) — no swap performed' };
    }

    // Step 1 (precondition, pre-lock): EXACT ledger membership BEFORE any path expansion. A value
    // not === a known slot is rejected — `../`/`~`/absolute traversal can never reach a keychain
    // service because we validate against the ledger's enumerated set, not the filesystem.
    const memberSlots = new Set(this.ledger.getAssignments().map((a) => a.slot));
    if (slotA === slotB) {
      return { outcome: 'precondition-failed', reason: 'slotA and slotB are the same slot' };
    }
    if (!memberSlots.has(slotA) || !memberSlots.has(slotB)) {
      return {
        outcome: 'precondition-failed',
        reason: `a slot is not a known ledger member (got '${slotA}', '${slotB}') — refusing an arbitrary keychain/path write`,
      };
    }
    const aAssign = this.ledger.getAssignment(slotA);
    const bAssign = this.ledger.getAssignment(slotB);
    if (aAssign?.quarantined || bAssign?.quarantined) {
      return { outcome: 'precondition-failed', reason: 'a slot tenant is quarantined — excluded from balancing' };
    }

    // Take the single-mover mutex (no swap in flight) THEN both slot locks (canonical order). The
    // funnel returns a SKIP rather than blocking → a busy lock is a transient retry, never a wedge.
    const moverResult = await this.funnel.withSingleMover(async () => {
      return this.funnel.withSlotLocks([credentialSlotKey(slotA), credentialSlotKey(slotB)], () =>
        this.swapLocked(slotA, slotB, aAssign?.accountId ?? '', bAssign?.accountId ?? ''),
      );
    });

    if (!moverResult.ran) {
      return { outcome: 'skipped', reason: scrub(moverResult.skippedReason ?? 'funnel busy') };
    }
    const inner = moverResult.value as { ran: boolean; value?: SwapResult; skippedReason?: string };
    if (!inner.ran) {
      return { outcome: 'skipped', reason: scrub(inner.skippedReason ?? 'slot lock busy') };
    }
    return inner.value as SwapResult;
  }

  /** Runs under the single-mover mutex + both slot locks. */
  private async swapLocked(slotA: string, slotB: string, expectA: string, expectB: string): Promise<SwapResult> {
    const swapId = this.swapIdFactory();

    // Step 1 (continued): re-read both blobs fresh; they must parse + carry refresh tokens.
    const read1A = await this.readBlob(slotA);
    const read1B = await this.readBlob(slotB);
    if (!read1A || !read1B) {
      return { outcome: 'precondition-failed', reason: `a slot blob is missing/unparseable or lacks a refresh token`, swapId };
    }

    // Step 1a: source-slot CAS — re-read each slot immediately before it is staged/overwritten. If
    // a slot changed AND the new blob is the SAME tenant → ADOPT it (the client's rotated copy). A
    // DIFFERENT-tenant blob is a clobber-race → ABORT, overwrite nothing.
    const casA = await this.casReread(slotA, read1A, expectA, swapId);
    if (casA.aborted) return { outcome: 'clobber-race', reason: casA.reason, swapId };
    const casB = await this.casReread(slotB, read1B, expectB, swapId);
    if (casB.aborted) return { outcome: 'clobber-race', reason: casB.reason, swapId };
    const blobA = casA.blob; // freshest A (adopted if the client rotated it)
    const blobB = casB.blob; // freshest B

    // dryRun: full decision loop ran, ZERO writes. Audit the WOULD-swap and stop before step 2.
    if (this.config.dryRun) {
      this.audit(swapId, 'dry-run', slotA, slotB, `would exchange ${expectA}<->${expectB}`);
      return { outcome: 'dry-run', reason: 'dry-run — decision computed, zero credential writes', swapId };
    }

    // Step 2: staging escrow — COPY blob A into a disjoint staging entry, THEN journal `begin`
    // BEFORE the first destructive write. (COPY not move: slot A is untouched until step 3, so a
    // crash before step 3 unwinds to a true no-op.)
    const staging = this.stagingService(swapId);
    await this.keychain.writeService(staging, blobA.raw);
    this.ledger.appendJournal({ op: 'swap', phase: 'begin', slots: [slotA, slotB], detail: `swapId=${swapId} staging` });
    this.audit(swapId, 'begin', slotA, slotB, `staged A; exchanging ${expectA}<->${expectB}`);

    // Step 3: the exchange — KEYCHAIN FIRST (write B→slotA, then A→slotB from staging), config
    // second. The between-the-two-writes crash point is recovery-decidable (journal begin + the
    // two slots' on-disk reads + the retained staging copy of A).
    await this.keychain.writeService(claudeCredentialService(slotA), blobB.raw);
    await this.keychain.writeService(claudeCredentialService(slotB), blobA.raw);
    this.ledger.appendJournal({ op: 'swap', phase: 'exchanged', slots: [slotA, slotB], detail: `swapId=${swapId} keychain` });
    try {
      await this.configExchange.exchange(slotA, slotB);
    } catch (err) {
      // Config-write failure AFTER a successful keychain exchange is a REPAIRABLE metadata
      // condition — never a quarantine. Audited; the metadata-follow retry is the §2.3 step-3 path.
      this.audit(swapId, 'config-exchange-deferred', slotA, slotB, `metadata follow failed (repairable): ${(err as Error)?.message ?? 'unknown'}`);
    }

    // Step 4: verify on ACCOUNT IDENTITY. The credential now in slotA must be expectB's; the one
    // in slotB must be expectA's.
    const verify = await this.verifyAndHeal(slotA, slotB, expectB, expectA, staging, blobB, blobA, swapId);
    if (verify.quarantined) {
      return { outcome: 'quarantined', reason: verify.reason, swapId, quarantinedSlots: verify.quarantinedSlots };
    }

    // Step 5: commit — ledger assignments updated; staging RETAINED (heal source through step 6).
    this.ledger.appendJournal({ op: 'swap', phase: 'verified', slots: [slotA, slotB], detail: `swapId=${swapId}` });
    this.ledger.recordAssignment(slotA, expectB, { verifiedAt: this.nowIso(), op: 'swap' });
    this.ledger.recordAssignment(slotB, expectA, { verifiedAt: this.nowIso(), op: 'swap' });
    this.audit(swapId, 'committed', slotA, slotB, `tenants exchanged (staging retained)`);
    // Census #8: the slot tenants just changed — bust any in-use badge cache so a default-slot
    // (`~/.claude`) swap doesn't leave the dashboard showing the pre-swap tenant for a full TTL.
    this.notifySlotsChanged([slotA, slotB]);

    // Step 6: delayed re-verify, then staging delete. Scheduled (does NOT block the swap return);
    // a client whose refresh exchange was in flight DURING the swap lands its write after step 4.
    this.scheduleReverify(slotA, slotB, expectB, expectA, staging, swapId);

    return { outcome: 'swapped', reason: 'credentials exchanged; staging retained pending delayed re-verify', swapId };
  }

  // ── Step 1a: source-slot CAS ──────────────────────────────────────────────────────────────────

  private async casReread(
    slot: string,
    read1: SlotBlob,
    expectTenant: string,
    swapId: string,
  ): Promise<{ aborted: false; blob: SlotBlob } | { aborted: true; reason: string }> {
    const fresh = await this.readBlob(slot);
    if (!fresh) {
      // The slot became unreadable between step 1 and the destructive write → abort (do not write a
      // stale copy over an absent/garbage on-disk state).
      return { aborted: true, reason: `slot '${slot}' became unreadable before write (CAS)` };
    }
    if (fresh.raw === read1.raw) {
      return { aborted: false, blob: read1 }; // unchanged
    }
    // It changed. Is the new blob the SAME tenant? Adopt; else it's a clobber-race → abort.
    const identity = await this.resolveIdentity(slot);
    if ('unavailable' in identity) {
      // Cannot confirm the tenant of the changed blob → do NOT guess. Abort the swap (the safe
      // direction: never overwrite a blob we cannot identity-verify is the same lineage).
      return { aborted: true, reason: `CAS: slot '${slot}' changed and identity is unavailable — aborting (${identity.reason})` };
    }
    if (identity.accountId !== expectTenant) {
      this.audit(swapId, 'clobber-race', slot, slot, `CAS saw a different-tenant blob (expected ${expectTenant})`);
      return { aborted: true, reason: `CAS: slot '${slot}' now holds a different tenant — clobber-race, aborting` };
    }
    // Same tenant, newer blob → ADOPT (the client's rotated copy).
    this.audit(swapId, 'cas-adopt', slot, slot, `adopted the client's rotated same-tenant blob`);
    return { aborted: false, blob: fresh };
  }

  // ── Step 4: verify-and-heal (identity match → adopt / mismatch → repair / unavailable → quarantine) ──

  private async verifyAndHeal(
    slotA: string,
    slotB: string,
    wantA: string,
    wantB: string,
    staging: string,
    blobForA: SlotBlob,
    blobForB: SlotBlob,
    swapId: string,
  ): Promise<{ quarantined: boolean; reason: string; quarantinedSlots?: string[] }> {
    const quarantined: string[] = [];

    for (const [slot, want, blob] of [
      [slotA, wantA, blobForA],
      [slotB, wantB, blobForB],
    ] as const) {
      const id = await this.resolveIdentity(slot);
      if ('unavailable' in id) {
        // Oracle UNAVAILABLE during verify → quarantine-never-repair (an outage must never trigger
        // a destructive repair). Leave the slot quarantined; the scheduled §2.4 re-probe clears it.
        this.ledger.quarantineSlot(slot, scrub(`oracle unavailable at verify: ${id.reason}`));
        await this.raiseQuarantineAttention(slot, swapId, 'oracle unavailable at verify');
        this.audit(swapId, 'quarantine-oracle-unavailable', slotA, slotB, `slot=${slot}`);
        quarantined.push(slot);
        continue;
      }
      if (id.accountId === want) {
        continue; // identity match → good
      }
      // Identity MISMATCH with a reachable oracle → ONE repair from staging/fresh blob, re-verify.
      this.audit(swapId, 'repair-attempt', slotA, slotB, `slot=${slot} expected=${want} got=${id.accountId}`);
      await this.keychain.writeService(claudeCredentialService(slot), blob.raw);
      const reId = await this.resolveIdentity(slot);
      if (!('unavailable' in reId) && reId.accountId === want) {
        this.audit(swapId, 'repair-ok', slotA, slotB, `slot=${slot}`);
        continue;
      }
      // Still wrong (or the oracle went unavailable on re-verify) → quarantine, leave the other
      // slot consistent. The bounded blast radius is one account re-auth (§6).
      this.ledger.quarantineSlot(slot, scrub(`identity unrepairable after one attempt (wanted ${want})`));
      await this.raiseQuarantineAttention(slot, swapId, 'identity mismatch unrepairable');
      this.audit(swapId, 'quarantine-mismatch', slotA, slotB, `slot=${slot}`);
      quarantined.push(slot);
    }

    if (quarantined.length > 0) {
      return { quarantined: true, reason: 'one or more slots could not be identity-confirmed — quarantined (never repaired blindly)', quarantinedSlots: quarantined };
    }
    return { quarantined: false, reason: 'both slots identity-confirmed' };
  }

  // ── Step 6: delayed re-verify + staging delete ────────────────────────────────────────────────

  private scheduleReverify(
    slotA: string,
    slotB: string,
    wantA: string,
    wantB: string,
    staging: string,
    swapId: string,
  ): void {
    const run = async () => {
      try {
        await this.reverifyNow(slotA, slotB, wantA, wantB, staging, swapId);
      } catch (err) {
        // @silent-fallback-ok — the delayed re-verify is best-effort cleanup; a failure here leaves
        // the journal at `committed` and staging RETAINED, which boot-recovery resolves (the
        // crash-safe state). It must never throw out of a timer and crash the process.
        this.audit(swapId, 'reverify-error', slotA, slotB, scrub((err as Error)?.message ?? 'unknown'));
      }
    };
    const t = setTimeout(() => void run(), this.reverifyDelayMs);
    if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref();
  }

  /** Run the step-6 re-verify immediately (exposed for deterministic tests). */
  async reverifyNow(
    slotA: string,
    slotB: string,
    wantA: string,
    wantB: string,
    staging: string,
    swapId: string,
  ): Promise<void> {
    let allGood = true;
    for (const [slot, want] of [
      [slotA, wantA],
      [slotB, wantB],
    ] as const) {
      const id = await this.resolveIdentity(slot);
      if ('unavailable' in id || id.accountId !== want) {
        // A write-back clobbered the slot (or the oracle is down). Do NOT blind-overwrite with
        // staging (adopt-on-newer): re-read the slot; if it already identity-matches, the client
        // healed it. Otherwise the honest outcome is needs-reauth/quarantine — surfaced, not papered.
        allGood = false;
        this.audit(swapId, 'reverify-divergence', slotA, slotB, `slot=${slot} want=${want}`);
        if ('unavailable' in id) {
          this.ledger.quarantineSlot(slot, scrub(`step-6 re-verify: oracle unavailable (${id.reason})`));
        } else {
          this.ledger.quarantineSlot(slot, scrub(`step-6 re-verify: slot diverged from ${want} (a client write-back)`));
        }
        await this.raiseQuarantineAttention(slot, swapId, 'delayed re-verify divergence');
      }
    }
    if (allGood) {
      // Both slots still correct → delete staging, journal `done`. Staging is the heal source ONLY
      // through this point (retaining it past `done` would orphan it; the sweep predicate protects
      // any non-`done` row).
      await this.keychain.deleteService(staging);
      this.ledger.appendJournal({ op: 'swap', phase: 'done', slots: [slotA, slotB], detail: `swapId=${swapId} reverified` });
      this.audit(swapId, 'done', slotA, slotB, 'delayed re-verify passed; staging deleted');
    }
  }

  // ── Boot recovery (single-mover mutex; resolves in-flight journal rows; barrier with hang-timeout) ──

  /**
   * Resolve every in-flight swap journal row left by a crash. Acquires the single-mover mutex (a
   * recovery WRITE must not race a boot balancer pass on the ledger). When it finishes (or the
   * hang-timeout fires) the recovery barrier lifts so the balancer's first pass can run. A wedged
   * recovery write quarantines its slots BEFORE the barrier lifts, so the post-lift balancer
   * structurally cannot select a wedged slot.
   */
  async recover(): Promise<void> {
    if (this.recoveryDone) return;
    let lifted = false;
    const lift = () => {
      if (lifted) return;
      lifted = true;
      this.recoveryDone = true;
      this.recoveryResolve?.();
    };
    // Hang-timeout: a wedged recovery write (a keychain ACL prompt on the default slot) must not
    // freeze the barrier forever. On timeout, quarantine the unresolved in-flight slots FIRST,
    // THEN lift — the per-write 10s execFile timeout is what actually releases a held lock.
    const inFlight = this.inFlightSwaps();
    const barrierTimer = setTimeout(() => {
      for (const e of inFlight) {
        for (const slot of e.slots) {
          try {
            this.ledger.quarantineSlot(slot, 'boot-recovery barrier timed out — slot unresolved, fail-closed');
          } catch {
            /* @silent-fallback-ok — ledger may be UNKNOWN-mode; the barrier still lifts so the balancer can run on the healthy remainder */
          }
        }
      }
      lift();
    }, this.recoveryBarrierTimeoutMs);
    if (typeof (barrierTimer as { unref?: () => void }).unref === 'function') (barrierTimer as { unref: () => void }).unref();

    try {
      await this.funnel.withSingleMover(async () => {
        for (const entry of inFlight) {
          await this.recoverEntry(entry);
        }
      });
    } finally {
      clearTimeout(barrierTimer);
      lift();
    }
  }

  /** In-flight swap journal rows = a `begin`/`exchanged`/`verified` row whose swapId has no later `done`/`aborted`. */
  private inFlightSwaps(): { swapId: string; slots: string[]; lastPhase: string }[] {
    const bySwap = new Map<string, { slots: string[]; phases: Set<string> }>();
    for (const e of this.ledger.getJournal()) {
      if (e.op !== 'swap') continue;
      const id = parseSwapId(e.detail);
      if (!id) continue;
      const rec = bySwap.get(id) ?? { slots: e.slots, phases: new Set<string>() };
      rec.phases.add(e.phase);
      if (e.slots.length) rec.slots = e.slots;
      bySwap.set(id, rec);
    }
    const out: { swapId: string; slots: string[]; lastPhase: string }[] = [];
    for (const [swapId, rec] of bySwap) {
      const terminal = rec.phases.has('done') || rec.phases.has('aborted');
      if (terminal) continue;
      const lastPhase = rec.phases.has('verified') ? 'verified' : rec.phases.has('exchanged') ? 'exchanged' : 'begin';
      out.push({ swapId, slots: rec.slots, lastPhase });
    }
    return out;
  }

  /**
   * Resolve one in-flight entry. Per §2.3 recovery decidability: re-read each slot, apply
   * adopt-on-newer (never a blind staging overwrite), and verify identity; an unverifiable slot is
   * quarantined (never repaired blindly). Staging is deleted + the row closed `done` ONLY when
   * both slots verify; otherwise the row stays in-flight and its staging is retained (the sweep
   * predicate protects any non-`done` row).
   */
  private async recoverEntry(entry: { swapId: string; slots: string[]; lastPhase: string }): Promise<void> {
    const [slotA, slotB] = entry.slots;
    if (!slotA || !slotB) {
      // Cannot resolve a malformed entry; close it aborted (nothing to heal that we can identify).
      this.ledger.appendJournal({ op: 'swap', phase: 'aborted', slots: entry.slots, detail: `swapId=${entry.swapId} unrecoverable-entry` });
      return;
    }
    // The ledger's intended tenants after this swap are the CURRENT assignments (recordAssignment
    // ran iff the swap committed); for an in-flight entry we resolve by reading the live identity
    // of each slot and quarantining anything we cannot confirm. We never guess a tenant.
    const staging = this.stagingService(entry.swapId);
    let allConfirmed = true;
    for (const slot of [slotA, slotB]) {
      const id = await this.resolveIdentity(slot);
      if ('unavailable' in id) {
        allConfirmed = false;
        this.ledger.quarantineSlot(slot, scrub(`boot-recovery: oracle unavailable (${id.reason})`));
        await this.raiseQuarantineAttention(slot, entry.swapId, 'boot-recovery oracle unavailable');
      }
    }
    if (allConfirmed) {
      // Both slots carry a confirmable tenant → the exchange is coherent; clean up staging + close.
      await this.keychain.deleteService(staging);
      this.ledger.appendJournal({ op: 'swap', phase: 'done', slots: entry.slots, detail: `swapId=${entry.swapId} recovered` });
      this.audit(entry.swapId, 'recovered', slotA, slotB, 'boot-recovery confirmed both slots');
    } else {
      // Leave the row in-flight (staging retained — the heal source). The slot(s) are quarantined
      // and excluded from balancing until a clean re-probe; staging is NOT deleted.
      this.audit(entry.swapId, 'recover-deferred', slotA, slotB, 'a slot unconfirmed — staging retained, slots quarantined');
    }
  }

  // ── Orphan-staging sweep (boot) ───────────────────────────────────────────────────────────────

  /**
   * A staging entry is an ORPHAN iff its swapId has NO journal row, OR its row is `done`. Any
   * non-`done` row (begin/exchanged/verified) PROTECTS its staging (the heal source through step
   * 6 — a literal "in-flight = begin only" reading would delete a committed row's heal source).
   * Caller supplies the live staging-service list (the executor never enumerates the keychain).
   */
  async sweepOrphanStaging(stagingServices: string[]): Promise<string[]> {
    // A swapId is PROTECTED iff it is currently in-flight — i.e. it has at least one swap journal
    // row and NONE of them is terminal (`done`/`aborted`). `inFlightSwaps()` computes exactly that
    // (a swapId with ANY `done` row drops out). A `done`/`aborted` swapId and a swapId with no row
    // at all are both UNPROTECTED → their staging is an orphan and is deleted. (The earlier
    // per-row "protect on any non-done row" reading would wrongly retain a finished swap's staging
    // whose history still carries its `begin` row — the lost-source bug this predicate avoids in
    // the other direction.)
    const inFlightIds = new Set(this.inFlightSwaps().map((e) => e.swapId));
    const deleted: string[] = [];
    for (const service of stagingServices) {
      if (!service.startsWith(STAGING_SERVICE_PREFIX)) continue;
      const id = service.slice(STAGING_SERVICE_PREFIX.length);
      if (inFlightIds.has(id)) continue;
      await this.keychain.deleteService(service);
      deleted.push(service);
    }
    return deleted;
  }

  // ── Blob read + validation ────────────────────────────────────────────────────────────────────

  /** Read a slot's blob via the async keychain exec; require it parse + carry a refresh token. */
  private async readBlob(slot: string): Promise<SlotBlob | null> {
    const raw = await this.keychain.readService(claudeCredentialService(slot));
    if (!raw) return null;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null; // @silent-fallback-ok: unparseable blob → precondition fail (never overwritten); the caller refuses the swap
    }
    const oauth = (parsed?.claudeAiOauth ?? null) as ClaudeOauth | null;
    if (!oauth || typeof oauth !== 'object') return null;
    if (typeof oauth.refreshToken !== 'string' || !oauth.refreshToken) return null;
    return { raw, oauth };
  }

  private async raiseQuarantineAttention(slot: string, swapId: string, why: string): Promise<void> {
    if (!this.emitAttention) return;
    try {
      await this.emitAttention({
        id: `credential-swap-quarantine:${credentialSlotKey(slot)}`,
        title: 'A credential slot was quarantined during a swap',
        summary: scrub(`Slot ${expandHome(slot)} was quarantined (${why}); it is excluded from balancing until a clean re-probe. Blast radius: one account may need re-auth.`),
        category: 'credential-repointing',
        priority: 'HIGH',
        sourceContext: 'credential-swap-executor',
      });
    } catch {
      // @silent-fallback-ok — best-effort notice; the quarantine (the safety action) is already
      // durably recorded in the ledger whether or not this notice is delivered.
    }
  }
}

// ─── Module helpers ──────────────────────────────────────────────────────────────────────────────

/** Extract `swapId=<id>` from a journal detail string. */
function parseSwapId(detail?: string): string | null {
  if (!detail) return null;
  const m = /swapId=([^\s]+)/.exec(detail);
  return m ? m[1] : null;
}

/**
 * Scrub any token material from a free-text string before it reaches a persisted/served/notified
 * surface (§2.9 single-emit chokepoint). Catches the `sk-ant-…` family via `redactToken` on any
 * token-shaped run, so a `security` stderr or a `${raw}`-bearing interpolation can't leak a byte.
 */
function scrub(s: string): string {
  if (!s) return s;
  return s.replace(/sk-ant-[A-Za-z0-9_-]+/g, (m) => redactToken(m));
}

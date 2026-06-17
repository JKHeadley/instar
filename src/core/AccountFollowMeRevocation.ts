/**
 * WS5.2 R12 — Revocation / de-authorization data-plane executor (Mechanism B, the DEFAULT).
 *
 * "Stop following to machine X" is TWO things: a control-plane mandate revocation (PIN-gated on the
 * Mandates tab; the agent CANNOT revoke — that authority stays with MandateGate) PLUS a real
 * data-plane effect. This module is the data-plane half: it CONSUMES a revocation signal (the
 * control-plane revoke already happened) and computes the honest data-plane outcome. It NEVER
 * self-revokes the mandate and is NOT a new blocking authority — it is a deterministic planner +
 * honest-state surface over INJECTED side-effect deps (logout, slot delete, SubscriptionPool.remove,
 * attention emit, pending store). No direct I/O in the logic; every effect is injected so each is
 * independently unit-testable (mirrors AccountFollowMeService / Grants / Orchestrator style).
 *
 * R12 has three honesty-load-bearing branches:
 *
 *   (i)  COOPERATIVE, still-paired target ONLINE (R12.i): the data-plane effect is local & total —
 *        the target logs the account OUT of its config-home, deletes the per-account slot, and
 *        SubscriptionPool.remove(accountId) fires on the target. End state: `removed`.
 *
 *   (ii) DE-PAIRED / HOSTILE / non-cooperative holder (S8 / R12.i corrected): a B-minted credential
 *        is an independently-refreshable real OAuth login; instar CANNOT force the logout remotely.
 *        The HONEST revocation path is provider-side de-authorization. We surface a phone-first
 *        instruction ("machine X still holds its own live login for account Y — de-authorize/rotate
 *        at <provider> to kill it"), NEVER a false "removed everywhere". End state:
 *        `provider-rotation-required`. (When a machine de-pairs, MachineStatus flips to 'revoked' —
 *        that flip is the caller's; this module READS that status and refuses to claim a wipe.)
 *
 *   (iii) OFFLINE-honest pending, BOUNDED (R12.iii): a still-paired target that is OFFLINE at revoke
 *        time gets its control-plane revoke immediately, but the data-plane wipe becomes a DURABLE
 *        pending action fired when it reconnects ("write it down durably, fire on return", the
 *        cross-machine-secret-sync pattern). Dashboard shows `revocation-pending`, NEVER `removed`.
 *        The pending wipe is NOT unbounded: after a fixed, operator-tunable reconnect-deadline it
 *        ESCALATES to a LOUD `revocation-FAILED — rotate at provider NOW` aggregated HIGH attention
 *        item (resume-queue give-up discipline). Honest end state of an offline-forever / terminated
 *        VM is "rotate at provider", never a silently-aging "pending".
 *
 * FAIL CLOSED on uncertainty: if we cannot positively confirm the cooperative-online wipe path
 * (unknown reachability, revoked status, the wipe effect threw), we NEVER report `removed` — we fall
 * to pending or provider-rotation-required. Deny-by-default for the optimistic "removed" claim.
 *
 * Mechanism A (sealed-transport) is dark/refused-for-Anthropic; per R9 it is out of scope here
 * beyond the minimal `mechanism` discriminator — a Mechanism-A revoke ALSO requires the wipe verb +
 * an unconditional provider-rotation prompt (a delivered credential cannot be un-delivered), so this
 * module flags `providerRotationRequired: true` for any Mechanism-A revoke regardless of branch.
 */

export type RevocationMechanism = 're-mint' | 'credential-transport';

/** Target reachability/cooperation posture at revoke time — drives the R12 branch. */
export type TargetPosture =
  | 'cooperative-online' // still-paired, online, running instar that will obey the logout (R12.i)
  | 'offline' //          still-paired but offline right now (R12.iii — durable pending)
  | 'revoked'; //         de-paired / hostile / MachineStatus==='revoked' (R12.i corrected / S8)

/** Honest end-state of a revocation's DATA plane (never conflate with the control-plane revoke). */
export type RevocationDataState =
  | 'removed' //                 cooperative-online wipe confirmed: logout + slot delete + pool.remove
  | 'revocation-pending' //      offline target: durable pending wipe, within the reconnect deadline
  | 'revocation-failed' //       offline target past the deadline: gave up — rotate at provider NOW
  | 'provider-rotation-required'; // de-paired/hostile (or Mechanism A): only provider-side kills it

export interface RevocationRequest {
  accountId: string;
  /** Operator-facing account email (shown in honest operator messaging). */
  accountEmail: string;
  targetMachineId: string;
  /** Operator-facing nickname of the target machine (shown in honest operator messaging). */
  targetMachineNickname: string;
  /** Provider name for the provider-side de-authorization instruction (e.g. 'Anthropic'). */
  provider: string;
  /** The mandate id whose control-plane revoke triggered this data-plane effect (audit). */
  mandateId: string;
  /** Default 're-mint' (Mechanism B). 'credential-transport' ⇒ unconditional provider rotation. */
  mechanism?: RevocationMechanism;
}

/** A phone-first provider-side de-authorization instruction — a real instruction, NOT a "handled" claim. */
export interface ProviderRotationInstruction {
  kind: 'provider-rotation-required';
  accountId: string;
  accountEmail: string;
  targetMachineId: string;
  targetMachineNickname: string;
  provider: string;
  /** Plain-English, honest message surfaced to the operator (never implies instar removed it). */
  message: string;
}

/** A LOUD aggregated attention item for an offline target that gave up (R12.iii give-up). */
export interface RevocationFailedAttention {
  /** Stable id so the item dedups per (account,target) — one running item, not a flood (P17). */
  id: string;
  title: string;
  body: string;
  priority: 'high';
  source: 'agent';
}

/** A durable pending-wipe record — fired on the target's reconnect; bounded by the deadline. */
export interface PendingWipeRecord {
  accountId: string;
  targetMachineId: string;
  mandateId: string;
  provider: string;
  accountEmail: string;
  targetMachineNickname: string;
  mechanism: RevocationMechanism;
  /** When the control-plane revoke fired — the deadline clock starts here. */
  revokedAt: number;
  /** Absolute deadline; after this a still-pending wipe escalates to revocation-failed. */
  deadlineAt: number;
}

/** Durable persistence seam for pending wipes (production: JSON/SQLite; tests: in-memory). */
export interface PendingWipeStore {
  /** Upsert keyed on `${accountId}::${targetMachineId}`. */
  put(record: PendingWipeRecord): void;
  /** Resolve (the wipe fired) — remove the pending record. */
  remove(accountId: string, targetMachineId: string): void;
  get(accountId: string, targetMachineId: string): PendingWipeRecord | undefined;
  all(): PendingWipeRecord[];
}

export function inMemoryPendingWipeStore(): PendingWipeStore {
  const map = new Map<string, PendingWipeRecord>();
  const key = (a: string, t: string) => `${a}::${t}`;
  return {
    put: (r) => { map.set(key(r.accountId, r.targetMachineId), r); },
    remove: (a, t) => { map.delete(key(a, t)); },
    get: (a, t) => map.get(key(a, t)),
    all: () => [...map.values()],
  };
}

/** Outcome of an attempted cooperative-online data-plane wipe (each step injected). */
export interface CooperativeWipeResult {
  loggedOut: boolean;
  slotDeleted: boolean;
  poolRemoved: boolean;
}

export interface AccountFollowMeRevocationDeps {
  /** Master gate: the whole feature is dark unless this is true (single-machine / flag-off ⇒ no-op). */
  enabled: () => boolean;
  /**
   * Execute the cooperative data-plane wipe ON the (online, still-paired) target: framework logout
   * against that CLAUDE_CONFIG_DIR + delete the per-account slot + SubscriptionPool.remove(accountId).
   * MUST throw or return all-false on any failure — we then fail closed (never claim `removed`).
   */
  cooperativeWipe: (req: RevocationRequest) => CooperativeWipeResult;
  /** Durable pending-wipe ledger (offline path). */
  pendingStore: PendingWipeStore;
  /** Raise ONE aggregated LOUD attention item (offline give-up). */
  emitRevocationFailed: (item: RevocationFailedAttention) => void;
  /** Reconnect-deadline before an offline pending wipe escalates to revocation-failed (ms). */
  reconnectDeadlineMs: () => number;
  now?: () => number;
  log?: (msg: string) => void;
}

export type RevocationOutcome = {
  state: RevocationDataState;
  accountId: string;
  targetMachineId: string;
  /** True whenever provider-side rotation is the (only) complete revocation — caller surfaces it. */
  providerRotationRequired: boolean;
  /** Present for the de-paired/hostile and Mechanism-A paths — a real phone-first instruction. */
  providerRotation?: ProviderRotationInstruction;
  /** Present on the cooperative-online success path. */
  wipe?: CooperativeWipeResult;
  reason: string;
};

export class AccountFollowMeRevocation {
  private readonly now: () => number;
  constructor(private readonly deps: AccountFollowMeRevocationDeps) {
    this.now = deps.now ?? Date.now;
  }

  private rotationInstruction(req: RevocationRequest, lead: string): ProviderRotationInstruction {
    return {
      kind: 'provider-rotation-required',
      accountId: req.accountId,
      accountEmail: req.accountEmail,
      targetMachineId: req.targetMachineId,
      targetMachineNickname: req.targetMachineNickname,
      provider: req.provider,
      message:
        `${lead} "${req.targetMachineNickname}" still holds its own live, refreshable login for ` +
        `${req.accountEmail}. instar cannot revoke it remotely — de-authorize that session/device ` +
        `or rotate the credential at ${req.provider} to kill it.`,
    };
  }

  /**
   * Revoke account access on `targetMachineId` given the control-plane revoke already fired. The
   * `posture` (computed by the caller from authoritative registry state — online flag, MachineStatus)
   * selects the R12 branch. Returns the HONEST data-plane outcome; never claims `removed` it can't
   * confirm. A no-op (`provider-rotation-required` with a no-op message) when the feature is dark.
   */
  revoke(req: RevocationRequest, posture: TargetPosture): RevocationOutcome {
    const mechanism: RevocationMechanism = req.mechanism ?? 're-mint';

    // Dark / single-machine ⇒ strict no-op (deny-by-default; never act).
    if (!this.deps.enabled()) {
      return {
        state: 'provider-rotation-required',
        accountId: req.accountId,
        targetMachineId: req.targetMachineId,
        providerRotationRequired: false,
        reason: 'feature-disabled',
      };
    }

    // Mechanism A relocated a real credential — provider rotation is ALWAYS required regardless of
    // branch (a delivered credential cannot be un-delivered, R12.ii). We still attempt the wipe for
    // a cooperative-online A target, but the rotation instruction is unconditional.
    const mechARotation = mechanism === 'credential-transport';

    // (ii) De-paired / hostile / MachineStatus==='revoked' — provider-side ONLY (S8/R12.i corrected).
    if (posture === 'revoked') {
      const rotation = this.rotationInstruction(req, 'Machine');
      this.deps.log?.(
        `[account-follow-me] revoke ${req.accountId}→${req.targetMachineId}: de-paired/hostile — ` +
          `provider-side de-authorization required (no remote wipe possible)`,
      );
      return {
        state: 'provider-rotation-required',
        accountId: req.accountId,
        targetMachineId: req.targetMachineId,
        providerRotationRequired: true,
        providerRotation: rotation,
        reason: 'de-paired-non-cooperative',
      };
    }

    // (iii) Offline still-paired target — durable pending wipe, fired on reconnect (BOUNDED).
    if (posture === 'offline') {
      const t = this.now();
      const record: PendingWipeRecord = {
        accountId: req.accountId,
        targetMachineId: req.targetMachineId,
        mandateId: req.mandateId,
        provider: req.provider,
        accountEmail: req.accountEmail,
        targetMachineNickname: req.targetMachineNickname,
        mechanism,
        revokedAt: t,
        deadlineAt: t + this.deps.reconnectDeadlineMs(),
      };
      this.deps.pendingStore.put(record);
      this.deps.log?.(
        `[account-follow-me] revoke ${req.accountId}→${req.targetMachineId}: target offline — ` +
          `durable pending wipe (deadline +${this.deps.reconnectDeadlineMs()}ms)`,
      );
      return {
        state: 'revocation-pending',
        accountId: req.accountId,
        targetMachineId: req.targetMachineId,
        // For Mechanism A, rotate at provider NOW even while pending (the blob already landed).
        providerRotationRequired: mechARotation,
        providerRotation: mechARotation
          ? this.rotationInstruction(req, 'Offline machine')
          : undefined,
        reason: 'target-offline-pending',
      };
    }

    // (i) Cooperative, still-paired, ONLINE target — local & total wipe. Fail closed on any error.
    let wipe: CooperativeWipeResult;
    try {
      wipe = this.deps.cooperativeWipe(req);
    } catch (err) {
      // The wipe threw — we CANNOT claim removed. Fail closed to a durable pending retry.
      const t = this.now();
      this.deps.pendingStore.put({
        accountId: req.accountId,
        targetMachineId: req.targetMachineId,
        mandateId: req.mandateId,
        provider: req.provider,
        accountEmail: req.accountEmail,
        targetMachineNickname: req.targetMachineNickname,
        mechanism,
        revokedAt: t,
        deadlineAt: t + this.deps.reconnectDeadlineMs(),
      });
      this.deps.log?.(
        `[account-follow-me] revoke ${req.accountId}→${req.targetMachineId}: cooperative wipe THREW ` +
          `(${err instanceof Error ? err.message : String(err)}) — fail-closed to pending`,
      );
      return {
        state: 'revocation-pending',
        accountId: req.accountId,
        targetMachineId: req.targetMachineId,
        providerRotationRequired: mechARotation,
        providerRotation: mechARotation ? this.rotationInstruction(req, 'Machine') : undefined,
        reason: 'cooperative-wipe-error',
      };
    }

    const fullyWiped = wipe.loggedOut && wipe.slotDeleted && wipe.poolRemoved;
    if (!fullyWiped) {
      // Partial wipe — fail closed: do NOT claim removed; keep a durable pending so it retries.
      const t = this.now();
      this.deps.pendingStore.put({
        accountId: req.accountId,
        targetMachineId: req.targetMachineId,
        mandateId: req.mandateId,
        provider: req.provider,
        accountEmail: req.accountEmail,
        targetMachineNickname: req.targetMachineNickname,
        mechanism,
        revokedAt: t,
        deadlineAt: t + this.deps.reconnectDeadlineMs(),
      });
      this.deps.log?.(
        `[account-follow-me] revoke ${req.accountId}→${req.targetMachineId}: partial wipe ` +
          `(logout=${wipe.loggedOut} slot=${wipe.slotDeleted} pool=${wipe.poolRemoved}) — pending`,
      );
      return {
        state: 'revocation-pending',
        accountId: req.accountId,
        targetMachineId: req.targetMachineId,
        providerRotationRequired: mechARotation,
        providerRotation: mechARotation ? this.rotationInstruction(req, 'Machine') : undefined,
        wipe,
        reason: 'cooperative-wipe-partial',
      };
    }

    // Confirmed local & total. The pending record (if any earlier offline/error attempt) is cleared.
    this.deps.pendingStore.remove(req.accountId, req.targetMachineId);
    this.deps.log?.(
      `[account-follow-me] revoke ${req.accountId}→${req.targetMachineId}: removed (logout + slot + pool)`,
    );
    return {
      state: mechARotation ? 'provider-rotation-required' : 'removed',
      accountId: req.accountId,
      targetMachineId: req.targetMachineId,
      // Even a clean Mechanism-A wipe still requires provider rotation (blob was delivered).
      providerRotationRequired: mechARotation,
      providerRotation: mechARotation ? this.rotationInstruction(req, 'Machine') : undefined,
      wipe,
      reason: mechARotation ? 'wiped-but-mechanism-a-rotate' : 'wiped-local-and-total',
    };
  }

  /**
   * A previously-offline target reconnected — fire its durable pending wipe (R12.iii). Drives the
   * SAME cooperative wipe as the online path; on success the pending record is cleared and we report
   * `removed`. On failure/partial we keep the record (it may still escalate at the deadline).
   * A no-op if no pending record exists for (account, target) or the feature is dark.
   */
  onTargetReconnect(accountId: string, targetMachineId: string): RevocationOutcome | null {
    if (!this.deps.enabled()) return null;
    const record = this.deps.pendingStore.get(accountId, targetMachineId);
    if (!record) return null;
    const req: RevocationRequest = {
      accountId: record.accountId,
      accountEmail: record.accountEmail,
      targetMachineId: record.targetMachineId,
      targetMachineNickname: record.targetMachineNickname,
      provider: record.provider,
      mandateId: record.mandateId,
      mechanism: record.mechanism,
    };
    // Reconnected ⇒ treat as cooperative-online and run the same wipe (revoke clears the record on success).
    return this.revoke(req, 'cooperative-online');
  }

  /**
   * Sweep durable pending wipes whose reconnect-deadline has passed and escalate each to a LOUD
   * `revocation-FAILED — rotate at provider NOW` aggregated HIGH attention item (R12.iii give-up).
   * Each escalated record is removed from the pending store (its honest end-state is now provider
   * rotation, never a silently-aging "pending"). Returns the records that escalated. Caller runs
   * this on a cadence (resume-queue drainer style). No-op when the feature is dark.
   */
  sweepDeadlines(): RevocationFailedAttention[] {
    if (!this.deps.enabled()) return [];
    const t = this.now();
    const escalated: RevocationFailedAttention[] = [];
    for (const record of this.deps.pendingStore.all()) {
      if (record.deadlineAt > t) continue; // still within the deadline — stays pending.
      const item: RevocationFailedAttention = {
        id: `agent:account-follow-me-revoke-failed:${record.accountId}::${record.targetMachineId}`,
        title: `Revocation FAILED on "${record.targetMachineNickname}" — rotate at ${record.provider} NOW`,
        body:
          `I revoked access for ${record.accountEmail} on "${record.targetMachineNickname}", but that ` +
          `machine never reconnected to confirm its copy was destroyed. Its login may still be live. ` +
          `Rotate or de-authorize the credential at ${record.provider} now to be certain.`,
        priority: 'high',
        source: 'agent',
      };
      this.deps.emitRevocationFailed(item);
      this.deps.pendingStore.remove(record.accountId, record.targetMachineId);
      this.deps.log?.(
        `[account-follow-me] revoke ${record.accountId}→${record.targetMachineId}: pending wipe ` +
          `EXCEEDED deadline — escalated to revocation-FAILED (rotate at ${record.provider})`,
      );
      escalated.push(item);
    }
    return escalated;
  }

  /**
   * Honest dashboard state for an (account, target) pair: a live pending record reports
   * `revocation-pending` (or `revocation-failed` once past its deadline), else null (no pending
   * revocation in flight). Read surface — never mutates.
   */
  pendingStateFor(accountId: string, targetMachineId: string): RevocationDataState | null {
    const record = this.deps.pendingStore.get(accountId, targetMachineId);
    if (!record) return null;
    return record.deadlineAt > this.now() ? 'revocation-pending' : 'revocation-failed';
  }
}

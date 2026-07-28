/**
 * CredentialRepointingLivetest — the §5 livetest battery as testable orchestration
 * (Step 10 of live credential re-pointing).
 *
 * Spec: docs/specs/live-credential-repointing-rebalancer.md §5 (livetest battery),
 * §0.c (E3/E4 live experiments), §2.8 (dogfood (d) — the §0.c residual).
 *
 * ── What this is ──
 * The livetest battery is the GATE for the dry-run → live promotion decision. It is
 * NOT part of the merge CI and it NEVER runs autonomously: it exchanges REAL OAuth
 * credentials between the operator's REAL subscription accounts, so executing it is an
 * enablement-time action the OPERATOR takes (with the agent), never a dark-build step.
 *
 * This module is the ORCHESTRATION + VERDICT logic for battery items (a) and (b) —
 * the automatable round-trip swaps — expressed over INJECTED dependencies so it is
 * fully unit-testable WITHOUT touching a keychain (the same fake-deps discipline the
 * CredentialSwapExecutor itself uses). Items (c) post-swap refresher correctness and
 * (d) the §0.c at-expiry residual (a deliberately-minted disposable grant) are
 * inherently manual/destructive and are surfaced as REQUIRED operator steps in the
 * report rather than auto-run — the harness reports them as pending, it does not fake
 * a pass.
 *
 * ── The load-bearing safety contract ──
 *   1. ARMED GUARD. `run()` REFUSES unless explicitly armed (the live entrypoint sets
 *      `armed` only behind an operator flag + the feature's own enable check). An
 *      unarmed run returns a `refused` report and performs ZERO swaps — so importing
 *      or unit-testing this module can never move a real credential.
 *   2. IDENTITY-VERIFIED ROUND TRIP. Every swap is verified by the identity oracle
 *      (NOT by `claude auth status`, disqualified in E4a as a lying oracle): after a
 *      swap the two slots' oracle identities must have EXCHANGED; after the swap-back
 *      they must be RESTORED to the originals. Any deviation fails the step.
 *   3. ALWAYS SWAP BACK. A round-trip leaves the world as it found it. If the forward
 *      swap's verification fails the harness still attempts the restoring swap and
 *      reports the residual state honestly (never silently leaves slots exchanged).
 *
 * This module performs NO IO of its own: it calls injected `swap` + `resolveIdentity`
 * functions. The live entrypoint wires those to the real CredentialSwapExecutor +
 * CredentialIdentityOracle; a unit test wires fakes.
 */

/** Identity of the account whose credential currently sits in a slot (oracle answer). */
export interface SlotIdentity {
  /** The owning account id/email per the identity oracle, or null when unresolvable. */
  accountId: string | null;
}

export interface CredentialRepointingLivetestDeps {
  /**
   * Executes a REAL staged swap of the credentials in slotA and slotB (the shipped
   * CredentialSwapExecutor.swap in live mode). Resolves on success; rejects on a
   * refusal/error (the harness records the rejection as a step failure).
   */
  swap: (slotA: string, slotB: string) => Promise<{ ok: boolean; detail?: string }>;
  /**
   * Resolves which account a slot's credential belongs to via the identity oracle
   * (GET /api/oauth/profile over the slot's blob — E4b). Returns `{ accountId: null }`
   * when the oracle is unavailable/uncertain (the harness treats null as a verify
   * failure, never a guess).
   */
  resolveIdentity: (slot: string) => Promise<SlotIdentity>;
}

/** A single battery step's verdict. */
export interface LivetestStepResult {
  step: string;
  passed: boolean;
  detail: string;
  /** Ordered observations (identities seen, swaps performed) for the operator report. */
  observations: string[];
}

/** The full battery report. */
export interface LivetestReport {
  armed: boolean;
  /** True only when armed AND every automated step passed AND no manual step is outstanding. */
  promotable: boolean;
  refusedReason?: string;
  steps: LivetestStepResult[];
  /** Items (c)/(d): inherently manual/destructive — listed, never auto-passed. */
  manualSteps: string[];
}

export interface CredentialRepointingLivetestOptions {
  /**
   * MUST be true to run any swap. The live entrypoint sets this only behind the
   * operator flag + the feature enable check. Default false ⇒ a strict no-op refusal.
   */
  armed?: boolean;
}

export class CredentialRepointingLivetest {
  private readonly swap: CredentialRepointingLivetestDeps['swap'];
  private readonly resolveIdentity: CredentialRepointingLivetestDeps['resolveIdentity'];
  private readonly armed: boolean;

  constructor(deps: CredentialRepointingLivetestDeps, opts?: CredentialRepointingLivetestOptions) {
    this.swap = deps.swap;
    this.resolveIdentity = deps.resolveIdentity;
    this.armed = opts?.armed === true;
  }

  /** The §2.8 manual/destructive items — surfaced for the operator, never auto-run. */
  static readonly MANUAL_STEPS: readonly string[] = [
    '(c) Post-swap hourly-refresher correctness on BOTH slots — observe one QuotaPoller ' +
      '401-refresh cycle per slot after a swap and confirm the refreshed token stays on the ' +
      'right account (requires waiting out an access-token expiry; operator-observed).',
    '(d) §0.c at-expiry write-back residual — mint a DISPOSABLE second grant, swap it under a ' +
      'live session, drive it past access-token expiry, and confirm the scheduled identity ' +
      'audit detects-or-clears any old-lineage write-back. Destructive to a real lineage by ' +
      'design ⇒ operator-run with a throwaway grant only.',
    'Liveness (E4): run the round-trip while a real interactive session is pinned to one slot ' +
      'and confirm zero interruption (the harness cannot observe the operator\'s session; ' +
      'operator-observed).',
  ];

  /**
   * Battery items (a)/(b): an identity-verified swap round-trip between two slots.
   * Used for both an enrolled-home pair (a) and the default-home slot (b).
   * ALWAYS attempts to restore the original layout, even when the forward verify fails.
   */
  private async roundTrip(slotA: string, slotB: string, label: string): Promise<LivetestStepResult> {
    const observations: string[] = [];

    const beforeA = await this.resolveIdentity(slotA);
    const beforeB = await this.resolveIdentity(slotB);
    observations.push(`before: ${slotA}=${beforeA.accountId ?? 'UNRESOLVED'}, ${slotB}=${beforeB.accountId ?? 'UNRESOLVED'}`);
    if (beforeA.accountId === null || beforeB.accountId === null) {
      return { step: label, passed: false, detail: 'oracle could not resolve a slot identity before the swap (fail-closed — never guess)', observations };
    }
    if (beforeA.accountId === beforeB.accountId) {
      return { step: label, passed: false, detail: 'both slots already report the same account — cannot prove an exchange', observations };
    }

    // Forward swap.
    const fwd = await this.swap(slotA, slotB).catch((e: unknown) => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }));
    observations.push(`forward swap: ${fwd.ok ? 'ok' : 'FAILED — ' + (fwd.detail ?? 'unknown')}`);
    if (!fwd.ok) {
      return { step: label, passed: false, detail: `forward swap did not complete: ${fwd.detail ?? 'unknown'}`, observations };
    }

    const afterA = await this.resolveIdentity(slotA);
    const afterB = await this.resolveIdentity(slotB);
    observations.push(`after swap: ${slotA}=${afterA.accountId ?? 'UNRESOLVED'}, ${slotB}=${afterB.accountId ?? 'UNRESOLVED'}`);
    const exchanged = afterA.accountId === beforeB.accountId && afterB.accountId === beforeA.accountId;

    // ALWAYS restore — even if the verify above failed, leave the world as we found it.
    const back = await this.swap(slotA, slotB).catch((e: unknown) => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }));
    observations.push(`restoring swap: ${back.ok ? 'ok' : 'FAILED — ' + (back.detail ?? 'unknown')}`);

    const restoredA = await this.resolveIdentity(slotA);
    const restoredB = await this.resolveIdentity(slotB);
    observations.push(`after restore: ${slotA}=${restoredA.accountId ?? 'UNRESOLVED'}, ${slotB}=${restoredB.accountId ?? 'UNRESOLVED'}`);
    const restored = restoredA.accountId === beforeA.accountId && restoredB.accountId === beforeB.accountId;

    if (!exchanged) {
      return { step: label, passed: false, detail: 'oracle identities did NOT exchange after the forward swap — actuation unproven', observations };
    }
    if (!back.ok || !restored) {
      return { step: label, passed: false, detail: 'forward swap verified, but the layout was NOT cleanly restored — left in a residual state, investigate before promotion', observations };
    }
    return { step: label, passed: true, detail: 'identity-verified round trip: slots exchanged then restored cleanly', observations };
  }

  /**
   * Runs the automatable battery (items a + b). REFUSES (zero swaps) unless armed.
   * @param enrolledPair two enrolled-home slots for item (a).
   * @param defaultSlotPair the default-home slot paired with an enrolled slot for item (b).
   */
  async run(
    enrolledPair: { slotA: string; slotB: string },
    defaultSlotPair: { defaultSlot: string; enrolledSlot: string },
  ): Promise<LivetestReport> {
    const manualSteps = [...CredentialRepointingLivetest.MANUAL_STEPS];
    if (!this.armed) {
      return {
        armed: false,
        promotable: false,
        refusedReason:
          'livetest is the dry-run→live PROMOTION gate — it swaps REAL credentials between REAL ' +
          'accounts and only runs when explicitly armed by the operator at enablement (never in CI, ' +
          'never as a dark-build step). No swaps performed.',
        steps: [],
        manualSteps,
      };
    }

    const steps: LivetestStepResult[] = [];
    steps.push(await this.roundTrip(enrolledPair.slotA, enrolledPair.slotB, '(a) enrolled-home swap round-trip (E3/E4 vs the shipped executor)'));
    steps.push(await this.roundTrip(defaultSlotPair.defaultSlot, defaultSlotPair.enrolledSlot, '(b) default-home slot swap + swap-back (CMT-1337 payoff; the claude-created ACL)'));

    const allAutomatedPassed = steps.every((s) => s.passed);
    return {
      armed: true,
      // Promotion still requires the operator to complete the manual items — the harness
      // never declares promotable while manual steps remain outstanding.
      promotable: allAutomatedPassed && manualSteps.length === 0,
      steps,
      manualSteps,
    };
  }
}

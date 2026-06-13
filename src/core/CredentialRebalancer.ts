/**
 * CredentialRebalancer — the §2.4 balancer ORCHESTRATOR (Increment B, step B3a).
 *
 * Spec: docs/specs/live-credential-repointing-rebalancer.md §2.4.
 *
 * ── What this is ──
 * Wraps the pure `CredentialRebalancerPolicy.decidePass()` decision core in a stateful
 * pass loop: on each `tick()` it builds the read-only pass snapshot from injected
 * providers (ledger/verify → slots, quota poller → accounts, config resolver), asks the
 * policy for the zero-or-more swaps, and ACTUATES each accepted swap through the injected
 * executor — but ONLY under the feature's dark/dry-run gate. It carries the hysteresis
 * state the pure policy cannot (cooldown timestamps across passes) and the §2.4 P19
 * breaker (N consecutive FAILED swaps opens it; it retries on the next quota-fresh pass).
 *
 * ── Safety contract (the autonomous-write surface — this is the risky layer) ──
 *   1. DARK = STRICT NO-OP. When `isEnabled()` is false the tick returns immediately
 *      having built NOTHING and called the executor ZERO times (the §2.4 "a pass with no
 *      actuation performs zero keychain/CLI operations" invariant, extended to the whole
 *      dark state).
 *   2. DRY-RUN actuates the DECISION but not the WRITE. The executor itself enforces
 *      dryRun (Step 5), so a dry-run pass audits what it WOULD swap and advances cooldown
 *      state so the simulated cadence is realistic, but moves no credential.
 *   3. The executor is the ONLY write path. This class never touches a keychain directly;
 *      it calls `deps.swap()` (a thin wrapper over the gated, oracle-verified, staged
 *      CredentialSwapExecutor.swap). A swap rejection/`ok:false` increments the breaker.
 *   4. EVERY pass is auditable. The decision, the actuation outcome, the breaker state,
 *      and the surfaced degraded/attention entries are all recorded in `status()`.
 *
 * Pure orchestration over injected deps → unit-testable without a keychain. The server
 * wiring (the setInterval pass) + the live `GET /credentials/rebalancer` status are B3b.
 */

import {
  decidePass,
  type RebalancePassInput,
  type RebalancerPolicyConfig,
  type AccountState,
  type SlotState,
  type SwapDecision,
} from './CredentialRebalancerPolicy.js';

export interface RebalancerResolvedConfig {
  policy: RebalancerPolicyConfig;
  /** A slot's verify counts as recent within this window. */
  auditCadenceMs: number;
  /** The account that should serve `~/.claude` (objective-0), or null. */
  desiredDefaultAccountId: string | null;
  /** Ceiling for forced wall-overrides per rolling window. */
  maxForcedOverridesPerWindow: number;
  /** N consecutive FAILED swaps that open the P19 breaker. */
  breakerThreshold: number;
}

export interface RebalancerActuationResult {
  ok: boolean;
  detail?: string;
}

export interface CredentialRebalancerDeps {
  /** Live feature gate — read per tick so a restartless flip is honored. */
  isEnabled: () => boolean;
  /** Live dry-run gate. When true the executor audits but writes nothing. */
  isDryRun: () => boolean;
  /** Build the per-slot snapshot (ledger tenancy + verify/quarantine/activity). */
  listSlots: () => SlotState[];
  /** Build the per-account snapshot (quota + reset proximity from the poller). */
  listAccounts: () => AccountState[];
  /** Resolve the clamped config for this pass. */
  resolveConfig: () => RebalancerResolvedConfig;
  /** The ONLY write path: the gated, oracle-verified CredentialSwapExecutor.swap wrapper. */
  swap: (slotA: string, slotB: string) => Promise<RebalancerActuationResult>;
  /** Optional sinks. */
  emitAudit?: (record: PassAudit) => void;
  emitDegraded?: (message: string) => void;
  emitAttention?: (message: string) => void;
  now?: () => number;
}

export interface PassAudit {
  at: number;
  enabled: boolean;
  dryRun: boolean;
  decisions: SwapDecision[];
  actuated: Array<{ decision: SwapDecision; result: RebalancerActuationResult }>;
  degraded: string[];
  attention: string[];
  noActuationReason?: string;
  breakerOpen: boolean;
}

export interface RebalancerStatus {
  enabled: boolean;
  breaker: { open: boolean; consecutiveFailures: number; threshold: number };
  lastPass: PassAudit | null;
  /** Count of pairs/tenants currently under cooldown (for the status surface). */
  cooldownPairs: number;
  cooldownTenants: number;
}

function sortedPair(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export class CredentialRebalancer {
  private readonly deps: CredentialRebalancerDeps;
  private readonly now: () => number;

  // Hysteresis state the pure policy cannot hold (carried across passes).
  private lastActuationByPair: Record<string, number> = {};
  private lastActuationByTenant: Record<string, number> = {};
  private forcedOverridesInWindow = 0;
  private forcedWindowStart = 0;

  // P19 breaker.
  private consecutiveFailures = 0;
  private breakerOpen = false;

  private lastPass: PassAudit | null = null;

  constructor(deps: CredentialRebalancerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Run one balancer pass. DARK ⇒ strict no-op. Returns the pass audit.
   * The breaker, when open, still runs the pass (to re-probe) but the spec retries on a
   * quota-fresh pass — here we simply attempt and let a continued failure keep it open;
   * a success resets it.
   */
  async tick(): Promise<PassAudit> {
    const at = this.now();

    if (!this.deps.isEnabled()) {
      // STRICT no-op while dark: build nothing, call the executor zero times.
      const audit: PassAudit = { at, enabled: false, dryRun: this.deps.isDryRun(), decisions: [], actuated: [], degraded: [], attention: [], noActuationReason: 'feature dark', breakerOpen: this.breakerOpen };
      this.lastPass = audit;
      return audit;
    }

    const cfg = this.deps.resolveConfig();

    // Roll the forced-override window if a window has elapsed (the per-window budget resets).
    if (at - this.forcedWindowStart >= cfg.policy.perTenantCooldownMs * 2) {
      this.forcedWindowStart = at;
      this.forcedOverridesInWindow = 0;
    }

    const input: RebalancePassInput = {
      now: at,
      slots: this.deps.listSlots(),
      accounts: this.deps.listAccounts(),
      cooldowns: {
        lastActuationByPair: this.lastActuationByPair,
        lastActuationByTenant: this.lastActuationByTenant,
        forcedOverridesInWindow: this.forcedOverridesInWindow,
        maxForcedOverridesPerWindow: cfg.maxForcedOverridesPerWindow,
      },
      config: cfg.policy,
      auditCadenceMs: cfg.auditCadenceMs,
      desiredDefaultAccountId: cfg.desiredDefaultAccountId,
    };

    const result = decidePass(input);
    for (const m of result.degraded) this.deps.emitDegraded?.(m);
    for (const m of result.attention) this.deps.emitAttention?.(m);

    const dryRun = this.deps.isDryRun();
    const actuated: PassAudit['actuated'] = [];

    for (const decision of result.decisions) {
      const r = await this.deps.swap(decision.targetSlot, decision.sourceSlot).catch(
        (e: unknown): RebalancerActuationResult => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }),
      );
      actuated.push({ decision, result: r });

      if (r.ok) {
        // Advance the hysteresis state (in BOTH dry-run and live — dry-run simulates the
        // real cadence so a dry-run soak shows realistic anti-churn behavior). Recorded by
        // the TENANT pair the decision exchanged (NOT the fixed slot seats).
        this.recordActuation(decision, input, at);
        this.consecutiveFailures = 0;
        this.breakerOpen = false;
        if (decision.forced === 'wall-override') this.forcedOverridesInWindow += 1;
      } else {
        // Only a LIVE failure counts toward the breaker (a dry-run never writes, so it
        // cannot "fail" a write — the executor returns ok under dry-run).
        if (!dryRun) {
          this.consecutiveFailures += 1;
          if (this.consecutiveFailures >= cfg.breakerThreshold && !this.breakerOpen) {
            this.breakerOpen = true;
            this.deps.emitDegraded?.(`credential rebalancer P19 breaker opened after ${this.consecutiveFailures} consecutive failed swaps`);
          }
        }
      }
    }

    const audit: PassAudit = {
      at, enabled: true, dryRun,
      decisions: result.decisions, actuated,
      degraded: result.degraded, attention: result.attention,
      noActuationReason: result.noActuationReason,
      breakerOpen: this.breakerOpen,
    };
    this.lastPass = audit;
    return audit;
  }

  /** Record cooldown timestamps for the tenants the decision exchanged. */
  private recordActuation(decision: SwapDecision, input: RebalancePassInput, at: number): void {
    const slotById = new Map(input.slots.map((s) => [s.slot, s]));
    const tA = slotById.get(decision.targetSlot)?.tenantAccountId ?? null;
    const tB = slotById.get(decision.sourceSlot)?.tenantAccountId ?? null;
    if (tA) this.lastActuationByTenant[tA] = at;
    if (tB) this.lastActuationByTenant[tB] = at;
    if (tA && tB) this.lastActuationByPair[sortedPair(tA, tB)] = at;
  }

  status(): RebalancerStatus {
    const cfg = this.safeBreakerThreshold();
    return {
      enabled: this.deps.isEnabled(),
      breaker: { open: this.breakerOpen, consecutiveFailures: this.consecutiveFailures, threshold: cfg },
      lastPass: this.lastPass,
      cooldownPairs: Object.keys(this.lastActuationByPair).length,
      cooldownTenants: Object.keys(this.lastActuationByTenant).length,
    };
  }

  private safeBreakerThreshold(): number {
    try { return this.deps.resolveConfig().breakerThreshold; } catch { return 3; }
  }
}

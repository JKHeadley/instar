/**
 * SingleMachineFailoverGapDetector — signal-only guard that surfaces the
 * "no failover target" gap BEFORE it bites.
 *
 * The failure it closes (2026-07-22, the Codey overnight loss): an agent was
 * running autonomous work single-machine, its one machine's session stopped
 * overnight, and NOTHING took over — because there was no second machine
 * registered to fail over TO. The gap was invisible until a human noticed the
 * next morning. Nothing structural surfaced "you have active autonomous work
 * and no failover target".
 *
 * This detector makes that gap loud: when this agent is single-machine (no
 * online mesh peer) WHILE it has active autonomous runs, it raises ONE deduped
 * attention item. It is SIGNAL-ONLY — it never blocks, never provisions a peer,
 * never touches a session. It only tells the operator (and future-me) that the
 * running autonomous work has no takeover if this machine goes down.
 *
 * ── Honesty: two distinct gap modes ──
 *   not-configured : multiMachine is OFF entirely — no peer was ever registered.
 *   peer-offline   : multiMachine is ON but every peer is currently offline —
 *                    the failover target exists but is down right now.
 * Both are a real gap when autonomous work is active (no takeover either way);
 * the message names which so the operator knows whether to ADD a machine or
 * REVIVE one.
 *
 * Pure + injected: every environment read is a callback, so this module unit
 * tests with zero real managers and no I/O.
 */

export type FailoverGapMode = 'not-configured' | 'peer-offline';

/** A snapshot of this agent's mesh membership, as this machine sees it. */
export interface MeshMembership {
  /** true iff multiMachine is configured/enabled on this agent at all. */
  multiMachineEnabled: boolean;
  /** Count of OTHER machines currently online in this agent's pool (excludes self). */
  onlinePeerCount: number;
}

/** The attention item this detector emits (shape kept minimal + transport-agnostic). */
export interface FailoverGapAttention {
  title: string;
  body: string;
  priority: 'high';
  /** Stable per-episode key so repeated ticks coalesce to ONE item. */
  dedupKey: string;
  source: 'single-machine-failover-gap';
}

export interface SingleMachineFailoverGapDetectorDeps {
  /** Dark gate. When false the detector is a strict no-op (never reads, never raises). */
  enabled: () => boolean;
  /**
   * Observe-only mode. When true the detector computes the verdict and audits a
   * would-raise, but does NOT raise the attention item (the graduated-rollout
   * dry-run rung).
   */
  dryRun: () => boolean;
  /** This agent's current mesh membership (single-machine ⇔ onlinePeerCount === 0). */
  getMeshMembership: () => MeshMembership;
  /** How many autonomous runs are active right now (the work that needs a failover target). */
  getActiveAutonomousRunCount: () => number;
  /** Raise a deduped attention item. Only called on a genuine gap when not in dryRun. */
  raiseAttention: (item: FailoverGapAttention) => void;
  /** Optional structured audit sink (every transition, including no-ops with a reason). */
  audit?: (event: string, detail: Record<string, unknown>) => void;
}

export interface FailoverGapTickResult {
  ran: boolean;
  /** True when this agent is single-machine WITH active autonomous work. */
  gapDetected: boolean;
  /** Which mode of gap (only meaningful when gapDetected). */
  mode: FailoverGapMode | null;
  /** How many autonomous runs are exposed by the gap. */
  atRiskRunCount: number;
  /** Whether an attention item was actually raised (false in dryRun even on a gap). */
  raised: boolean;
}

const DEDUP_KEY = 'single-machine-failover-gap';

/**
 * The pure detector. One `tick()` = one evaluation. It raises at most one
 * (deduped) attention item per gap episode; the attention layer's own dedup
 * collapses repeated ticks so a persistent gap never floods.
 */
export class SingleMachineFailoverGapDetector {
  constructor(private readonly deps: SingleMachineFailoverGapDetectorDeps) {}

  tick(): FailoverGapTickResult {
    if (!this.deps.enabled()) {
      return { ran: false, gapDetected: false, mode: null, atRiskRunCount: 0, raised: false };
    }

    const membership = this.deps.getMeshMembership();
    const atRiskRunCount = this.deps.getActiveAutonomousRunCount();

    const singleMachine = membership.onlinePeerCount <= 0;
    const hasWorkNeedingFailover = atRiskRunCount > 0;
    const gapDetected = singleMachine && hasWorkNeedingFailover;

    if (!gapDetected) {
      this.audit('no-gap', {
        onlinePeerCount: membership.onlinePeerCount,
        multiMachineEnabled: membership.multiMachineEnabled,
        atRiskRunCount,
      });
      return { ran: true, gapDetected: false, mode: null, atRiskRunCount, raised: false };
    }

    const mode: FailoverGapMode = membership.multiMachineEnabled ? 'peer-offline' : 'not-configured';

    if (this.deps.dryRun()) {
      this.audit('would-raise', { mode, atRiskRunCount });
      return { ran: true, gapDetected: true, mode, atRiskRunCount, raised: false };
    }

    this.deps.raiseAttention(buildAttention(mode, atRiskRunCount));
    this.audit('raised', { mode, atRiskRunCount });
    return { ran: true, gapDetected: true, mode, atRiskRunCount, raised: true };
  }

  private audit(event: string, detail: Record<string, unknown>): void {
    try {
      this.deps.audit?.(event, detail);
    } catch {
      /* audit is best-effort — never let it break the tick */
    }
  }
}

/** Build the operator-facing attention item for a confirmed gap. Plain language, no jargon. */
export function buildAttention(mode: FailoverGapMode, atRiskRunCount: number): FailoverGapAttention {
  const runWord = atRiskRunCount === 1 ? 'autonomous run' : 'autonomous runs';
  const body =
    mode === 'not-configured'
      ? `${atRiskRunCount} ${runWord} are running on this machine with no second machine registered. ` +
        `If this machine sleeps or the session stops, the work stops with nothing to take over. ` +
        `Register a second machine so this agent has a failover target.`
      : `${atRiskRunCount} ${runWord} are running, but every other machine in this agent's pool is ` +
        `currently offline — so there is no failover target right now. Bring the other machine back ` +
        `online, or the work has no takeover if this machine goes down.`;
  return {
    title: 'No failover target for active autonomous work',
    body,
    priority: 'high',
    dedupKey: DEDUP_KEY,
    source: 'single-machine-failover-gap',
  };
}

export const SINGLE_MACHINE_FAILOVER_GAP_DEDUP_KEY = DEDUP_KEY;

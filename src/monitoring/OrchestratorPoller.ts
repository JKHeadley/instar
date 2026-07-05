/**
 * OrchestratorPoller — the cadence wrapper around the SeamlessOrchestratorEngine +
 * OrchestratorActuator (spec: llm-seamlessness-orchestrator.md, Phase 1 skeleton /
 * Phase 3 soak). Mirrors CartographerSweepPoller: an in-process, idle-aware,
 * reentrancy-guarded poller constructed in server.ts beside the other background
 * pollers. Ships dark behind `multiMachine.seamlessOrchestrator.enabled`.
 *
 * Why a poller and not a scheduler Job: a spawned session can reach none of the
 * in-process LlmQueue / working-set coordinator / placement-planner seams the
 * engine + actuator are injected with. The poller runs in the AgentServer process
 * so the whole loop shares one in-process instance.
 *
 * Each tick: engine.pass() (which is itself lease-gated + pressure-suspended + PURE
 * of cadence) → actuate every proposal through the guarded actuator → record the
 * per-topic actuation time (feeds the engine's cooldown reader). The poller is thin:
 * all the safety (lease-gate, pressure-suspend, dedupe, cap) lives in the engine +
 * actuator; the poller only drives cadence + idle backoff + a coarse error breaker.
 */
import { IdleAwareCadence } from './IdleAwareCadence.js';
import type { OrchestratorPassResult } from '../core/SeamlessOrchestratorEngine.js';
import type { ActuationResult } from '../core/OrchestratorActuator.js';

export interface OrchestratorPollerEngineLike {
  pass(): Promise<OrchestratorPassResult>;
}
export interface OrchestratorPollerActuatorLike {
  actuate(proposal: OrchestratorPassResult['proposals'][number]): Promise<ActuationResult>;
}

export interface OrchestratorPollerOptions {
  engine: OrchestratorPollerEngineLike;
  actuator: OrchestratorPollerActuatorLike;
  /** Full cadence while there is work (default 900000 = 15 min). */
  cadenceMs?: number;
  /** Backed-off cadence while idle (no proposals) or breaker-open (default 30 min). */
  idleCadenceMs?: number;
  /** Consecutive zero-proposal ticks before backing off to the idle cadence (default 2). */
  idleAfterZeroProposalTicks?: number;
  /** Consecutive tick errors before the breaker opens + backs off (default 3). */
  errorTicksToBreak?: number;
  /** Record the per-topic actuation time (feeds the engine's per-topic cooldown). */
  recordActuated?: (topic: number, now: number) => void;
  onError?: (err: unknown) => void;
  log?: (msg: string) => void;
  now?: () => number;
}

/** One tick's summary — visible for tests + the /audit route's last-tick surface. */
export interface OrchestratorTickResult {
  ranProposePath: boolean;
  suspended: boolean;
  reason: string;
  proposalCount: number;
  actuated: number;
  refused: number;
}

export class OrchestratorPoller {
  private readonly engine: OrchestratorPollerEngineLike;
  private readonly actuator: OrchestratorPollerActuatorLike;
  private readonly cadenceMs: number;
  private readonly idleCadenceMs: number;
  private readonly idleAfterZeroProposalTicks: number;
  private readonly errorTicksToBreak: number;
  private readonly recordActuated: (topic: number, now: number) => void;
  private readonly onError: (err: unknown) => void;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;

  private cadence: IdleAwareCadence | null = null;
  private running = false;
  private consecutiveZeroProposal = 0;
  private consecutiveErrors = 0;
  private breakerOpen = false;
  private lastTick: OrchestratorTickResult | null = null;
  private lastTickAt: number | null = null;

  constructor(opts: OrchestratorPollerOptions) {
    this.engine = opts.engine;
    this.actuator = opts.actuator;
    this.cadenceMs = opts.cadenceMs && opts.cadenceMs > 0 ? opts.cadenceMs : 900_000;
    this.idleCadenceMs = opts.idleCadenceMs && opts.idleCadenceMs > 0 ? opts.idleCadenceMs : 30 * 60_000;
    this.idleAfterZeroProposalTicks = opts.idleAfterZeroProposalTicks ?? 2;
    this.errorTicksToBreak = opts.errorTicksToBreak ?? 3;
    this.recordActuated = opts.recordActuated ?? (() => {});
    this.onError = opts.onError ?? ((err) => console.warn('[seamless-orchestrator] error:', err));
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => Date.parse(new Date().toISOString()));
  }

  start(): void {
    if (this.cadence) return;
    this.cadence = new IdleAwareCadence({
      activeMs: this.cadenceMs,
      idleMs: this.idleCadenceMs,
      isIdle: () => this.breakerOpen || this.consecutiveZeroProposal >= this.idleAfterZeroProposalTicks,
      tick: async () => { await this.tick(); },
    });
    this.cadence.start();
  }

  stop(): void {
    if (this.cadence) { this.cadence.stop(); this.cadence = null; }
  }

  getLastTick(): OrchestratorTickResult | null { return this.lastTick; }
  getLastTickAt(): number | null { return this.lastTickAt; }
  isBreakerOpen(): boolean { return this.breakerOpen; }

  /** Run one pass. Public so the POST /tick route can drive a manual soak tick. Never throws. */
  async tick(): Promise<OrchestratorTickResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const pass = await this.engine.pass();
      const result = await this.drive(pass);
      this.consecutiveErrors = 0;
      if (this.breakerOpen) { this.breakerOpen = false; this.log('[seamless-orchestrator] breaker CLOSED — pass succeeded.'); }
      this.lastTick = result;
      this.lastTickAt = this.now();
      // Idle-backoff bookkeeping: a pass that proposes nothing (or didn't run) is "idle".
      if (result.proposalCount === 0) this.consecutiveZeroProposal += 1;
      else this.consecutiveZeroProposal = 0;
      return result;
    } catch (err) {
      // @silent-fallback-ok — a tick error is REPORTED via onError (the injected logger) and drives
      // the consecutive-error breaker (which opens + backs off cadence after N). Not silent, not
      // data-loss: the next cadence retries; a sustained failure trips the breaker (the real surface).
      this.onError(err);
      this.consecutiveErrors += 1;
      if (this.consecutiveErrors >= this.errorTicksToBreak && !this.breakerOpen) {
        this.breakerOpen = true;
        this.log(`[seamless-orchestrator] breaker OPEN — ${this.consecutiveErrors} consecutive tick errors; backing off cadence.`);
      }
      return null;
    } finally {
      this.running = false;
    }
  }

  /** Actuate every proposal from a pass through the guarded actuator. */
  private async drive(pass: OrchestratorPassResult): Promise<OrchestratorTickResult> {
    let actuated = 0;
    let refused = 0;
    for (const proposal of pass.proposals) {
      const r = await this.actuator.actuate(proposal);
      if (r.decision === 'actuated' || r.decision === 'would-actuate' || r.decision === 'signal-recorded' || r.decision === 'would-signal') {
        actuated += 1;
        this.recordActuated(proposal.targetTopic, this.now());
      } else {
        refused += 1;
      }
    }
    return {
      ranProposePath: pass.ranProposePath,
      suspended: pass.suspended,
      reason: pass.reason,
      proposalCount: pass.proposals.length,
      actuated,
      refused,
    };
  }
}

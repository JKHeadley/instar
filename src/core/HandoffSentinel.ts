/**
 * HandoffSentinel — the single owner of the planned-handoff lifecycle (spec §8 G3e).
 *
 * Replaces the v0 design that scattered handoff steps across HeartbeatManager,
 * MultiMachineCoordinator, SyncOrchestrator, and HandoffManager with no owner.
 * One entry point, an explicit state machine, verify-before-finalize, terminal
 * events, and a race guard so the reaper/scheduler do not act mid-handoff.
 *
 * State machine (planned handoff):
 *   idle → prepare → tail_synced → ingress_fenced → new_owner_active
 *        → old_owner_standby → committed
 *
 * The CRITICAL invariant (spec §8 G3e): the OUTGOING machine retains the lease
 * (and its fencing epoch) through ingress_fenced → new_owner_active; the
 * incoming machine attempts its lease-CAS acquisition ONLY after an explicit
 * `yield` signal, sent ONLY on a verified ack AND a passing validation. A
 * validator timeout or ack-verification failure means NO yield is sent — the
 * incoming never initiates its CAS, the outgoing simply stays awake, and there
 * is no window in which both attempt to hold the same epoch.
 *
 * "Caught up" is never a bare boolean: the ack must echo the live-tail sequence,
 * the ingress position, and a hash of the loaded thread history; the outgoing
 * verifies the echo matches what it flushed before yielding.
 */

import type { IngressPosition } from './types.js';

export type HandoffState =
  | 'idle'
  | 'prepare'
  | 'tail_synced'
  | 'ingress_fenced'
  | 'new_owner_active'
  | 'old_owner_standby'
  | 'committed'
  | 'aborted'
  | 'failed';

export type HandoffOutcome = 'handed-off' | 'aborted-stay-awake' | 'failed';

/** What the outgoing machine flushed; the incoming must echo it back exactly. */
export interface FlushManifest {
  tailSeq: number;
  ingressPosition: IngressPosition;
  threadHistoryHash: string;
}

/** The incoming machine's "caught up" ack — must echo the flush manifest. */
export interface HandoffAck {
  tailSeq: number;
  ingressPosition: IngressPosition;
  threadHistoryHash: string;
}

export interface HandoffOps {
  /** Flush the live tail + return the manifest the incoming must echo. */
  flush: () => Promise<FlushManifest>;
  /** Await the incoming machine's ack (null/throw → no ack). */
  awaitAck: (timeoutMs: number) => Promise<HandoffAck | null>;
  /** Tier-1 validation that the receiving machine is truly ready. */
  validate: (ack: HandoffAck, manifest: FlushManifest) => Promise<boolean>;
  /** Send the explicit yield signal — the ONLY trigger for the incoming CAS. */
  sendYield: () => Promise<void>;
  /** Demote self to standby (after a confirmed yield). */
  demoteSelf: () => Promise<void>;
}

export interface HandoffSentinelConfig {
  handoffAckTimeoutMs: number;
  minHandoffIntervalMs: number;
  now?: () => number;
  logger?: (msg: string) => void;
  onTerminal?: (outcome: HandoffOutcome, detail: string) => void;
}

export class HandoffSentinel {
  private readonly ops: HandoffOps;
  private readonly cfg: HandoffSentinelConfig;
  private _state: HandoffState = 'idle';
  private lastHandoffAt = 0;
  private _inProgress = false;

  constructor(ops: HandoffOps, cfg: HandoffSentinelConfig) {
    this.ops = ops;
    this.cfg = cfg;
  }

  private now(): number {
    return (this.cfg.now ?? Date.now)();
  }
  private log(m: string): void {
    this.cfg.logger?.(`[handoff] ${m}`);
  }

  get state(): HandoffState {
    return this._state;
  }

  /** Race guard: the reaper/scheduler must not act while this is true. */
  get inProgress(): boolean {
    return this._inProgress;
  }

  private ackMatches(ack: HandoffAck, manifest: FlushManifest): boolean {
    return (
      ack.tailSeq === manifest.tailSeq &&
      ack.threadHistoryHash === manifest.threadHistoryHash &&
      ack.ingressPosition.platform === manifest.ingressPosition.platform &&
      String(ack.ingressPosition.cursor) === String(manifest.ingressPosition.cursor)
    );
  }

  /**
   * Run a planned handoff to completion. The outgoing machine NEVER yields the
   * lease unless the ack is verified AND validation passes; otherwise it aborts
   * and stays awake.
   */
  async initiate(): Promise<HandoffOutcome> {
    if (this._inProgress) return this.report('aborted-stay-awake', 'handoff already in progress');
    // Anti-oscillation floor — protects CONTINUATION LLM cost.
    if (this.lastHandoffAt !== 0 && this.now() - this.lastHandoffAt < this.cfg.minHandoffIntervalMs) {
      return this.report('aborted-stay-awake', 'within minHandoffIntervalMs — staying awake');
    }

    this._inProgress = true;
    try {
      this._state = 'prepare';
      let manifest: FlushManifest;
      try {
        manifest = await this.ops.flush();
      } catch (err) {
        this._state = 'failed';
        return this.report('failed', `flush failed: ${msg(err)}`);
      }
      this._state = 'tail_synced';

      // Await + VERIFY the ack. Timeout or mismatch → abort, stay awake.
      let ack: HandoffAck | null;
      try {
        ack = await this.ops.awaitAck(this.cfg.handoffAckTimeoutMs);
      } catch {
        ack = null;
      }
      if (!ack) {
        this._state = 'aborted';
        return this.report('aborted-stay-awake', 'no verified ack within handoffAckTimeoutMs — staying awake');
      }
      if (!this.ackMatches(ack, manifest)) {
        this._state = 'aborted';
        return this.report('aborted-stay-awake', 'ack echo mismatch — staying awake');
      }

      // Tier-1 validation — a timeout/failure is treated as "not verified".
      let valid = false;
      try {
        valid = await this.ops.validate(ack, manifest);
      } catch {
        valid = false;
      }
      if (!valid) {
        this._state = 'aborted';
        return this.report('aborted-stay-awake', 'validation failed/timed out — staying awake');
      }

      this._state = 'ingress_fenced';
      // Only NOW do we yield — the incoming CAS is gated on this signal.
      try {
        await this.ops.sendYield();
      } catch (err) {
        this._state = 'aborted';
        return this.report('aborted-stay-awake', `yield send failed: ${msg(err)} — staying awake`);
      }
      this._state = 'new_owner_active';

      try {
        await this.ops.demoteSelf();
      } catch (err) {
        // Lease already moved; if demotion fails we still hand off, but flag it.
        this.log(`demoteSelf warning: ${msg(err)}`);
      }
      this._state = 'old_owner_standby';
      this.lastHandoffAt = this.now();
      this._state = 'committed';
      return this.report('handed-off', 'planned handoff complete');
    } finally {
      this._inProgress = false;
    }
  }

  private report(outcome: HandoffOutcome, detail: string): HandoffOutcome {
    this.log(`${outcome}: ${detail}`);
    this.cfg.onTerminal?.(outcome, detail);
    return outcome;
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

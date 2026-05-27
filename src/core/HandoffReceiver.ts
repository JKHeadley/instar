/**
 * HandoffReceiver — the INCOMING-machine side of the planned handoff (spec §8
 * G3d/G3e), the counterpart to the outgoing-only HandoffSentinel.
 *
 * The incoming machine is already receiving the live tail (via /api/live-tail).
 * When the outgoing machine signals a handoff is beginning, this receiver:
 *   1. builds its "caught up" ack — echoing the live-tail sequence it holds, the
 *      ingress position it will resume from, and a hash of the thread history it
 *      loaded (the outgoing verifies this echo before yielding);
 *   2. sends the ack to the outgoing machine;
 *   3. on the explicit `yield` signal (the ONLY trigger), acquires the lease via
 *      the consented path.
 *
 * State machine: idle → catching_up → ack_sent → acquired | failed.
 *
 * The yield is acted on ONLY while a handoff is in progress (ack_sent) — a stray
 * yield with no handoff underway is ignored (and the lease's own consent guard
 * refuses a yield from a non-holder regardless). All I/O is injected, so the
 * sequencing is unit-testable without a network.
 */

// RULE 3: EXEMPT — this is a handoff PROTOCOL state machine (idle→ack_sent→acquired),
// not provider state-DETECTION. It does no polling/parsing of external provider state;
// it sequences injected ops (buildAck/sendAck/acquireOnYield) driven by explicit signals.
// (The class-name pattern matched "*Receiver"; the state-detection robustness spec at
// specs/provider-portability/05-state-detection-robustness.md does not apply here.)
import type { HandoffAck } from './HandoffSentinel.js';

export type HandoffReceiverState = 'idle' | 'catching_up' | 'ack_sent' | 'acquired' | 'failed';

export interface HandoffReceiverOps {
  /** Build the "caught up" ack from the live-tail buffer + adapter ingress + thread hash. */
  buildAck: () => Promise<HandoffAck>;
  /** Send the ack to the outgoing machine (HandoffWireTransport.sendAck). */
  sendAck: (ack: HandoffAck) => Promise<boolean>;
  /** Acquire the lease on the verified yield (coordinator.acquireLeaseOnConsent). */
  acquireOnYield: () => Promise<boolean>;
}

export interface HandoffReceiverConfig {
  logger?: (msg: string) => void;
  onTerminal?: (state: 'acquired' | 'failed', detail: string) => void;
}

export class HandoffReceiver {
  private readonly ops: HandoffReceiverOps;
  private readonly cfg: HandoffReceiverConfig;
  private _state: HandoffReceiverState = 'idle';

  constructor(ops: HandoffReceiverOps, cfg: HandoffReceiverConfig = {}) {
    this.ops = ops;
    this.cfg = cfg;
  }

  get state(): HandoffReceiverState {
    return this._state;
  }

  private log(m: string): void {
    this.cfg.logger?.(`[handoff-recv] ${m}`);
  }

  /**
   * The outgoing machine has begun a handoff to us. Build + send our caught-up
   * ack. Returns true if the ack was sent (the outgoing will verify the echo and,
   * if it matches + validation passes, send a yield).
   */
  async onBeginHandoff(): Promise<boolean> {
    this._state = 'catching_up';
    let ack: HandoffAck;
    try {
      ack = await this.ops.buildAck();
    } catch (err) {
      this._state = 'failed';
      this.log(`buildAck failed: ${msg(err)}`);
      return false;
    }
    let sent: boolean;
    try {
      sent = await this.ops.sendAck(ack);
    } catch (err) {
      this._state = 'failed';
      this.log(`sendAck failed: ${msg(err)}`);
      return false;
    }
    if (!sent) {
      this._state = 'failed';
      this.log('ack not accepted by the outgoing machine');
      return false;
    }
    this._state = 'ack_sent';
    return true;
  }

  /**
   * The outgoing machine sent the explicit yield. Acquire the lease — but ONLY if
   * a handoff is genuinely in progress (we sent an ack). A stray yield is ignored.
   */
  async onYield(): Promise<boolean> {
    if (this._state !== 'ack_sent') {
      this.log(`ignoring yield in state '${this._state}' — no handoff in progress`);
      return false;
    }
    let acquired: boolean;
    try {
      acquired = await this.ops.acquireOnYield();
    } catch (err) {
      this._state = 'failed';
      this.cfg.onTerminal?.('failed', `acquire threw: ${msg(err)}`);
      return false;
    }
    if (acquired) {
      this._state = 'acquired';
      this.cfg.onTerminal?.('acquired', 'lease acquired on yield — now awake');
      return true;
    }
    this._state = 'failed';
    this.cfg.onTerminal?.('failed', 'consent acquire did not take the lease — staying standby');
    return false;
  }

  /** Reset to idle (e.g. a handoff was aborted or completed). */
  reset(): void {
    this._state = 'idle';
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

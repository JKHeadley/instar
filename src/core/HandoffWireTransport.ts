/**
 * HandoffWireTransport — the point-to-point ack/yield channel for the planned
 * handoff protocol (spec §8 G3d/G3e). Symmetric: both machines run it, using the
 * half that matches their role in a given handoff.
 *
 *   OUTGOING machine (HandoffSentinel.initiate):
 *     - awaitAck(timeoutMs): resolves when the incoming POSTs its verified-ack to
 *       /api/handoff/ack (recordAck fires the pending promise); null on timeout.
 *     - sendYield(): POSTs the explicit yield signal to the incoming's
 *       /api/handoff/yield — the ONLY trigger for the incoming's lease CAS. Sent
 *       ONLY after a verified ack + passing validation (HandoffSentinel enforces).
 *
 *   INCOMING machine:
 *     - sendAck(ack): POSTs its "caught up" echo (tailSeq + ingressPosition +
 *       threadHistoryHash) to the outgoing's /api/handoff/ack.
 *     - onYield(cb): the /api/handoff/yield route invokes the registered handler,
 *       which triggers the incoming's lease-CAS acquisition.
 *
 * All POSTs ride the authenticated machine channel (signRequest +
 * machineAuthMiddleware on the receiver). Injected fetch/clock for testability.
 * A handoff is strictly 1:1 with the single peer, resolved by the caller.
 */

import { signRequest } from '../server/machineAuth.js';
import type { HandoffAck } from './HandoffSentinel.js';

export interface HandoffWirePeer {
  machineId: string;
  url: string;
}

export interface HandoffWireTransportDeps {
  selfMachineId: string;
  signingKeyPem: string;
  /** Resolve the single counterpart machine for a handoff (excludes self). */
  peer: () => HandoffWirePeer | null;
  nextSequence: () => number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: (msg: string) => void;
}

export class HandoffWireTransport {
  private readonly d: HandoffWireTransportDeps;
  private pendingAck: { resolve: (ack: HandoffAck | null) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private yieldHandler: (() => void) | null = null;

  constructor(deps: HandoffWireTransportDeps) {
    this.d = deps;
  }

  private log(m: string): void {
    this.d.logger?.(`[handoff-wire] ${m}`);
  }
  private fetchImpl(): typeof fetch {
    return this.d.fetchImpl ?? fetch;
  }
  private async post(path: string, body: unknown): Promise<boolean> {
    const peer = this.d.peer();
    if (!peer) {
      this.log(`no peer for ${path}`);
      return false;
    }
    try {
      const headers = signRequest(this.d.selfMachineId, this.d.signingKeyPem, body, this.d.nextSequence());
      const res = await this.fetchImpl()(`${peer.url.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      return !!(res && (res as Response).ok);
    } catch (err) {
      this.log(`POST ${path} to ${peer.machineId} failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // ── OUTGOING side ──────────────────────────────────────────────

  /** Wait for the incoming machine's ack (resolved by recordAck), or null on timeout. */
  awaitAck(timeoutMs: number): Promise<HandoffAck | null> {
    // Only one handoff at a time; a new wait supersedes any stale pending one.
    if (this.pendingAck) {
      clearTimeout(this.pendingAck.timer);
      this.pendingAck.resolve(null);
      this.pendingAck = null;
    }
    return new Promise<HandoffAck | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAck = null;
        this.log(`ack timed out after ${timeoutMs}ms`);
        resolve(null);
      }, timeoutMs);
      // Don't let a pending handoff ack keep the process alive.
      (timer as any).unref?.();
      this.pendingAck = { resolve, timer };
    });
  }

  /** Called by POST /api/handoff/ack — delivers the incoming machine's ack. */
  recordAck(ack: HandoffAck): void {
    if (!this.pendingAck) {
      this.log('received an ack with no pending awaitAck — dropping');
      return;
    }
    clearTimeout(this.pendingAck.timer);
    const { resolve } = this.pendingAck;
    this.pendingAck = null;
    resolve(ack);
  }

  /** Send the yield signal to the incoming machine. */
  async sendYield(): Promise<boolean> {
    return this.post('/api/handoff/yield', { yield: true, from: this.d.selfMachineId });
  }

  /** Open a planned handoff: POST the flush manifest to the incoming's begin route. */
  async sendBegin(manifest: unknown): Promise<boolean> {
    return this.post('/api/handoff/begin', { manifest });
  }

  // ── INCOMING side ──────────────────────────────────────────────

  /** Send this machine's "caught up" ack to the outgoing machine. */
  async sendAck(ack: HandoffAck): Promise<boolean> {
    return this.post('/api/handoff/ack', { ack });
  }

  /** Register the handler the /api/handoff/yield route invokes (incoming side). */
  onYield(cb: () => void): void {
    this.yieldHandler = cb;
  }

  /** Called by POST /api/handoff/yield — triggers the incoming's lease CAS. */
  recordYield(): void {
    if (!this.yieldHandler) {
      this.log('received a yield with no handler registered — dropping');
      return;
    }
    this.yieldHandler();
  }
}

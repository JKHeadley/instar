import type { KeyObject } from 'node:crypto';
import { verifyConsentActivation } from './ConnectConsentActivation.js';

export interface PendingConnectConsent {
  readonly sessionId: string;
  readonly generation: string;
  readonly nonce: string;
  readonly requestDigest: string;
  readonly expiresAt: number;
}

/** A single pending request on an already authenticated companion connection. */
export class ConnectConsentLifecycle {
  readonly request: PendingConnectConsent;
  #state: 'pending' | 'allowed' | 'prepared' | 'consumed' = 'pending';
  #ackDigest?: string;
  #activationDeadline = 0;

  constructor(request: PendingConnectConsent, private readonly companion: KeyObject,
      private readonly agent: KeyObject, private readonly isCurrent: () => boolean) {
    this.request = Object.freeze({ ...request });
  }

  private live(now: number): boolean {
    return Number.isSafeInteger(now) && now >= 0 && Number.isSafeInteger(this.request.expiresAt) &&
      now < this.request.expiresAt && this.isCurrent();
  }

  private matches(message: { sessionId: string; generation: string }): boolean {
    return message.sessionId === this.request.sessionId && message.generation === this.request.generation;
  }

  decide(frame: Buffer, now = Date.now()): 'allow' | 'decline' | undefined {
    if (this.#state !== 'pending' || !this.live(now)) return;
    const decision = verifyConsentActivation(frame, this.companion, 'decision');
    if (!decision?.decision || !this.matches(decision) || decision.nonce !== this.request.nonce ||
        decision.digest !== this.request.requestDigest) return;
    this.#state = decision.decision === 'allow' ? 'allowed' : 'consumed';
    return decision.decision;
  }

  prepare(frame: Buffer, now = Date.now()): boolean {
    if (this.#state !== 'allowed' || !this.live(now)) return false;
    const ack = verifyConsentActivation(frame, this.agent, 'ack');
    if (!ack || !this.matches(ack) || ack.digest !== this.request.requestDigest ||
        ack.deadline === undefined || ack.deadline <= now || ack.deadline > now + 5000 ||
        ack.deadline > this.request.expiresAt) return false;
    this.#ackDigest = ack.transcriptDigest;
    this.#activationDeadline = ack.deadline;
    this.#state = 'prepared';
    return true;
  }

  /** The returned request can be activated once, using its preallocated session ID. */
  confirm(frame: Buffer, now = Date.now()): PendingConnectConsent | undefined {
    if (this.#state !== 'prepared' || now >= this.#activationDeadline || !this.live(now)) return;
    const confirmation = verifyConsentActivation(frame, this.companion, 'confirm');
    if (!confirmation || !this.matches(confirmation) || confirmation.digest !== this.#ackDigest) return;
    this.cancel();
    return this.request;
  }

  cancel(): void {
    this.#state = 'consumed';
    this.#ackDigest = undefined;
    this.#activationDeadline = 0;
  }
}

import type { KeyObject } from 'node:crypto';
import { verifyConsentActivation } from './ConnectConsentActivation.js';

interface ConsentClock {
  wall(): number;
  monotonic(): number;
}

const systemClock: ConsentClock = { wall: Date.now, monotonic: () => performance.now() };

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
  #activationMono = 0;
  readonly #requestMono: number;

  constructor(request: PendingConnectConsent, private readonly companion: KeyObject,
      private readonly agent: KeyObject, private readonly isCurrent: () => boolean,
      private readonly clock: ConsentClock = systemClock) {
    this.request = Object.freeze({ ...request });
    this.#requestMono = clock.monotonic() + Math.max(0, Math.min(15 * 60_000, request.expiresAt - clock.wall()));
  }

  private live(): boolean {
    const now = this.clock.wall();
    const mono = this.clock.monotonic();
    const live = Number.isSafeInteger(now) && now >= 0 && Number.isFinite(mono) &&
      Number.isSafeInteger(this.request.expiresAt) && now < this.request.expiresAt &&
      mono < this.#requestMono && this.isCurrent();
    if (!live) this.cancel();
    return live;
  }

  private matches(message: { sessionId: string; generation: string }): boolean {
    return message.sessionId === this.request.sessionId && message.generation === this.request.generation;
  }

  decide(frame: Buffer): 'allow' | 'decline' | undefined {
    if (this.#state !== 'pending' || !this.live()) return;
    const decision = verifyConsentActivation(frame, this.companion, 'decision');
    if (!decision?.decision || !this.matches(decision) || decision.nonce !== this.request.nonce ||
        decision.digest !== this.request.requestDigest) return;
    this.#state = decision.decision === 'allow' ? 'allowed' : 'consumed';
    return decision.decision;
  }

  prepare(frame: Buffer): boolean {
    if (this.#state !== 'allowed' || !this.live()) return false;
    const now = this.clock.wall();
    const ack = verifyConsentActivation(frame, this.agent, 'ack');
    if (!ack || !this.matches(ack) || ack.digest !== this.request.requestDigest ||
        ack.deadline === undefined || ack.deadline <= now || ack.deadline > now + 5000 ||
        ack.deadline > this.request.expiresAt) return false;
    this.#ackDigest = ack.transcriptDigest;
    this.#activationDeadline = ack.deadline;
    this.#activationMono = this.clock.monotonic() + (ack.deadline - now);
    this.#state = 'prepared';
    return true;
  }

  /** Publish is the synchronous authority commit and must check the exact session and display. */
  confirm(frame: Buffer, publish: (request: PendingConnectConsent) => boolean): boolean {
    if (this.#state !== 'prepared' || !this.live()) return false;
    if (this.clock.wall() >= this.#activationDeadline || this.clock.monotonic() >= this.#activationMono) {
      this.cancel();
      return false;
    }
    const confirmation = verifyConsentActivation(frame, this.companion, 'confirm');
    if (!confirmation || !this.matches(confirmation) || confirmation.digest !== this.#ackDigest) return false;
    this.cancel();
    if (!this.live()) return false;
    return publish(this.request);
  }

  cancel(): void {
    this.#state = 'consumed';
    this.#ackDigest = undefined;
    this.#activationDeadline = 0;
    this.#activationMono = 0;
  }
}

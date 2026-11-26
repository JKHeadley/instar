import { randomUUID } from 'node:crypto';
import type { ConnectViewerBinding } from './ConnectViewerEnrollment.js';

export interface ConnectViewerConsent extends ConnectViewerBinding {
  readonly displayId: string;
  readonly expiresAt: number;
}

/** In-memory grant created only by the trusted local consent caller. */
export class ConnectViewerSession {
  readonly id = randomUUID();
  readonly consent: ConnectViewerConsent;
  readonly #controller = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout>;
  #attached = false;

  constructor(consent: ConnectViewerConsent) {
    const remaining = consent.expiresAt - Date.now();
    if (!Number.isSafeInteger(consent.expiresAt) || remaining <= 0 || remaining > 15 * 60_000) {
      throw new RangeError('Invalid Look only consent expiry');
    }
    this.consent = Object.freeze({ ...consent });
    this.#timer = setTimeout(() => this.stop(), remaining).unref();
  }

  attach(binding: ConnectViewerBinding, displayId: string): AbortSignal | undefined {
    if (this.#attached || this.#controller.signal.aborted || Date.now() >= this.consent.expiresAt ||
        binding.agentId !== this.consent.agentId || binding.targetMachineId !== this.consent.targetMachineId ||
        binding.keyDigest !== this.consent.keyDigest || displayId !== this.consent.displayId) return;
    this.#attached = true;
    return this.#controller.signal;
  }

  /** Recheck immediately before dispatch, even if the expiry timer is delayed. */
  dispatchFrame(deliver: () => void): boolean {
    if (!this.#attached || this.#controller.signal.aborted) return false;
    if (Date.now() >= this.consent.expiresAt) {
      this.stop();
      return false;
    }
    deliver();
    return true;
  }

  stop(): void {
    clearTimeout(this.#timer);
    this.#controller.abort();
  }
}

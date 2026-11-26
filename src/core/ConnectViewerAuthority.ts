import { ConnectViewerEnrollment, type ConnectViewerBinding } from './ConnectViewerEnrollment.js';
import { ConnectViewerSession, type ConnectViewerConsent } from './ConnectViewerSession.js';

const MAX_VIEWERS = 16;
const MAX_CHALLENGES = 16;

/** One process owns all approvals and grants. Restart drops both. */
export class ConnectViewerAuthority {
  #challenges = new Map<string, ConnectViewerEnrollment>();
  #viewers = new Map<string, { binding: ConnectViewerBinding; publicKey: string }>();
  #sessions = new Map<string, ConnectViewerSession>();

  approveEnrollment(binding: ConnectViewerBinding): ConnectViewerEnrollment['challenge'] | undefined {
    const now = Date.now();
    for (const [nonce, approved] of this.#challenges) {
      if (approved.challenge.expiresAt <= now) this.#challenges.delete(nonce);
    }
    if (this.#challenges.size >= MAX_CHALLENGES || this.#viewers.size >= MAX_VIEWERS ||
        this.#viewers.has(binding.keyDigest)) return;
    const approved = new ConnectViewerEnrollment(binding, now);
    this.#challenges.set(approved.challenge.nonce, approved);
    return approved.challenge;
  }

  /** Called synchronously so proof consumption and viewer registration share one process turn. */
  enroll(nonce: string, publicKey: string, signature: string): boolean {
    const approved = this.#challenges.get(nonce);
    if (!approved || this.#viewers.size >= MAX_VIEWERS || this.#viewers.has(approved.challenge.keyDigest)) return false;
    const binding = approved.accept(publicKey, signature);
    if (!binding) return false;
    this.#challenges.delete(nonce);
    this.#viewers.set(binding.keyDigest, { binding, publicKey });
    return true;
  }

  viewer(keyDigest: string): Readonly<{ binding: ConnectViewerBinding; publicKey: string }> | undefined {
    const viewer = this.#viewers.get(keyDigest);
    return viewer && Object.freeze({ ...viewer });
  }

  /** Only the trusted local consent surface calls this after showing the exact viewer and display. */
  grant(consent: ConnectViewerConsent): ConnectViewerSession | undefined {
    const viewer = this.#viewers.get(consent.keyDigest);
    if (!viewer || viewer.binding.agentId !== consent.agentId ||
        viewer.binding.targetMachineId !== consent.targetMachineId) return;
    this.#sessions.get(consent.keyDigest)?.stop();
    const session = new ConnectViewerSession(consent);
    this.#sessions.set(consent.keyDigest, session);
    return session;
  }

  revoke(keyDigest: string): void {
    this.#viewers.delete(keyDigest);
    for (const [nonce, approved] of this.#challenges) {
      if (approved.challenge.keyDigest === keyDigest) this.#challenges.delete(nonce);
    }
    this.#sessions.get(keyDigest)?.stop();
    this.#sessions.delete(keyDigest);
  }
}

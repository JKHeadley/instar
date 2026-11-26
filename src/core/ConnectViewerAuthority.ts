import { verify } from 'node:crypto';
import { isStrictLowSDer, parseDevicePublicKey } from './MobileDeviceKeys.js';
import { ConnectViewerEnrollment, type ConnectViewerBinding } from './ConnectViewerEnrollment.js';
import { ConnectViewerSession, type ConnectViewerConsent } from './ConnectViewerSession.js';

const MAX_VIEWERS = 16;
const MAX_CHALLENGES = 16;

export function connectViewerAttachMessage(session: ConnectViewerSession): Buffer {
  const { agentId, targetMachineId, keyDigest, displayId, expiresAt } = session.consent;
  return Buffer.from(JSON.stringify([
    'instar-connect-attach-v1', 'look-only', session.id, agentId, targetMachineId, keyDigest, displayId, expiresAt,
  ]));
}

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
    const session = new ConnectViewerSession(consent);
    const keyDigest = session.consent.keyDigest;
    const previous = this.#sessions.get(keyDigest);
    // Abort listeners run synchronously and may revoke this viewer or replace this grant.
    this.#sessions.set(keyDigest, session);
    previous?.stop();
    return this.#viewers.get(keyDigest) === viewer && this.#sessions.get(keyDigest) === session ? session : undefined;
  }

  attach(keyDigest: string, sessionId: string, signature: string): AbortSignal | undefined {
    const viewer = this.#viewers.get(keyDigest);
    const session = this.#sessions.get(keyDigest);
    if (!viewer || !session || session.id !== sessionId || !/^[A-Za-z0-9_-]{8,100}$/.test(signature)) return;
    const key = parseDevicePublicKey(viewer.publicKey);
    const bytes = Buffer.from(signature, 'base64url');
    if (!key || bytes.toString('base64url') !== signature || !isStrictLowSDer(bytes) ||
        !verify('sha256', connectViewerAttachMessage(session), key, bytes)) return;
    return session.attach(viewer.binding, session.consent.displayId);
  }

  revoke(keyDigest: string): void {
    this.#viewers.delete(keyDigest);
    for (const [nonce, approved] of this.#challenges) {
      if (approved.challenge.keyDigest === keyDigest) this.#challenges.delete(nonce);
    }
    const session = this.#sessions.get(keyDigest);
    this.#sessions.delete(keyDigest);
    session?.stop();
  }
}

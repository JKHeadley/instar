import { connectConsentInteger, connectConsentText } from './ConnectConsentConnection.js';
import { ConnectConsentLifecycle, type PendingConnectConsent } from './ConnectConsentLifecycle.js';
import { isConnectConsentHostHandle, type ConnectConsentHostHandle } from './ConnectConsentHost.js';
import { createHash, randomBytes, verify, type KeyObject } from 'node:crypto';
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
  #issued = new WeakMap<ConnectConsentHostHandle, number>();

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

  /** Create one exchange from the verified request retained by the trusted connection owner. */
  beginConsent(consent: ConnectViewerConsent, connection: ConnectConsentHostHandle,
      agent: KeyObject, displayStillCurrent: () => boolean) {
    const retained = Object.freeze({ ...consent });
    const viewer = this.#viewers.get(retained.keyDigest);
    if (!isConnectConsentHostHandle(connection) || !viewer ||
        connection.agentId !== retained.agentId || connection.targetId !== retained.targetMachineId ||
        viewer.binding.agentId !== retained.agentId || viewer.binding.targetMachineId !== retained.targetMachineId ||
        !/^[a-f0-9]{64}$/.test(retained.keyDigest)) return;
    const remaining = retained.expiresAt - Date.now();
    if (!Number.isSafeInteger(retained.expiresAt) || remaining <= 0 || remaining > 15 * 60_000) return;
    const current = () => connection.current() && displayStillCurrent() &&
      !connection.signal.aborted && this.#viewers.get(retained.keyDigest) === viewer;
    if (!current()) return;
    const issued = this.#issued.get(connection) ?? 0;
    if (issued >= 128) return;
    const session = randomBytes(16);
    const nonce = randomBytes(32);
    const transcript = Buffer.concat([
      connectConsentText('instar-connect-consent-request-v1'), connectConsentText(retained.agentId),
      Buffer.from(connection.companionKeyDigest, 'hex'), connectConsentInteger(connection.revision),
      Buffer.from(connection.generation, 'hex'), Buffer.from(retained.keyDigest, 'hex'),
      connectConsentText(retained.targetMachineId), connectConsentText(retained.displayId),
      session, nonce, connectConsentInteger(retained.expiresAt), connectConsentText('look-only'),
    ]);
    const pending: PendingConnectConsent = {
      sessionId: session.toString('hex'), generation: connection.generation, nonce: nonce.toString('hex'),
      requestDigest: createHash('sha256').update(transcript).digest('hex'), expiresAt: retained.expiresAt,
    };
    this.#issued.set(connection, issued + 1);
    const exchange = new ConnectConsentLifecycle(pending, connection.companionKey, agent, current);
    connection.signal.addEventListener('abort', () => exchange.cancel(), { once: true });
    return {
      request: exchange.request,
      requestTranscript: Buffer.from(transcript),
      decide: (frame: Buffer) => exchange.decide(frame),
      prepare: (frame: Buffer) => exchange.prepare(frame),
      confirm: (frame: Buffer): ConnectViewerSession | undefined => {
        let grant: ConnectViewerSession | undefined;
        exchange.confirm(frame, request => {
          grant = this.#publish(retained, request, connection, current);
          return grant !== undefined;
        });
        return grant;
      },
      cancel: () => exchange.cancel(),
    };
  }

  #publish(consent: ConnectViewerConsent, pending: PendingConnectConsent, connection: ConnectConsentHostHandle,
      current: () => boolean): ConnectViewerSession | undefined {
    if (!current()) return;
    const viewer = this.#viewers.get(consent.keyDigest);
    if (connection.generation !== pending.generation || !/^[a-f0-9]{32}$/.test(pending.sessionId) ||
        connection.signal.aborted || !connection.current() || connection.signal.aborted ||
        this.#viewers.get(consent.keyDigest) !== viewer || !viewer || viewer.binding.agentId !== consent.agentId ||
        viewer.binding.targetMachineId !== consent.targetMachineId) return;
    const session = new ConnectViewerSession(consent, connection.signal, pending.sessionId);
    const keyDigest = session.consent.keyDigest;
    const previous = this.#sessions.get(keyDigest);
    // Abort listeners run synchronously and may revoke this viewer or replace this grant.
    this.#sessions.set(keyDigest, session);
    previous?.stop();
    return !connection.signal.aborted && this.#viewers.get(keyDigest) === viewer && this.#sessions.get(keyDigest) === session ? session : undefined;
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

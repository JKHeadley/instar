/**
 * Machine-to-machine authentication middleware.
 *
 * Verifies inter-machine API requests using the 5-header scheme:
 *   X-Machine-Id:  Sender's machine ID (must be active in registry)
 *   X-Timestamp:   Unix seconds (within 30s window)
 *   X-Nonce:       16 random bytes, hex-encoded (never reused)
 *   X-Sequence:    Per-peer monotonic counter
 *   X-Signature:   Ed25519("machineId|timestamp|nonce|sequence|SHA256(body)")
 *
 * Also provides helper to sign outgoing requests.
 *
 * Part of Phase 4 (secret sync infrastructure).
 */

import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { verify, sign } from '../core/MachineIdentity.js';
import type { MachineIdentityManager } from '../core/MachineIdentity.js';
import type { NonceStore } from '../core/NonceStore.js';
import type { SecurityLog } from '../core/SecurityLog.js';

// ── Types ──────────────────────────────────────────────────────────

export interface MachineAuthContext {
  /** The verified machine ID of the sender */
  machineId: string;
  /** The sequence number from this request */
  sequence: number;
}

export interface MachineAuthDeps {
  /** Machine identity manager (for registry lookups and key access) */
  identityManager: MachineIdentityManager;
  /** Nonce store for replay prevention */
  nonceStore: NonceStore;
  /** Security log for audit trail */
  securityLog: SecurityLog;
  /** This machine's ID (to reject self-requests) */
  localMachineId: string;
}

// ── Middleware ──────────────────────────────────────────────────────

/**
 * Express middleware that authenticates machine-to-machine requests.
 *
 * On success, attaches `req.machineAuth` with the verified sender info.
 * On failure, responds with 401/403 and logs the event.
 */
export function machineAuthMiddleware(deps: MachineAuthDeps) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const machineId = req.headers['x-machine-id'] as string | undefined;
    const timestamp = req.headers['x-timestamp'] as string | undefined;
    const nonce = req.headers['x-nonce'] as string | undefined;
    const sequence = req.headers['x-sequence'] as string | undefined;
    const signature = req.headers['x-signature'] as string | undefined;

    // 1. All headers must be present
    if (!machineId || !timestamp || !nonce || !sequence || !signature) {
      res.status(401).json({ error: 'Missing machine authentication headers' });
      return;
    }

    // 2. Machine must be in registry and active
    const registry = deps.identityManager.loadRegistry();
    const entry = registry.machines[machineId];
    if (!entry || entry.status !== 'active') {
      deps.securityLog.append({
        event: 'auth_rejected',
        machineId,
        reason: entry ? `Machine status: ${entry.status}` : 'Unknown machine',
        ip: req.ip || req.socket.remoteAddress || 'unknown',
      });
      res.status(403).json({ error: 'Machine not authorized' });
      return;
    }

    // 3. Validate via NonceStore (timestamp window + nonce uniqueness + sequence)
    const seqNum = parseInt(sequence, 10);
    if (isNaN(seqNum)) {
      res.status(400).json({ error: 'Invalid sequence number' });
      return;
    }

    const nonceResult = deps.nonceStore.validate(
      parseInt(timestamp, 10) * 1000, // Convert Unix seconds to ms
      nonce,
      seqNum,
      machineId,
    );

    if (!nonceResult.valid) {
      deps.securityLog.append({
        event: 'replay_detected',
        machineId,
        reason: nonceResult.reason,
        ip: req.ip || req.socket.remoteAddress || 'unknown',
      });
      res.status(403).json({ error: `Anti-replay check failed: ${nonceResult.reason}` });
      return;
    }

    // 4. Verify Ed25519 signature
    const bodyHash = crypto.createHash('sha256')
      .update(JSON.stringify(req.body) || '')
      .digest('hex');
    const signedMessage = `${machineId}|${timestamp}|${nonce}|${sequence}|${bodyHash}`;

    // Look up the machine's public signing key
    const publicKeyPem = deps.identityManager.getSigningPublicKeyPem(machineId);
    if (!publicKeyPem) {
      res.status(403).json({ error: 'Machine public key not found' });
      return;
    }

    try {
      const isValid = verify(signedMessage, signature, publicKeyPem);
      if (!isValid) {
        deps.securityLog.append({
          event: 'signature_invalid',
          machineId,
          ip: req.ip || req.socket.remoteAddress || 'unknown',
        });
        res.status(403).json({ error: 'Invalid signature' });
        return;
      }
    } catch (err) {
      deps.securityLog.append({
        event: 'signature_error',
        machineId,
        error: err instanceof Error ? err.message : String(err),
        ip: req.ip || req.socket.remoteAddress || 'unknown',
      });
      res.status(403).json({ error: 'Signature verification failed' });
      return;
    }

    // 5. All checks passed — attach auth context
    (req as any).machineAuth = {
      machineId,
      sequence: seqNum,
    } satisfies MachineAuthContext;

    next();
  };
}

// ── Request Signing ────────────────────────────────────────────────

export interface SignedHeaders {
  'X-Machine-Id': string;
  'X-Timestamp': string;
  'X-Nonce': string;
  'X-Sequence': string;
  'X-Signature': string;
}

/**
 * Process-global monotonic sequence for ALL machineAuth-signed outbound requests.
 *
 * The receiver's NonceStore tracks ONE monotonic sequence PER SENDING MACHINE
 * (src/core/NonceStore.ts) — so EVERY signed channel from this process (lease
 * broadcast, machine heartbeat, handoff, reply-marker, live-tail, …) MUST draw
 * from a single shared counter. They previously each used their own
 * `Date.now()`-seeded counter; the fast-firing heartbeat pushed the receiver's
 * per-machine watermark high while the slow lease counter stayed low, so every
 * lease broadcast was rejected as an out-of-order replay and the standby never
 * learned the holder (found live 2026-05-31:
 * `Sequence 1780200440053 <= last seen 1780200440744`). Seeding from `Date.now()`
 * keeps it monotonic across a process restart (wall-clock only advances), so the
 * receiver's persisted watermark from a prior run is never above our fresh seed.
 */
let __machineAuthSequence = Date.now();
/** The next process-global machineAuth sequence (strictly increasing). */
export function nextMachineAuthSequence(): number {
  __machineAuthSequence += 1;
  return __machineAuthSequence;
}

/**
 * Sign an outgoing request with machine credentials.
 *
 * @param machineId - This machine's ID
 * @param privateKeyPem - Ed25519 private key in PEM format
 * @param body - The request body (will be JSON stringified for hashing)
 * @param _legacySequence - IGNORED. Retained for signature compatibility with
 *   existing callers. The sequence is now drawn from the process-global
 *   `nextMachineAuthSequence()` so every channel shares one monotonic counter
 *   (see the note above — per-caller counters collided on the receiver's
 *   per-machine watermark). New callers may omit it.
 * @returns Headers to include in the request
 */
export function signRequest(
  machineId: string,
  privateKeyPem: string,
  body: unknown,
  _legacySequence?: number,
): SignedHeaders {
  const sequence = nextMachineAuthSequence();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodyHash = crypto.createHash('sha256')
    .update(JSON.stringify(body) || '')
    .digest('hex');

  const message = `${machineId}|${timestamp}|${nonce}|${sequence}|${bodyHash}`;
  const sig = sign(message, privateKeyPem);

  return {
    'X-Machine-Id': machineId,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Sequence': sequence.toString(),
    'X-Signature': sig,
  };
}

// ── multi-transport-mesh-comms — freshness-bound accept-ack (Decision 9) ──────
// The receiver signs an `ack` proving it (a) is the expected peer, (b) folded the
// caller's CURRENT lease (observedEpoch), and (c) is answering THIS request (the
// echoed reqNonce). Domain-separated under `mesh-ack-v1|` so an ack signature can
// never be replayed as a request signature (the request message format is
// `machineId|ts|nonce|seq|bodyHash`, which never starts with `mesh-ack-v1|`).

/** The signed body of an accept-ack. `reqNonce` echoes the caller's challenge. */
export interface LeaseAck {
  machineId: string;
  reqNonce: string;
  observedEpoch: number;
}

/** Canonical, domain-separated message bytes for an accept-ack. */
function leaseAckMessage(ack: LeaseAck): string {
  return `mesh-ack-v1|${ack.machineId}|${ack.reqNonce}|${ack.observedEpoch}`;
}

/** Receiver-side: sign an accept-ack with this machine's private key. */
export function signLeaseAck(ack: LeaseAck, privateKeyPem: string): string {
  return sign(leaseAckMessage(ack), privateKeyPem);
}

/**
 * Caller-side: verify an accept-ack is fresh + from the expected peer + confirms
 * OUR epoch. Returns 'confirmed' (fold of our lease), 'higher-epoch' (a real
 * takeover — stand down, do NOT confirm), or false (replay / wrong responder /
 * bad sig / stale nonce → FAILED rope, fail-closed).
 */
export function verifyLeaseAck(
  ack: LeaseAck | undefined,
  sig: string | undefined,
  expectedPeerId: string,
  sentReqNonce: string,
  sentEpoch: number,
  peerPublicKeyPem: string,
): 'confirmed' | 'higher-epoch' | false {
  if (!ack || !sig) return false;
  if (typeof ack.machineId !== 'string' || typeof ack.reqNonce !== 'string' || typeof ack.observedEpoch !== 'number') {
    return false;
  }
  if (ack.machineId !== expectedPeerId) return false; // responder identity
  if (ack.reqNonce !== sentReqNonce) return false; // freshness — defeats recorded-ack replay
  let sigOk = false;
  try {
    sigOk = verify(leaseAckMessage(ack), sig, peerPublicKeyPem);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return false;
  if (ack.observedEpoch === sentEpoch) return 'confirmed';
  if (ack.observedEpoch > sentEpoch) return 'higher-epoch';
  return false; // a lower folded epoch never confirms our renewal
}

/**
 * Caller-side (PULL): verify an accept-ack proves the responder is the expected
 * peer AND is answering THIS request — WITHOUT epoch-equality (a pull reads the
 * peer's lease, it does not fold ours). Used by /api/lease/pull. Returns true iff
 * sig verifies + machineId matches + reqNonce echoes our challenge.
 */
export function verifyLeaseAckIdentity(
  ack: LeaseAck | undefined,
  sig: string | undefined,
  expectedPeerId: string,
  sentReqNonce: string,
  peerPublicKeyPem: string,
): boolean {
  if (!ack || !sig) return false;
  if (typeof ack.machineId !== 'string' || typeof ack.reqNonce !== 'string') return false;
  if (ack.machineId !== expectedPeerId) return false;
  if (ack.reqNonce !== sentReqNonce) return false;
  try {
    return verify(leaseAckMessage(ack), sig, peerPublicKeyPem);
  } catch {
    return false;
  }
}

/** Caller-side: mint a fresh challenge nonce (Decision 9 — crypto.randomBytes(16) hex). */
export function newReqNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

// ── Challenge-Response ─────────────────────────────────────────────

export interface Challenge {
  /** Random 32-byte challenge, hex-encoded */
  challenge: string;
  /** When this challenge expires */
  expiresAt: number;
  /** Whether this challenge has been consumed */
  consumed: boolean;
}

/**
 * Manages challenge-response for high-value endpoints.
 * Challenges are single-use, expire after 10 seconds.
 */
export class ChallengeStore {
  private challenges = new Map<string, Challenge>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    // Clean up expired challenges every 30 seconds
    this.cleanupTimer = setInterval(() => this.cleanup(), 30_000);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /** Generate a new challenge. Returns the challenge string. */
  generate(): Challenge {
    const challenge: Challenge = {
      challenge: crypto.randomBytes(32).toString('hex'),
      expiresAt: Date.now() + 10_000, // 10 seconds
      consumed: false,
    };
    this.challenges.set(challenge.challenge, challenge);
    return challenge;
  }

  /**
   * Consume a challenge. Returns true if the challenge was valid and unconsumed.
   * The challenge is marked as consumed and cannot be reused.
   */
  consume(challengeStr: string): boolean {
    const challenge = this.challenges.get(challengeStr);
    if (!challenge) return false;
    if (challenge.consumed) return false;
    if (Date.now() > challenge.expiresAt) {
      this.challenges.delete(challengeStr);
      return false;
    }
    challenge.consumed = true;
    this.challenges.delete(challengeStr);
    return true;
  }

  /** Clean up expired challenges. */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, challenge] of this.challenges) {
      if (now > challenge.expiresAt) {
        this.challenges.delete(key);
      }
    }
  }

  /** Stop the cleanup timer. */
  destroy(): void {
    clearInterval(this.cleanupTimer);
  }
}

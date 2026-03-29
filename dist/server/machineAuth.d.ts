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
import type { MachineIdentityManager } from '../core/MachineIdentity.js';
import type { NonceStore } from '../core/NonceStore.js';
import type { SecurityLog } from '../core/SecurityLog.js';
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
/**
 * Express middleware that authenticates machine-to-machine requests.
 *
 * On success, attaches `req.machineAuth` with the verified sender info.
 * On failure, responds with 401/403 and logs the event.
 */
export declare function machineAuthMiddleware(deps: MachineAuthDeps): (req: Request, res: Response, next: NextFunction) => void;
export interface SignedHeaders {
    'X-Machine-Id': string;
    'X-Timestamp': string;
    'X-Nonce': string;
    'X-Sequence': string;
    'X-Signature': string;
}
/**
 * Sign an outgoing request with machine credentials.
 *
 * @param machineId - This machine's ID
 * @param privateKeyPem - Ed25519 private key in PEM format
 * @param body - The request body (will be JSON stringified for hashing)
 * @param sequence - The sequence number for this request
 * @returns Headers to include in the request
 */
export declare function signRequest(machineId: string, privateKeyPem: string, body: unknown, sequence: number): SignedHeaders;
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
export declare class ChallengeStore {
    private challenges;
    private cleanupTimer;
    constructor();
    /** Generate a new challenge. Returns the challenge string. */
    generate(): Challenge;
    /**
     * Consume a challenge. Returns true if the challenge was valid and unconsumed.
     * The challenge is marked as consumed and cannot be reused.
     */
    consume(challengeStr: string): boolean;
    /** Clean up expired challenges. */
    private cleanup;
    /** Stop the cleanup timer. */
    destroy(): void;
}
//# sourceMappingURL=machineAuth.d.ts.map
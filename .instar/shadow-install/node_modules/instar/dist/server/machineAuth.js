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
import crypto from 'node:crypto';
import { verify, sign } from '../core/MachineIdentity.js';
// ── Middleware ──────────────────────────────────────────────────────
/**
 * Express middleware that authenticates machine-to-machine requests.
 *
 * On success, attaches `req.machineAuth` with the verified sender info.
 * On failure, responds with 401/403 and logs the event.
 */
export function machineAuthMiddleware(deps) {
    return (req, res, next) => {
        const machineId = req.headers['x-machine-id'];
        const timestamp = req.headers['x-timestamp'];
        const nonce = req.headers['x-nonce'];
        const sequence = req.headers['x-sequence'];
        const signature = req.headers['x-signature'];
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
        const nonceResult = deps.nonceStore.validate(parseInt(timestamp, 10) * 1000, // Convert Unix seconds to ms
        nonce, seqNum, machineId);
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
        }
        catch (err) {
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
        req.machineAuth = {
            machineId,
            sequence: seqNum,
        };
        next();
    };
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
export function signRequest(machineId, privateKeyPem, body, sequence) {
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
/**
 * Manages challenge-response for high-value endpoints.
 * Challenges are single-use, expire after 10 seconds.
 */
export class ChallengeStore {
    challenges = new Map();
    cleanupTimer;
    constructor() {
        // Clean up expired challenges every 30 seconds
        this.cleanupTimer = setInterval(() => this.cleanup(), 30_000);
        if (this.cleanupTimer.unref)
            this.cleanupTimer.unref();
    }
    /** Generate a new challenge. Returns the challenge string. */
    generate() {
        const challenge = {
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
    consume(challengeStr) {
        const challenge = this.challenges.get(challengeStr);
        if (!challenge)
            return false;
        if (challenge.consumed)
            return false;
        if (Date.now() > challenge.expiresAt) {
            this.challenges.delete(challengeStr);
            return false;
        }
        challenge.consumed = true;
        this.challenges.delete(challengeStr);
        return true;
    }
    /** Clean up expired challenges. */
    cleanup() {
        const now = Date.now();
        for (const [key, challenge] of this.challenges) {
            if (now > challenge.expiresAt) {
                this.challenges.delete(key);
            }
        }
    }
    /** Stop the cleanup timer. */
    destroy() {
        clearInterval(this.cleanupTimer);
    }
}
//# sourceMappingURL=machineAuth.js.map
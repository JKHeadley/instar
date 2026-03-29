/**
 * Multi-machine API routes.
 *
 * Endpoints for inter-machine communication:
 *   POST /api/heartbeat          — Receive heartbeat from another machine
 *   POST /api/pair               — Handle pairing requests
 *   POST /api/handoff/challenge  — Generate challenge for handoff
 *   POST /api/handoff/request    — Request role handoff
 *   POST /api/secrets/challenge  — Generate challenge for secret sync
 *   POST /api/secrets/sync       — Receive encrypted secrets
 *   POST /api/sync/state         — Sync operational state
 *
 * All endpoints (except /api/pair) require machine-to-machine authentication.
 *
 * Part of Phases 4-5 of the multi-machine spec.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import { verify } from '../core/MachineIdentity.js';
import { machineAuthMiddleware, ChallengeStore } from './machineAuth.js';
// ── Route Factory ──────────────────────────────────────────────────
export function createMachineRoutes(ctx) {
    const router = Router();
    const authMiddleware = machineAuthMiddleware(ctx.authDeps);
    const handoffChallenges = new ChallengeStore();
    const secretChallenges = new ChallengeStore();
    // ── POST /api/heartbeat — Receive heartbeat from another machine ──
    router.post('/api/heartbeat', authMiddleware, (req, res) => {
        const { machineAuth } = req;
        const auth = machineAuth;
        const incoming = req.body;
        if (!incoming || !incoming.holder || !incoming.timestamp || !incoming.expiresAt) {
            res.status(400).json({ error: 'Invalid heartbeat payload' });
            return;
        }
        // Verify the heartbeat holder matches the authenticated machine
        if (incoming.holder !== auth.machineId) {
            ctx.securityLog.append({
                event: 'heartbeat_mismatch',
                machineId: auth.machineId,
                detail: `Heartbeat holder ${incoming.holder} != authenticated ${auth.machineId}`,
            });
            res.status(403).json({ error: 'Heartbeat holder does not match authenticated machine' });
            return;
        }
        const result = ctx.heartbeatManager.processIncomingHeartbeat(incoming);
        ctx.securityLog.append({
            event: 'heartbeat_received',
            machineId: auth.machineId,
            result,
        });
        if (result === 'demote') {
            // We should demote — the incoming heartbeat is newer
            ctx.onDemote?.();
            res.json({ status: 'acknowledged', action: 'we-demoted' });
        }
        else if (result === 'they-should-demote') {
            // Our heartbeat is newer — tell them to demote
            res.json({ status: 'conflict', action: 'you-should-demote' });
        }
        else {
            // ignore (from self or non-conflicting)
            res.json({ status: 'acknowledged', action: 'none' });
        }
    });
    // ── POST /api/pair — Handle pairing from a new machine ──────────
    // Note: This endpoint does NOT use machineAuth (new machine isn't registered yet).
    // Instead, it relies on the pairing code exchange for authentication.
    router.post('/api/pair', (req, res) => {
        const { pairingCode, machineIdentity, ephemeralPublicKey } = req.body;
        if (!pairingCode || !machineIdentity || !ephemeralPublicKey) {
            res.status(400).json({ error: 'Missing required pairing fields' });
            return;
        }
        // Pairing validation is handled by the caller (CLI command).
        // This endpoint just receives the request and signals the pairing flow.
        // The actual pairing code comparison and SAS verification happen interactively.
        ctx.securityLog.append({
            event: 'pairing_request',
            machineId: machineIdentity.machineId,
            machineName: machineIdentity.name,
            ip: req.ip || req.socket.remoteAddress || 'unknown',
        });
        // Return this machine's identity and an ephemeral key for the ECDH exchange
        const localIdentity = ctx.identityManager.loadIdentity();
        res.json({
            status: 'pending',
            machineIdentity: localIdentity,
            message: 'Pairing request received. Verify the SAS on both machines.',
        });
    });
    // ── POST /api/handoff/challenge — Generate challenge for handoff ──
    router.post('/api/handoff/challenge', authMiddleware, (req, res) => {
        const challenge = handoffChallenges.generate();
        res.json({
            challenge: challenge.challenge,
            expiresAt: challenge.expiresAt,
        });
    });
    // ── POST /api/handoff/request — Request role handoff ──────────────
    router.post('/api/handoff/request', authMiddleware, async (req, res) => {
        const { machineAuth } = req;
        const auth = machineAuth;
        const { challenge, challengeSignature } = req.body;
        // 1. Verify challenge
        if (!challenge || !challengeSignature) {
            res.status(400).json({ error: 'Missing challenge or signature' });
            return;
        }
        if (!handoffChallenges.consume(challenge)) {
            res.status(403).json({ error: 'Invalid, expired, or already-used challenge' });
            return;
        }
        // 2. Verify challenge signature
        // The sender signs: challenge + sender_machine_id + receiver_machine_id + SHA256(body-without-challenge-fields)
        const bodyForHash = { ...req.body };
        delete bodyForHash.challenge;
        delete bodyForHash.challengeSignature;
        const bodyHash = crypto.createHash('sha256')
            .update(JSON.stringify(bodyForHash))
            .digest('hex');
        const challengeMessage = `${challenge}|${auth.machineId}|${ctx.localMachineId}|${bodyHash}`;
        const publicKeyPem = ctx.identityManager.getSigningPublicKeyPem(auth.machineId);
        if (!publicKeyPem) {
            res.status(403).json({ error: 'Machine public key not found' });
            return;
        }
        try {
            const valid = verify(challengeMessage, challengeSignature, publicKeyPem);
            if (!valid) {
                ctx.securityLog.append({
                    event: 'handoff_challenge_failed',
                    machineId: auth.machineId,
                });
                res.status(403).json({ error: 'Invalid challenge signature' });
                return;
            }
        }
        catch {
            res.status(403).json({ error: 'Challenge verification failed' });
            return;
        }
        ctx.securityLog.append({
            event: 'handoff_requested',
            machineId: auth.machineId,
            machineName: ctx.identityManager.loadRemoteIdentity(auth.machineId)?.name ?? auth.machineId,
        });
        // 3. Prepare for handoff — stop services and sync state
        try {
            const handoffResult = await ctx.onHandoffRequest?.();
            if (!handoffResult?.ready) {
                res.json({
                    status: 'not-ready',
                    message: 'This machine is not ready to hand off. Try again shortly.',
                });
                return;
            }
            // Update registry: demote self to standby
            ctx.identityManager.updateRole(ctx.localMachineId, 'standby');
            ctx.identityManager.updateRole(auth.machineId, 'awake');
            ctx.securityLog.append({
                event: 'handoff_completed',
                machineId: auth.machineId,
                from: ctx.localMachineId,
            });
            ctx.onDemote?.();
            res.json({
                status: 'handed-off',
                state: handoffResult.state,
                message: 'Handoff complete. You are now the awake machine.',
            });
        }
        catch (err) {
            ctx.securityLog.append({
                event: 'handoff_failed',
                machineId: auth.machineId,
                error: err instanceof Error ? err.message : String(err),
            });
            res.status(500).json({ error: 'Handoff failed' });
        }
    });
    // ── POST /api/secrets/challenge — Generate challenge for secret sync ──
    router.post('/api/secrets/challenge', authMiddleware, (req, res) => {
        const challenge = secretChallenges.generate();
        res.json({
            challenge: challenge.challenge,
            expiresAt: challenge.expiresAt,
        });
    });
    // ── POST /api/secrets/sync — Receive encrypted secrets ──────────
    router.post('/api/secrets/sync', authMiddleware, (req, res) => {
        const { machineAuth } = req;
        const auth = machineAuth;
        const { challenge, challengeSignature, ephemeralPublicKey, ciphertext, nonce, tag } = req.body;
        // 1. Verify challenge (same pattern as handoff)
        if (!challenge || !challengeSignature) {
            res.status(400).json({ error: 'Missing challenge or signature' });
            return;
        }
        if (!secretChallenges.consume(challenge)) {
            res.status(403).json({ error: 'Invalid, expired, or already-used challenge' });
            return;
        }
        // 2. Verify challenge signature
        const bodyForHash = { ...req.body };
        delete bodyForHash.challenge;
        delete bodyForHash.challengeSignature;
        const bodyHash = crypto.createHash('sha256')
            .update(JSON.stringify(bodyForHash))
            .digest('hex');
        const challengeMessage = `${challenge}|${auth.machineId}|${ctx.localMachineId}|${bodyHash}`;
        const publicKeyPem = ctx.identityManager.getSigningPublicKeyPem(auth.machineId);
        if (!publicKeyPem) {
            res.status(403).json({ error: 'Machine public key not found' });
            return;
        }
        try {
            const valid = verify(challengeMessage, challengeSignature, publicKeyPem);
            if (!valid) {
                ctx.securityLog.append({
                    event: 'secret_sync_challenge_failed',
                    machineId: auth.machineId,
                });
                res.status(403).json({ error: 'Invalid challenge signature' });
                return;
            }
        }
        catch {
            res.status(403).json({ error: 'Challenge verification failed' });
            return;
        }
        // 3. Validate encrypted payload
        if (!ephemeralPublicKey || !ciphertext || !nonce || !tag) {
            res.status(400).json({ error: 'Missing encryption payload fields' });
            return;
        }
        ctx.securityLog.append({
            event: 'secret_sync_received',
            machineId: auth.machineId,
        });
        // Decryption is handled by the caller (the server lifecycle code).
        // This route just validates auth + challenge and returns the encrypted payload
        // for the server to decrypt with its own private key.
        res.json({
            status: 'received',
            message: 'Encrypted secrets received. Decryption will be handled locally.',
        });
    });
    // ── POST /api/sync/state — Sync operational state ──────────────
    router.post('/api/sync/state', authMiddleware, (req, res) => {
        const { machineAuth } = req;
        const auth = machineAuth;
        const { type, data, timestamp } = req.body;
        if (!type || !data) {
            res.status(400).json({ error: 'Missing sync type or data' });
            return;
        }
        const validTypes = ['jobs', 'sessions', 'logs'];
        if (!validTypes.includes(type)) {
            res.status(400).json({ error: `Invalid sync type: ${type}. Valid: ${validTypes.join(', ')}` });
            return;
        }
        ctx.securityLog.append({
            event: 'state_sync_received',
            machineId: auth.machineId,
            syncType: type,
        });
        // State sync application is handled by the server lifecycle code.
        // This route validates auth and returns acknowledgment.
        res.json({
            status: 'received',
            type,
            timestamp: new Date().toISOString(),
        });
    });
    // ── POST /api/messages/relay-machine — Cross-machine message relay ──
    // Protected by Machine-HMAC (5-header scheme). Envelope carries Ed25519 signature
    // verified by the MessageRouter.relay() method.
    router.post('/api/messages/relay-machine', authMiddleware, async (req, res) => {
        if (!ctx.messageRouter) {
            res.status(503).json({ error: 'Messaging not available' });
            return;
        }
        try {
            const envelope = req.body;
            if (!envelope?.message?.id) {
                res.status(400).json({ error: 'Invalid envelope' });
                return;
            }
            // Ed25519 signature verification happens inside relay() for source='machine'
            const accepted = await ctx.messageRouter.relay(envelope, 'machine');
            if (accepted) {
                res.json({ ok: true });
            }
            else {
                res.status(409).json({ error: 'Relay rejected (loop, duplicate, or invalid signature)' });
            }
        }
        catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : 'Relay failed' });
        }
    });
    return router;
}
//# sourceMappingURL=machineRoutes.js.map
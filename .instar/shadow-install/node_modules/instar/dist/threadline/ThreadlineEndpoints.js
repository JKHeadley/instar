/**
 * ThreadlineEndpoints — HTTP route handlers for the Threadline protocol.
 *
 * Routes:
 *   GET  /threadline/health              — Health check + version
 *   POST /threadline/handshake/hello     — Initiate handshake (unauthenticated)
 *   POST /threadline/handshake/confirm   — Complete handshake (unauthenticated)
 *   POST /threadline/messages/receive    — Receive a message (authenticated)
 *   GET  /threadline/messages/thread/:id — Get thread messages (authenticated)
 *   GET  /threadline/blobs/:id           — Fetch blob content (authenticated)
 *
 * Authentication: Threadline-Relay token + signed headers for authenticated routes.
 * Content-Type: application/threadline+json; version=1.0
 *
 * Part of Threadline Protocol Phase 3.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import { verify } from './ThreadlineCrypto.js';
// ── Error Codes ──────────────────────────────────────────────────────
const ERROR_CODES = {
    TL_AUTH_FAILED: 'TL_AUTH_FAILED',
    TL_AUTH_MISSING: 'TL_AUTH_MISSING',
    TL_INVALID_PAYLOAD: 'TL_INVALID_PAYLOAD',
    TL_HANDSHAKE_FAILED: 'TL_HANDSHAKE_FAILED',
    TL_RATE_LIMITED: 'TL_RATE_LIMITED',
    TL_NOT_FOUND: 'TL_NOT_FOUND',
    TL_INTERNAL_ERROR: 'TL_INTERNAL_ERROR',
    TL_REPLAY_DETECTED: 'TL_REPLAY_DETECTED',
    TL_TIMESTAMP_EXPIRED: 'TL_TIMESTAMP_EXPIRED',
};
const CONTENT_TYPE = 'application/threadline+json; version=1.0';
const TIMESTAMP_WINDOW_MS = 30_000; // 30 seconds
// ── Nonce Store (replay protection for authenticated endpoints) ──────
class ThreadlineNonceStore {
    nonces = new Set();
    pruneTimer;
    constructor() {
        // Prune every 60 seconds
        this.pruneTimer = setInterval(() => {
            this.nonces.clear(); // Simple approach: clear all every minute
        }, 60_000);
        if (this.pruneTimer.unref)
            this.pruneTimer.unref();
    }
    check(nonce) {
        if (this.nonces.has(nonce))
            return false;
        this.nonces.add(nonce);
        return true;
    }
    destroy() {
        clearInterval(this.pruneTimer);
    }
}
// ── Route Factory ────────────────────────────────────────────────────
export function createThreadlineRoutes(handshakeManager, threadlineRouter, config) {
    const router = Router();
    const nonceStore = new ThreadlineNonceStore();
    // ── Content-Type middleware for all threadline routes ───────────
    router.use('/threadline', (_req, res, next) => {
        res.setHeader('Content-Type', CONTENT_TYPE);
        next();
    });
    // ── Health ─────────────────────────────────────────────────────
    router.get('/threadline/health', (_req, res) => {
        res.json({
            status: 'ok',
            protocol: 'threadline',
            version: config.version,
            agent: config.localAgent,
            identityPub: handshakeManager.getIdentityPublicKey(),
            pairedAgents: handshakeManager.listPairedAgents().length,
            timestamp: new Date().toISOString(),
        });
    });
    // ── Handshake: Hello (UNAUTHENTICATED) ─────────────────────────
    router.post('/threadline/handshake/hello', (req, res) => {
        try {
            const body = req.body;
            // Validate payload
            if (!body || !body.agent || !body.identityPub || !body.ephemeralPub || !body.nonce) {
                res.status(400).json(makeError(ERROR_CODES.TL_INVALID_PAYLOAD, 'Missing required fields: agent, identityPub, ephemeralPub, nonce', false));
                return;
            }
            // Validate hex encoding
            if (!isHex(body.identityPub, 64) || !isHex(body.ephemeralPub, 64)) {
                res.status(400).json(makeError(ERROR_CODES.TL_INVALID_PAYLOAD, 'identityPub and ephemeralPub must be 32-byte hex-encoded values', false));
                return;
            }
            const hello = {
                agent: body.agent,
                identityPub: body.identityPub,
                ephemeralPub: body.ephemeralPub,
                nonce: body.nonce,
                challengeResponse: body.challengeResponse,
            };
            // Check if this is a hello-response (has challengeResponse) to our initiated hello
            if (hello.challengeResponse) {
                const result = handshakeManager.handleHelloResponse(hello);
                if ('error' in result) {
                    const statusCode = result.error.includes('Rate limited') ? 429 : 400;
                    res.status(statusCode).json(makeError(result.error.includes('Rate limited') ? ERROR_CODES.TL_RATE_LIMITED : ERROR_CODES.TL_HANDSHAKE_FAILED, result.error, result.error.includes('Rate limited'), result.error.includes('Rate limited') ? 60 : undefined));
                    return;
                }
                res.json({
                    type: 'confirm-ack',
                    agent: config.localAgent,
                    status: 'paired',
                });
                return;
            }
            // Standard hello — they're initiating
            const result = handshakeManager.handleHello(hello);
            if ('error' in result) {
                const statusCode = result.error.includes('Rate limited') ? 429 : 400;
                res.status(statusCode).json(makeError(result.error.includes('Rate limited') ? ERROR_CODES.TL_RATE_LIMITED : ERROR_CODES.TL_HANDSHAKE_FAILED, result.error, result.error.includes('Rate limited'), result.error.includes('Rate limited') ? 60 : undefined));
                return;
            }
            res.json({
                type: 'hello-response',
                ...result.payload,
            });
        }
        catch (err) {
            console.error('[ThreadlineEndpoints] Handshake hello error:', err);
            res.status(500).json(makeError(ERROR_CODES.TL_INTERNAL_ERROR, 'Internal error during handshake', true, 5));
        }
    });
    // ── Handshake: Confirm (UNAUTHENTICATED) ───────────────────────
    router.post('/threadline/handshake/confirm', (req, res) => {
        try {
            const body = req.body;
            if (!body || !body.agent || !body.challengeResponse) {
                res.status(400).json(makeError(ERROR_CODES.TL_INVALID_PAYLOAD, 'Missing required fields: agent, challengeResponse', false));
                return;
            }
            const confirm = {
                agent: body.agent,
                challengeResponse: body.challengeResponse,
            };
            const result = handshakeManager.handleConfirm(confirm);
            if ('error' in result) {
                const statusCode = result.error.includes('Rate limited') ? 429 :
                    result.error.includes('timed out') ? 408 : 400;
                res.status(statusCode).json(makeError(result.error.includes('Rate limited') ? ERROR_CODES.TL_RATE_LIMITED : ERROR_CODES.TL_HANDSHAKE_FAILED, result.error, result.error.includes('Rate limited') || result.error.includes('timed out'), result.error.includes('Rate limited') ? 60 : undefined));
                return;
            }
            res.json({
                type: 'confirm-ack',
                agent: config.localAgent,
                status: 'paired',
            });
        }
        catch (err) {
            console.error('[ThreadlineEndpoints] Handshake confirm error:', err);
            res.status(500).json(makeError(ERROR_CODES.TL_INTERNAL_ERROR, 'Internal error during handshake', true, 5));
        }
    });
    // ── Auth Middleware for authenticated endpoints ────────────────
    const threadlineAuth = (req, res, next) => {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Threadline-Relay ')) {
            res.status(401).json(makeError(ERROR_CODES.TL_AUTH_MISSING, 'Missing Authorization: Threadline-Relay <token> header', false));
            return;
        }
        const token = authHeader.slice('Threadline-Relay '.length);
        const agentName = req.headers['x-threadline-agent'];
        const nonce = req.headers['x-threadline-nonce'];
        const timestamp = req.headers['x-threadline-timestamp'];
        const signature = req.headers['x-threadline-signature'];
        if (!agentName || !nonce || !timestamp || !signature) {
            res.status(401).json(makeError(ERROR_CODES.TL_AUTH_MISSING, 'Missing required headers: X-Threadline-Agent, X-Threadline-Nonce, X-Threadline-Timestamp, X-Threadline-Signature', false));
            return;
        }
        // Validate relay token
        if (!handshakeManager.validateRelayToken(agentName, token)) {
            res.status(403).json(makeError(ERROR_CODES.TL_AUTH_FAILED, 'Invalid relay token for agent', false));
            return;
        }
        // Validate timestamp freshness
        const tsMs = new Date(timestamp).getTime();
        if (isNaN(tsMs) || Math.abs(Date.now() - tsMs) > TIMESTAMP_WINDOW_MS) {
            res.status(401).json(makeError(ERROR_CODES.TL_TIMESTAMP_EXPIRED, 'Timestamp outside acceptable window', true, 1));
            return;
        }
        // Replay protection via nonce
        if (!nonceStore.check(nonce)) {
            res.status(401).json(makeError(ERROR_CODES.TL_REPLAY_DETECTED, 'Nonce already used (replay detected)', false));
            return;
        }
        // Verify signature: Ed25519 sign over (method + path + nonce + timestamp + body_hash)
        const bodyHash = crypto.createHash('sha256')
            .update(JSON.stringify(req.body ?? ''))
            .digest();
        const signedData = Buffer.concat([
            Buffer.from(`${req.method}\n${req.path}\n${nonce}\n${timestamp}\n`, 'utf-8'),
            bodyHash,
        ]);
        // We need the agent's identity pub to verify
        // It's stored in the relay tokens via handshakeManager
        // For now we accept the signature check against the stored identity
        try {
            const identityPub = getAgentIdentityPub(handshakeManager, agentName);
            if (!identityPub) {
                res.status(403).json(makeError(ERROR_CODES.TL_AUTH_FAILED, 'Unknown agent identity', false));
                return;
            }
            const isValid = verify(Buffer.from(identityPub, 'hex'), signedData, Buffer.from(signature, 'hex'));
            if (!isValid) {
                res.status(403).json(makeError(ERROR_CODES.TL_AUTH_FAILED, 'Signature verification failed', false));
                return;
            }
        }
        catch {
            res.status(403).json(makeError(ERROR_CODES.TL_AUTH_FAILED, 'Signature verification error', false));
            return;
        }
        next();
    };
    // ── Messages: Receive (AUTHENTICATED) ──────────────────────────
    router.post('/threadline/messages/receive', threadlineAuth, async (req, res) => {
        try {
            const body = req.body;
            if (!body || !body.message) {
                res.status(400).json(makeError(ERROR_CODES.TL_INVALID_PAYLOAD, 'Missing required field: message', false));
                return;
            }
            if (!threadlineRouter) {
                res.status(503).json(makeError(ERROR_CODES.TL_INTERNAL_ERROR, 'Threadline router not available', true, 5));
                return;
            }
            // Route the message through the ThreadlineRouter
            // Build a minimal MessageEnvelope from the inbound payload
            const envelope = {
                schemaVersion: 1,
                message: body.message,
                transport: body.transport ?? {
                    originServer: req.headers['x-threadline-agent'],
                    nonce: req.headers['x-threadline-nonce'],
                    timestamp: req.headers['x-threadline-timestamp'],
                },
                delivery: body.delivery ?? {
                    status: 'pending',
                    attempts: 0,
                    createdAt: new Date().toISOString(),
                },
            };
            const result = await threadlineRouter.handleInboundMessage(envelope);
            if (result.error) {
                res.status(422).json(makeError(ERROR_CODES.TL_INTERNAL_ERROR, result.error, true, 5));
                return;
            }
            res.json({
                accepted: true,
                threadId: result.threadId,
                spawned: result.spawned,
                resumed: result.resumed,
            });
        }
        catch (err) {
            console.error('[ThreadlineEndpoints] Message receive error:', err);
            res.status(500).json(makeError(ERROR_CODES.TL_INTERNAL_ERROR, 'Internal error processing message', true, 5));
        }
    });
    // ── Messages: Thread (AUTHENTICATED) ───────────────────────────
    router.get('/threadline/messages/thread/:id', threadlineAuth, (_req, res) => {
        // Thread retrieval — returns messages in this thread
        // For now, this returns a placeholder. Full implementation depends on
        // MessageStore integration which is outside Phase 3 scope.
        const threadId = _req.params.id;
        res.json({
            threadId,
            messages: [],
            messageCount: 0,
        });
    });
    // ── Blobs: Fetch (AUTHENTICATED) ──────────────────────────────
    router.get('/threadline/blobs/:id', threadlineAuth, (_req, res) => {
        // Blob retrieval — returns binary content for a blob ID.
        // Placeholder for Phase 3. Full blob storage is a future phase.
        const blobId = _req.params.id;
        res.status(404).json(makeError(ERROR_CODES.TL_NOT_FOUND, `Blob ${blobId} not found`, false));
    });
    return router;
}
// ── Helpers ──────────────────────────────────────────────────────────
function makeError(code, message, retryable, retryAfterSeconds) {
    return {
        error: {
            code,
            message,
            retryable,
            ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
        },
    };
}
function isHex(value, expectedLength) {
    return typeof value === 'string' &&
        value.length === expectedLength &&
        /^[0-9a-f]+$/i.test(value);
}
/**
 * Get an agent's identity public key from the relay token store.
 * This is stored when the handshake completes.
 */
function getAgentIdentityPub(handshakeManager, agentName) {
    // Access the stored identity pub through the handshake manager.
    // The relay tokens store includes theirIdentityPub.
    // We expose this through a method on HandshakeManager.
    return handshakeManager.relayTokens?.[agentName]?.theirIdentityPub ?? null;
}
//# sourceMappingURL=ThreadlineEndpoints.js.map
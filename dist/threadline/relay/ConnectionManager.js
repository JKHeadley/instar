/**
 * ConnectionManager — Manages WebSocket connections from agents.
 *
 * Handles authentication, heartbeat, and connection lifecycle.
 * Part of Threadline Relay Phase 1.
 */
import crypto from 'node:crypto';
import { RELAY_ERROR_CODES } from './types.js';
import { verify } from '../ThreadlineCrypto.js';
export class ConnectionManager {
    config;
    presence;
    rateLimiter;
    pending = new Map();
    connections = new Map();
    socketToAgent = new Map();
    /** Optional registry store for persistent agent profiles */
    registryStore;
    /** Optional registry auth for JWT token issuance */
    registryAuth;
    /** Callback when a fully authenticated agent connection is established */
    onAuthenticated;
    /** Callback when an agent disconnects */
    onDisconnected;
    /** Callback when an existing agent is displaced by a new connection */
    onDisplaced;
    constructor(config, presence, rateLimiter) {
        this.config = config;
        this.presence = presence;
        this.rateLimiter = rateLimiter;
    }
    /**
     * Get the base64-encoded public key for an agent.
     */
    getPublicKey(agentId) {
        return this.connections.get(agentId)?.publicKeyBase64;
    }
    /**
     * Handle a new WebSocket connection.
     * Sends a challenge and waits for auth response.
     */
    handleConnection(socket, ip) {
        // Rate limit auth attempts by IP
        const authCheck = this.rateLimiter.checkAuth(ip);
        if (!authCheck.allowed) {
            this.sendFrame(socket, {
                type: 'auth_error',
                code: RELAY_ERROR_CODES.RATE_LIMITED,
                message: 'Too many auth attempts',
            });
            socket.close(4029, 'Rate limited');
            return;
        }
        this.rateLimiter.recordAuth(ip);
        // Generate challenge nonce
        const nonce = crypto.randomBytes(32).toString('base64');
        const challenge = { type: 'challenge', nonce };
        // Set auth timeout
        const timer = setTimeout(() => {
            this.pending.delete(socket);
            this.sendFrame(socket, {
                type: 'auth_error',
                code: RELAY_ERROR_CODES.AUTH_TIMEOUT,
                message: 'Authentication timeout',
            });
            socket.close(4008, 'Auth timeout');
        }, this.config.authTimeoutMs);
        this.pending.set(socket, { nonce, timer, ip });
        this.sendFrame(socket, challenge);
    }
    /**
     * Handle an auth response from an agent.
     */
    handleAuth(socket, frame) {
        const pending = this.pending.get(socket);
        if (!pending) {
            this.sendFrame(socket, {
                type: 'auth_error',
                code: RELAY_ERROR_CODES.AUTH_FAILED,
                message: 'No pending challenge',
            });
            return false;
        }
        clearTimeout(pending.timer);
        this.pending.delete(socket);
        // Decode public key
        let publicKey;
        try {
            publicKey = Buffer.from(frame.publicKey, 'base64');
            if (publicKey.length !== 32)
                throw new Error('Invalid key length');
        }
        catch {
            this.sendFrame(socket, {
                type: 'auth_error',
                code: RELAY_ERROR_CODES.AUTH_FAILED,
                message: 'Invalid public key',
            });
            return false;
        }
        // Verify fingerprint matches public key
        const expectedFingerprint = publicKey.subarray(0, 16).toString('hex');
        if (frame.agentId !== expectedFingerprint) {
            this.sendFrame(socket, {
                type: 'auth_error',
                code: RELAY_ERROR_CODES.AUTH_FAILED,
                message: 'Agent ID does not match public key',
            });
            return false;
        }
        // Verify signature
        let signature;
        try {
            signature = Buffer.from(frame.signature, 'base64');
        }
        catch {
            this.sendFrame(socket, {
                type: 'auth_error',
                code: RELAY_ERROR_CODES.AUTH_FAILED,
                message: 'Invalid signature encoding',
            });
            return false;
        }
        const nonceBuffer = Buffer.from(pending.nonce, 'utf-8');
        const valid = verify(publicKey, nonceBuffer, signature);
        if (!valid) {
            this.sendFrame(socket, {
                type: 'auth_error',
                code: RELAY_ERROR_CODES.AUTH_FAILED,
                message: 'Signature verification failed',
            });
            return false;
        }
        // Handle displacement: if this agent is already connected, disconnect the old socket
        const existingConn = this.connections.get(frame.agentId);
        if (existingConn) {
            const displacedFrame = {
                type: 'displaced',
                reason: 'Another device connected with the same identity key',
            };
            this.sendFrame(existingConn.socket, displacedFrame);
            this.removeConnection(existingConn.socket, frame.agentId);
            existingConn.socket.close(4001, 'Displaced by new connection');
            this.onDisplaced?.(frame.agentId, existingConn.socket);
        }
        // Register with presence
        const sessionId = `relay-${crypto.randomBytes(8).toString('hex')}`;
        const visibility = frame.visibility ?? 'unlisted';
        try {
            this.presence.register(frame.agentId, frame.publicKey, frame.metadata, visibility, sessionId);
        }
        catch (err) {
            this.sendFrame(socket, {
                type: 'auth_error',
                code: RELAY_ERROR_CODES.INTERNAL_ERROR,
                message: err instanceof Error ? err.message : 'Registration failed',
            });
            return false;
        }
        // Store connection
        const connection = {
            socket,
            agentId: frame.agentId,
            publicKey,
            publicKeyBase64: frame.publicKey,
            sessionId,
            ip: pending.ip,
            missedPongs: 0,
            heartbeatTimer: null,
        };
        this.connections.set(frame.agentId, connection);
        this.socketToAgent.set(socket, frame.agentId);
        // Start heartbeat
        this.startHeartbeat(connection);
        // Handle registry
        const authOk = {
            type: 'auth_ok',
            sessionId,
            heartbeatInterval: this.config.heartbeatIntervalMs,
        };
        if (this.registryStore && this.registryAuth) {
            // Issue JWT token for REST API access
            const tokenInfo = this.registryAuth.issueToken(frame.publicKey);
            authOk.registry_token = tokenInfo.token;
            authOk.registry_token_expires = tokenInfo.expiresAt;
            // Auto-register public agents in persistent registry (survives deploys)
            // Agents with explicit registry config get priority fields; all public agents get listed
            const registryFrameworkVisible = frame.registry?.frameworkVisible ?? true;
            const registryHomepage = frame.registry?.homepage ?? '';
            if (visibility === 'public' || frame.registry?.listed) {
                this.registryStore.upsert({
                    publicKey: frame.publicKey,
                    agentId: frame.agentId,
                    name: frame.metadata.name ?? '',
                    bio: frame.metadata.bio ?? '',
                    interests: frame.metadata.interests ?? [],
                    capabilities: frame.metadata.capabilities ?? [],
                    framework: frame.metadata.framework ?? 'unknown',
                    frameworkVisible: registryFrameworkVisible,
                    homepage: registryHomepage,
                    visibility: visibility === 'private' ? 'unlisted' : visibility,
                    consentMethod: 'auth_handshake',
                });
                authOk.registry_status = 'listed';
                if (frame.registry?.listed) {
                    authOk.registry_notice = 'Your online status and last-seen time are visible to anyone searching the registry.';
                }
            }
            else {
                // Unlisted/private — update last_seen if entry exists, don't auto-create
                const existing = this.registryStore.getByPublicKey(frame.publicKey);
                if (existing) {
                    // Update visibility in case it changed (e.g., was public, now unlisted)
                    this.registryStore.upsert({
                        publicKey: frame.publicKey,
                        agentId: frame.agentId,
                        name: frame.metadata.name ?? '',
                        bio: frame.metadata.bio ?? '',
                        interests: frame.metadata.interests ?? [],
                        capabilities: frame.metadata.capabilities ?? [],
                        framework: frame.metadata.framework ?? 'unknown',
                        frameworkVisible: registryFrameworkVisible,
                        homepage: registryHomepage,
                        visibility: 'unlisted',
                        consentMethod: 'auth_handshake',
                    });
                    this.registryStore.setOnline(frame.publicKey);
                    authOk.registry_status = 'updated';
                }
                else {
                    authOk.registry_status = 'not_listed';
                }
            }
        }
        this.sendFrame(socket, authOk);
        this.onAuthenticated?.(frame.agentId, socket);
        return true;
    }
    /**
     * Handle a pong response from an agent.
     */
    handlePong(socket) {
        const agentId = this.socketToAgent.get(socket);
        if (!agentId)
            return;
        const conn = this.connections.get(agentId);
        if (!conn)
            return;
        conn.missedPongs = 0;
        this.presence.touch(agentId);
    }
    /**
     * Handle socket close/error.
     */
    handleDisconnect(socket) {
        // Clean up pending auth
        const pending = this.pending.get(socket);
        if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(socket);
        }
        // Clean up authenticated connection
        const agentId = this.socketToAgent.get(socket);
        if (agentId) {
            this.removeConnection(socket, agentId);
            this.onDisconnected?.(agentId);
        }
    }
    /**
     * Get socket for an agent.
     */
    getSocket(agentId) {
        return this.connections.get(agentId)?.socket;
    }
    /**
     * Get agent ID for a socket.
     */
    getAgentId(socket) {
        return this.socketToAgent.get(socket);
    }
    /**
     * Get IP address for an agent.
     */
    getIP(agentId) {
        return this.connections.get(agentId)?.ip ?? 'unknown';
    }
    /**
     * Check if a socket is authenticated.
     */
    isAuthenticated(socket) {
        return this.socketToAgent.has(socket);
    }
    /**
     * Get total number of active connections.
     */
    get size() {
        return this.connections.size;
    }
    /**
     * Destroy all connections and timers.
     */
    destroy() {
        for (const [, conn] of this.connections) {
            if (conn.heartbeatTimer)
                clearTimeout(conn.heartbeatTimer);
        }
        for (const [, pending] of this.pending) {
            clearTimeout(pending.timer);
        }
        this.connections.clear();
        this.socketToAgent.clear();
        this.pending.clear();
    }
    // ── Private ─────────────────────────────────────────────────────
    startHeartbeat(conn) {
        const scheduleNext = () => {
            const jitter = (Math.random() * 2 - 1) * this.config.heartbeatJitterMs;
            const interval = this.config.heartbeatIntervalMs + jitter;
            conn.heartbeatTimer = setTimeout(() => {
                if (conn.missedPongs >= this.config.missedPongsBeforeDisconnect) {
                    // Too many missed pongs — disconnect
                    this.handleDisconnect(conn.socket);
                    conn.socket.close(4000, 'Heartbeat timeout');
                    return;
                }
                conn.missedPongs++;
                const ping = {
                    type: 'ping',
                    timestamp: new Date().toISOString(),
                };
                this.sendFrame(conn.socket, ping);
                scheduleNext();
            }, Math.max(1000, interval));
        };
        scheduleNext();
    }
    removeConnection(socket, agentId) {
        const conn = this.connections.get(agentId);
        if (conn?.heartbeatTimer) {
            clearTimeout(conn.heartbeatTimer);
        }
        // Set offline in registry
        if (conn && this.registryStore) {
            this.registryStore.setOffline(conn.publicKeyBase64);
        }
        this.connections.delete(agentId);
        this.socketToAgent.delete(socket);
        this.presence.unregister(agentId);
    }
    sendFrame(socket, frame) {
        if (socket.readyState === 1 /* OPEN */) {
            socket.send(JSON.stringify(frame));
        }
    }
}
//# sourceMappingURL=ConnectionManager.js.map
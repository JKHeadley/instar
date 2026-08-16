/**
 * RelayServer — The main Threadline relay WebSocket server.
 *
 * Ties together ConnectionManager, MessageRouter, PresenceRegistry,
 * RelayRateLimiter, OfflineQueue, A2ABridge, AbuseDetector, and
 * RelayMetrics into a complete relay service.
 *
 * Part of Threadline Relay Phases 1-5.
 */
import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';
import { RELAY_ERROR_CODES } from './types.js';
import { PresenceRegistry } from './PresenceRegistry.js';
import { RelayRateLimiter } from './RelayRateLimiter.js';
import { MessageRouter } from './MessageRouter.js';
import { ConnectionManager } from './ConnectionManager.js';
import { A2ABridge, A2ABridgeRateLimiter } from './A2ABridge.js';
import { InMemoryOfflineQueue } from './OfflineQueue.js';
import { AbuseDetector } from './AbuseDetector.js';
import { RelayMetrics } from './RelayMetrics.js';
import { RegistryStore } from './RegistryStore.js';
import { RegistryAuth } from './RegistryAuth.js';
const DEFAULTS = {
    port: 8787,
    host: '0.0.0.0',
    heartbeatIntervalMs: 60_000,
    heartbeatJitterMs: 15_000,
    authTimeoutMs: 10_000,
    maxEnvelopeSize: 256 * 1024,
    maxAgents: 10_000,
    missedPongsBeforeDisconnect: 3,
    registryDataDir: './data',
    relayId: 'relay-threadline-default',
};
export class RelayServer {
    config;
    presence;
    rateLimiter;
    router;
    connections;
    a2aBridge;
    offlineQueue;
    abuseDetector;
    metrics;
    registry;
    registryAuth;
    httpServer = null;
    wss = null;
    running = false;
    a2aResponseHandlers = new Map();
    /** Per-IP rate limit tracking for unauthenticated registry requests */
    registryRateLimits = new Map();
    /** Per-agent rate limit tracking for authenticated registry requests */
    registryAgentRateLimits = new Map();
    constructor(config) {
        this.config = { ...DEFAULTS, ...config };
        const relayId = config?.relayId ?? `relay-threadline-${Date.now().toString(36)}`;
        const dataDir = config?.registryDataDir ?? './data';
        // Initialize registry
        this.registry = new RegistryStore({ dataDir, relayId });
        this.registryAuth = new RegistryAuth({ relayId, keyDir: dataDir });
        this.presence = new PresenceRegistry({ maxAgents: this.config.maxAgents });
        this.rateLimiter = new RelayRateLimiter(config?.rateLimitConfig);
        this.connections = new ConnectionManager({
            heartbeatIntervalMs: this.config.heartbeatIntervalMs,
            heartbeatJitterMs: this.config.heartbeatJitterMs,
            authTimeoutMs: this.config.authTimeoutMs,
            missedPongsBeforeDisconnect: this.config.missedPongsBeforeDisconnect,
        }, this.presence, this.rateLimiter);
        // Wire registry into connection manager
        this.connections.registryStore = this.registry;
        this.connections.registryAuth = this.registryAuth;
        this.router = new MessageRouter({
            presence: this.presence,
            rateLimiter: this.rateLimiter,
            getSocket: (id) => this.connections.getSocket(id),
            getIP: (id) => this.connections.getIP(id),
            maxEnvelopeSize: this.config.maxEnvelopeSize,
        });
        this.a2aBridge = new A2ABridge({
            baseUrl: `http://${this.config.host}:${this.config.port}`,
        }, {
            presence: this.presence,
            rateLimiter: new A2ABridgeRateLimiter(config?.a2aRateLimitConfig),
            sendToAgent: (agentId, envelope) => {
                const socket = this.connections.getSocket(agentId);
                if (!socket || socket.readyState !== WebSocket.OPEN)
                    return false;
                socket.send(JSON.stringify({ type: 'message', envelope }));
                return true;
            },
            onAgentResponse: (taskId, handler) => {
                this.a2aResponseHandlers.set(taskId, handler);
            },
            removeResponseHandler: (taskId) => {
                this.a2aResponseHandlers.delete(taskId);
            },
        });
        // Initialize offline queue
        const queue = new InMemoryOfflineQueue(config?.offlineQueueConfig);
        this.offlineQueue = queue;
        // Initialize abuse detector
        this.abuseDetector = new AbuseDetector(config?.abuseDetectorConfig);
        // Initialize metrics
        this.metrics = new RelayMetrics();
        // Wire abuse events to metrics
        this.abuseDetector.onAbuse(() => {
            this.metrics.recordAbuseBan();
        });
        // Wire up expiry notifications
        queue.onExpiry((expired) => {
            for (const envelope of expired) {
                this.notifyDeliveryExpired(envelope);
                this.metrics.recordMessageExpired();
            }
        });
        // Wire up presence change notifications + queue flush
        this.connections.onAuthenticated = (agentId) => {
            this.metrics.recordConnection();
            this.metrics.setActiveConnections(this.connections.size);
            // Check abuse: connection churn
            const churnBan = this.abuseDetector.recordConnection(agentId);
            if (churnBan) {
                // Agent was banned for connection churn — disconnect
                const socket = this.connections.getSocket(agentId);
                if (socket) {
                    this.sendFrame(socket, {
                        type: 'error',
                        code: RELAY_ERROR_CODES.BANNED,
                        message: churnBan.reason,
                    });
                    socket.close(4003, 'Banned: connection churn');
                }
                return;
            }
            this.notifyPresenceChange(agentId, 'online');
            this.flushOfflineQueue(agentId);
        };
        this.connections.onDisconnected = (agentId) => {
            this.metrics.setActiveConnections(this.connections.size);
            this.notifyPresenceChange(agentId, 'offline');
        };
    }
    /**
     * Start the relay server.
     */
    async start() {
        if (this.running)
            return;
        return new Promise((resolve) => {
            this.httpServer = http.createServer(async (req, res) => {
                const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
                const pathname = url.pathname;
                // CORS headers for registry API
                if (pathname.startsWith('/v1/registry')) {
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
                    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
                    if (req.method === 'OPTIONS') {
                        res.writeHead(204);
                        res.end();
                        return;
                    }
                }
                // Health check endpoint
                if (pathname === '/health') {
                    const queueStats = this.offlineQueue.getStats();
                    const abuseStats = this.abuseDetector.getStats();
                    const metricsSnapshot = this.metrics.getSnapshot();
                    const registryHealth = this.registry.getHealth();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        status: 'ok',
                        agents: this.presence.size,
                        connections: this.connections.size,
                        offlineQueue: queueStats,
                        abuse: abuseStats,
                        throughput: {
                            messagesRouted: metricsSnapshot.messagesRouted,
                            messagesPerMinute: metricsSnapshot.messagesPerMinute,
                        },
                        registry: registryHealth,
                        uptime: process.uptime(),
                    }));
                    return;
                }
                // Debug: connected agents with visibility (for diagnosing discovery issues)
                if (pathname === '/debug/agents') {
                    const agents = this.presence.getAll();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        connected: agents.map(a => ({
                            agentId: a.agentId,
                            name: a.metadata.name,
                            visibility: a.visibility,
                            status: a.status,
                            framework: a.metadata.framework,
                            connectedSince: a.connectedSince,
                        })),
                        count: agents.length,
                    }));
                    return;
                }
                // Registry dashboard (HTML)
                if (pathname === '/registry' || pathname === '/registry/') {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(this.getRegistryDashboardHTML());
                    return;
                }
                // Registry REST API
                if (pathname.startsWith('/v1/registry')) {
                    try {
                        await this.handleRegistryRequest(req, res, url);
                    }
                    catch (err) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Internal server error' }));
                    }
                    return;
                }
                // A2A Bridge routes
                if (pathname.startsWith('/a2a/')) {
                    try {
                        const handled = await this.a2aBridge.handleRequest(req, res, pathname);
                        if (handled)
                            return;
                    }
                    catch {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }));
                        return;
                    }
                }
                res.writeHead(404);
                res.end();
            });
            this.wss = new WebSocketServer({
                server: this.httpServer,
                path: '/v1/connect',
                maxPayload: this.config.maxEnvelopeSize + 1024, // envelope + frame overhead
            });
            this.wss.on('connection', (socket, req) => {
                const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
                    ?? req.socket.remoteAddress
                    ?? 'unknown';
                this.connections.handleConnection(socket, ip);
                socket.on('message', (data) => {
                    this.handleMessage(socket, data);
                });
                socket.on('close', () => {
                    this.connections.handleDisconnect(socket);
                });
                socket.on('error', () => {
                    this.connections.handleDisconnect(socket);
                });
            });
            this.httpServer.listen(this.config.port, this.config.host, () => {
                this.running = true;
                resolve();
            });
        });
    }
    /**
     * Stop the relay server.
     */
    async stop() {
        if (!this.running)
            return;
        return new Promise((resolve) => {
            this.registry.destroy();
            this.router.destroy();
            this.connections.destroy();
            this.a2aBridge.destroy();
            this.offlineQueue.destroy();
            this.abuseDetector.destroy();
            if (this.wss) {
                // Close all connections
                for (const client of this.wss.clients) {
                    client.close(1001, 'Server shutting down');
                }
                this.wss.close();
                this.wss = null;
            }
            if (this.httpServer) {
                this.httpServer.close(() => {
                    this.httpServer = null;
                    this.running = false;
                    resolve();
                });
            }
            else {
                this.running = false;
                resolve();
            }
        });
    }
    /**
     * Get the server's address (for testing).
     */
    get address() {
        const addr = this.httpServer?.address();
        if (!addr || typeof addr === 'string')
            return null;
        return { host: addr.address, port: addr.port };
    }
    /**
     * Whether the server is running.
     */
    get isRunning() {
        return this.running;
    }
    // ── Registry REST API ───────────────────────────────────────────
    async handleRegistryRequest(req, res, url) {
        const pathname = url.pathname;
        const method = req.method ?? 'GET';
        // Extract IP for rate limiting
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
            ?? req.socket.remoteAddress ?? 'unknown';
        // Extract auth token
        const token = this.registryAuth.extractToken(req.headers.authorization);
        const tokenPayload = token ? this.registryAuth.verifyToken(token) : null;
        const isAuthenticated = !!tokenPayload;
        // Rate limiting
        if (!this.checkRegistryRateLimit(pathname, method, ip, tokenPayload?.sub, isAuthenticated)) {
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
            res.end(JSON.stringify({ error: 'Rate limit exceeded', code: 'RATE_LIMITED' }));
            return;
        }
        // Route to handler
        if (pathname === '/v1/registry/search' && method === 'GET') {
            return this.handleRegistrySearch(req, res, url, isAuthenticated);
        }
        if (pathname === '/v1/registry/me' && method === 'GET') {
            return this.handleRegistryMe(req, res, tokenPayload);
        }
        if (pathname === '/v1/registry/me' && method === 'PUT') {
            return this.handleRegistryUpdate(req, res, tokenPayload);
        }
        if (pathname === '/v1/registry/me' && method === 'DELETE') {
            return this.handleRegistryDelete(req, res, tokenPayload);
        }
        if (pathname === '/v1/registry/stats' && method === 'GET') {
            return this.handleRegistryStats(req, res);
        }
        // /v1/registry/agent/:agentId
        const agentMatch = pathname.match(/^\/v1\/registry\/agent\/([^/]+)$/);
        if (agentMatch && method === 'GET') {
            return this.handleRegistryAgentLookup(req, res, agentMatch[1], isAuthenticated, tokenPayload);
        }
        // /v1/registry/agent/:agentId/a2a-card
        const a2aMatch = pathname.match(/^\/v1\/registry\/agent\/([^/]+)\/a2a-card$/);
        if (a2aMatch && method === 'GET') {
            return this.handleRegistryA2ACard(req, res, a2aMatch[1]);
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }
    handleRegistrySearch(_req, res, url, isAuthenticated) {
        const params = {
            q: url.searchParams.get('q') ?? undefined,
            capability: url.searchParams.get('capability') ?? undefined,
            framework: url.searchParams.get('framework') ?? undefined,
            interest: url.searchParams.get('interest') ?? undefined,
            online: url.searchParams.has('online') ? url.searchParams.get('online') === 'true' : undefined,
            limit: url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit')) : undefined,
            cursor: url.searchParams.get('cursor') ?? undefined,
            sort: url.searchParams.get('sort') ?? undefined,
        };
        // At least one filter required (unless listing all with limit)
        const hasFilter = params.q || params.capability || params.framework || params.interest || params.online !== undefined;
        if (!hasFilter && !params.limit) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'At least one search filter is required (or provide limit to list all)', code: 'FILTER_REQUIRED' }));
            return;
        }
        const result = this.registry.search(params);
        // Apply two-tier response model
        const agents = result.agents.map(a => this.formatRegistryEntry(a, isAuthenticated));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            count: result.count,
            total: result.total,
            agents,
            pagination: result.pagination,
        }));
    }
    handleRegistryMe(_req, res, tokenPayload) {
        if (!tokenPayload) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }
        const entry = this.registry.getByPublicKey(tokenPayload.sub);
        if (!entry) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                registered: false,
                tip: 'Set registry.listed: true in your auth handshake or call threadline_registry_update to register.',
            }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            registered: true,
            entry: this.formatRegistryEntry(entry, true),
            consentMethod: entry.consentMethod,
            registeredAt: entry.registeredAt,
        }));
    }
    async handleRegistryUpdate(req, res, tokenPayload) {
        if (!tokenPayload) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }
        const body = await this.readBody(req);
        if (!body) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request body' }));
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(body);
        }
        catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
            return;
        }
        const updated = this.registry.update(tokenPayload.sub, {
            name: typeof parsed.name === 'string' ? parsed.name : undefined,
            bio: typeof parsed.bio === 'string' ? parsed.bio : undefined,
            interests: Array.isArray(parsed.interests) ? parsed.interests : undefined,
            capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : undefined,
            homepage: typeof parsed.homepage === 'string' ? parsed.homepage : undefined,
            visibility: parsed.visibility === 'public' || parsed.visibility === 'unlisted' ? parsed.visibility : undefined,
            frameworkVisible: typeof parsed.frameworkVisible === 'boolean' ? parsed.frameworkVisible : undefined,
        });
        if (!updated) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No registry entry found. Register first.' }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.formatRegistryEntry(updated, true)));
    }
    handleRegistryDelete(_req, res, tokenPayload) {
        if (!tokenPayload) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Authentication required' }));
            return;
        }
        const deleted = this.registry.hardDelete(tokenPayload.sub);
        if (!deleted) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No registry entry found' }));
            return;
        }
        const purgeBy = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ deleted: true, purgeBy }));
    }
    handleRegistryStats(_req, res) {
        const stats = this.registry.getStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
    }
    handleRegistryAgentLookup(_req, res, agentIdOrKey, isAuthenticated, tokenPayload) {
        const decoded = decodeURIComponent(agentIdOrKey);
        // Try as public key first (base64), then as agentId
        let entry = null;
        if (decoded.length > 32) {
            entry = this.registry.getByPublicKey(decoded);
        }
        if (!entry) {
            entry = this.registry.getByAgentId(decoded);
        }
        if (!entry) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Agent not found' }));
            return;
        }
        // Unlisted agents only visible to themselves
        if (entry.visibility === 'unlisted' && tokenPayload?.sub !== entry.publicKey) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Agent not found' }));
            return;
        }
        const formatted = this.formatRegistryEntry(entry, isAuthenticated);
        const ambiguous = this.registry.isAgentIdAmbiguous(entry.agentId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...formatted, ...(ambiguous ? { ambiguous: true } : {}) }));
    }
    handleRegistryA2ACard(_req, res, agentIdOrKey) {
        const decoded = decodeURIComponent(agentIdOrKey);
        let entry = null;
        if (decoded.length > 32) {
            entry = this.registry.getByPublicKey(decoded);
        }
        if (!entry) {
            entry = this.registry.getByAgentId(decoded);
        }
        if (!entry || entry.visibility === 'unlisted') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Agent not found' }));
            return;
        }
        const a2aCard = {
            name: entry.name,
            description: entry.bio,
            url: entry.homepage || undefined,
            version: '1.0',
            capabilities: {
                streaming: false,
                pushNotifications: false,
            },
            skills: entry.capabilities.map(cap => ({
                id: cap,
                name: cap.charAt(0).toUpperCase() + cap.slice(1),
            })),
            defaultInputModes: ['text/plain'],
            defaultOutputModes: ['text/plain'],
            'x-threadline': {
                agentId: entry.agentId,
                publicKey: entry.publicKey,
                interests: entry.interests,
                framework: entry.frameworkVisible ? entry.framework : undefined,
                registeredAt: entry.registeredAt,
                lastSeen: entry.lastSeen,
                online: entry.online,
            },
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(a2aCard));
    }
    /**
     * Format a registry entry for API response based on auth tier.
     */
    formatRegistryEntry(entry, authenticated) {
        const base = {
            agentId: entry.agentId,
            name: entry.name,
            bio: entry.bio,
            interests: entry.interests,
            capabilities: entry.capabilities,
            homepage: entry.homepage,
            registeredAt: entry.registeredAt,
        };
        if (authenticated) {
            base.lastSeen = entry.lastSeen;
            base.online = entry.online;
            base.stale = entry.stale;
            if (entry.frameworkVisible) {
                base.framework = entry.framework;
                base.frameworkVisible = true;
            }
            if (entry.verified) {
                base.verified = true;
                base.verifiedDomain = entry.verifiedDomain;
            }
        }
        return base;
    }
    /**
     * Check rate limits for registry endpoints.
     */
    checkRegistryRateLimit(pathname, method, ip, agentPublicKey, isAuthenticated) {
        const now = Date.now();
        const windowMs = 60_000;
        // Determine limit based on endpoint and auth
        let limit;
        if (method === 'PUT' || method === 'DELETE') {
            limit = method === 'DELETE' ? 5 : 10;
        }
        else if (pathname === '/v1/registry/stats') {
            limit = 30;
        }
        else if (pathname === '/v1/registry/search') {
            limit = isAuthenticated ? 120 : 30;
        }
        else {
            limit = isAuthenticated ? 240 : 60;
        }
        // Use agent key for authenticated, IP for unauthenticated
        const key = isAuthenticated && agentPublicKey ? agentPublicKey : ip;
        const map = isAuthenticated ? this.registryAgentRateLimits : this.registryRateLimits;
        const entry = map.get(key);
        if (!entry || now > entry.resetAt) {
            map.set(key, { count: 1, resetAt: now + windowMs });
            return true;
        }
        if (entry.count >= limit)
            return false;
        entry.count++;
        return true;
    }
    readBody(req) {
        return new Promise((resolve) => {
            const chunks = [];
            let size = 0;
            req.on('data', (chunk) => {
                size += chunk.length;
                if (size > 64 * 1024) { // 64KB max body
                    resolve(null);
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', () => resolve(Buffer.concat(chunks).toString()));
            req.on('error', () => resolve(null));
        });
    }
    // ── Registry Dashboard ──────────────────────────────────────────
    getRegistryDashboardHTML() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Threadline Agent Registry</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0a0a0f; color: #e0e0e8; min-height: 100vh; }
  .container { max-width: 960px; margin: 0 auto; padding: 2rem 1rem; }
  h1 { font-size: 1.8rem; font-weight: 600; margin-bottom: 0.3rem; color: #fff; }
  .subtitle { color: #888; font-size: 0.95rem; margin-bottom: 2rem; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
  .stat-card { background: #14141f; border: 1px solid #2a2a3a; border-radius: 8px; padding: 1rem; text-align: center; }
  .stat-value { font-size: 2rem; font-weight: 700; color: #7c8aff; }
  .stat-label { font-size: 0.8rem; color: #888; margin-top: 0.3rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .caps-row { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 2rem; }
  .cap-tag { background: #1a1a2e; border: 1px solid #2a2a3a; border-radius: 16px; padding: 0.3rem 0.8rem; font-size: 0.8rem; color: #aab; cursor: pointer; transition: all 0.2s; }
  .cap-tag:hover, .cap-tag.active { background: #2a2a4e; border-color: #7c8aff; color: #fff; }
  .cap-count { color: #7c8aff; margin-left: 0.3rem; }
  .search-box { width: 100%; background: #14141f; border: 1px solid #2a2a3a; border-radius: 8px; padding: 0.8rem 1rem; color: #e0e0e8; font-size: 1rem; margin-bottom: 1.5rem; outline: none; }
  .search-box:focus { border-color: #7c8aff; }
  .search-box::placeholder { color: #555; }
  .agent-list { display: flex; flex-direction: column; gap: 0.8rem; }
  .agent-card { background: #14141f; border: 1px solid #2a2a3a; border-radius: 8px; padding: 1.2rem; transition: border-color 0.2s; }
  .agent-card:hover { border-color: #3a3a5a; }
  .agent-header { display: flex; align-items: center; gap: 0.8rem; margin-bottom: 0.5rem; }
  .agent-name { font-size: 1.1rem; font-weight: 600; color: #fff; }
  .agent-status { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .agent-status.online { background: #4ade80; box-shadow: 0 0 6px #4ade80; }
  .agent-status.offline { background: #555; }
  .agent-bio { color: #999; font-size: 0.9rem; margin-bottom: 0.6rem; line-height: 1.4; }
  .agent-meta { display: flex; flex-wrap: wrap; gap: 0.4rem; }
  .agent-cap { background: #1a1a2e; border-radius: 4px; padding: 0.15rem 0.5rem; font-size: 0.75rem; color: #7c8aff; }
  .agent-interest { background: #1a1a2e; border-radius: 4px; padding: 0.15rem 0.5rem; font-size: 0.75rem; color: #aab; font-style: italic; }
  .agent-framework { font-size: 0.75rem; color: #666; margin-left: auto; }
  .agent-link { color: #7c8aff; text-decoration: none; font-size: 0.8rem; }
  .agent-link:hover { text-decoration: underline; }
  .empty { text-align: center; color: #555; padding: 3rem; }
  .footer { text-align: center; color: #444; font-size: 0.8rem; margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #1a1a2a; }
  .footer a { color: #7c8aff; text-decoration: none; }
  .loading { text-align: center; color: #555; padding: 2rem; }
</style>
</head>
<body>
<div class="container">
  <h1>Threadline Agent Registry</h1>
  <p class="subtitle">Discover AI agents on the Threadline network</p>

  <div class="stats-grid" id="stats"></div>
  <div class="caps-row" id="caps"></div>
  <input type="text" class="search-box" id="search" placeholder="Search agents by name, bio, or interest...">
  <div class="agent-list" id="agents"><div class="loading">Loading agents...</div></div>

  <div class="footer">
    <p>Powered by <a href="https://www.npmjs.com/package/threadline-mcp">threadline-mcp</a> &middot;
    <a href="/v1/registry/stats">API</a> &middot;
    <a href="/health">Health</a></p>
  </div>
</div>

<script>
const API = '';
let allAgents = [];
let activeFilter = null;

async function loadStats() {
  const res = await fetch(API + '/v1/registry/stats');
  const s = await res.json();
  document.getElementById('stats').innerHTML = [
    card(s.totalAgents, 'Agents'),
    card(s.onlineAgents, 'Online'),
    card(s.registeredLast24h, 'New (24h)'),
    card(s.registeredLast7d, 'New (7d)'),
  ].join('');

  const capsEl = document.getElementById('caps');
  capsEl.innerHTML = s.topCapabilities.map(c =>
    '<span class="cap-tag" data-cap="' + c.capability + '">' +
    c.capability + '<span class="cap-count">' + c.count + '</span></span>'
  ).join('');

  capsEl.querySelectorAll('.cap-tag').forEach(el => {
    el.addEventListener('click', () => {
      const cap = el.dataset.cap;
      if (activeFilter === cap) {
        activeFilter = null;
        el.classList.remove('active');
      } else {
        capsEl.querySelectorAll('.cap-tag').forEach(e => e.classList.remove('active'));
        activeFilter = cap;
        el.classList.add('active');
      }
      renderAgents();
    });
  });
}

async function loadAgents() {
  const res = await fetch(API + '/v1/registry/search?limit=100');
  const data = await res.json();
  allAgents = data.agents || [];
  renderAgents();
}

function renderAgents() {
  const q = document.getElementById('search').value.toLowerCase();
  let filtered = allAgents;

  if (activeFilter) {
    filtered = filtered.filter(a => a.capabilities && a.capabilities.includes(activeFilter));
  }
  if (q) {
    filtered = filtered.filter(a =>
      (a.name || '').toLowerCase().includes(q) ||
      (a.bio || '').toLowerCase().includes(q) ||
      (a.interests || []).some(i => i.includes(q)) ||
      (a.capabilities || []).some(c => c.includes(q))
    );
  }

  const el = document.getElementById('agents');
  if (filtered.length === 0) {
    el.innerHTML = '<div class="empty">No agents found</div>';
    return;
  }

  el.innerHTML = filtered.map(a => {
    const status = a.online ? 'online' : 'offline';
    const caps = (a.capabilities || []).map(c => '<span class="agent-cap">' + esc(c) + '</span>').join('');
    const interests = (a.interests || []).map(i => '<span class="agent-interest">' + esc(i) + '</span>').join('');
    const fw = a.framework && a.frameworkVisible ? '<span class="agent-framework">' + esc(a.framework) + '</span>' : '';
    const link = a.homepage ? '<a class="agent-link" href="' + esc(a.homepage) + '" target="_blank">' + esc(a.homepage) + '</a>' : '';
    return '<div class="agent-card">' +
      '<div class="agent-header">' +
        '<div class="agent-status ' + status + '"></div>' +
        '<span class="agent-name">' + esc(a.name || a.agentId) + '</span>' +
        fw +
      '</div>' +
      (a.bio ? '<p class="agent-bio">' + esc(a.bio) + '</p>' : '') +
      '<div class="agent-meta">' + caps + interests + '</div>' +
      (link ? '<div style="margin-top:0.5rem">' + link + '</div>' : '') +
    '</div>';
  }).join('');
}

function card(val, label) {
  return '<div class="stat-card"><div class="stat-value">' + val + '</div><div class="stat-label">' + label + '</div></div>';
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

document.getElementById('search').addEventListener('input', renderAgents);
loadStats();
loadAgents();
setInterval(loadStats, 60000);
setInterval(loadAgents, 30000);
</script>
</body>
</html>`;
    }
    // ── Private ─────────────────────────────────────────────────────
    handleMessage(socket, data) {
        let frame;
        try {
            const text = typeof data === 'string' ? data : data.toString();
            frame = JSON.parse(text);
        }
        catch {
            this.sendFrame(socket, {
                type: 'error',
                code: RELAY_ERROR_CODES.INVALID_FRAME,
                message: 'Invalid JSON',
            });
            return;
        }
        // Handle auth before checking authentication
        if (frame.type === 'auth') {
            this.connections.handleAuth(socket, frame);
            return;
        }
        // All other frames require authentication
        if (!this.connections.isAuthenticated(socket)) {
            this.sendFrame(socket, {
                type: 'error',
                code: RELAY_ERROR_CODES.AUTH_FAILED,
                message: 'Not authenticated',
            });
            return;
        }
        const agentId = this.connections.getAgentId(socket);
        // Check if agent is banned
        const ban = this.abuseDetector.isBanned(agentId);
        if (ban) {
            this.sendFrame(socket, {
                type: 'error',
                code: RELAY_ERROR_CODES.BANNED,
                message: `Banned until ${ban.expiresAt}: ${ban.reason}`,
            });
            return;
        }
        switch (frame.type) {
            case 'message':
                this.handleRouteMessage(socket, agentId, frame);
                break;
            case 'ack':
                this.handleAck(agentId, frame);
                break;
            case 'discover':
                this.handleDiscover(socket, agentId, frame);
                break;
            case 'pong':
                this.connections.handlePong(socket);
                break;
            case 'subscribe':
                this.presence.subscribe(agentId, frame.agentIds);
                break;
            case 'presence':
                // Agent can update its own presence
                if (frame.status === 'offline') {
                    this.connections.handleDisconnect(socket);
                    socket.close(1000, 'Agent going offline');
                }
                break;
            default:
                this.sendFrame(socket, {
                    type: 'error',
                    code: RELAY_ERROR_CODES.INVALID_FRAME,
                    message: `Unknown frame type: ${frame.type}`,
                });
        }
    }
    handleRouteMessage(socket, senderAgentId, frame) {
        this.metrics.recordMessageRouted();
        // Check Sybil limits for new agents
        const sybilCheck = this.abuseDetector.checkSybilLimit(senderAgentId);
        if (!sybilCheck.allowed) {
            this.sendFrame(socket, {
                type: 'ack',
                messageId: frame.envelope.messageId,
                status: 'rejected',
                reason: sybilCheck.reason,
            });
            this.metrics.recordMessageRejected();
            return;
        }
        // Check abuse patterns (spam, flooding)
        const abuseBan = this.abuseDetector.recordMessage(senderAgentId, frame.envelope.to);
        if (abuseBan) {
            this.sendFrame(socket, {
                type: 'error',
                code: RELAY_ERROR_CODES.BANNED,
                message: abuseBan.reason,
            });
            this.metrics.recordMessageRejected();
            return;
        }
        // Check if this message is addressed to the A2A bridge
        if (frame.envelope.to === this.a2aBridge.bridgeFingerprint) {
            const handled = this.a2aBridge.handleAgentResponse(frame.envelope);
            this.sendFrame(socket, {
                type: 'ack',
                messageId: frame.envelope.messageId,
                status: handled ? 'delivered' : 'rejected',
                reason: handled ? undefined : 'No pending A2A task for this thread',
            });
            if (handled)
                this.metrics.recordMessageDelivered();
            else
                this.metrics.recordMessageRejected();
            return;
        }
        const result = this.router.route(frame.envelope, senderAgentId);
        // If recipient is offline, try to queue the message
        if (!result.delivered && result.errorCode === RELAY_ERROR_CODES.RECIPIENT_OFFLINE) {
            const queueResult = this.offlineQueue.enqueue(frame.envelope);
            if (queueResult.queued) {
                this.sendFrame(socket, {
                    type: 'ack',
                    messageId: frame.envelope.messageId,
                    status: 'queued',
                    ttl: queueResult.ttlMs ? Math.round(queueResult.ttlMs / 1000) : undefined,
                });
                this.metrics.recordMessageQueued();
                return;
            }
            // Queue full — reject with specific reason
            this.sendFrame(socket, {
                type: 'ack',
                messageId: frame.envelope.messageId,
                status: 'rejected',
                reason: `Offline queue full (${queueResult.reason})`,
            });
            this.metrics.recordMessageRejected();
            return;
        }
        // Send ack back to sender
        this.sendFrame(socket, {
            type: 'ack',
            messageId: frame.envelope.messageId,
            status: result.status,
            reason: result.reason,
        });
        if (result.delivered) {
            this.metrics.recordMessageDelivered();
        }
        else {
            this.metrics.recordMessageRejected();
        }
    }
    /**
     * Flush queued messages when an agent comes online.
     */
    flushOfflineQueue(agentId) {
        const queued = this.offlineQueue.drain(agentId);
        if (queued.length === 0)
            return;
        const socket = this.connections.getSocket(agentId);
        if (!socket || socket.readyState !== WebSocket.OPEN)
            return;
        for (const msg of queued) {
            this.sendFrame(socket, {
                type: 'message',
                envelope: msg.envelope,
            });
            // Notify the original sender that the message was delivered (if still connected)
            const senderSocket = this.connections.getSocket(msg.envelope.from);
            if (senderSocket) {
                this.sendFrame(senderSocket, {
                    type: 'ack',
                    messageId: msg.envelope.messageId,
                    status: 'delivered',
                });
            }
        }
    }
    /**
     * Notify sender when a queued message expires.
     */
    notifyDeliveryExpired(envelope) {
        const senderSocket = this.connections.getSocket(envelope.from);
        if (senderSocket) {
            this.sendFrame(senderSocket, {
                type: 'delivery_expired',
                messageId: envelope.messageId,
                recipientId: envelope.to,
                queuedAt: envelope.timestamp,
            });
        }
    }
    handleAck(senderAgentId, frame) {
        // Forward ack to the original sender of the message
        // For Phase 1, acks from recipients are informational only
        // The relay already sent its own delivery ack
    }
    handleDiscover(socket, agentId, frame) {
        // Rate limit discovery
        const check = this.rateLimiter.checkDiscovery(agentId);
        if (!check.allowed) {
            this.sendFrame(socket, {
                type: 'error',
                code: RELAY_ERROR_CODES.RATE_LIMITED,
                message: 'Discovery rate limited',
            });
            return;
        }
        this.rateLimiter.recordDiscovery(agentId);
        this.metrics.recordDiscoveryQuery();
        // Query persistent registry (survives deploys) as primary source
        const registryResult = this.registry.search({
            capability: frame.filter?.capability,
            framework: frame.filter?.framework,
            q: frame.filter?.name,
            limit: 100,
        });
        // Merge with live presence status
        const agents = registryResult.agents.map(entry => ({
            agentId: entry.agentId,
            name: entry.name,
            framework: entry.framework,
            capabilities: entry.capabilities,
            status: this.presence.isOnline(entry.agentId) ? 'online' : 'offline',
            connectedSince: this.presence.get(entry.agentId)?.connectedSince ?? undefined,
            lastSeen: entry.lastSeen,
        }));
        // Also include any agents in live presence that aren't in registry yet
        // (connected but haven't registered — e.g., agents from before registry existed)
        const registryAgentIds = new Set(registryResult.agents.map(a => a.agentId));
        const presenceAgents = this.presence.discover(frame.filter);
        for (const pa of presenceAgents) {
            if (!registryAgentIds.has(pa.agentId)) {
                agents.push({
                    agentId: pa.agentId,
                    name: pa.metadata.name,
                    framework: pa.metadata.framework ?? 'unknown',
                    capabilities: pa.metadata.capabilities ?? [],
                    status: 'online',
                    connectedSince: pa.connectedSince,
                    lastSeen: new Date().toISOString(),
                });
            }
        }
        this.sendFrame(socket, {
            type: 'discover_result',
            agents,
        });
    }
    notifyPresenceChange(agentId, status) {
        const subscribers = this.presence.getSubscribers(agentId);
        const entry = this.presence.get(agentId);
        const notification = {
            type: 'presence_change',
            agentId,
            status,
            metadata: entry?.metadata,
        };
        for (const subscriberId of subscribers) {
            const socket = this.connections.getSocket(subscriberId);
            if (socket) {
                this.sendFrame(socket, notification);
            }
        }
    }
    sendFrame(socket, frame) {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(frame));
        }
    }
}
//# sourceMappingURL=RelayServer.js.map
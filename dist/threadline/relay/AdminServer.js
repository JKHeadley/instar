/**
 * AdminServer — Relay administration endpoints.
 *
 * Exposes relay health, agent management, metrics, and ban management
 * on a separate port accessible only from the operator's network.
 *
 * Requires authentication via `RELAY_ADMIN_KEY` environment variable
 * or config, passed as `Authorization: Bearer <key>`.
 *
 * Part of Threadline Relay Phase 5.
 */
import http from 'node:http';
// ── Implementation ─────────────────────────────────────────────────
export class AdminServer {
    config;
    deps;
    server = null;
    running = false;
    constructor(config, deps) {
        this.config = {
            port: config.port,
            host: config.host ?? '127.0.0.1',
            adminKey: config.adminKey,
        };
        this.deps = deps;
    }
    async start() {
        if (this.running)
            return;
        return new Promise((resolve) => {
            this.server = http.createServer((req, res) => {
                this.handleRequest(req, res);
            });
            this.server.listen(this.config.port, this.config.host, () => {
                this.running = true;
                resolve();
            });
        });
    }
    async stop() {
        if (!this.running || !this.server)
            return;
        return new Promise((resolve) => {
            this.server.close(() => {
                this.server = null;
                this.running = false;
                resolve();
            });
        });
    }
    get isRunning() {
        return this.running;
    }
    get address() {
        const addr = this.server?.address();
        if (!addr || typeof addr === 'string')
            return null;
        return { host: addr.address, port: addr.port };
    }
    // ── Request Handling ─────────────────────────────────────────────
    handleRequest(req, res) {
        // CORS for localhost only
        res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
        // Auth check
        const authHeader = req.headers.authorization;
        if (!authHeader || authHeader !== `Bearer ${this.config.adminKey}`) {
            this.sendJson(res, 401, { error: 'Unauthorized. Provide relay admin key.' });
            return;
        }
        const pathname = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname;
        try {
            if (pathname === '/admin/status' && req.method === 'GET') {
                this.handleStatus(res);
            }
            else if (pathname === '/admin/agents' && req.method === 'GET') {
                this.handleListAgents(res);
            }
            else if (pathname === '/admin/metrics' && req.method === 'GET') {
                this.handleMetrics(req, res);
            }
            else if (pathname === '/admin/ban' && req.method === 'POST') {
                this.handleBan(req, res);
            }
            else if (pathname === '/admin/unban' && req.method === 'POST') {
                this.handleUnban(req, res);
            }
            else if (pathname === '/admin/bans' && req.method === 'GET') {
                this.handleListBans(res);
            }
            else {
                this.sendJson(res, 404, { error: 'Not found' });
            }
        }
        catch (err) {
            this.sendJson(res, 500, { error: err instanceof Error ? err.message : 'Internal error' });
        }
    }
    handleStatus(res) {
        const queueStats = this.deps.offlineQueue.getStats();
        const abuseStats = this.deps.abuseDetector.getStats();
        const metricsSnapshot = this.deps.metrics.getSnapshot();
        this.sendJson(res, 200, {
            status: 'ok',
            uptime: this.deps.getUptime(),
            agents: this.deps.presence.size,
            connections: this.deps.connections.size,
            offlineQueue: queueStats,
            abuse: abuseStats,
            throughput: {
                messagesTotal: metricsSnapshot.messagesRouted,
                messagesPerMinute: metricsSnapshot.messagesPerMinute,
                connectionsTotal: metricsSnapshot.connectionsTotal,
                authFailures: metricsSnapshot.authFailures,
            },
        });
    }
    handleListAgents(res) {
        const agents = this.deps.presence.getAll();
        this.sendJson(res, 200, {
            agents: agents.map(a => ({
                agentId: a.agentId,
                name: a.metadata.name,
                framework: a.metadata.framework,
                capabilities: a.metadata.capabilities,
                visibility: a.visibility,
                status: a.status,
                connectedSince: a.connectedSince,
                lastSeen: a.lastSeen,
                sessionId: a.sessionId,
            })),
            count: agents.length,
        });
    }
    handleMetrics(req, res) {
        const accept = req.headers.accept ?? '';
        const snapshot = this.deps.metrics.getSnapshot();
        // If Prometheus format requested (or default)
        if (accept.includes('text/plain') || !accept.includes('application/json')) {
            res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
            res.end(this.deps.metrics.toPrometheus());
            return;
        }
        // JSON format
        this.sendJson(res, 200, snapshot);
    }
    async handleBan(req, res) {
        const body = await this.readBody(req);
        if (!body) {
            this.sendJson(res, 400, { error: 'Request body required' });
            return;
        }
        let params;
        try {
            params = JSON.parse(body);
        }
        catch {
            this.sendJson(res, 400, { error: 'Invalid JSON body' });
            return;
        }
        if (!params.agentId) {
            this.sendJson(res, 400, { error: 'agentId is required' });
            return;
        }
        const durationMs = params.durationMs ?? 60 * 60 * 1000; // default 1 hour
        const reason = params.reason ?? 'Manual admin ban';
        const ban = this.deps.abuseDetector.ban(params.agentId, reason, durationMs);
        this.sendJson(res, 200, { ban });
    }
    async handleUnban(req, res) {
        const body = await this.readBody(req);
        if (!body) {
            this.sendJson(res, 400, { error: 'Request body required' });
            return;
        }
        let params;
        try {
            params = JSON.parse(body);
        }
        catch {
            this.sendJson(res, 400, { error: 'Invalid JSON body' });
            return;
        }
        if (!params.agentId) {
            this.sendJson(res, 400, { error: 'agentId is required' });
            return;
        }
        const removed = this.deps.abuseDetector.unban(params.agentId);
        this.sendJson(res, 200, { unbanned: removed, agentId: params.agentId });
    }
    handleListBans(res) {
        const bans = this.deps.abuseDetector.getActiveBans();
        this.sendJson(res, 200, { bans, count: bans.length });
    }
    // ── Helpers ──────────────────────────────────────────────────────
    readBody(req) {
        return new Promise((resolve) => {
            const chunks = [];
            req.on('data', (chunk) => chunks.push(chunk));
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
            req.on('error', () => resolve(''));
        });
    }
    sendJson(res, status, data) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    }
}
//# sourceMappingURL=AdminServer.js.map
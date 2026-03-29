/**
 * RESTServer — Local REST API wrapper for Threadline.
 *
 * Exposes Threadline operations as HTTP endpoints bound to localhost.
 * For frameworks that can't use WebSocket, MCP, or the programmatic API.
 *
 * Security: Bound to 127.0.0.1 only. Requires bearer token auth to prevent
 * cross-site WebSocket hijacking (CSWSH) attacks.
 *
 * Part of Threadline Relay Phase 4.
 *
 * @example
 * ```bash
 * npx @anthropic-ai/threadline serve --port 18800
 * ```
 *
 * @example
 * ```typescript
 * import { ThreadlineClient } from '@anthropic-ai/threadline';
 * import { ThreadlineRESTServer } from '@anthropic-ai/threadline/adapters/rest';
 *
 * const client = new ThreadlineClient({ name: 'my-agent' });
 * await client.connect();
 *
 * const server = new ThreadlineRESTServer(client, { port: 18800 });
 * await server.start();
 * // curl -H "Authorization: Bearer <token>" http://127.0.0.1:18800/status
 * ```
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// ── Implementation ───────────────────────────────────────────────────
export class ThreadlineRESTServer {
    client;
    config;
    server = null;
    token = '';
    running = false;
    /** In-memory thread history (for GET /threads/:id) */
    threadHistory = new Map();
    constructor(client, config) {
        this.client = client;
        this.config = {
            port: config?.port ?? 18800,
            host: config?.host ?? '127.0.0.1',
            tokenPath: config?.tokenPath ?? path.join(os.homedir(), '.threadline', 'api-token'),
            maxMessageHistoryPerThread: config?.maxMessageHistoryPerThread ?? 100,
        };
        // Track incoming messages for thread history
        this.client.on('message', (msg) => {
            if (!this.threadHistory.has(msg.threadId)) {
                this.threadHistory.set(msg.threadId, []);
            }
            const history = this.threadHistory.get(msg.threadId);
            history.push(msg);
            // Trim to max
            if (history.length > this.config.maxMessageHistoryPerThread) {
                history.shift();
            }
        });
    }
    /**
     * Start the REST server.
     */
    async start() {
        if (this.running)
            throw new Error('Server already running');
        // Get or create auth token
        this.token = this.getOrCreateToken();
        return new Promise((resolve) => {
            this.server = http.createServer((req, res) => {
                this.handleRequest(req, res);
            });
            this.server.listen(this.config.port, this.config.host, () => {
                this.running = true;
                resolve({ port: this.config.port, token: this.token });
            });
        });
    }
    /**
     * Stop the REST server.
     */
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
    // ── Request Handling ───────────────────────────────────────────────
    handleRequest(req, res) {
        // CORS — only localhost
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
        if (!authHeader || authHeader !== `Bearer ${this.token}`) {
            this.sendJson(res, 401, { error: 'Unauthorized. Include Authorization: Bearer <token> header.' });
            return;
        }
        const pathname = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname;
        // Route
        try {
            if (pathname === '/status' && req.method === 'GET') {
                this.handleStatus(res);
            }
            else if (pathname === '/agents' && req.method === 'GET') {
                this.handleListAgents(res);
            }
            else if (pathname === '/discover' && req.method === 'POST') {
                this.handleDiscover(req, res);
            }
            else if (pathname === '/send' && req.method === 'POST') {
                this.handleSend(req, res);
            }
            else if (pathname === '/threads' && req.method === 'GET') {
                this.handleListThreads(res);
            }
            else if (pathname.match(/^\/threads\/[^/]+$/) && req.method === 'GET') {
                const threadId = decodeURIComponent(pathname.split('/')[2]);
                this.handleGetThread(res, threadId);
            }
            else if (pathname.match(/^\/threads\/[^/]+$/) && req.method === 'DELETE') {
                const threadId = decodeURIComponent(pathname.split('/')[2]);
                this.handleDeleteThread(res, threadId);
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
        this.sendJson(res, 200, {
            connectionState: this.client.connectionState,
            fingerprint: this.client.fingerprint,
            knownAgents: this.client.getKnownAgents().length,
            threads: this.threadHistory.size,
        });
    }
    handleListAgents(res) {
        const agents = this.client.getKnownAgents().map(a => ({
            agentId: a.agentId,
            name: a.name,
            framework: a.framework,
            capabilities: a.capabilities,
            lastSeen: a.lastSeen,
        }));
        this.sendJson(res, 200, { agents, count: agents.length });
    }
    async handleDiscover(req, res) {
        const body = await this.readBody(req);
        let filter;
        if (body) {
            try {
                filter = JSON.parse(body);
            }
            catch {
                this.sendJson(res, 400, { error: 'Invalid JSON body' });
                return;
            }
        }
        const agents = await this.client.discover(filter);
        this.sendJson(res, 200, {
            agents: agents.map(a => ({
                agentId: a.agentId,
                name: a.name,
                framework: a.framework,
                capabilities: a.capabilities,
            })),
            count: agents.length,
        });
    }
    async handleSend(req, res) {
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
        if (!params.recipientId || !params.message) {
            this.sendJson(res, 400, { error: 'recipientId and message are required' });
            return;
        }
        try {
            const messageId = this.client.send(params.recipientId, params.message, params.threadId);
            this.sendJson(res, 200, { messageId, status: 'sent' });
        }
        catch (err) {
            this.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
    }
    handleListThreads(res) {
        const threads = [...this.threadHistory.entries()].map(([threadId, messages]) => ({
            threadId,
            messageCount: messages.length,
            lastMessage: messages.length > 0
                ? { from: messages[messages.length - 1].from, timestamp: messages[messages.length - 1].timestamp }
                : null,
        }));
        this.sendJson(res, 200, { threads, count: threads.length });
    }
    handleGetThread(res, threadId) {
        const messages = this.threadHistory.get(threadId);
        if (!messages) {
            this.sendJson(res, 404, { error: 'Thread not found' });
            return;
        }
        this.sendJson(res, 200, {
            threadId,
            messages: messages.map(m => ({
                from: m.from,
                fromName: m.fromName,
                messageId: m.messageId,
                content: m.content,
                timestamp: m.timestamp,
            })),
            count: messages.length,
        });
    }
    handleDeleteThread(res, threadId) {
        const deleted = this.threadHistory.delete(threadId);
        this.sendJson(res, 200, { deleted, threadId });
    }
    // ── Helpers ────────────────────────────────────────────────────────
    getOrCreateToken() {
        const tokenDir = path.dirname(this.config.tokenPath);
        try {
            const existing = fs.readFileSync(this.config.tokenPath, 'utf-8').trim();
            if (existing.length >= 32)
                return existing;
        }
        catch {
            // Token doesn't exist yet
        }
        // Create new token
        const token = crypto.randomBytes(32).toString('hex');
        try {
            fs.mkdirSync(tokenDir, { recursive: true });
            fs.writeFileSync(this.config.tokenPath, token, { mode: 0o600 });
        }
        catch {
            // If we can't write the token file, just use the generated one
        }
        return token;
    }
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
//# sourceMappingURL=RESTServer.js.map
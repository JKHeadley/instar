/**
 * IMessageRpcClient — JSON-RPC client for the `imsg` CLI tool.
 *
 * Manages a child process running `imsg rpc` and communicates via
 * JSON-RPC 2.0 over stdin/stdout. Handles:
 * - Process lifecycle (spawn, restart, cleanup)
 * - Request/response matching with timeouts
 * - Notification (incoming message) event emission
 * - Line-buffered stdout parsing
 * - Reconnection with exponential backoff
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
const MAX_RECONNECT_DELAY_MS = 60_000;
export class IMessageRpcClient extends EventEmitter {
    process = null;
    readline = null;
    pendingRequests = new Map();
    nextId = 1;
    _state = 'disconnected';
    reconnectAttempts = 0;
    reconnectTimer = null;
    intentionalStop = false;
    cliPath;
    dbPath;
    autoReconnect;
    maxReconnectAttempts;
    reconnectBaseDelayMs;
    requestTimeoutMs;
    constructor(options = {}) {
        super();
        this.cliPath = options.cliPath || 'imsg';
        this.dbPath = options.dbPath;
        this.autoReconnect = options.autoReconnect ?? true;
        this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
        this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
        this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    }
    /** Current connection state */
    get state() {
        return this._state;
    }
    /** PID of the running imsg process, if any */
    get pid() {
        return this.process?.pid;
    }
    /**
     * Start the imsg rpc process and begin listening.
     * Resolves when the process is spawned (does not wait for first message).
     */
    async connect() {
        if (this._state === 'connected' || this._state === 'connecting') {
            return;
        }
        this.intentionalStop = false;
        this._setState('connecting');
        try {
            await this._spawn();
            this._setState('connected');
            this.reconnectAttempts = 0;
        }
        catch (err) {
            this._setState('error');
            throw err;
        }
    }
    /**
     * Stop the imsg rpc process and clean up.
     */
    async disconnect() {
        this.intentionalStop = true;
        this._clearReconnectTimer();
        this._rejectAllPending(new Error('Client disconnecting'));
        await this._kill();
        this._setState('disconnected');
    }
    /**
     * Send a JSON-RPC request and wait for the response.
     * @throws Error on timeout, process not running, or RPC error response.
     */
    async request(method, params) {
        if (this._state !== 'connected' || !this.process?.stdin?.writable) {
            throw new Error(`Cannot send request: client is ${this._state}`);
        }
        const id = this.nextId++;
        const request = {
            jsonrpc: '2.0',
            id,
            method,
            ...(params !== undefined ? { params } : {}),
        };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`RPC request '${method}' timed out after ${this.requestTimeoutMs}ms`));
            }, this.requestTimeoutMs);
            this.pendingRequests.set(id, {
                resolve: resolve,
                reject,
                timer,
            });
            const line = JSON.stringify(request) + '\n';
            this.process.stdin.write(line, (err) => {
                if (err) {
                    this.pendingRequests.delete(id);
                    clearTimeout(timer);
                    reject(new Error(`Failed to write to imsg stdin: ${err.message}`));
                }
            });
        });
    }
    // ── Internal Methods ──
    _setState(state) {
        const prev = this._state;
        this._state = state;
        if (prev !== state) {
            this.emit('stateChange', state, prev);
        }
    }
    async _spawn() {
        const args = ['rpc'];
        if (this.dbPath) {
            args.push('--db', this.dbPath);
        }
        return new Promise((resolve, reject) => {
            const proc = spawn(this.cliPath, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    // Prevent macOS Objective-C runtime crashes when imsg (Swift binary)
                    // is spawned from a LaunchAgent/forked process context
                    OBJC_DISABLE_INITIALIZE_FORK_SAFETY: 'YES',
                },
            });
            // Handle spawn error (e.g., binary not found)
            proc.on('error', (err) => {
                this.process = null;
                reject(new Error(`Failed to spawn imsg: ${err.message}`));
            });
            // Line-buffered stdout parsing
            const rl = createInterface({ input: proc.stdout });
            rl.on('line', (line) => this._handleLine(line));
            // Capture stderr for diagnostics
            const stderrChunks = [];
            proc.stderr?.on('data', (chunk) => {
                const text = chunk.toString().trim();
                if (text) {
                    stderrChunks.push(text);
                    this.emit('stderr', text);
                }
            });
            // Handle process exit
            proc.on('exit', (code, signal) => {
                this._cleanup();
                this.emit('processExit', code, signal);
                if (!this.intentionalStop && this.autoReconnect) {
                    this._scheduleReconnect();
                }
            });
            this.process = proc;
            this.readline = rl;
            // Consider the process started once it's spawned
            // (imsg rpc doesn't send a "ready" signal — it's ready on spawn)
            // Use a brief delay to catch immediate spawn failures
            const spawnCheck = setTimeout(() => {
                if (proc.exitCode !== null) {
                    reject(new Error(`imsg exited immediately with code ${proc.exitCode}: ${stderrChunks.join('\n')}`));
                }
                else {
                    resolve();
                }
            }, 200);
            proc.on('exit', () => {
                clearTimeout(spawnCheck);
            });
        });
    }
    _handleLine(line) {
        const trimmed = line.trim();
        if (!trimmed)
            return;
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch {
            this.emit('parseError', trimmed);
            return;
        }
        // Check if it's a JSON-RPC 2.0 message
        if (parsed.jsonrpc !== '2.0') {
            this.emit('parseError', trimmed);
            return;
        }
        // Response (has id) vs Notification (no id)
        if ('id' in parsed && typeof parsed.id === 'number') {
            this._handleResponse(parsed);
        }
        else if ('method' in parsed) {
            this._handleNotification(parsed);
        }
    }
    _handleResponse(response) {
        const pending = this.pendingRequests.get(response.id);
        if (!pending) {
            // Response for unknown request — may have already timed out
            return;
        }
        this.pendingRequests.delete(response.id);
        clearTimeout(pending.timer);
        if (response.error) {
            pending.reject(new Error(`RPC error ${response.error.code}: ${response.error.message}`));
        }
        else {
            pending.resolve(response.result);
        }
    }
    _handleNotification(notification) {
        if (notification.method === 'message') {
            const msg = notification.params;
            this.emit('message', msg);
        }
        else {
            this.emit('notification', notification.method, notification.params);
        }
    }
    _cleanup() {
        if (this.readline) {
            this.readline.close();
            this.readline = null;
        }
        this._rejectAllPending(new Error('imsg process exited'));
        this.process = null;
        if (this._state === 'connected' || this._state === 'connecting') {
            this._setState('disconnected');
        }
    }
    async _kill() {
        if (!this.process)
            return;
        return new Promise((resolve) => {
            const proc = this.process;
            const killTimer = setTimeout(() => {
                try {
                    proc.kill('SIGKILL');
                }
                catch { /* already dead */ }
                resolve();
            }, 3_000);
            proc.on('exit', () => {
                clearTimeout(killTimer);
                resolve();
            });
            try {
                // Close stdin first to give imsg a chance to clean up
                proc.stdin?.end();
                proc.kill('SIGTERM');
            }
            catch {
                clearTimeout(killTimer);
                resolve();
            }
        });
    }
    _rejectAllPending(error) {
        for (const [id, pending] of this.pendingRequests) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pendingRequests.clear();
    }
    _scheduleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this._setState('error');
            this.emit('reconnectFailed', this.reconnectAttempts);
            return;
        }
        const delay = Math.min(this.reconnectBaseDelayMs * Math.pow(2, this.reconnectAttempts), MAX_RECONNECT_DELAY_MS);
        this.reconnectAttempts++;
        this.emit('reconnecting', this.reconnectAttempts, delay);
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            try {
                await this.connect();
                this.emit('reconnected', this.reconnectAttempts);
            }
            catch {
                // connect() will set state to 'error', _spawn failure will trigger
                // another exit event which calls _scheduleReconnect again
            }
        }, delay);
    }
    _clearReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
}
//# sourceMappingURL=IMessageRpcClient.js.map
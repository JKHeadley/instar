/**
 * Cloudflare Tunnel manager for Instar agents.
 *
 * Manages cloudflared tunnel lifecycle — quick tunnels (zero-config,
 * ephemeral) and named tunnels (persistent, custom domain).
 *
 * Quick tunnels require no Cloudflare account. Named tunnels require
 * a tunnel token from the Cloudflare dashboard.
 *
 * The tunnel exposes the agent's local HTTP server to the internet,
 * enabling:
 *   - Private content viewing (auth-gated rendered markdown)
 *   - Remote API access from anywhere
 *   - File serving (logs, reports, exports)
 *   - Webhook endpoints for external integrations
 */
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { bin, install, Tunnel } from 'cloudflared';
// ── Manager ────────────────────────────────────────────────────────
export class TunnelManager extends EventEmitter {
    config;
    tunnel = null;
    stateFile;
    _state;
    _stopped = false;
    _autoReconnect = false;
    _reconnectTimer = null;
    _reconnectAttempt = 0;
    _startPromise = null; // Mutex: prevents concurrent start()
    static MAX_RECONNECT_ATTEMPTS = 10;
    static BASE_RECONNECT_DELAY_MS = 5_000;
    static MAX_RECONNECT_DELAY_MS = 5 * 60_000;
    constructor(config) {
        super();
        this.config = config;
        this.stateFile = path.join(config.stateDir, 'tunnel.json');
        this._state = {
            url: null,
            type: config.type,
            startedAt: null,
        };
    }
    /** Current tunnel URL, or null if not connected */
    get url() {
        return this._state.url;
    }
    /** Whether the tunnel is currently running */
    get isRunning() {
        return this.tunnel !== null && !this._stopped;
    }
    /** Current tunnel state */
    get state() {
        return { ...this._state };
    }
    /**
     * Start the tunnel. Ensures the cloudflared binary is installed,
     * then starts the appropriate tunnel type.
     */
    async start() {
        // Mutex: if a start is already in progress, return the same promise
        // This prevents concurrent start() calls from the SleepWake handler
        // and auto-reconnect racing each other.
        if (this._startPromise) {
            return this._startPromise;
        }
        // If tunnel is already running, return the current URL
        if (this.tunnel && this._state.url) {
            return this._state.url;
        }
        this._stopped = false;
        const doStart = async () => {
            try {
                // Ensure cloudflared binary is installed
                await this.ensureBinary();
                // Start the appropriate tunnel type
                if (this.config.type === 'named') {
                    if (!this.config.token && !this.config.configFile) {
                        throw new Error('Named tunnel requires either a token or a configFile. Set tunnel.token or tunnel.configFile in config.');
                    }
                    if (this.config.configFile) {
                        return await this.startConfigFileTunnel();
                    }
                    return await this.startNamedTunnel();
                }
                else {
                    return await this.startQuickTunnel();
                }
            }
            finally {
                this._startPromise = null;
            }
        };
        this._startPromise = doStart();
        return this._startPromise;
    }
    /**
     * Stop the tunnel gracefully. Intentional stops disable auto-reconnect.
     */
    async stop() {
        this._stopped = true;
        this._startPromise = null; // Cancel any in-flight start
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        this._reconnectAttempt = 0;
        if (this.tunnel) {
            this.tunnel.stop();
            this.tunnel = null;
        }
        this._state.url = null;
        this._state.startedAt = null;
        this.saveState();
        this.emit('stopped');
    }
    /**
     * Force-stop the tunnel with a timeout. If cloudflared doesn't respond to
     * SIGINT within `timeoutMs`, escalate to SIGKILL. Essential for sleep/wake
     * recovery where cloudflared may be a zombie process.
     */
    async forceStop(timeoutMs = 5000) {
        this._stopped = true;
        this._startPromise = null; // Cancel any in-flight start
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        this._reconnectAttempt = 0;
        if (this.tunnel) {
            const tunnelProcess = this.tunnel.process;
            const pid = tunnelProcess?.pid;
            // Send SIGINT (graceful)
            try {
                this.tunnel.stop();
            }
            catch { /* may already be dead */ }
            if (pid) {
                // Wait for process to exit, escalate to SIGKILL if it doesn't
                const exited = await new Promise((resolve) => {
                    const timer = setTimeout(() => resolve(false), timeoutMs);
                    // Check if process is already dead
                    try {
                        process.kill(pid, 0);
                    }
                    catch {
                        clearTimeout(timer);
                        resolve(true);
                        return;
                    }
                    // Poll for exit
                    const poll = setInterval(() => {
                        try {
                            process.kill(pid, 0);
                        }
                        catch {
                            clearInterval(poll);
                            clearTimeout(timer);
                            resolve(true);
                        }
                    }, 200);
                });
                if (!exited) {
                    console.warn(`[Tunnel] cloudflared (PID ${pid}) didn't exit after ${timeoutMs}ms SIGINT — sending SIGKILL`);
                    try {
                        process.kill(pid, 'SIGKILL');
                    }
                    catch { /* already dead */ }
                }
            }
            this.tunnel = null;
        }
        this._state.url = null;
        this._state.startedAt = null;
        this.saveState();
        this.emit('stopped');
    }
    /**
     * Enable automatic reconnection when the tunnel disconnects unexpectedly.
     * Uses exponential backoff: 5s, 10s, 20s, ... up to 5 minutes, max 10 attempts.
     */
    enableAutoReconnect() {
        this._autoReconnect = true;
    }
    disableAutoReconnect() {
        this._autoReconnect = false;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        this._reconnectAttempt = 0;
    }
    /**
     * Attempt to reconnect the tunnel with exponential backoff.
     */
    attemptReconnect() {
        if (!this._autoReconnect || this._stopped)
            return;
        // Skip if a start is already in progress (e.g., SleepWake handler is restarting)
        if (this._startPromise)
            return;
        if (this._reconnectAttempt >= TunnelManager.MAX_RECONNECT_ATTEMPTS) {
            console.error(`[Tunnel] Auto-reconnect gave up after ${this._reconnectAttempt} attempts`);
            this.emit('error', new Error(`Tunnel auto-reconnect failed after ${this._reconnectAttempt} attempts`));
            return;
        }
        const delay = Math.min(TunnelManager.BASE_RECONNECT_DELAY_MS * Math.pow(2, this._reconnectAttempt), TunnelManager.MAX_RECONNECT_DELAY_MS);
        this._reconnectAttempt++;
        console.log(`[Tunnel] Auto-reconnect attempt ${this._reconnectAttempt}/${TunnelManager.MAX_RECONNECT_ATTEMPTS} in ${delay / 1000}s`);
        this._reconnectTimer = setTimeout(async () => {
            if (this._stopped)
                return;
            try {
                const url = await this.start();
                console.log(`[Tunnel] Auto-reconnected: ${url}`);
                this._reconnectAttempt = 0;
            }
            catch (err) {
                console.error(`[Tunnel] Auto-reconnect failed:`, err instanceof Error ? err.message : err);
                this.attemptReconnect();
            }
        }, delay);
    }
    /**
     * Get the full external URL for a local path.
     * Returns null if tunnel is not connected.
     */
    getExternalUrl(localPath) {
        if (!this._state.url)
            return null;
        const base = this._state.url.replace(/\/$/, '');
        const p = localPath.startsWith('/') ? localPath : `/${localPath}`;
        return `${base}${p}`;
    }
    // ── Internal ───────────────────────────────────────────────────
    async ensureBinary() {
        if (!fs.existsSync(bin)) {
            await install(bin);
        }
    }
    startQuickTunnel() {
        return new Promise((resolve, reject) => {
            const localUrl = `http://127.0.0.1:${this.config.port}`;
            try {
                // Write an empty config to prevent cloudflared from loading
                // ~/.cloudflared/config.yml, which may contain named tunnel
                // ingress rules that override the quick tunnel's --url proxy.
                const emptyConfig = path.join(this.config.stateDir, 'cloudflared-quick.yml');
                const dir = path.dirname(emptyConfig);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                fs.writeFileSync(emptyConfig, '# Quick tunnel — no ingress rules\n');
                this.tunnel = Tunnel.quick(localUrl, { '--config': emptyConfig });
            }
            catch (err) {
                reject(new Error(`Failed to start quick tunnel: ${err instanceof Error ? err.message : String(err)}`));
                return;
            }
            let resolved = false;
            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    reject(new Error('Tunnel connection timed out after 30 seconds'));
                }
            }, 30_000);
            this.tunnel.once('url', (url) => {
                if (resolved)
                    return;
                resolved = true;
                clearTimeout(timeout);
                this._state.url = url;
                this._state.startedAt = new Date().toISOString();
                this.saveState();
                this.emit('url', url);
                resolve(url);
            });
            this.tunnel.once('connected', (info) => {
                this._state.connectionId = info.id;
                this._state.connectionLocation = info.location;
                this.saveState();
                this.emit('connected', info);
            });
            this.tunnel.on('error', (err) => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    reject(err);
                }
                this.emit('error', err);
            });
            this.tunnel.on('exit', (code) => {
                if (!this._stopped) {
                    this.tunnel = null;
                    this._state.url = null;
                    this.saveState();
                    this.emit('disconnected');
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeout);
                        reject(new Error(`Tunnel process exited with code ${code}`));
                    }
                    else {
                        // Tunnel was running and disconnected unexpectedly — try to reconnect
                        this.attemptReconnect();
                    }
                }
            });
        });
    }
    startNamedTunnel() {
        return new Promise((resolve, reject) => {
            try {
                this.tunnel = Tunnel.withToken(this.config.token);
            }
            catch (err) {
                reject(new Error(`Failed to start named tunnel: ${err instanceof Error ? err.message : String(err)}`));
                return;
            }
            let resolved = false;
            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    reject(new Error('Named tunnel connection timed out after 30 seconds'));
                }
            }, 30_000);
            this.tunnel.once('url', (url) => {
                if (resolved)
                    return;
                resolved = true;
                clearTimeout(timeout);
                this._state.url = url;
                this._state.startedAt = new Date().toISOString();
                this.saveState();
                this.emit('url', url);
                resolve(url);
            });
            this.tunnel.once('connected', (info) => {
                this._state.connectionId = info.id;
                this._state.connectionLocation = info.location;
                this.saveState();
                this.emit('connected', info);
                // For named tunnels, the URL may come from the connection info
                // rather than the 'url' event, since the URL is pre-configured
                if (!resolved && this._state.url) {
                    resolved = true;
                    clearTimeout(timeout);
                    resolve(this._state.url);
                }
            });
            this.tunnel.on('error', (err) => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    reject(err);
                }
                this.emit('error', err);
            });
            this.tunnel.on('exit', (code) => {
                if (!this._stopped) {
                    this.tunnel = null;
                    this._state.url = null;
                    this.saveState();
                    this.emit('disconnected');
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeout);
                        reject(new Error(`Named tunnel process exited with code ${code}`));
                    }
                    else {
                        this.attemptReconnect();
                    }
                }
            });
        });
    }
    startConfigFileTunnel() {
        return new Promise((resolve, reject) => {
            const configFile = this.config.configFile;
            const hostname = this.config.hostname;
            if (!fs.existsSync(configFile)) {
                reject(new Error(`Tunnel config file not found: ${configFile}`));
                return;
            }
            // Spawn cloudflared directly with the config file
            const child = spawn(bin, ['tunnel', '--config', configFile, 'run'], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let resolved = false;
            let stderrBuffer = '';
            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    // Named tunnels with config files don't emit a URL — the URL is the hostname
                    if (hostname) {
                        const url = `https://${hostname}`;
                        this._state.url = url;
                        this._state.startedAt = new Date().toISOString();
                        this.saveState();
                        this.emit('url', url);
                        resolve(url);
                    }
                    else {
                        reject(new Error('Named tunnel timed out and no hostname configured'));
                    }
                }
            }, 15_000);
            // Watch stderr for connection established messages
            child.stderr.on('data', (data) => {
                const line = data.toString();
                stderrBuffer += line;
                // cloudflared logs connection info to stderr
                if (line.includes('Registered tunnel connection') || line.includes('Connection registered')) {
                    if (!resolved && hostname) {
                        resolved = true;
                        clearTimeout(timeout);
                        const url = `https://${hostname}`;
                        this._state.url = url;
                        this._state.startedAt = new Date().toISOString();
                        this.saveState();
                        this.emit('url', url);
                        resolve(url);
                    }
                }
            });
            child.on('error', (err) => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    reject(new Error(`Failed to start config-file tunnel: ${err.message}`));
                }
            });
            child.on('exit', (code) => {
                if (!this._stopped) {
                    this.tunnel = null;
                    this._state.url = null;
                    this.saveState();
                    this.emit('disconnected');
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeout);
                        const errContext = stderrBuffer.slice(-500);
                        reject(new Error(`Config-file tunnel exited with code ${code}: ${errContext}`));
                    }
                    else {
                        this.attemptReconnect();
                    }
                }
            });
            // Store reference for cleanup — wrap in a Tunnel-like interface
            this.tunnel = {
                stop: () => { child.kill('SIGTERM'); },
                once: () => { },
                on: () => { },
                emit: () => false,
            };
        });
    }
    saveState() {
        try {
            const dir = path.dirname(this.stateFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.stateFile, JSON.stringify(this._state, null, 2));
        }
        catch {
            // Non-critical — don't crash if state save fails
        }
    }
}
//# sourceMappingURL=TunnelManager.js.map
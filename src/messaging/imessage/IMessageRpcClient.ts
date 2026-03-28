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

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  IMessageIncoming,
  ConnectionState,
} from './types.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
const MAX_RECONNECT_DELAY_MS = 60_000;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RpcClientOptions {
  /** Path to the imsg CLI binary (default: 'imsg') */
  cliPath?: string;
  /** Path to the Messages database */
  dbPath?: string;
  /** Auto-reconnect on process exit (default: true) */
  autoReconnect?: boolean;
  /** Max reconnection attempts (default: 10) */
  maxReconnectAttempts?: number;
  /** Base delay in ms for exponential backoff (default: 1000) */
  reconnectBaseDelayMs?: number;
  /** Request timeout in ms (default: 15000) */
  requestTimeoutMs?: number;
}

export class IMessageRpcClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private pendingRequests = new Map<number, PendingRequest>();
  private nextId = 1;
  private _state: ConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalStop = false;

  private readonly cliPath: string;
  private readonly dbPath: string | undefined;
  private readonly autoReconnect: boolean;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly requestTimeoutMs: number;

  constructor(options: RpcClientOptions = {}) {
    super();
    this.cliPath = options.cliPath || 'imsg';
    this.dbPath = options.dbPath;
    this.autoReconnect = options.autoReconnect ?? true;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** Current connection state */
  get state(): ConnectionState {
    return this._state;
  }

  /** PID of the running imsg process, if any */
  get pid(): number | undefined {
    return this.process?.pid;
  }

  /**
   * Start the imsg rpc process and begin listening.
   * Resolves when the process is spawned (does not wait for first message).
   */
  async connect(): Promise<void> {
    if (this._state === 'connected' || this._state === 'connecting') {
      return;
    }

    this.intentionalStop = false;
    this._setState('connecting');

    try {
      await this._spawn();
      this._setState('connected');
      this.reconnectAttempts = 0;
    } catch (err) {
      this._setState('error');
      throw err;
    }
  }

  /**
   * Stop the imsg rpc process and clean up.
   */
  async disconnect(): Promise<void> {
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
  async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this._state !== 'connected' || !this.process?.stdin?.writable) {
      throw new Error(`Cannot send request: client is ${this._state}`);
    }

    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC request '${method}' timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      });

      const line = JSON.stringify(request) + '\n';
      this.process!.stdin!.write(line, (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          clearTimeout(timer);
          reject(new Error(`Failed to write to imsg stdin: ${err.message}`));
        }
      });
    });
  }

  // ── Internal Methods ──

  private _setState(state: ConnectionState): void {
    const prev = this._state;
    this._state = state;
    if (prev !== state) {
      this.emit('stateChange', state, prev);
    }
  }

  private async _spawn(): Promise<void> {
    const args = ['rpc'];
    if (this.dbPath) {
      args.push('--db', this.dbPath);
    }

    return new Promise<void>((resolve, reject) => {
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
      const rl = createInterface({ input: proc.stdout! });
      rl.on('line', (line) => this._handleLine(line));

      // Capture stderr for diagnostics
      const stderrChunks: string[] = [];
      proc.stderr?.on('data', (chunk: Buffer) => {
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
        } else {
          resolve();
        }
      }, 200);

      proc.on('exit', () => {
        clearTimeout(spawnCheck);
      });
    });
  }

  private _handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: JsonRpcResponse | JsonRpcNotification;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.emit('parseError', trimmed);
      return;
    }

    // Check if it's a JSON-RPC 2.0 message
    if ((parsed as unknown as Record<string, unknown>).jsonrpc !== '2.0') {
      this.emit('parseError', trimmed);
      return;
    }

    // Response (has id) vs Notification (no id)
    if ('id' in parsed && typeof (parsed as JsonRpcResponse).id === 'number') {
      this._handleResponse(parsed as JsonRpcResponse);
    } else if ('method' in parsed) {
      this._handleNotification(parsed as JsonRpcNotification);
    }
  }

  private _handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      // Response for unknown request — may have already timed out
      return;
    }

    this.pendingRequests.delete(response.id);
    clearTimeout(pending.timer);

    if (response.error) {
      pending.reject(
        new Error(`RPC error ${response.error.code}: ${response.error.message}`),
      );
    } else {
      pending.resolve(response.result);
    }
  }

  private _handleNotification(notification: JsonRpcNotification): void {
    if (notification.method === 'message') {
      const msg = notification.params as unknown as IMessageIncoming;
      this.emit('message', msg);
    } else {
      this.emit('notification', notification.method, notification.params);
    }
  }

  private _cleanup(): void {
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

  private async _kill(): Promise<void> {
    if (!this.process) return;

    return new Promise<void>((resolve) => {
      const proc = this.process!;
      const killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
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
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });
  }

  private _rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private _scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this._setState('error');
      this.emit('reconnectFailed', this.reconnectAttempts);
      return;
    }

    const delay = Math.min(
      this.reconnectBaseDelayMs * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempts++;

    this.emit('reconnecting', this.reconnectAttempts, delay);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        this.emit('reconnected', this.reconnectAttempts);
      } catch {
        // connect() will set state to 'error', _spawn failure will trigger
        // another exit event which calls _scheduleReconnect again
      }
    }, delay);
  }

  private _clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

/**
 * WakeSocketServer — Server-side Unix domain socket that receives
 * wake signals from the listener daemon.
 *
 * Part of RFC: Persistent Listener Daemon Architecture (Phase 1).
 *
 * The daemon sends a 1-byte signal (\x01) when a new inbox entry is written.
 * The server picks this up immediately (event-driven, no polling) and routes
 * the message via ThreadlineRouter.
 *
 * Security:
 * - Socket created with 0600 permissions (owner only)
 * - Peer credentials verified via SO_PEERCRED (Linux) / LOCAL_PEERCRED (macOS)
 * - Socket path resolved via fs.realpathSync() to prevent symlink attacks
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export interface WakeSocketEvents {
  /** New inbox entry available */
  wake: () => void;
  /** Peer agent disconnected — evaluate failover */
  'failover-trigger': () => void;
  error: (err: Error) => void;
  'client-connected': () => void;
  'client-disconnected': () => void;
}

export class WakeSocketServer extends EventEmitter {
  private server: net.Server | null = null;
  private socketPath: string;
  private clients: Set<net.Socket> = new Set();
  private wakeCount = 0;

  constructor(stateDir: string) {
    super();
    this.socketPath = path.join(stateDir, 'listener.sock');
  }

  /**
   * Start listening on the Unix domain socket.
   *
   * Recovery sequence on EADDRINUSE:
   *   1. Pre-unlink any existing socket file (cleans up after unclean exits).
   *   2. If listen() fires EADDRINUSE anyway, probe the socket: a live peer
   *      will accept our connect; a stale file will refuse with ENOENT/ECONNREFUSED.
   *   3. If no live peer, force-unlink and retry listen once.
   *
   * This handles the "stale listener.sock after crash" failure mode without
   * clobbering a genuinely running second instance.
   */
  start(): void {
    this.attemptListen(0);
  }

  private attemptListen(attempt: number): void {
    // Only unlink on a retry (attempt > 0). On the first attempt we
    // listen() without touching the file, then let probeAndRetry decide
    // whether the socket is stale or genuinely held by a live peer. This
    // avoids the silent-clobber path where the previous code unconditionally
    // deleted any pre-existing file (including live peers' sockets) before
    // bind. On retry, probeAndRetry has already confirmed the file is
    // stale, so we unlink before listening again.
    if (attempt > 0 && fs.existsSync(this.socketPath)) {
      try {
        SafeFsExecutor.safeUnlinkSync(this.socketPath, { operation: 'src/threadline/WakeSocketServer.ts:retry-unlink' });
      } catch (unlinkErr) {
        const msg = unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr);
        process.stderr.write(`[WakeSocketServer] retry unlink failed (attempt=${attempt}): ${msg}\n`);
      }
    }

    this.server = net.createServer((client) => {
      this.clients.add(client);
      this.emit('client-connected');

      client.on('data', (data) => {
        if (data.length === 0) return;

        // Protocol: 0x01 = wake signal, 0x02 = failover trigger
        for (const byte of data) {
          if (byte === 0x01) {
            this.wakeCount++;
            this.emit('wake');
          } else if (byte === 0x02) {
            this.emit('failover-trigger');
          }
        }
      });

      client.on('close', () => {
        this.clients.delete(client);
        this.emit('client-disconnected');
      });

      client.on('error', () => {
        this.clients.delete(client);
      });
    });

    const currentServer = this.server;
    currentServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && attempt === 0) {
        // Probe whether anything is actually listening on the socket.
        // Detach listeners on this server so subsequent close-emitted
        // errors don't re-trigger the retry path.
        currentServer.removeAllListeners('error');
        // Swallow any further errors from this dying server (close() can
        // emit them asynchronously after we've moved on to attempt 1).
        currentServer.on('error', () => { /* dying server — drop */ });
        this.probeAndRetry();
        return;
      }
      this.emit('error', err);
    });

    this.server.listen(this.socketPath, () => {
      // Set socket file permissions to 0600 (owner only)
      try {
        fs.chmodSync(this.socketPath, 0o600);
      } catch {
        // Non-critical — socket may already have correct permissions
      }
    });
  }

  /**
   * EADDRINUSE recovery: probe the socket. If we can connect, a live peer
   * is bound — propagate the error. If connect refuses/fails, the socket is
   * stale; force-unlink and retry listen once.
   */
  private probeAndRetry(): void {
    const probe = net.createConnection(this.socketPath);
    let settled = false;
    const settle = (liveRefused: boolean): void => {
      if (settled) return;
      settled = true;
      // Detach listeners before destroying so the destroy-emitted 'error'
      // event doesn't propagate as an unhandled emission after the probe
      // has already done its job.
      probe.removeAllListeners();
      // After removeAllListeners(), an 'error' emitted by destroy() would
      // crash the process (EventEmitter rule: unhandled 'error' is fatal).
      // Attach a noop catcher so destroy() can fire whatever it wants.
      probe.on('error', () => { /* swallowed — probe is being torn down */ });
      try { probe.destroy(); } catch { /* ignore */ }
      if (liveRefused) {
        // Live peer — surface EADDRINUSE as a normal error
        const err = new Error(`EADDRINUSE: another process is listening on ${this.socketPath}`) as NodeJS.ErrnoException;
        err.code = 'EADDRINUSE';
        this.emit('error', err);
        return;
      }
      // Stale socket — force-unlink and retry. ENOENT is fine: the file
      // is already gone (e.g., Node's failed-listen cleanup got there
      // first, or the timeout fired after a real unlink raced). Any
      // other error is fatal because retrying listen() would re-loop.
      try {
        SafeFsExecutor.safeUnlinkSync(this.socketPath, { operation: 'src/threadline/WakeSocketServer.ts:stale-socket-recovery' });
      } catch (unlinkErr) {
        const code = (unlinkErr as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT') {
          const msg = unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr);
          const err = new Error(`stale socket at ${this.socketPath} could not be unlinked: ${msg}`) as NodeJS.ErrnoException;
          err.code = 'EADDRINUSE';
          this.emit('error', err);
          return;
        }
      }
      // Close the failed server so we don't leak handles, then retry
      try { this.server?.close(); } catch { /* ignore */ }
      this.server = null;
      process.stderr.write(`[WakeSocketServer] stale socket recovered at ${this.socketPath}; retrying bind\n`);
      this.attemptListen(1);
    };

    probe.on('connect', () => settle(/* liveRefused */ true));
    probe.on('error', () => settle(/* liveRefused */ false));
    // Hard timeout in case the peer accepts but never replies. 500ms is
    // generous for a local UDS — anything slower is effectively dead.
    setTimeout(() => settle(/* liveRefused */ false), 500).unref();
  }

  /**
   * Stop the socket server and clean up.
   */
  stop(): void {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    // Remove socket file
    try {
      if (fs.existsSync(this.socketPath)) {
        SafeFsExecutor.safeUnlinkSync(this.socketPath, { operation: 'src/threadline/WakeSocketServer.ts:117' });
      }
    } catch {
      // Non-critical
    }
  }

  /**
   * Get the number of wake signals received.
   */
  get totalWakes(): number {
    return this.wakeCount;
  }

  /**
   * Check if daemon is connected.
   */
  get isDaemonConnected(): boolean {
    return this.clients.size > 0;
  }
}

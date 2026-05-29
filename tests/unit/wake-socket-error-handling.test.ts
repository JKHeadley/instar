/**
 * Fleet crash-loop fix: the WakeSocketServer emits 'error' ASYNCHRONOUSLY when a
 * LIVE peer (a duplicate instance / a rapid-respawn race) already holds
 * listener.sock. The server-boot consumer wired 'wake' + 'failover-trigger'
 * listeners but NO 'error' listener, and its try/catch around .start() only
 * catches synchronous errors — so the async EADDRINUSE was an unhandled
 * EventEmitter 'error' that CRASHED THE WHOLE SERVER PROCESS. With the supervisor
 * respawn, that became an unrecoverable crash loop (inspec: 1830 restarts).
 *
 * These tests pin (1) the consumer now attaches an 'error' handler before
 * .start(), and (2) the live-peer EADDRINUSE surfaces as a catchable 'error'
 * event rather than throwing uncaught.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { WakeSocketServer } from '../../src/threadline/WakeSocketServer.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('server-boot wiring: wake socket has a graceful error handler', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');

  it("attaches wakeSocketServer.on('error') BEFORE .start() so an async EADDRINUSE cannot crash the process", () => {
    const errIdx = src.indexOf("wakeSocketServer.on('error'");
    const startIdx = src.indexOf('wakeSocketServer.start()');
    expect(errIdx).toBeGreaterThan(0);
    expect(startIdx).toBeGreaterThan(0);
    expect(errIdx).toBeLessThan(startIdx);
    // The handler degrades (continues without the wake socket), not rethrows.
    const block = src.slice(errIdx, errIdx + 240);
    expect(block.toLowerCase()).toContain('degraded');
  });
});

describe('WakeSocketServer — live-peer EADDRINUSE surfaces as a catchable error', () => {
  let dir: string;
  let livePeer: net.Server;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-err-'));
  });
  afterEach(async () => {
    await new Promise<void>((r) => { try { livePeer?.close(() => r()); } catch { r(); } });
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/wake-socket-error-handling.test.ts:afterEach' }); } catch { /* cleanup */ }
  });

  it('emits an EADDRINUSE error event (not an uncaught throw) when a live peer holds the socket', async () => {
    const socketPath = path.join(dir, 'listener.sock');
    // Stand up a LIVE peer already listening on the socket.
    await new Promise<void>((resolve) => {
      livePeer = net.createServer();
      livePeer.listen(socketPath, () => resolve());
    });

    const wss = new WakeSocketServer(dir);
    const err = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
      wss.on('error', (e: NodeJS.ErrnoException) => resolve(e)); // a handler exists → no crash
      setTimeout(() => reject(new Error('no error event within 3s')), 3000);
      wss.start();
    });

    expect(err.code).toBe('EADDRINUSE'); // surfaced as a normal, handleable event
  });
});

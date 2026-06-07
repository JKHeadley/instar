// safe-fs-allow: test fixture cleanup uses SafeFsExecutor on tmp dirs only.
/**
 * Tier-3 ("feature is alive") round trip for Pool Dashboard Streaming
 * (POOL-DASHBOARD-STREAM-SPEC §2.2+§2.3): a REQUESTING WebSocketManager streams
 * a session that lives on a SERVING WebSocketManager, over real sockets. A
 * browser client subscribes with a remote machineId on the requesting side; the
 * requesting side mints a ticket from the serving side and opens a real
 * /pool-stream upstream; the serving side streams output back; it fans to the
 * browser client tagged with the machine. Two real http servers, real ws.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

import { WebSocketManager } from '../../src/server/WebSocketManager.js';
import { StreamTicketStore } from '../../src/server/StreamTicketStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir: string;
let servingHttp: http.Server;
let requestingHttp: http.Server;
let servingWsm: WebSocketManager;
let requestingWsm: WebSocketManager;
let servingPort: number;
let requestingPort: number;

function fakeSM(running: string[]) {
  return {
    captureOutput: () => 'live from serving machine',
    listRunningSessions: () => running.map((tmuxSession) => ({ tmuxSession, name: tmuxSession })),
    sendInput: () => true,
    sendKey: () => true,
  } as any;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-rt-'));

  // ── SERVING side: owns "mini-sess", exposes /pool-stream gated by tickets ──
  servingHttp = http.createServer();
  await new Promise<void>((r) => servingHttp.listen(0, '127.0.0.1', r));
  servingPort = (servingHttp.address() as AddressInfo).port;
  const store = new StreamTicketStore({
    filePath: path.join(dir, 'tickets.json'),
    now: () => Date.now(),
    mintId: () => `tkt-${Math.random().toString(36).slice(2)}`,
  });
  servingWsm = new WebSocketManager({
    server: servingHttp,
    sessionManager: fakeSM(['mini-sess']),
    state: {} as any,
    streamTicketStore: store,
    poolStreamAllowRemoteInput: false,
  });

  // ── REQUESTING side: no local sessions; routes remote subs to the serving
  //    machine via a connector that mints a ticket then opens the real ws. ──
  requestingHttp = http.createServer();
  await new Promise<void>((r) => requestingHttp.listen(0, '127.0.0.1', r));
  requestingPort = (requestingHttp.address() as AddressInfo).port;
  const connector = {
    connect: (_machineId: string, handlers: any) => {
      let ws: WebSocket | null = null;
      let open = false;
      const pending: string[] = [];
      // The mesh-verb mint is exercised separately; here mint directly from the
      // serving store (same operation the verb performs) then open the real ws.
      const t = store.mint('m_serving');
      ws = new WebSocket(`ws://127.0.0.1:${servingPort}/pool-stream?ticket=${t.ticket}`);
      ws.on('open', () => { open = true; for (const m of pending) ws!.send(m); pending.length = 0; handlers.onOpen(); });
      ws.on('message', (d) => { try { handlers.onFrame(JSON.parse(d.toString())); } catch { /* noop */ } });
      ws.on('close', () => handlers.onClose());
      ws.on('error', () => { if (!open) handlers.onClose(); });
      return {
        send: (f: any) => { const s = JSON.stringify(f); if (open && ws) ws.send(s); else pending.push(s); },
        close: () => { try { ws?.close(); } catch { /* noop */ } },
      };
    },
  };
  requestingWsm = new WebSocketManager({
    server: requestingHttp,
    sessionManager: fakeSM([]),         // no local sessions
    state: {} as any,
    authToken: undefined,
    poolStreamConnector: connector,
    selfMachineId: 'm_requesting',
  });
});

afterEach(async () => {
  try { servingWsm?.shutdown?.(); requestingWsm?.shutdown?.(); } catch { /* noop */ }
  await new Promise<void>((r) => servingHttp?.close(() => r()));
  await new Promise<void>((r) => requestingHttp?.close(() => r()));
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/pool-stream-roundtrip-alive.test.ts:cleanup' });
});

function browserSubscribeAndCollect(): Promise<any[]> {
  return new Promise((resolve) => {
    const frames: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${requestingPort}/ws`);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', session: 'mini-sess', machineId: 'm_serving' })));
    ws.on('message', (d) => { try { frames.push(JSON.parse(d.toString())); } catch { /* noop */ } });
    setTimeout(() => { try { ws.close(); } catch { /* noop */ } resolve(frames); }, 700);
  });
}

describe('Pool dashboard streaming — full requesting→serving round trip (feature alive)', () => {
  it('a browser subscribe to a REMOTE session streams the serving machine output back, machine-tagged', async () => {
    const frames = await browserSubscribeAndCollect();
    const out = frames.find((f) => f.type === 'output' && f.session === 'mini-sess');
    expect(out).toBeDefined();
    expect(out.machineId).toBe('m_serving');
    expect(String(out.data)).toContain('live from serving machine');
  });
});

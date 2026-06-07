// safe-fs-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Tier-2/3 ("feature is alive") test for the Pool Dashboard Streaming SERVING
 * side (POOL-DASHBOARD-STREAM-SPEC §2.3): a real http.Server + WebSocketManager
 * + StreamTicketStore. A peer mints a single-use ticket, opens a REAL
 * `/pool-stream` WebSocket with it, subscribes to a session, and is correctly
 * gated on input (default-off). Exercises the whole upgrade→consume→peer-client
 * →gate chain over a live socket — not mocks.
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
let server: http.Server;
let wsm: WebSocketManager;
let port: number;
let store: StreamTicketStore;

function fakeSessionManager(running: string[] = ['proj-alpha']) {
  return {
    captureOutput: () => 'hello from alpha',
    listRunningSessions: () => running.map((tmuxSession) => ({ tmuxSession, name: tmuxSession })),
    sendInput: () => true,
    sendKey: () => true,
  } as any;
}

async function startServer(opts: { allowRemoteInput?: boolean } = {}): Promise<void> {
  server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  store = new StreamTicketStore({
    filePath: path.join(dir, 'stream-tickets.json'),
    now: () => Date.now(),
    mintId: () => `tkt-${Math.random().toString(36).slice(2)}`,
  });
  wsm = new WebSocketManager({
    server,
    sessionManager: fakeSessionManager(),
    state: {} as any,
    streamTicketStore: store,
    poolStreamAllowRemoteInput: opts.allowRemoteInput ?? false,
  });
}

/** Open a ws and collect frames until `predicate` matches or it times out. */
function openAndCollect(url: string, send: Record<string, unknown>[] = []): Promise<{ frames: any[]; code?: number; opened: boolean }> {
  return new Promise((resolve) => {
    const frames: any[] = [];
    const ws = new WebSocket(url);
    let opened = false;
    const done = (code?: number) => { try { ws.close(); } catch { /* noop */ } resolve({ frames, code, opened }); };
    ws.on('open', () => { opened = true; for (const m of send) ws.send(JSON.stringify(m)); setTimeout(() => done(), 200); });
    ws.on('message', (d) => { try { frames.push(JSON.parse(d.toString())); } catch { /* noop */ } });
    ws.on('unexpected-response', (_req, res) => done(res.statusCode));
    ws.on('error', () => { if (!opened) done(0); });
    setTimeout(() => done(), 1500);
  });
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-stream-')); });
afterEach(async () => {
  try { wsm?.shutdown?.(); } catch { /* noop */ }
  await new Promise<void>((r) => server?.close(() => r()));
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/pool-stream-serving-alive.test.ts:cleanup' });
});

describe('Pool dashboard streaming — serving endpoint (feature alive)', () => {
  it('a valid ticket opens /pool-stream and a subscribe streams output', async () => {
    await startServer();
    const t = store.mint('m_peer');
    const { frames, opened } = await openAndCollect(
      `ws://127.0.0.1:${port}/pool-stream?ticket=${t.ticket}`,
      [{ type: 'subscribe', session: 'proj-alpha' }],
    );
    expect(opened).toBe(true);
    expect(frames.some((f) => f.type === 'output' && f.session === 'proj-alpha')).toBe(true);
    expect(frames.some((f) => f.type === 'subscribed' && f.session === 'proj-alpha')).toBe(true);
  });

  it('an invalid/absent ticket is rejected at the upgrade (401, never opens)', async () => {
    await startServer();
    const r = await openAndCollect(`ws://127.0.0.1:${port}/pool-stream?ticket=bogus`);
    expect(r.opened).toBe(false);
    expect(r.code).toBe(401);
  });

  it('a ticket is single-use — the second upgrade with the same ticket is rejected', async () => {
    await startServer();
    const t = store.mint('m_peer');
    const first = await openAndCollect(`ws://127.0.0.1:${port}/pool-stream?ticket=${t.ticket}`);
    expect(first.opened).toBe(true);
    const second = await openAndCollect(`ws://127.0.0.1:${port}/pool-stream?ticket=${t.ticket}`);
    expect(second.opened).toBe(false);
    expect(second.code).toBe(401);
  });

  it('peer input is gated OFF by default — input yields input-not-allowed, never reaches tmux', async () => {
    await startServer({ allowRemoteInput: false });
    const t = store.mint('m_peer');
    const { frames } = await openAndCollect(
      `ws://127.0.0.1:${port}/pool-stream?ticket=${t.ticket}`,
      [{ type: 'input', session: 'proj-alpha', text: 'whoami\n' }],
    );
    expect(frames.some((f) => f.type === 'error' && f.code === 'input-not-allowed')).toBe(true);
    expect(frames.some((f) => f.type === 'input_ack')).toBe(false);
  });

  it('with allowRemoteInput ON, peer input is accepted', async () => {
    await startServer({ allowRemoteInput: true });
    const t = store.mint('m_peer');
    const { frames } = await openAndCollect(
      `ws://127.0.0.1:${port}/pool-stream?ticket=${t.ticket}`,
      [{ type: 'input', session: 'proj-alpha', text: 'ls\n' }],
    );
    expect(frames.some((f) => f.type === 'input_ack' && f.success === true)).toBe(true);
  });

  it('a crafted (tmux-unsafe) session name is refused with invalid-session', async () => {
    await startServer({ allowRemoteInput: true });
    const t = store.mint('m_peer');
    const { frames } = await openAndCollect(
      `ws://127.0.0.1:${port}/pool-stream?ticket=${t.ticket}`,
      [{ type: 'input', session: 'a; touch /tmp/pwned #', text: 'x' }],
    );
    expect(frames.some((f) => f.type === 'error' && f.code === 'invalid-session')).toBe(true);
    expect(frames.some((f) => f.type === 'input_ack')).toBe(false);
  });
});

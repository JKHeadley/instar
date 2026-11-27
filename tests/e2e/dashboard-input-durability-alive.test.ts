// safe-fs-allow: test fixture cleanup uses SafeFsExecutor on tmp dirs only.
/**
 * Tier-3 "feature is alive" for native-conversation-any-machine-access §3e (the dashboard
 * never loses a reply quietly).
 *
 *  1. The REAL AgentServer on the production init path: its live socket says what it can
 *     do first on every subscribe (`input_caps`, `inputAck: 2`), echoes an id on the
 *     acknowledgement, answers a repeat without a second write, and its counters route
 *     answers 200 (not 503) with remote input still off by default. The served console
 *     carries the composer model.
 *  2. The shipped console in a DOM, talking over REAL sockets to a requesting server that
 *     relays to a serving one: type, drop the socket before the acknowledgement, and the
 *     text is still in the box.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { JSDOM } from 'jsdom';
import { WebSocket } from 'ws';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { WebSocketManager } from '../../src/server/WebSocketManager.js';
import { StreamTicketStore } from '../../src/server/StreamTicketStore.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const tmpBase = () => (process.env.TMPDIR && !process.env.TMPDIR.includes('/.') ? process.env.TMPDIR : os.tmpdir());
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error('timed out waiting'); await wait(15); }
}

describe('§3e dashboard input durability — the production server path', () => {
  const AUTH = 'test-e2e-input-durability';
  let tmpDir: string;
  let server: AgentServer;
  const writes: string[] = [];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(tmpBase(), 'input-dur-e2e-'));
    const stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
    const config = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, host: '127.0.0.1', authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;
    const sessionManager = {
      listRunningSessions: () => [{ tmuxSession: 'e2e-sess', name: 'e2e-sess', id: 'e2e', status: 'running', startedAt: new Date().toISOString() }],
      getSession: () => null,
      captureOutput: () => 'pane',
      sendInput: (_s: string, t: string) => { writes.push(t); return true; },
      sendKey: () => true,
    };
    server = new AgentServer({ config, sessionManager: sessionManager as any, state: new StateManager(stateDir) });
    await server.start();
    await until(() => Boolean((server as any).wsManager), 10_000);
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/dashboard-input-durability-alive.test.ts:cleanup' });
  });

  it('the counters route is alive (200) with remote input off by default; it needs the bearer', async () => {
    const app = server.getApp();
    expect((await request(app).get('/sessions/dashboard-input-status')).status).toBe(401);
    const res = await request(app).get('/sessions/dashboard-input-status').set({ Authorization: `Bearer ${AUTH}` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: true, inputAck: 2, allowRemoteInput: false, idsPerSession: 256, inputIdsEvicted: 0, inputRetryUnknown: 0 });
  });

  it('the served console carries the composer model', async () => {
    const res = await request(server.getApp()).get('/dashboard/console/input-model.js');
    expect(res.status).toBe(200);
    expect(res.text).toContain('createInputTracker');
    expect(res.text).toContain('Not confirmed yet.');
  });

  it('the live socket says what it can do first, echoes the id, and answers a repeat without typing twice', async () => {
    const port = ((server as any).server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${AUTH}`);
    const frames: Array<Record<string, unknown>> = [];
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
    await new Promise<void>((r) => ws.on('open', () => r()));
    ws.send(JSON.stringify({ type: 'subscribe', session: 'e2e-sess' }));
    await until(() => frames.some((f) => f.type === 'subscribed'));
    const forSession = frames.filter((f) => f.session === 'e2e-sess');
    expect(forSession[0]).toEqual({ type: 'input_caps', session: 'e2e-sess', inputAck: 2, remoteInput: true });
    const id = 'e2eAliveInputId_0001';
    ws.send(JSON.stringify({ type: 'input', session: 'e2e-sess', text: 'hello', clientInputId: id }));
    ws.send(JSON.stringify({ type: 'input', session: 'e2e-sess', text: 'hello', clientInputId: id, retry: true }));
    await until(() => frames.filter((f) => f.type === 'input_ack').length === 2);
    expect(frames.filter((f) => f.type === 'input_ack')).toEqual([
      { type: 'input_ack', session: 'e2e-sess', success: true, clientInputId: id },
      { type: 'input_ack', session: 'e2e-sess', success: true, clientInputId: id },
    ]);
    expect(writes).toEqual(['hello']);
    ws.close();
    const stats = await request(server.getApp()).get('/sessions/dashboard-input-status').set({ Authorization: `Bearer ${AUTH}` });
    expect(stats.body.inputIdsRepeated).toBe(1);
  });
});

describe('§3e — the shipped console over real sockets: a dropped socket never loses the text', () => {
  const cleanups: Array<() => unknown> = [];
  afterAll(async () => { for (const c of cleanups.reverse()) { try { await c(); } catch { /* best effort */ } } });

  it('type, drop the socket before the acknowledgement: the text is still in the box', async () => {
    const dir = fs.mkdtempSync(path.join(tmpBase(), 'input-dur-dom-'));
    cleanups.push(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/dashboard-input-durability-alive.test.ts:dom-cleanup' }));
    const listen = async () => { const s = http.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); cleanups.push(() => new Promise<void>((r) => s.close(() => r()))); return { s, port: (s.address() as AddressInfo).port }; };

    // The serving machine: owns the session, accepts remote input on this throwaway pair.
    const serving = await listen();
    const typed: string[] = [];
    const store = new StreamTicketStore({ filePath: path.join(dir, 't.json'), now: () => Date.now(), mintId: () => `tkt-${Math.random().toString(36).slice(2)}` });
    const servingWsm = new WebSocketManager({
      server: serving.s, state: {} as any, streamTicketStore: store, poolStreamAllowRemoteInput: true,
      sessionManager: { captureOutput: () => 'remote pane', listRunningSessions: () => [{ tmuxSession: 'far-sess', name: 'far-sess' }], sendInput: (_s: string, t: string) => { typed.push(t); return true; }, sendKey: () => true } as any,
    });
    cleanups.push(() => servingWsm.shutdown());

    // The machine the dashboard is open on: relays to the serving machine over /pool-stream.
    const requesting = await listen();
    const requestingWsm = new WebSocketManager({
      server: requesting.s, state: {} as any, selfMachineId: 'm_here',
      sessionManager: { captureOutput: () => null, listRunningSessions: () => [], sendInput: () => false, sendKey: () => false } as any,
      poolStreamConnector: {
        connect: (_m: string, handlers: any) => {
          let open = false; const pending: string[] = [];
          const ws = new WebSocket(`ws://127.0.0.1:${serving.port}/pool-stream?ticket=${store.mint('m_here').ticket}`);
          ws.on('open', () => { open = true; for (const m of pending) ws.send(m); pending.length = 0; handlers.onOpen(); });
          ws.on('message', (d) => handlers.onFrame(JSON.parse(d.toString())));
          ws.on('close', () => handlers.onClose());
          return { send: (f: unknown) => { const s = JSON.stringify(f); if (open) ws.send(s); else pending.push(s); }, close: () => ws.close() };
        },
      },
    });
    cleanups.push(() => requestingWsm.shutdown());

    // The shipped console in a DOM whose WebSocket is the real client, pointed at the requesting server.
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: `http://127.0.0.1:${requesting.port}/dashboard/console/#/work/sessions?s=${encodeURIComponent('remote:m_far:far-sess')}` });
    cleanups.push(() => dom.window.close());
    const g = globalThis as Record<string, unknown>;
    const sockets: WebSocket[] = [];
    class BrowserWS extends WebSocket { constructor(url: string) { super(url); sockets.push(this); } }
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0), WebSocket: BrowserWS });
    dom.window.localStorage.setItem('instar_token', 't');
    (dom.window as unknown as Record<string, unknown>).Terminal = class { buffer = { active: { baseY: 0, viewportY: 0 } }; loadAddon() {} open() {} onScroll() {} clear() {} write() {} scrollToBottom() {} dispose() {} };
    (dom.window as unknown as Record<string, unknown>).FitAddon = { FitAddon: class { fit() {} } };
    const row = { id: 'far', name: 'far-sess', tmuxSession: 'far-sess', status: 'running', startedAt: new Date().toISOString(), machineId: 'm_far', machineNickname: 'Far Mac', remote: true, platform: 'telegram', platformId: 9, platformName: 'Far work' };
    g.fetch = async (url: string) => {
      const table: Record<string, unknown> = {
        '/sessions?scope=pool': { sessions: [row], pool: { enabled: true, selfMachineId: 'm_here', selfMachineNickname: 'Here', machines: [{ machineId: 'm_far', nickname: 'Far Mac', ok: true }], failed: [], duplicateTopics: [] } },
        '/sessions': [],
        '/telegram/topics?scope=pool': { topics: [] },
        '/health': { project: { name: 'e2e' } },
      };
      const body = table[url];
      return { ok: body !== undefined, status: body !== undefined ? 200 : 404, json: async () => body ?? {} };
    };
    const { vi } = await import('vitest');
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    const doc = dom.window.document;
    await until(() => Boolean(doc.querySelector('.sess-input')), 8000);
    const input = doc.querySelector('.sess-input') as HTMLTextAreaElement;
    const send = doc.querySelector('button[data-send]') as HTMLButtonElement;
    // The serving machine says what it can do through the relay; then the box opens.
    await until(() => !send.disabled, 8000);

    input.value = 'please deploy';
    send.click();
    sockets.at(-1)!.terminate(); // before the acknowledgement can come back
    await until(() => typed.includes('please deploy'), 5000); // it did reach the session…
    await wait(300);
    // …but this tab never saw its acknowledgement, so the text is still in the box.
    expect(input.value).toBe('please deploy');
    expect(typed.filter((t) => t === 'please deploy')).toHaveLength(1);
  }, 30_000);
});

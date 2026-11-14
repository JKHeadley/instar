// safe-fs-allow: test fixture cleanup uses SafeFsExecutor on tmp dirs only.
/**
 * native-conversation-any-machine-access §3e — the dashboard reply box over two real
 * servers (a requesting WebSocketManager relaying to a serving one through a real
 * /pool-stream socket), driven by the shipped composer model:
 *  - remote input off → `input-not-allowed` carrying the id; nothing typed;
 *  - on → two sends of one id make ONE tmux write;
 *  - a dropped link → `peer-stream-lost` with the id;
 *  - the browser socket drops before the ack and reconnects: "Send again" with the same
 *    id gives no second write and clears the draft when the first try had arrived, and is
 *    refused `input-retry-unknown` with nothing typed when it had not;
 *  - an older serving machine (no `input_caps`, id-less acks): the draft stays unresolved
 *    with no send control, the session receives the one line, nothing the session shows
 *    clears it; a refusal shows the refusal sentence; two clients waiting on one older
 *    session both receive the first client's acknowledgement and neither is cleared.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

import { WebSocketManager } from '../../src/server/WebSocketManager.js';
import { StreamTicketStore } from '../../src/server/StreamTicketStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createInputTracker, WORDS } from '../../dashboard/console/input-model.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) { try { await c(); } catch { /* best effort */ } }
});

const tmpBase = () => (process.env.TMPDIR && !process.env.TMPDIR.includes('/.') ? process.env.TMPDIR : os.tmpdir());
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error('timed out waiting'); await wait(10); }
}

async function listen(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { server, port: (server.address() as AddressInfo).port };
}

/** A current serving machine that owns `sess`, records every write to its pane. */
async function servingMachine(allowRemoteInput: boolean) {
  const dir = fs.mkdtempSync(path.join(tmpBase(), 'input-dur-'));
  cleanups.push(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/dashboard-input-durability.test.ts:cleanup' }));
  const { server, port } = await listen();
  const writes: string[] = [];
  const store = new StreamTicketStore({ filePath: path.join(dir, 'tickets.json'), now: () => Date.now(), mintId: () => `tkt-${Math.random().toString(36).slice(2)}` });
  const wsm = new WebSocketManager({
    server, state: {} as any, streamTicketStore: store, poolStreamAllowRemoteInput: allowRemoteInput,
    sessionManager: {
      captureOutput: () => 'pane', listRunningSessions: () => [{ tmuxSession: 'sess', name: 'sess' }],
      sendInput: (_s: string, t: string) => { writes.push(t); return true; }, sendKey: () => true,
    } as any,
  });
  cleanups.push(() => wsm.shutdown());
  return { url: () => `ws://127.0.0.1:${port}/pool-stream?ticket=${store.mint('m_requesting').ticket}`, writes, wsm };
}

/** An OLDER serving machine: no `input_caps`, no ids, its acknowledgement goes to the
 *  connection (the relay), which fans an id-less frame to every client of the session. */
async function olderServingMachine(opts: { refuse?: boolean } = {}) {
  const { server, port } = await listen();
  const wss = new WebSocketServer({ server, path: '/pool-stream' });
  cleanups.push(() => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }));
  const writes: Array<Record<string, unknown>> = [];
  wss.on('connection', (ws) => {
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'subscribe') { ws.send(JSON.stringify({ type: 'output', session: m.session, data: 'old pane' })); ws.send(JSON.stringify({ type: 'subscribed', session: m.session })); }
      if (m.type === 'input') {
        if (opts.refuse) { ws.send(JSON.stringify({ type: 'error', code: 'input-not-allowed', session: m.session })); return; }
        writes.push(m);
        ws.send(JSON.stringify({ type: 'input_ack', session: m.session, success: true }));
      }
    });
  });
  return { url: () => `ws://127.0.0.1:${port}/pool-stream`, writes };
}

/** The requesting machine (the one the dashboard is open on). `holdInput` drops input
 *  frames on the link once, to stand for a frame lost before it reached the serving machine. */
async function requestingMachine(peerUrl: () => string, opts: { dropNextInput?: { on: boolean } } = {}) {
  const { server, port } = await listen();
  const links: WebSocket[] = [];
  const connector = {
    connect: (_machineId: string, handlers: any) => {
      let open = false;
      const pending: string[] = [];
      const ws = new WebSocket(peerUrl());
      links.push(ws);
      ws.on('open', () => { open = true; for (const m of pending) ws.send(m); pending.length = 0; handlers.onOpen(); });
      ws.on('message', (d) => { try { handlers.onFrame(JSON.parse(d.toString())); } catch { /* noop */ } });
      ws.on('close', () => handlers.onClose());
      ws.on('error', () => { if (!open) handlers.onClose(); });
      return {
        send: (f: any) => {
          if (f.type === 'input' && opts.dropNextInput?.on) { opts.dropNextInput.on = false; return; }
          const s = JSON.stringify(f); if (open) ws.send(s); else pending.push(s);
        },
        close: () => { try { ws.close(); } catch { /* noop */ } },
      };
    },
  };
  const wsm = new WebSocketManager({
    server, state: {} as any, poolStreamConnector: connector, selfMachineId: 'm_requesting',
    sessionManager: { captureOutput: () => null, listRunningSessions: () => [], sendInput: () => { throw new Error('never local'); }, sendKey: () => false } as any,
  });
  cleanups.push(() => wsm.shutdown());
  return { port, links, wsm };
}

/** A browser tab on the requesting machine, running the shipped composer model. */
async function browserTab(port: number) {
  const frames: Array<Record<string, unknown>> = [];
  let ws!: WebSocket;
  let tracker!: ReturnType<typeof createInputTracker>;
  const connect = async () => {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('message', (d) => { const m = JSON.parse(d.toString()); frames.push(m); if (m.session === 'sess') tracker.onFrame(m); });
    ws.on('close', () => tracker.linkDown());
    await new Promise<void>((r) => ws.on('open', () => r()));
    ws.send(JSON.stringify({ type: 'subscribe', session: 'sess', machineId: 'm_serving' }));
  };
  tracker = createInputTracker({
    send: (extra: Record<string, unknown>) => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify({ type: 'key' in extra ? 'key' : 'input', session: 'sess', machineId: 'm_serving', ...extra }));
      return true;
    },
  });
  cleanups.push(() => { try { ws.terminate(); } catch { /* noop */ } });
  await connect();
  await until(() => tracker.caps !== null);
  return { frames, tracker, reconnect: connect, socket: () => ws };
}

describe('dashboard input durability over two servers (§3e)', () => {
  it('remote input off: refused with the id, nothing typed, the composer is read-only with the refusal sentence', async () => {
    const serving = await servingMachine(false);
    const req = await requestingMachine(serving.url);
    const tab = await browserTab(req.port);
    expect(tab.tracker.view().composer).toEqual({ disabled: true, readOnly: true, words: WORDS.refused });
    // Even a frame sent around the read-only box is refused, with its id.
    tab.socket().send(JSON.stringify({ type: 'input', session: 'sess', machineId: 'm_serving', text: 'x', clientInputId: 'aaaaaaaaaaaaaaaaaaaa' }));
    await until(() => tab.frames.some((f) => f.code === 'input-not-allowed'));
    expect(tab.frames.find((f) => f.code === 'input-not-allowed')).toMatchObject({ clientInputId: 'aaaaaaaaaaaaaaaaaaaa', session: 'sess' });
    expect(serving.writes).toEqual([]);
  });

  it('on: two sends of one id make one tmux write, and the draft clears on its own acknowledgement', async () => {
    const serving = await servingMachine(true);
    const req = await requestingMachine(serving.url);
    const tab = await browserTab(req.port);
    expect(tab.tracker.caps).toEqual({ inputAck: 2, remoteInput: true });
    const { id } = tab.tracker.sendText('yes') as { id: string };
    tab.socket().send(JSON.stringify({ type: 'input', session: 'sess', machineId: 'm_serving', text: 'yes', clientInputId: id, retry: true }));
    await until(() => tab.frames.filter((f) => f.type === 'input_ack').length === 2);
    expect(serving.writes).toEqual(['yes']);
    expect(tab.tracker.view().sending).toBeNull();
    expect(tab.tracker.view().drafts).toEqual([]);
  });

  it('a dropped link: the relay answers peer-stream-lost with the id, and the text comes back', async () => {
    const serving = await servingMachine(true);
    // The serving machine stops answering: the one bounded reconnect goes nowhere.
    let first = true;
    const req = await requestingMachine(() => { if (first) { first = false; return serving.url(); } return 'ws://127.0.0.1:1/pool-stream'; });
    const tab = await browserTab(req.port);
    req.links[0].terminate();
    await until(() => tab.tracker.caps === null);
    tab.socket().send(JSON.stringify({ type: 'input', session: 'sess', machineId: 'm_serving', text: 'go', clientInputId: 'bbbbbbbbbbbbbbbbbbbb' }));
    await until(() => tab.frames.some((f) => f.code === 'peer-stream-lost' && f.clientInputId === 'bbbbbbbbbbbbbbbbbbbb'));
    expect(serving.writes).toEqual([]);
  });

  it('the browser socket drops before the ack; "Send again" with the same id gives no second write and clears the draft', async () => {
    const serving = await servingMachine(true);
    const req = await requestingMachine(serving.url);
    const tab = await browserTab(req.port);
    const { id } = tab.tracker.sendText('ship it') as { id: string };
    tab.socket().terminate(); // before the acknowledgement can arrive
    await until(() => serving.writes.length === 1);
    expect(tab.tracker.view().sending).toMatchObject({ id, text: 'ship it' }); // still in the box
    await tab.reconnect();
    await until(() => tab.tracker.caps !== null);
    await until(() => tab.tracker.view().drafts.length === 1, 10_000); // 8 s with no answer → not confirmed
    expect(tab.tracker.view().drafts[0].controls).toContain('send-again');
    expect(tab.tracker.retry(id)).toBe(true);
    await until(() => tab.tracker.view().drafts.length === 0);
    expect(serving.writes.filter((w) => w === 'ship it')).toHaveLength(1);
    // The one line asked the session about the unresolved draft, once.
    expect(serving.writes.filter((w) => w.startsWith('[dashboard]'))).toHaveLength(1);
  }, 20_000);

  it('a first try that never reached the serving machine: "Send again" is refused input-retry-unknown and nothing is typed', async () => {
    const serving = await servingMachine(true);
    const drop = { on: false };
    const req = await requestingMachine(serving.url, { dropNextInput: drop });
    const tab = await browserTab(req.port);
    drop.on = true;
    const { id } = tab.tracker.sendText('lost on the way') as { id: string };
    await until(() => tab.tracker.view().drafts.length === 1, 10_000);
    expect(tab.tracker.retry(id)).toBe(true);
    await until(() => tab.frames.some((f) => f.code === 'input-retry-unknown'));
    expect(serving.writes.filter((w) => w === 'lost on the way')).toEqual([]);
    const d = tab.tracker.view().drafts[0];
    expect(d.words.startsWith(WORDS.retryUnknown)).toBe(true);
    expect(d.controls).toEqual(['copy', 'discard']);
  }, 20_000);

  it('an older serving machine: unresolved at once, no send control, the session gets the one line, nothing clears it', async () => {
    const older = await olderServingMachine();
    const req = await requestingMachine(older.url);
    const tab = await browserTab(req.port);
    expect(tab.tracker.caps).toEqual({ inputAck: 1, remoteInput: null });
    tab.tracker.sendText('yes');
    await until(() => older.writes.length === 2);
    expect(older.writes[0]).toEqual({ type: 'input', session: 'sess', text: 'yes' }); // no id, as today
    expect(String(older.writes[1].text)).toMatch(/^\[dashboard\] A message typed in the dashboard at \d\d:\d\d \(input `/);
    await until(() => tab.frames.filter((f) => f.type === 'input_ack').length === 2);
    const v = tab.tracker.view();
    expect(v.drafts).toHaveLength(1);
    expect(v.drafts[0].controls).toEqual(['copy', 'discard']);
  });

  it('an older serving machine that refuses: the refusal sentence is shown and the draft kept', async () => {
    const older = await olderServingMachine({ refuse: true });
    const req = await requestingMachine(older.url);
    const tab = await browserTab(req.port);
    tab.tracker.sendText('yes');
    await until(() => tab.frames.some((f) => f.code === 'input-not-allowed'));
    const v = tab.tracker.view();
    expect(v.drafts).toHaveLength(1);
    expect(v.drafts[0].words).toBe(WORDS.refused);
  });

  it('two clients on one older-server session, both waiting: the first client\'s acknowledgement reaches both and clears neither', async () => {
    const older = await olderServingMachine();
    const req = await requestingMachine(older.url);
    const a = await browserTab(req.port);
    const b = await browserTab(req.port);
    a.tracker.sendText('from a');
    b.tracker.sendText('from b');
    await until(() => older.writes.length === 4);
    await until(() => a.frames.filter((f) => f.type === 'input_ack').length >= 2 && b.frames.filter((f) => f.type === 'input_ack').length >= 2);
    expect(a.tracker.view().drafts).toHaveLength(1);
    expect(b.tracker.view().drafts).toHaveLength(1);
  });
});

/**
 * SocketModeClient connection-leak tests (JKHeadley/instar#1076) — verifies that:
 * 1. A late close event from a replaced socket cannot orphan the new connection
 *    or trigger an extra reconnect (the sleep/wake leak).
 * 2. An in-flight backoff sleeper superseded by an explicit reconnect() does
 *    not open a second, untracked connection.
 * 3. A Slack-initiated `too_many_websockets` disconnect reconnects exactly
 *    once, after the mandated delay — a stale close event can't add another.
 * 4. A natural unsolicited close still reconnects (regression guard).
 *
 * Root cause: WebSocket close events fire on a later tick. The old
 * "temporarily clear `started`" save/restore was synchronous, so by the time
 * the old socket's close handler ran, `started` was restored and `this.ws`
 * pointed at the replacement socket. The handler then nulled `this.ws`
 * (orphaning the replacement — it stayed OPEN, untracked, counting against
 * Slack's ~10-connection Socket Mode cap) and fired another reconnect.
 * Every sleep/wake reconnect leaked one live websocket; after ~10 wakes the
 * cap was hit and the client churned with too_many_websockets forever
 * (observed live: 5,075 disconnects in 73 minutes, ~70/min).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SocketModeClient, type SocketModeHandlers } from '../../src/messaging/slack/SocketModeClient.js';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }

  send(_data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('not open');
  }

  // Like the real thing, close() transitions state but the close EVENT fires
  // on a later tick — tests fire it explicitly to simulate that async gap.
  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = FakeWebSocket.CLOSING;
  }

  fire(type: string, ev: Record<string, unknown> = {}): void {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }

  fireOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.fire('open');
  }

  fireClose(reason = 'connection closed'): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.fire('close', { reason, code: 1000 });
  }
}

function makeHandlers(): SocketModeHandlers {
  return {
    onEvent: vi.fn(async () => {}),
    onInteraction: vi.fn(async () => {}),
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
    onError: vi.fn(),
  };
}

function makeApi(): { call: ReturnType<typeof vi.fn> } {
  let n = 0;
  return {
    call: vi.fn(async () => ({ ok: true, url: `wss://fake.slack/${++n}` })),
  };
}

function trackedWs(client: SocketModeClient): FakeWebSocket | null {
  return (client as unknown as { ws: FakeWebSocket | null }).ws;
}

async function handleRaw(client: SocketModeClient, raw: string): Promise<void> {
  await (client as unknown as { _handleRawMessage(raw: string): Promise<void> })._handleRawMessage(raw);
}

const realWebSocket = globalThis.WebSocket;

describe('SocketModeClient connection leak (#1076)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    // The client resolves WebSocket from the global at construction time of
    // each socket, so swapping the global is enough.
    (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as Record<string, unknown>).WebSocket = realWebSocket;
  });

  it('a late close event from the replaced socket does not orphan the new connection or open another', async () => {
    const api = makeApi();
    const client = new SocketModeClient(api as never, makeHandlers());

    await client.connect();
    const a = FakeWebSocket.instances[0];
    a.fireOpen();

    await client.reconnect(); // e.g. the SleepWake handler after a wake
    expect(FakeWebSocket.instances.length).toBe(2);
    const b = FakeWebSocket.instances[1];
    b.fireOpen();
    expect(api.call).toHaveBeenCalledTimes(2);
    expect(a.closeCalls.length).toBe(1); // old socket genuinely closed

    // The old socket's close event arrives on a later tick — the bug's trigger.
    a.fireClose('reconnect');
    await vi.advanceTimersByTimeAsync(120_000);

    // No third connection may be opened, and the replacement must stay tracked.
    expect(api.call).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances.length).toBe(2);
    expect(trackedWs(client)).toBe(b);
    expect(b.closeCalls.length).toBe(0);
  });

  it('an in-flight backoff superseded by reconnect() does not open a second connection', async () => {
    const api = makeApi();
    let failFirst = true;
    api.call.mockImplementation(async () => {
      if (failFirst) {
        failFirst = false;
        throw new Error('network not ready');
      }
      return { ok: true, url: 'wss://fake.slack/ok' };
    });
    const client = new SocketModeClient(api as never, makeHandlers());

    // First open fails → a backoff sleeper is now armed (1s).
    const connectPromise = client.connect();
    await vi.advanceTimersByTimeAsync(0);

    // An explicit reconnect lands while the sleeper is still in flight.
    await client.reconnect();
    const b = FakeWebSocket.instances[0];
    b.fireOpen();
    expect(api.call).toHaveBeenCalledTimes(2);

    // The stale sleeper wakes — it must NOT open a third connection.
    await vi.advanceTimersByTimeAsync(120_000);
    await connectPromise;

    expect(api.call).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances.length).toBe(1);
    expect(trackedWs(client)).toBe(b);
    expect(b.closeCalls.length).toBe(0);
  });

  it('too_many_websockets reconnects exactly once after the delay; the stale close adds nothing', async () => {
    const api = makeApi();
    const client = new SocketModeClient(api as never, makeHandlers());

    await client.connect();
    const a = FakeWebSocket.instances[0];
    a.fireOpen();
    expect(api.call).toHaveBeenCalledTimes(1);

    // Slack tells us to back off via a disconnect envelope.
    await handleRaw(client, JSON.stringify({ type: 'disconnect', payload: { reason: 'too_many_websockets' } }));
    // The torn-down socket's close event arrives late.
    a.fireClose('too_many_websockets');

    // Inside the 30s mandated delay nothing may reconnect — including via the stale close.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(api.call).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.call).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances.length).toBe(2);
  });

  it('a natural unsolicited close still reconnects (regression guard)', async () => {
    const api = makeApi();
    const client = new SocketModeClient(api as never, makeHandlers());

    await client.connect();
    const a = FakeWebSocket.instances[0];
    a.fireOpen();

    // Slack drops the connection without warning — the close IS current.
    a.fireClose('connection closed');
    await vi.advanceTimersByTimeAsync(120_000);

    expect(api.call).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances.length).toBe(2);
    expect(trackedWs(client)).toBe(FakeWebSocket.instances[1]);
  });

  it('disconnect() stops everything — a late close event triggers no reconnect', async () => {
    const api = makeApi();
    const client = new SocketModeClient(api as never, makeHandlers());

    await client.connect();
    const a = FakeWebSocket.instances[0];
    a.fireOpen();

    await client.disconnect();
    a.fireClose('client disconnect');
    await vi.advanceTimersByTimeAsync(120_000);

    expect(api.call).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances.length).toBe(1);
    expect(trackedWs(client)).toBe(null);
  });
});

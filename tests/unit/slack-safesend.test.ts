/**
 * _safeSend funnel tests (Robustness Net #1 — Slack subsystem error containment).
 *
 * Every WebSocket send in SocketModeClient routes through one private _safeSend
 * funnel: it checks the socket is OPEN, swallows a send throw so it can never
 * escape an un-awaited event listener (→ uncaughtException/unhandledRejection →
 * process crash), returns a boolean, and (liveness path only) self-heals via the
 * existing _forceReconnect. These tests pin the behavior on every readyState, the
 * per-callsite policy (queueOutbound enqueues, ack does NOT reconnect, drain
 * breaks-and-retains, liveness reconnects), the storm guard, the stale-socket
 * identity guard, and the wiring-integrity ratchet.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { SocketModeClient, type SocketModeHandlers } from '../../src/messaging/slack/SocketModeClient.js';

const socketClientPath = path.resolve(__dirname, '../../src/messaging/slack/SocketModeClient.ts');
const socketClientSource = readFileSync(socketClientPath, 'utf-8');

function makeHandlers(): SocketModeHandlers {
  return {
    onEvent: vi.fn(async () => {}),
    onInteraction: vi.fn(async () => {}),
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
    onError: vi.fn(),
  };
}

function makeClient(): SocketModeClient {
  return new SocketModeClient({} as any, makeHandlers());
}

/** Invoke the private _safeSend with whatever this.ws currently is. */
function safeSend(client: SocketModeClient, data: string, context: string, reconnect = false): boolean {
  return (client as unknown as {
    _safeSend(d: string, c: string, r?: boolean): boolean;
  })._safeSend(data, context, reconnect);
}

describe('_safeSend on each readyState', () => {
  it('OPEN → sends and returns true', () => {
    const client = makeClient();
    const send = vi.fn();
    (client as any).ws = { readyState: WebSocket.OPEN, send };
    expect(safeSend(client, 'hi', 'test')).toBe(true);
    expect(send).toHaveBeenCalledWith('hi');
  });

  it.each([
    ['CONNECTING', WebSocket.CONNECTING],
    ['CLOSING', WebSocket.CLOSING],
    ['CLOSED', WebSocket.CLOSED],
  ])('%s → no-op, returns false, never calls send, never throws, never logs', (_name, state) => {
    const client = makeClient();
    const send = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (client as any).ws = { readyState: state, send };
    expect(() => safeSend(client, 'hi', 'test')).not.toThrow();
    expect(safeSend(client, 'hi', 'test')).toBe(false);
    expect(send).not.toHaveBeenCalled();
    // The not-OPEN precheck is the EXPECTED transient state — it must not log
    // (otherwise a dead socket floods the log at message rate).
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('this.ws null → no-op, returns false, no throw', () => {
    const client = makeClient();
    (client as any).ws = null;
    expect(() => safeSend(client, 'hi', 'test')).not.toThrow();
    expect(safeSend(client, 'hi', 'test')).toBe(false);
  });
});

describe('_safeSend swallows a send throw on an OPEN socket', () => {
  it('catches the throw, logs message-only, returns false', () => {
    const client = makeClient();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi.fn(() => { throw new Error('WebSocket is not open: readyState 2'); });
    (client as any).ws = { readyState: WebSocket.OPEN, send };
    expect(safeSend(client, 'hi', 'ack')).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ack send failed'));
    // Never logs the payload itself.
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('hi'));
    warn.mockRestore();
  });

  it('does NOT reconnect when reconnectOnFailure is false (default — e.g. ack path)', () => {
    const client = makeClient();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const force = vi.spyOn(client as any, '_forceReconnect').mockImplementation(() => {});
    const send = vi.fn(() => { throw new Error('WebSocket is not open: readyState 2'); });
    (client as any).ws = { readyState: WebSocket.OPEN, send };
    (client as any).started = true;
    safeSend(client, 'hi', 'ack', false);
    expect(force).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('reconnects when reconnectOnFailure is true (liveness path)', () => {
    const client = makeClient();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const force = vi.spyOn(client as any, '_forceReconnect').mockImplementation(() => {});
    const send = vi.fn(() => { throw new Error('WebSocket is not open: readyState 2'); });
    (client as any).ws = { readyState: WebSocket.OPEN, send };
    (client as any).started = true;
    (client as any).reconnecting = false;
    safeSend(client, '{"type":"ping"}', 'liveness-probe', true);
    expect(force).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('storm guard: does NOT reconnect if already reconnecting', () => {
    const client = makeClient();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const force = vi.spyOn(client as any, '_forceReconnect').mockImplementation(() => {});
    const send = vi.fn(() => { throw new Error('WebSocket is not open: readyState 2'); });
    (client as any).ws = { readyState: WebSocket.OPEN, send };
    (client as any).started = true;
    (client as any).reconnecting = true; // a reconnect is already in flight
    safeSend(client, '{"type":"ping"}', 'liveness-probe', true);
    expect(force).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('stale-socket identity guard: does NOT reconnect if this.ws was replaced before the throw', () => {
    const client = makeClient();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const force = vi.spyOn(client as any, '_forceReconnect').mockImplementation(() => {});
    const freshSocket = { readyState: WebSocket.OPEN, send: vi.fn() };
    const dyingSocket = {
      readyState: WebSocket.OPEN,
      send: vi.fn(() => {
        // Simulate a teardown-and-replace happening between capture and throw.
        (client as any).ws = freshSocket;
        throw new Error('WebSocket is not open: readyState 2');
      }),
    };
    (client as any).ws = dyingSocket;
    (client as any).started = true;
    (client as any).reconnecting = false;
    safeSend(client, '{"type":"ping"}', 'liveness-probe', true);
    // this.ws !== sock (the socket we sent on) → must NOT tear down the fresh one.
    expect(force).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe('queueOutbound through _safeSend', () => {
  it('OPEN → sends immediately, queue stays empty', () => {
    const client = makeClient();
    const send = vi.fn();
    (client as any).ws = { readyState: WebSocket.OPEN, send };
    client.queueOutbound('msg-1');
    expect(send).toHaveBeenCalledWith('msg-1');
    expect((client as any).outboundQueue).toHaveLength(0);
  });

  it('CONNECTING → enqueues (does not drop), does not reconnect', () => {
    const client = makeClient();
    const send = vi.fn();
    const force = vi.spyOn(client as any, '_forceReconnect').mockImplementation(() => {});
    (client as any).ws = { readyState: WebSocket.CONNECTING, send };
    client.queueOutbound('msg-1');
    expect(send).not.toHaveBeenCalled();
    expect((client as any).outboundQueue.map((i: any) => i.data)).toEqual(['msg-1']);
    expect(force).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('OPEN-but-throws → enqueues for the next drain instead of dropping', () => {
    const client = makeClient();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi.fn(() => { throw new Error('WebSocket is not open: readyState 2'); });
    (client as any).ws = { readyState: WebSocket.OPEN, send };
    client.queueOutbound('msg-1');
    expect((client as any).outboundQueue.map((i: any) => i.data)).toEqual(['msg-1']);
    vi.restoreAllMocks();
  });
});

describe('_drainQueue through _safeSend (break-and-retain)', () => {
  function drain(client: SocketModeClient): void {
    (client as unknown as { _drainQueue(): void })._drainQueue();
  }

  it('all OPEN → drains everything, queue empties', () => {
    const client = makeClient();
    const send = vi.fn();
    (client as any).ws = { readyState: WebSocket.OPEN, send };
    (client as any).outboundQueue = ['a', 'b', 'c'].map((data) => ({ data, enqueuedAt: 0 }));
    drain(client);
    expect(send).toHaveBeenCalledTimes(3);
    expect((client as any).outboundQueue).toHaveLength(0);
  });

  it('fails at item k → items before k sent, item k + remainder retained, loop stops, no reconnect', () => {
    const client = makeClient();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const force = vi.spyOn(client as any, '_forceReconnect').mockImplementation(() => {});
    let calls = 0;
    const send = vi.fn(() => {
      calls++;
      if (calls === 3) throw new Error('WebSocket is not open: readyState 2'); // item index 2 fails
    });
    (client as any).ws = { readyState: WebSocket.OPEN, send };
    (client as any).started = true;
    (client as any).outboundQueue = ['a', 'b', 'c', 'd', 'e'].map((data) => ({ data, enqueuedAt: 0 }));
    drain(client);
    // items a,b sent (2 successful) + c attempted-and-threw = 3 send() calls; d,e never attempted.
    expect(send).toHaveBeenCalledTimes(3);
    // c,d,e retained for the next 'open' drain (remove-only — never dropped).
    expect((client as any).outboundQueue.map((i: any) => i.data)).toEqual(['c', 'd', 'e']);
    // Drain never triggers reconnect.
    expect(force).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('retained queue length never exceeds the original (remove-only)', () => {
    const client = makeClient();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi.fn(() => { throw new Error('WebSocket is not open: readyState 2'); }); // first item fails
    (client as any).ws = { readyState: WebSocket.OPEN, send };
    const original = ['a', 'b', 'c'].map((data) => ({ data, enqueuedAt: 0 }));
    (client as any).outboundQueue = original;
    drain(client);
    expect((client as any).outboundQueue.length).toBeLessThanOrEqual(original.length);
    expect((client as any).outboundQueue.map((i: any) => i.data)).toEqual(['a', 'b', 'c']);
    vi.restoreAllMocks();
  });
});

describe('Wiring-integrity ratchet — every raw socket send funnels through _safeSend', () => {
  /** Brace-match a method body starting at `signaturePrefix`. */
  function methodBody(source: string, signaturePrefix: string): { body: string; start: number; end: number } {
    const sigIdx = source.indexOf(signaturePrefix);
    expect(sigIdx, `expected to find ${signaturePrefix}`).toBeGreaterThan(-1);
    const open = source.indexOf('{', sigIdx);
    let depth = 0;
    let j = open;
    for (; j < source.length; j++) {
      if (source[j] === '{') depth++;
      else if (source[j] === '}') { depth--; if (depth === 0) break; }
    }
    return { body: source.slice(open, j + 1), start: open, end: j + 1 };
  }

  it('the ONLY raw socket send (sock.send / this.ws(?.)send) lives inside _safeSend', () => {
    const span = methodBody(socketClientSource, 'private _safeSend(');
    // Match every raw socket-send form, optional-chained or not.
    const re = /\b(?:this\.ws\??|sock)\.send\(/g;
    const offenders: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(socketClientSource)) !== null) {
      if (m.index < span.start || m.index >= span.end) offenders.push(m.index);
    }
    expect(
      offenders,
      `raw socket .send( found OUTSIDE _safeSend at offsets ${offenders.join(', ')} — route it through _safeSend`,
    ).toEqual([]);
  });

  it('all four logical callsites reference _safeSend', () => {
    // queueOutbound, the ack, the liveness probe, and the drain.
    expect(socketClientSource).toMatch(/queueOutbound\(data: string\): void \{[\s\S]*?this\._safeSend\(data, 'outbound'\)/);
    expect(socketClientSource).toMatch(/this\._safeSend\(JSON\.stringify\(\{ envelope_id: envelope\.envelope_id \}\), 'ack'\)/);
    expect(socketClientSource).toMatch(/this\._safeSend\('\{"type":"ping"\}', 'liveness-probe', true\)/);
    expect(socketClientSource).toMatch(/_drainQueue\(\): void \{[\s\S]*?this\._safeSend\(pending\[k\]\.data, 'drain'\)/);
  });
});

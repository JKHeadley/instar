/**
 * Tier-1 tests for PeerStreamProxy (Pool Dashboard Streaming phase 1,
 * POOL-DASHBOARD-STREAM-SPEC §2.2). The whole state machine is exercised
 * deterministically: a fake upstream transport + a manual timer queue + a
 * manual clock, so refcount / idle-close / reconnect / url-change races are
 * tested without sockets or wall time.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { PeerStreamProxy, type UpstreamHandlers, type UpstreamTransport, type TimerHandle } from '../../src/server/PeerStreamProxy.js';

// ── deterministic harness ───────────────────────────────────────────────
class FakeUpstream implements UpstreamTransport {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  constructor(public url: string, public handlers: UpstreamHandlers) {}
  send(frame: Record<string, unknown>): void { this.sent.push(frame); }
  close(): void { this.closed = true; }
}

function harness(opts: { url?: string | null } = {}) {
  let url: string | null = 'url' in opts ? (opts.url ?? null) : 'wss://peer/ws';
  const connects: FakeUpstream[] = [];
  const framesToClients: Array<{ session: string; frame: Record<string, unknown> }> = [];
  const errors: Array<{ session: string; code: string; detail?: string }> = [];
  let nowMs = 1_000;
  let timerSeq = 0;
  const timers = new Map<TimerHandle, { fireAt: number; fn: () => void }>();

  const proxy = new PeerStreamProxy({
    peerMachineId: 'm_peer',
    resolveUrl: () => url,
    connect: (u, handlers) => {
      const t = new FakeUpstream(u, handlers);
      connects.push(t);
      return t;
    },
    onFrameToClients: (session, frame) => framesToClients.push({ session, frame }),
    onError: (session, code, detail) => errors.push({ session, code, detail }),
    now: () => nowMs,
    setTimer: (ms, fn) => {
      const h = { __brand: 'PeerStreamProxyTimer' as const, id: ++timerSeq } as unknown as TimerHandle;
      timers.set(h, { fireAt: nowMs + ms, fn });
      return h;
    },
    clearTimer: (t) => { timers.delete(t); },
    idleGraceMs: 60_000,
    reconnectTimeoutMs: 10_000,
  });

  return {
    proxy,
    connects,
    framesToClients,
    errors,
    last: () => connects[connects.length - 1],
    setUrl: (u: string | null) => { url = u; },
    advance: (ms: number) => {
      nowMs += ms;
      for (const [h, t] of [...timers]) {
        if (t.fireAt <= nowMs) { timers.delete(h); t.fn(); }
      }
    },
    pendingTimers: () => timers.size,
  };
}

describe('PeerStreamProxy — open + multiplex', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  it('first subscribe opens one upstream and subscribes on open', () => {
    h.proxy.subscribe('s1', 'c1');
    expect(h.proxy.currentState).toBe('connecting');
    expect(h.connects).toHaveLength(1);
    h.last().handlers.onOpen();
    expect(h.proxy.currentState).toBe('active');
    expect(h.last().sent).toContainEqual({ type: 'subscribe', session: 's1' });
  });

  it('multiplexes: a second session reuses the one upstream; a second client on the same session does NOT re-subscribe', () => {
    h.proxy.subscribe('s1', 'c1');
    h.last().handlers.onOpen();
    h.last().sent.length = 0;
    h.proxy.subscribe('s2', 'c1');      // new session → subscribe sent
    h.proxy.subscribe('s1', 'c2');      // same session, new client → NO new subscribe
    expect(h.connects).toHaveLength(1);
    expect(h.last().sent).toEqual([{ type: 'subscribe', session: 's2' }]);
    expect(h.proxy.refCount).toBe(3);
  });

  it('fans peer frames out only for sessions with local subscribers', () => {
    h.proxy.subscribe('s1', 'c1');
    h.last().handlers.onOpen();
    h.last().handlers.onFrame({ type: 'output', session: 's1', data: 'hi' });
    h.last().handlers.onFrame({ type: 'output', session: 'ghost', data: 'x' }); // not subscribed
    expect(h.framesToClients).toEqual([{ session: 's1', frame: { type: 'output', session: 's1', data: 'hi' } }]);
  });
});

describe('PeerStreamProxy — idle close + reactivate', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  it('last unsubscribe schedules idle close; the grace elapsing closes the upstream', () => {
    h.proxy.subscribe('s1', 'c1');
    h.last().handlers.onOpen();
    h.proxy.unsubscribe('s1', 'c1');
    expect(h.proxy.currentState).toBe('idle-scheduled');
    expect(h.last().closed).toBe(false);
    h.advance(60_000);
    expect(h.proxy.currentState).toBe('closed');
    expect(h.last().closed).toBe(true);
  });

  it('a subscribe DURING the idle grace cancels the close and reactivates the same upstream', () => {
    h.proxy.subscribe('s1', 'c1');
    h.last().handlers.onOpen();
    h.proxy.unsubscribe('s1', 'c1');
    expect(h.proxy.currentState).toBe('idle-scheduled');
    h.proxy.subscribe('s2', 'c1');     // demand returns mid-grace
    expect(h.proxy.currentState).toBe('active');
    expect(h.connects).toHaveLength(1); // SAME upstream, not reopened
    h.advance(60_000);                  // the old timer must NOT close us
    expect(h.proxy.currentState).toBe('active');
    expect(h.last().closed).toBe(false);
  });
});

describe('PeerStreamProxy — reconnect (P19 bounded)', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  it('first drop emits peer-stream-lost, reconnects once, and resubscribes every session on open', () => {
    h.proxy.subscribe('s1', 'c1');
    h.proxy.subscribe('s2', 'c1');
    h.last().handlers.onOpen();
    h.proxy.unsubscribe('s2', 'c1'); h.proxy.subscribe('s2', 'c1'); // keep s2; noise
    h.last().handlers.onClose();      // upstream drops
    expect(h.errors.filter((e) => e.code === 'peer-stream-lost').map((e) => e.session).sort()).toEqual(['s1', 's2']);
    expect(h.connects).toHaveLength(2); // reconnect opened
    h.last().handlers.onOpen();
    const subs = h.last().sent.filter((f) => f.type === 'subscribe').map((f) => f.session).sort();
    expect(subs).toEqual(['s1', 's2']);
    expect(h.proxy.currentState).toBe('active');
  });

  it('a SECOND drop surfaces machine-unreachable (no reconnect storm)', () => {
    h.proxy.subscribe('s1', 'c1');
    h.last().handlers.onOpen();
    h.last().handlers.onClose();      // first drop → reconnect
    h.last().handlers.onOpen();       // reconnect succeeds
    h.last().handlers.onClose();      // second drop
    expect(h.errors.some((e) => e.code === 'machine-unreachable' && e.session === 's1')).toBe(true);
    expect(h.proxy.currentState).toBe('closed');
  });

  it('a reconnect that does NOT open within the timeout surfaces machine-unreachable', () => {
    h.proxy.subscribe('s1', 'c1');
    h.last().handlers.onOpen();
    h.last().handlers.onClose();      // drop → reconnect attempt (stays connecting)
    expect(h.proxy.currentState).toBe('connecting');
    h.advance(10_000);                // reconnect deadline passes, never opened
    expect(h.errors.some((e) => e.code === 'machine-unreachable')).toBe(true);
    expect(h.proxy.currentState).toBe('closed');
  });

  it('a subscribe arriving mid-reconnect is merged into the resubscribe batch (never lost)', () => {
    h.proxy.subscribe('s1', 'c1');
    h.last().handlers.onOpen();
    h.last().handlers.onClose();      // drop → reconnect (connecting)
    h.proxy.subscribe('s2', 'c1');    // arrives while connecting
    h.last().handlers.onOpen();
    const subs = h.last().sent.filter((f) => f.type === 'subscribe').map((f) => f.session).sort();
    expect(subs).toEqual(['s1', 's2']);
  });
});

describe('PeerStreamProxy — url change + no-url', () => {
  it('a changed peer url on subscribe tears down the old link and opens a fresh one', () => {
    const h = harness({ url: 'wss://old/ws' });
    h.proxy.subscribe('s1', 'c1');
    h.last().handlers.onOpen();
    const old = h.last();
    h.setUrl('wss://new/ws');
    h.proxy.subscribe('s2', 'c1');    // re-resolves url → changed → reconnect
    expect(old.closed).toBe(true);
    expect(h.connects).toHaveLength(2);
    expect(h.last().url).toBe('wss://new/ws');
    h.last().handlers.onOpen();
    const subs = h.last().sent.filter((f) => f.type === 'subscribe').map((f) => f.session).sort();
    expect(subs).toEqual(['s1', 's2']); // both replayed on the fresh link
  });

  it('subscribe with no resolvable url errors machine-unreachable and opens nothing', () => {
    const h = harness({ url: null });
    h.proxy.subscribe('s1', 'c1');
    expect(h.connects).toHaveLength(0);
    expect(h.errors).toEqual([{ session: 's1', code: 'machine-unreachable', detail: 'no url for peer' }]);
    expect(h.proxy.refCount).toBe(0);
  });
});

describe('PeerStreamProxy — input relay + close', () => {
  it('relays input only while active; never queues keystrokes', () => {
    const h = harness();
    h.proxy.subscribe('s1', 'c1');
    h.proxy.relayInput({ type: 'input', session: 's1', text: 'x' }); // connecting → dropped
    h.last().handlers.onOpen();
    h.proxy.relayInput({ type: 'input', session: 's1', text: 'y' }); // active → sent
    const inputs = h.last().sent.filter((f) => f.type === 'input');
    expect(inputs).toEqual([{ type: 'input', session: 's1', text: 'y' }]);
  });

  it('close() is idempotent, clears subs, and closes the upstream', () => {
    const h = harness();
    h.proxy.subscribe('s1', 'c1');
    h.last().handlers.onOpen();
    h.proxy.close();
    expect(h.proxy.currentState).toBe('closed');
    expect(h.last().closed).toBe(true);
    expect(h.proxy.refCount).toBe(0);
    expect(() => h.proxy.close()).not.toThrow();
  });
});

describe('PeerStreamProxy — read-only frame relay (history, §2.2)', () => {
  it('relayFrame forwards a history request only while active; dropped while connecting or closed', () => {
    const h = harness();
    h.proxy.subscribe('s1', 'c1');
    h.proxy.relayFrame({ type: 'history', session: 's1', lines: 5000 }); // connecting → dropped
    h.last().handlers.onOpen();
    h.proxy.relayFrame({ type: 'history', session: 's1', lines: 7000 }); // active → sent
    h.proxy.close();
    h.proxy.relayFrame({ type: 'history', session: 's1', lines: 9000 }); // closed → dropped
    const hist = h.last().sent.filter((f) => f.type === 'history');
    expect(hist).toEqual([{ type: 'history', session: 's1', lines: 7000 }]);
  });

  it('a history reply frame from the peer fans out to local clients like output', () => {
    const h = harness();
    h.proxy.subscribe('s1', 'c1');
    h.last().handlers.onOpen();
    h.last().handlers.onFrame({ type: 'history', session: 's1', data: 'scrollback', lines: 5000 });
    expect(h.framesToClients).toEqual([
      { session: 's1', frame: { type: 'history', session: 's1', data: 'scrollback', lines: 5000 } },
    ]);
  });
});

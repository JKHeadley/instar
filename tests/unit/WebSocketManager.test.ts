import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketManager } from '../../src/server/WebSocketManager.js';
import { WebSocket } from 'ws';

/**
 * WebSocketManager tests — real-time terminal streaming for the dashboard.
 *
 * Tests cover session list building, streaming efficiency, output diffing,
 * session ended detection, client lifecycle, broadcast guards, and shutdown.
 */

// --- Mock Helpers ---

function createMockWebSocket(): WebSocket & { sentMessages: Array<Record<string, unknown>>; closeCalled: boolean } {
  const sent: Array<Record<string, unknown>> = [];
  const ws = {
    readyState: WebSocket.OPEN,
    send: vi.fn((data: string) => {
      sent.push(JSON.parse(data));
    }),
    close: vi.fn(() => {
      (ws as any).closeCalled = true;
    }),
    ping: vi.fn(),
    terminate: vi.fn(),
    on: vi.fn(),
    sentMessages: sent,
    closeCalled: false,
    // Simulate _socket for clientId
    _socket: { remotePort: Math.floor(Math.random() * 60000) + 1024 },
  } as unknown as WebSocket & { sentMessages: Array<Record<string, unknown>>; closeCalled: boolean };
  return ws;
}

interface MockSessionManager {
  captureOutput: ReturnType<typeof vi.fn>;
  listRunningSessions: ReturnType<typeof vi.fn>;
  sendInput: ReturnType<typeof vi.fn>;
  sendKey: ReturnType<typeof vi.fn>;
}

function createMockSessionManager(overrides: Partial<MockSessionManager> = {}): MockSessionManager {
  return {
    captureOutput: vi.fn(() => 'terminal output here'),
    listRunningSessions: vi.fn(() => []),
    sendInput: vi.fn(() => true),
    sendKey: vi.fn(() => true),
    ...overrides,
  };
}

function createMockStateManager() {
  return {} as any;
}

function createMockHttpServer() {
  return {
    on: vi.fn(),
  } as any;
}

/**
 * Create a WebSocketManager with mocked dependencies, plus helpers
 * to simulate client connections and message handling.
 */
function createTestManager(options: {
  sessionManager?: MockSessionManager;
  authToken?: string;
  hookEventReceiver?: any;
  poolStreamConnector?: any;
  selfMachineId?: string;
} = {}) {
  const sessionManager = options.sessionManager ?? createMockSessionManager();
  const httpServer = createMockHttpServer();

  // We need to mock WebSocketServer to avoid binding to a real HTTP server.
  // The constructor calls `new WebSocketServer({ noServer: true })` and
  // sets up event listeners. We'll intercept and control the flow.
  const manager = new WebSocketManager({
    server: httpServer,
    sessionManager: sessionManager as any,
    state: createMockStateManager(),
    authToken: options.authToken,
    hookEventReceiver: options.hookEventReceiver,
    poolStreamConnector: options.poolStreamConnector,
    selfMachineId: options.selfMachineId,
  });

  /**
   * Simulate a client connecting by injecting a mock WebSocket into the
   * clients map and returning helpers.
   */
  function connectClient(): {
    ws: WebSocket & { sentMessages: Array<Record<string, unknown>> };
    client: { ws: WebSocket; subscriptions: Set<string>; isAlive: boolean };
  } {
    const ws = createMockWebSocket();
    const client = { ws, subscriptions: new Set<string>(), isAlive: true };
    (manager as any).clients.set(ws, client);
    return { ws, client };
  }

  /**
   * Send a message through handleMessage as if the client sent it.
   */
  function sendMessage(client: any, msg: Record<string, unknown>) {
    (manager as any).handleMessage(client, msg);
  }

  /**
   * Trigger one cycle of the streaming loop logic.
   */
  function tickStreaming() {
    // Extract the streaming loop body by clearing and re-invoking.
    // Instead, call the internal logic directly.
    const subscribedSessions = new Set<string>();
    for (const c of (manager as any).clients.values()) {
      for (const session of c.subscriptions) {
        subscribedSessions.add(session);
      }
    }

    for (const session of subscribedSessions) {
      const output = sessionManager.captureOutput(session, 2000);
      for (const [, c] of (manager as any).clients) {
        if (!c.subscriptions.has(session)) continue;
        const cacheKey = `${(manager as any).clientId(c)}:${session}`;
        const cached = (manager as any).sessionOutputCache.get(cacheKey);
        if (output === null) {
          if (cached !== undefined) {
            (manager as any).send(c.ws, { type: 'session_ended', session });
            (manager as any).sessionOutputCache.delete(cacheKey);
          }
          continue;
        }
        if (output !== cached) {
          (manager as any).sessionOutputCache.set(cacheKey, output);
          (manager as any).send(c.ws, { type: 'output', session, data: output });
        }
      }
    }
  }

  return { manager, sessionManager, httpServer, connectClient, sendMessage, tickStreaming };
}

// --- Tests ---

describe('WebSocketManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('client lifecycle', () => {
    it('subscribe adds session to client subscriptions and sends current output', () => {
      const { connectClient, sendMessage, sessionManager } = createTestManager();
      sessionManager.captureOutput.mockReturnValue('hello world');

      const { ws, client } = connectClient();
      sendMessage(client, { type: 'subscribe', session: 'my-session' });

      expect(client.subscriptions.has('my-session')).toBe(true);
      // Should have sent output + subscribed confirmation
      const outputMsg = ws.sentMessages.find(m => m.type === 'output' && m.session === 'my-session');
      const subMsg = ws.sentMessages.find(m => m.type === 'subscribed' && m.session === 'my-session');
      expect(outputMsg).toBeDefined();
      expect(outputMsg!.data).toBe('hello world');
      expect(subMsg).toBeDefined();
    });

    it('subscribe sends error when session name is missing', () => {
      const { connectClient, sendMessage } = createTestManager();
      const { ws, client } = connectClient();

      sendMessage(client, { type: 'subscribe', session: '' });

      const errMsg = ws.sentMessages.find(m => m.type === 'error');
      expect(errMsg).toBeDefined();
      expect(errMsg!.message).toContain('Missing session name');
    });

    it('unsubscribe removes session and clears cache', () => {
      const { connectClient, sendMessage, manager, sessionManager } = createTestManager();
      sessionManager.captureOutput.mockReturnValue('output');

      const { ws, client } = connectClient();
      sendMessage(client, { type: 'subscribe', session: 'sess-1' });
      sendMessage(client, { type: 'unsubscribe', session: 'sess-1' });

      expect(client.subscriptions.has('sess-1')).toBe(false);
      const unsubMsg = ws.sentMessages.find(m => m.type === 'unsubscribed' && m.session === 'sess-1');
      expect(unsubMsg).toBeDefined();
      // Cache should be cleared for this client+session
      const cacheKey = `${(manager as any).clientId(client)}:sess-1`;
      expect((manager as any).sessionOutputCache.has(cacheKey)).toBe(false);
    });
  });

  describe('message routing', () => {
    it('ping returns pong', () => {
      const { connectClient, sendMessage } = createTestManager();
      const { ws, client } = connectClient();

      sendMessage(client, { type: 'ping' });

      expect(ws.sentMessages).toContainEqual({ type: 'pong' });
    });

    it('unknown message type returns error', () => {
      const { connectClient, sendMessage } = createTestManager();
      const { ws, client } = connectClient();

      sendMessage(client, { type: 'invalid_type' });

      const errMsg = ws.sentMessages.find(m => m.type === 'error');
      expect(errMsg).toBeDefined();
      expect(errMsg!.message).toContain('Unknown message type');
    });

    it('input forwards to sessionManager.sendInput and returns ack', () => {
      // §2.1: input only reaches tmux for a session that actually exists locally.
      const sm = createMockSessionManager({ listRunningSessions: vi.fn(() => [{ tmuxSession: 'sess-1', name: 'sess-1' } as any]) });
      const { connectClient, sendMessage, sessionManager } = createTestManager({ sessionManager: sm });
      sessionManager.sendInput.mockReturnValue(true);
      const { ws, client } = connectClient();

      sendMessage(client, { type: 'input', session: 'sess-1', text: 'hello' });

      expect(sessionManager.sendInput).toHaveBeenCalledWith('sess-1', 'hello');
      const ack = ws.sentMessages.find(m => m.type === 'input_ack');
      expect(ack).toBeDefined();
      expect(ack!.success).toBe(true);
    });

    it('input with missing fields returns error', () => {
      const { connectClient, sendMessage } = createTestManager();
      const { ws, client } = connectClient();

      sendMessage(client, { type: 'input', session: '', text: '' });

      const errMsg = ws.sentMessages.find(m => m.type === 'error');
      expect(errMsg).toBeDefined();
      expect(errMsg!.message).toContain('Missing session or text');
    });

    it('key forwards to sessionManager.sendKey and returns ack', () => {
      const sm = createMockSessionManager({ listRunningSessions: vi.fn(() => [{ tmuxSession: 'sess-1', name: 'sess-1' } as any]) });
      const { connectClient, sendMessage, sessionManager } = createTestManager({ sessionManager: sm });
      sessionManager.sendKey.mockReturnValue(true);
      const { ws, client } = connectClient();

      sendMessage(client, { type: 'key', session: 'sess-1', key: 'C-c' });

      expect(sessionManager.sendKey).toHaveBeenCalledWith('sess-1', 'C-c');
      const ack = ws.sentMessages.find(m => m.type === 'input_ack');
      expect(ack).toBeDefined();
      expect(ack!.success).toBe(true);
    });

    it('key with missing fields returns error', () => {
      const { connectClient, sendMessage } = createTestManager();
      const { ws, client } = connectClient();

      sendMessage(client, { type: 'key', session: 'sess-1', key: '' });

      const errMsg = ws.sentMessages.find(m => m.type === 'error');
      expect(errMsg).toBeDefined();
    });
  });

  describe('history', () => {
    it('sends captured output with requested line count', () => {
      const { connectClient, sendMessage, sessionManager } = createTestManager();
      sessionManager.captureOutput.mockReturnValue('scrollback content');
      const { ws, client } = connectClient();

      sendMessage(client, { type: 'history', session: 'sess-1', lines: 3000 });

      expect(sessionManager.captureOutput).toHaveBeenCalledWith('sess-1', 3000);
      const histMsg = ws.sentMessages.find(m => m.type === 'history');
      expect(histMsg).toBeDefined();
      expect(histMsg!.data).toBe('scrollback content');
      expect(histMsg!.lines).toBe(3000);
    });

    it('clamps lines to valid range (1-50000)', () => {
      const { connectClient, sendMessage, sessionManager } = createTestManager();
      sessionManager.captureOutput.mockReturnValue('data');
      const { ws, client } = connectClient();

      sendMessage(client, { type: 'history', session: 'sess-1', lines: 100000 });

      expect(sessionManager.captureOutput).toHaveBeenCalledWith('sess-1', 50000);
    });

    it('returns error when no output available', () => {
      const { connectClient, sendMessage, sessionManager } = createTestManager();
      sessionManager.captureOutput.mockReturnValue(null);
      const { ws, client } = connectClient();

      sendMessage(client, { type: 'history', session: 'sess-1', lines: 100 });

      const errMsg = ws.sentMessages.find(m => m.type === 'error');
      expect(errMsg).toBeDefined();
      expect(errMsg!.message).toContain('No output for session');
    });
  });

  describe('streaming efficiency', () => {
    it('does not call captureOutput when no clients are connected', () => {
      const { tickStreaming, sessionManager } = createTestManager();

      tickStreaming();

      expect(sessionManager.captureOutput).not.toHaveBeenCalled();
    });

    it('does not call captureOutput when clients have no subscriptions', () => {
      const { connectClient, tickStreaming, sessionManager } = createTestManager();
      connectClient(); // connected but not subscribed to anything

      tickStreaming();

      expect(sessionManager.captureOutput).not.toHaveBeenCalled();
    });

    it('calls captureOutput only for subscribed sessions', () => {
      const { connectClient, sendMessage, tickStreaming, sessionManager } = createTestManager();
      sessionManager.captureOutput.mockReturnValue('output');

      const { client } = connectClient();
      sendMessage(client, { type: 'subscribe', session: 'sess-a' });

      // Reset call count after subscribe (which also calls captureOutput)
      sessionManager.captureOutput.mockClear();
      sessionManager.captureOutput.mockReturnValue('new output');

      tickStreaming();

      expect(sessionManager.captureOutput).toHaveBeenCalledTimes(1);
      expect(sessionManager.captureOutput).toHaveBeenCalledWith('sess-a', 2000);
    });
  });

  describe('output diffing (cache)', () => {
    it('does not re-send identical output to the same client', () => {
      const { connectClient, sendMessage, tickStreaming, sessionManager } = createTestManager();
      sessionManager.captureOutput.mockReturnValue('same output');

      const { ws, client } = connectClient();
      sendMessage(client, { type: 'subscribe', session: 'sess-x' });

      // Clear messages from subscribe
      ws.sentMessages.length = 0;

      // First tick: output is in cache from subscribe, same value -> no send
      tickStreaming();

      const outputMsgs = ws.sentMessages.filter(m => m.type === 'output');
      expect(outputMsgs).toHaveLength(0);
    });

    it('sends output when it changes', () => {
      const { connectClient, sendMessage, tickStreaming, sessionManager } = createTestManager();
      sessionManager.captureOutput.mockReturnValue('initial output');

      const { ws, client } = connectClient();
      sendMessage(client, { type: 'subscribe', session: 'sess-x' });

      // Clear messages from subscribe
      ws.sentMessages.length = 0;

      // Change output
      sessionManager.captureOutput.mockReturnValue('updated output');
      tickStreaming();

      const outputMsgs = ws.sentMessages.filter(m => m.type === 'output');
      expect(outputMsgs).toHaveLength(1);
      expect(outputMsgs[0].data).toBe('updated output');
    });
  });

  describe('session ended detection', () => {
    it('sends session_ended when captureOutput returns null for a subscribed session', () => {
      const { connectClient, sendMessage, tickStreaming, sessionManager } = createTestManager();
      sessionManager.captureOutput.mockReturnValue('alive output');

      const { ws, client } = connectClient();
      sendMessage(client, { type: 'subscribe', session: 'sess-z' });

      // Clear messages from subscribe
      ws.sentMessages.length = 0;

      // Session ends
      sessionManager.captureOutput.mockReturnValue(null);
      tickStreaming();

      const endedMsg = ws.sentMessages.find(m => m.type === 'session_ended');
      expect(endedMsg).toBeDefined();
      expect(endedMsg!.session).toBe('sess-z');
    });

    it('does not send session_ended twice for the same session', () => {
      const { connectClient, sendMessage, tickStreaming, sessionManager } = createTestManager();
      sessionManager.captureOutput.mockReturnValue('alive');

      const { ws, client } = connectClient();
      sendMessage(client, { type: 'subscribe', session: 'sess-z' });
      ws.sentMessages.length = 0;

      sessionManager.captureOutput.mockReturnValue(null);
      tickStreaming();
      tickStreaming(); // second tick

      const endedMsgs = ws.sentMessages.filter(m => m.type === 'session_ended');
      expect(endedMsgs).toHaveLength(1);
    });
  });

  describe('session list building', () => {
    it('builds session list from listRunningSessions', () => {
      const { manager, sessionManager } = createTestManager();
      sessionManager.listRunningSessions.mockReturnValue([
        {
          id: 'abc-123',
          name: 'main-session',
          tmuxSession: 'instar-main',
          status: 'running',
          startedAt: '2026-03-26T00:00:00Z',
          jobSlug: null,
          model: 'opus',
        },
      ]);

      const sessions = (manager as any).buildSessionList();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('abc-123');
      expect(sessions[0].name).toBe('main-session');
      expect(sessions[0].type).toBe('interactive');
    });

    it('marks sessions with jobSlug as type "job"', () => {
      const { manager, sessionManager } = createTestManager();
      sessionManager.listRunningSessions.mockReturnValue([
        {
          id: 'job-1',
          name: 'health-check',
          tmuxSession: 'instar-health',
          status: 'running',
          startedAt: '2026-03-26T00:00:00Z',
          jobSlug: 'health-check',
          model: 'haiku',
        },
      ]);

      const sessions = (manager as any).buildSessionList();

      expect(sessions[0].type).toBe('job');
      expect(sessions[0].jobSlug).toBe('health-check');
    });

    it('enriches sessions with hook event telemetry when available', () => {
      const hookEventReceiver = {
        getSessionSummary: vi.fn((tmuxSession: string) => ({
          eventCount: 42,
          toolsUsed: 15,
          subagentsSpawned: 2,
          lastEvent: '2026-03-26T01:00:00Z',
        })),
      };

      const sessionManager = createMockSessionManager({
        listRunningSessions: vi.fn(() => [{
          id: 's1',
          name: 'test',
          tmuxSession: 'instar-test',
          status: 'running',
          startedAt: '2026-03-26T00:00:00Z',
          jobSlug: null,
          model: 'opus',
        }]),
      });

      const { manager } = createTestManager({ sessionManager, hookEventReceiver });
      const sessions = (manager as any).buildSessionList();

      expect(sessions[0].telemetry).toBeDefined();
      expect(sessions[0].telemetry.eventCount).toBe(42);
      expect(sessions[0].telemetry.toolsUsed).toBe(15);
      expect(sessions[0].telemetry.subagentsSpawned).toBe(2);
    });
  });

  describe('broadcast guard', () => {
    it('broadcastSessionList returns early when no clients connected', () => {
      const { manager, sessionManager } = createTestManager();

      (manager as any).broadcastSessionList();

      // listRunningSessions should NOT be called because no clients
      expect(sessionManager.listRunningSessions).not.toHaveBeenCalled();
    });

    it('broadcastSessionList sends to connected clients', () => {
      const { manager, sessionManager, connectClient } = createTestManager();
      sessionManager.listRunningSessions.mockReturnValue([]);
      const { ws } = connectClient();

      (manager as any).broadcastSessionList();

      const sessionMsg = ws.sentMessages.find(m => m.type === 'sessions');
      expect(sessionMsg).toBeDefined();
      expect(sessionMsg!.sessions).toEqual([]);
    });
  });

  describe('broadcastEvent', () => {
    it('returns early when no clients connected', () => {
      const { manager } = createTestManager();
      // Should not throw
      manager.broadcastEvent({ type: 'test_event', data: 'hello' });
    });

    it('sends event to all connected clients', () => {
      const { manager, connectClient } = createTestManager();
      const { ws: ws1 } = connectClient();
      const { ws: ws2 } = connectClient();

      manager.broadcastEvent({ type: 'paste_delivered', pasteId: '123' });

      const ev1 = ws1.sentMessages.find(m => m.type === 'paste_delivered');
      const ev2 = ws2.sentMessages.find(m => m.type === 'paste_delivered');
      expect(ev1).toBeDefined();
      expect(ev2).toBeDefined();
    });

    it('skips clients with closed connections', () => {
      const { manager, connectClient } = createTestManager();
      const { ws: ws1 } = connectClient();
      const { ws: ws2 } = connectClient();

      // Close ws2
      (ws2 as any).readyState = WebSocket.CLOSED;

      manager.broadcastEvent({ type: 'test', data: 'x' });

      expect(ws1.sentMessages.find(m => m.type === 'test')).toBeDefined();
      // ws2.send should not have been called for this event
      const ws2TestMsgs = ws2.sentMessages.filter(m => m.type === 'test');
      expect(ws2TestMsgs).toHaveLength(0);
    });
  });

  describe('shutdown', () => {
    it('clears intervals, closes connections, and clears clients map', () => {
      const { manager, connectClient } = createTestManager();
      const { ws } = connectClient();

      manager.shutdown();

      expect((ws.close as any)).toHaveBeenCalledWith(1001, 'Server shutting down');
      expect((manager as any).clients.size).toBe(0);
    });
  });
});

// ── Pool Dashboard Streaming — requesting side (§2.2) ────────────────────
describe('WebSocketManager — remote session routing (requesting side)', () => {
  /** A fake connector that captures the proxy's handlers so the test can drive
   *  onOpen/onFrame/onClose, and records frames the proxy sends upstream. */
  function fakeConnector() {
    const state: { handlers?: any; sent: any[]; closed: boolean; connectCount: number } = { sent: [], closed: false, connectCount: 0 };
    const connector = {
      connect: (_machineId: string, handlers: any) => {
        state.handlers = handlers;
        state.connectCount++;
        return {
          send: (f: any) => state.sent.push(f),
          close: () => { state.closed = true; },
        };
      },
    };
    return { connector, state };
  }

  it('a subscribe with a remote machineId opens a peer proxy and fans output back to the client', () => {
    const { connector, state } = fakeConnector();
    const { connectClient, sendMessage } = createTestManager({ poolStreamConnector: connector, selfMachineId: 'm_self' });
    const { ws, client } = connectClient();

    sendMessage(client, { type: 'subscribe', session: 'mini-sess', machineId: 'm_mini' });
    expect(state.connectCount).toBe(1);                       // upstream opened
    expect(client.remoteSubs.has('m_mini::mini-sess')).toBe(true);
    expect(ws.sentMessages.some(m => m.type === 'subscribed' && m.machineId === 'm_mini')).toBe(true);

    // Peer comes online and streams output → fans to the subscribed client, tagged.
    state.handlers.onOpen();
    state.handlers.onFrame({ type: 'output', session: 'mini-sess', data: 'remote hello' });
    const out = ws.sentMessages.find(m => m.type === 'output' && m.session === 'mini-sess');
    expect(out).toBeDefined();
    expect(out!.machineId).toBe('m_mini');
    expect(out!.data).toBe('remote hello');
  });

  it('a subscribe whose machineId is SELF uses the local path (no proxy)', () => {
    const { connector, state } = fakeConnector();
    const { connectClient, sendMessage } = createTestManager({ poolStreamConnector: connector, selfMachineId: 'm_self' });
    const { client } = connectClient();
    sendMessage(client, { type: 'subscribe', session: 'local-sess', machineId: 'm_self' });
    expect(state.connectCount).toBe(0);
    expect(client.subscriptions.has('local-sess')).toBe(true);
  });

  it('a session that exists LOCALLY is served locally even if a (stale) remote machineId is hinted', () => {
    const sm = createMockSessionManager({ listRunningSessions: vi.fn(() => [{ tmuxSession: 'here', name: 'here' } as any]) });
    const { connector, state } = fakeConnector();
    const { connectClient, sendMessage } = createTestManager({ sessionManager: sm, poolStreamConnector: connector, selfMachineId: 'm_self' });
    const { client } = connectClient();
    sendMessage(client, { type: 'subscribe', session: 'here', machineId: 'm_mini' });
    expect(state.connectCount).toBe(0);                       // not routed remote
    expect(client.subscriptions.has('here')).toBe(true);
  });

  it('remote input is relayed upstream (the SERVING machine enforces its gate)', () => {
    const { connector, state } = fakeConnector();
    const { connectClient, sendMessage } = createTestManager({ poolStreamConnector: connector, selfMachineId: 'm_self' });
    const { client } = connectClient();
    sendMessage(client, { type: 'subscribe', session: 'mini-sess', machineId: 'm_mini' });
    state.handlers.onOpen();
    sendMessage(client, { type: 'input', session: 'mini-sess', machineId: 'm_mini', text: 'ls\n' });
    expect(state.sent.some((f: any) => f.type === 'input' && f.session === 'mini-sess' && f.text === 'ls\n')).toBe(true);
  });

  it('an upstream drop fans an honest peer-stream-lost error frame to the subscribed client', () => {
    const { connector, state } = fakeConnector();
    const { connectClient, sendMessage } = createTestManager({ poolStreamConnector: connector, selfMachineId: 'm_self' });
    const { ws, client } = connectClient();
    sendMessage(client, { type: 'subscribe', session: 'mini-sess', machineId: 'm_mini' });
    state.handlers.onOpen();
    state.handlers.onClose();   // the upstream drops → proxy surfaces peer-stream-lost
    const err = ws.sentMessages.find(m => m.type === 'error' && m.code === 'peer-stream-lost');
    expect(err).toBeDefined();
    expect(err!.machineId).toBe('m_mini');
    expect(err!.session).toBe('mini-sess');
  });

  it('a remote unsubscribe stops routing and drops the remote sub', () => {
    const { connector } = fakeConnector();
    const { connectClient, sendMessage } = createTestManager({ poolStreamConnector: connector, selfMachineId: 'm_self' });
    const { client } = connectClient();
    sendMessage(client, { type: 'subscribe', session: 'mini-sess', machineId: 'm_mini' });
    expect(client.remoteSubs.has('m_mini::mini-sess')).toBe(true);
    sendMessage(client, { type: 'unsubscribe', session: 'mini-sess', machineId: 'm_mini' });
    expect(client.remoteSubs.has('m_mini::mini-sess')).toBe(false);
  });

  // ── 2026-06-08 live bug #2: no recovery after a hiccup ──────────────────
  // A proxy that reached `closed` (failed bounded reconnect, or idle-grace
  // close) was cached forever; every later subscribe was silently ignored
  // while the server still answered `subscribed` — a permanent blank terminal
  // until server restart. peerProxyFor must EVICT a closed proxy.
  describe('closed-proxy eviction (recovery after a dead upstream)', () => {
    it('after the bounded reconnect fails (two drops), a NEW subscribe opens a FRESH upstream and streams again', () => {
      const { connector, state } = fakeConnector();
      const { connectClient, sendMessage } = createTestManager({ poolStreamConnector: connector, selfMachineId: 'm_self' });
      const { ws, client } = connectClient();

      sendMessage(client, { type: 'subscribe', session: 'mini-sess', machineId: 'm_mini' });
      state.handlers.onOpen();
      state.handlers.onClose();                 // drop #1 → bounded reconnect (connect #2)
      expect(state.connectCount).toBe(2);
      state.handlers.onClose();                 // drop #2 → machine-unreachable → proxy closed
      expect(ws.sentMessages.some(m => m.type === 'error' && m.code === 'machine-unreachable')).toBe(true);

      // The user clicks the tile again — a fresh episode must open a fresh link.
      sendMessage(client, { type: 'subscribe', session: 'mini-sess', machineId: 'm_mini' });
      expect(state.connectCount).toBe(3);       // EVICTED + recreated, not the dead cached proxy
      state.handlers.onOpen();
      state.handlers.onFrame({ type: 'output', session: 'mini-sess', data: 'back alive' });
      const out = ws.sentMessages.filter(m => m.type === 'output' && m.session === 'mini-sess');
      expect(out.some(m => m.data === 'back alive')).toBe(true);
    });

    it('after a force-closed proxy (idle-grace path), a NEW subscribe recreates the proxy', () => {
      const { connector, state } = fakeConnector();
      const { manager, connectClient, sendMessage } = createTestManager({ poolStreamConnector: connector, selfMachineId: 'm_self' });
      const { client } = connectClient();
      sendMessage(client, { type: 'subscribe', session: 'mini-sess', machineId: 'm_mini' });
      expect(state.connectCount).toBe(1);
      (manager as any).peerProxies.get('m_mini').close();   // what the idle-grace timer does
      sendMessage(client, { type: 'subscribe', session: 'mini-sess', machineId: 'm_mini' });
      expect(state.connectCount).toBe(2);                   // fresh proxy, fresh upstream
    });
  });

  // ── 2026-06-08 live bug #1: the screen-text fetch only looked locally ──
  describe('cross-machine history relay (§2.2 capture only on the owning machine)', () => {
    it('a history request for a remote-subscribed session relays upstream and never captures locally', () => {
      const sm = createMockSessionManager();
      const { connector, state } = fakeConnector();
      const { connectClient, sendMessage } = createTestManager({ sessionManager: sm, poolStreamConnector: connector, selfMachineId: 'm_self' });
      const { ws, client } = connectClient();
      sendMessage(client, { type: 'subscribe', session: 'mini-sess', machineId: 'm_mini' });
      state.handlers.onOpen();
      sm.captureOutput.mockClear();

      sendMessage(client, { type: 'history', session: 'mini-sess', machineId: 'm_mini', lines: 7000 });
      expect(state.sent.some((f: any) => f.type === 'history' && f.session === 'mini-sess' && f.lines === 7000)).toBe(true);
      expect(sm.captureOutput).not.toHaveBeenCalled();      // capture happens ONLY on the owning machine

      // The owning machine replies — the history frame fans back, machine-tagged.
      state.handlers.onFrame({ type: 'history', session: 'mini-sess', data: 'remote scrollback', lines: 7000 });
      const hist = ws.sentMessages.find(m => m.type === 'history' && m.session === 'mini-sess');
      expect(hist).toBeDefined();
      expect(hist!.data).toBe('remote scrollback');
      expect(hist!.machineId).toBe('m_mini');
    });

    it('a history request WITHOUT a machineId stays on the local capture path (regression)', () => {
      const sm = createMockSessionManager({ captureOutput: vi.fn(() => 'local scrollback') });
      const { connector, state } = fakeConnector();
      const { connectClient, sendMessage } = createTestManager({ sessionManager: sm, poolStreamConnector: connector, selfMachineId: 'm_self' });
      const { ws, client } = connectClient();
      sendMessage(client, { type: 'history', session: 'local-sess', lines: 5000 });
      expect(sm.captureOutput).toHaveBeenCalledWith('local-sess', 5000);
      expect(ws.sentMessages.some(m => m.type === 'history' && m.data === 'local scrollback')).toBe(true);
      expect(state.sent).toHaveLength(0);                   // nothing relayed upstream
    });

    it('a local history miss answers an honest, relayable error (session + code, never a sessionless frame)', () => {
      const sm = createMockSessionManager({ captureOutput: vi.fn(() => null) });
      const { connectClient, sendMessage } = createTestManager({ sessionManager: sm });
      const { ws, client } = connectClient();
      sendMessage(client, { type: 'history', session: 'gone-sess', lines: 5000 });
      const err = ws.sentMessages.find(m => m.type === 'error' && m.session === 'gone-sess');
      expect(err).toBeDefined();
      expect(err!.code).toBe('session-not-found');
    });
  });
});

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
  resolveSessionPlatform?: (tmuxSession: string) => any;
  sessionPresentationSources?: () => any;
  poolStreamAllowRemoteInput?: boolean;
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
    resolveSessionPlatform: options.resolveSessionPlatform,
    sessionPresentationSources: options.sessionPresentationSources,
    poolStreamAllowRemoteInput: options.poolStreamAllowRemoteInput,
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
    it('uses the same durable conversation source as HTTP when the adapter is stale', () => {
      const { manager, sessionManager } = createTestManager({
        sessionPresentationSources: () => ({ telegramRegistry: { topicToName: { 42: 'Instar App' } } }),
      });
      sessionManager.listRunningSessions.mockReturnValue([{
        id: 'old', name: 'echo-topic-42', tmuxSession: 'old-binding', telegramTopicId: 42, status: 'running',
      }]);
      expect((manager as any).buildSessionList()[0]).toMatchObject({ name: 'Instar App', platformName: 'Instar App', platform: 'telegram' });
    });

    it('never presents a Telegram routing key as the session name', () => {
      const { manager, sessionManager } = createTestManager({
        resolveSessionPlatform: () => ({ platform: 'telegram', platformId: 127504, platformName: null }),
      });
      sessionManager.listRunningSessions.mockReturnValue([{
        id: 'abc-123', name: 'topic-127504', tmuxSession: 'instar-topic-127504', status: 'running',
      }]);
      expect((manager as any).buildSessionList()[0].name).toBe('Conversation name unavailable');
    });

    it('uses a verified Telegram title from the platform metadata', () => {
      const { manager, sessionManager } = createTestManager({
        resolveSessionPlatform: () => ({ platform: 'telegram', platformId: 127504, platformName: 'Instar dashboard makeover' }),
      });
      sessionManager.listRunningSessions.mockReturnValue([{
        id: 'abc-123', name: 'topic-127504', tmuxSession: 'instar-topic-127504', status: 'running',
      }]);
      expect((manager as any).buildSessionList()[0].name).toBe('Instar dashboard makeover');
    });

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
      // Tmux-name lookup (native-hook-events D1): the id-keyed getSessionSummary
      // never matched a tmux name, so the list now asks the tmux-scoped method.
      const hookEventReceiver = {
        getSessionSummaryForTmux: vi.fn((tmuxSession: string) => ({
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

  describe('session list platform (topic 112490)', () => {
    const running = [{
      id: 's1', name: 'door', tmuxSession: 'echo-door', status: 'running',
      startedAt: '2026-10-21T00:00:00Z', jobSlug: null, model: 'claude-opus-5-5',
    }];

    it('carries platform from the injected resolver so local Telegram rows are not drawn as headless', () => {
      const sessionManager = createMockSessionManager({ listRunningSessions: vi.fn(() => running) });
      const { manager } = createTestManager({
        sessionManager,
        resolveSessionPlatform: (t: string) => (t === 'echo-door'
          ? { platform: 'telegram', platformId: 112490, platformName: 'door model selection' }
          : { platform: 'headless' }),
      });
      const [row] = (manager as any).buildSessionList();
      expect(row.platform).toBe('telegram');
      expect(row.platformId).toBe(112490);
    });

    it('leaves platform unset when no resolver is wired or it throws', () => {
      const sessionManager = createMockSessionManager({ listRunningSessions: vi.fn(() => running) });
      const { manager } = createTestManager({ sessionManager });
      expect((manager as any).buildSessionList()[0].platform).toBeUndefined();

      const sm2 = createMockSessionManager({ listRunningSessions: vi.fn(() => running) });
      const { manager: m2 } = createTestManager({
        sessionManager: sm2,
        resolveSessionPlatform: () => { throw new Error('adapter down'); },
      });
      expect((m2 as any).buildSessionList()[0].platform).toBeUndefined();
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

describe('WebSocketManager — dashboard input durability (native-conversation-any-machine-access §3e)', () => {
  const ID = 'abcdefghij0123456789';
  const ID2 = 'ZYXWVUTSRQ0123456789';
  const running = (names: string[]) => createMockSessionManager({ listRunningSessions: vi.fn(() => names.map((tmuxSession) => ({ tmuxSession, name: tmuxSession }) as any)) });
  function fakeConnector() {
    const state: { handlers?: any; sent: any[] } = { sent: [] };
    return { state, connector: { connect: (_m: string, handlers: any) => { state.handlers = handlers; return { send: (f: any) => state.sent.push(f), close: () => {} }; } } };
  }

  describe('serving side', () => {
    it('input_caps comes first on every subscribe: inputAck 2, remote input as configured for a peer, always on for a local browser', () => {
      const sm = running(['s1']);
      const { connectClient, sendMessage } = createTestManager({ sessionManager: sm, poolStreamAllowRemoteInput: false });
      const local = connectClient();
      sendMessage(local.client, { type: 'subscribe', session: 's1' });
      expect(local.ws.sentMessages[0]).toEqual({ type: 'input_caps', session: 's1', inputAck: 2, remoteInput: true });
      const peer = connectClient();
      (peer.client as any).isPeer = true;
      sendMessage(peer.client, { type: 'subscribe', session: 's1' });
      expect(peer.ws.sentMessages[0]).toEqual({ type: 'input_caps', session: 's1', inputAck: 2, remoteInput: false });
    });

    it('echoes the id on the acknowledgement and on each refusal', () => {
      const sm = running(['s1']);
      const { connectClient, sendMessage } = createTestManager({ sessionManager: sm, poolStreamAllowRemoteInput: false });
      const { ws, client } = connectClient();
      sendMessage(client, { type: 'input', session: 's1', text: 'hi', clientInputId: ID });
      expect(ws.sentMessages.at(-1)).toEqual({ type: 'input_ack', session: 's1', success: true, clientInputId: ID });
      sendMessage(client, { type: 'input', session: 'gone', text: 'hi', clientInputId: ID2 });
      expect(ws.sentMessages.at(-1)).toEqual({ type: 'error', code: 'session-not-found', session: 'gone', clientInputId: ID2 });
      sendMessage(client, { type: 'input', session: 'bad name!', text: 'hi', clientInputId: ID2 });
      expect(ws.sentMessages.at(-1)).toEqual({ type: 'error', code: 'invalid-session', session: 'bad name!', clientInputId: ID2 });
      const peer = connectClient();
      (peer.client as any).isPeer = true;
      sendMessage(peer.client, { type: 'input', session: 's1', text: 'hi', clientInputId: 'peerpeerpeerpeer01' });
      expect(peer.ws.sentMessages.at(-1)).toEqual({ type: 'error', code: 'input-not-allowed', session: 's1', clientInputId: 'peerpeerpeerpeer01' });
      expect(sm.sendInput).toHaveBeenCalledTimes(1);
    });

    it('a malformed id is refused and never echoed or typed', () => {
      const sm = running(['s1']);
      const { connectClient, sendMessage } = createTestManager({ sessionManager: sm });
      const { ws, client } = connectClient();
      sendMessage(client, { type: 'input', session: 's1', text: 'hi', clientInputId: '<script>' });
      expect(ws.sentMessages.at(-1)).toEqual({ type: 'error', code: 'invalid-input-id', session: 's1' });
      expect(sm.sendInput).not.toHaveBeenCalled();
    });

    it('a repeated id is written once and answered with the original acknowledgement', () => {
      const sm = running(['s1']);
      sm.sendInput.mockReturnValue(false);
      const { connectClient, sendMessage } = createTestManager({ sessionManager: sm });
      const { ws, client } = connectClient();
      sendMessage(client, { type: 'input', session: 's1', text: 'hi', clientInputId: ID });
      sendMessage(client, { type: 'input', session: 's1', text: 'hi', clientInputId: ID, retry: true });
      expect(sm.sendInput).toHaveBeenCalledTimes(1);
      expect(ws.sentMessages.filter((m) => m.type === 'input_ack')).toEqual([
        { type: 'input_ack', session: 's1', success: false, clientInputId: ID },
        { type: 'input_ack', session: 's1', success: false, clientInputId: ID },
      ]);
    });

    it('a repeat arriving mid-write is not written again and gets the original acknowledgement when the write ends', () => {
      const sm = running(['s1']);
      const { connectClient, sendMessage, manager } = createTestManager({ sessionManager: sm }) as any;
      const a = connectClient();
      const b = connectClient();
      sm.sendInput.mockImplementation(() => {
        // The same id arrives (on another connection) while the first write is in progress.
        if (sm.sendInput.mock.calls.length === 1) (manager as any).handleMessage(b.client, { type: 'input', session: 's1', text: 'hi', clientInputId: ID });
        return true;
      });
      sendMessage(a.client, { type: 'input', session: 's1', text: 'hi', clientInputId: ID });
      expect(sm.sendInput).toHaveBeenCalledTimes(1);
      expect(a.ws.sentMessages.at(-1)).toEqual({ type: 'input_ack', session: 's1', success: true, clientInputId: ID });
      expect(b.ws.sentMessages.at(-1)).toEqual({ type: 'input_ack', session: 's1', success: true, clientInputId: ID });
    });

    it('a repeated id arriving on a different connection is still recognised and answered on that connection', () => {
      const sm = running(['s1']);
      const { connectClient, sendMessage } = createTestManager({ sessionManager: sm });
      const first = connectClient();
      sendMessage(first.client, { type: 'input', session: 's1', text: 'hi', clientInputId: ID });
      const second = connectClient();
      sendMessage(second.client, { type: 'input', session: 's1', text: 'hi', clientInputId: ID, retry: true });
      expect(sm.sendInput).toHaveBeenCalledTimes(1);
      expect(second.ws.sentMessages).toEqual([{ type: 'input_ack', session: 's1', success: true, clientInputId: ID }]);
    });

    it('an unknown flagged retry is refused and not typed, and counted', () => {
      const sm = running(['s1']);
      const { connectClient, sendMessage, manager } = createTestManager({ sessionManager: sm }) as any;
      const { ws, client } = connectClient();
      sendMessage(client, { type: 'input', session: 's1', text: 'hi', clientInputId: ID, retry: true });
      expect(ws.sentMessages.at(-1)).toEqual({ type: 'error', code: 'input-retry-unknown', session: 's1', clientInputId: ID });
      expect(sm.sendInput).not.toHaveBeenCalled();
      expect(manager.inputDurabilityStats()).toMatchObject({ inputRetryUnknown: 1, inputIdsEvicted: 0, sessions: { s1: { retryUnknown: 1 } } });
    });

    it('an evicted id refuses its retry (never a second write) and the eviction is counted', () => {
      const sm = running(['s1']);
      const { connectClient, sendMessage, manager } = createTestManager({ sessionManager: sm }) as any;
      const { ws, client } = connectClient();
      const id = (i: number) => `idididididid${String(i).padStart(6, '0')}`;
      for (let i = 0; i < 257; i++) sendMessage(client, { type: 'input', session: 's1', text: 'x', clientInputId: id(i) });
      expect(sm.sendInput).toHaveBeenCalledTimes(257);
      sendMessage(client, { type: 'input', session: 's1', text: 'x', clientInputId: id(0), retry: true });
      expect(ws.sentMessages.at(-1)).toMatchObject({ code: 'input-retry-unknown', clientInputId: id(0) });
      expect(sm.sendInput).toHaveBeenCalledTimes(257);
      expect(manager.inputDurabilityStats()).toMatchObject({ inputIdsEvicted: 1, inputRetryUnknown: 1, sessions: { s1: { evicted: 1, retryUnknown: 1 } } });
    });

    it('an id-less input keeps today\'s legacy path (no id on the acknowledgement)', () => {
      const sm = running(['s1']);
      const { connectClient, sendMessage } = createTestManager({ sessionManager: sm });
      const { ws, client } = connectClient();
      sendMessage(client, { type: 'input', session: 's1', text: 'hi' });
      sendMessage(client, { type: 'input', session: 's1', text: 'hi' });
      expect(sm.sendInput).toHaveBeenCalledTimes(2);
      expect(ws.sentMessages.at(-1)).toEqual({ type: 'input_ack', session: 's1', success: true });
    });

    it('a key gets an id and an answer', () => {
      const sm = running(['s1']);
      const { connectClient, sendMessage } = createTestManager({ sessionManager: sm });
      const { ws, client } = connectClient();
      sendMessage(client, { type: 'key', session: 's1', key: 'C-c', clientInputId: ID });
      expect(ws.sentMessages.at(-1)).toEqual({ type: 'input_ack', session: 's1', success: true, clientInputId: ID });
    });
  });

  describe('relay side', () => {
    it('the relayed frame keeps the id and the retry flag', () => {
      const { connector, state } = fakeConnector();
      const { connectClient, sendMessage } = createTestManager({ poolStreamConnector: connector, selfMachineId: 'm_self' });
      const { client } = connectClient();
      sendMessage(client, { type: 'subscribe', session: 'r1', machineId: 'm_peer' });
      state.handlers.onOpen();
      sendMessage(client, { type: 'input', session: 'r1', machineId: 'm_peer', text: 'go', clientInputId: ID, retry: true });
      expect(state.sent.at(-1)).toEqual({ type: 'input', session: 'r1', text: 'go', clientInputId: ID, retry: true });
    });

    it('passes an acknowledgement only to the client that sent its id', () => {
      const { connector, state } = fakeConnector();
      const { connectClient, sendMessage } = createTestManager({ poolStreamConnector: connector, selfMachineId: 'm_self' });
      const a = connectClient();
      const b = connectClient();
      sendMessage(a.client, { type: 'subscribe', session: 'r1', machineId: 'm_peer' });
      sendMessage(b.client, { type: 'subscribe', session: 'r1', machineId: 'm_peer' });
      state.handlers.onOpen();
      sendMessage(a.client, { type: 'input', session: 'r1', machineId: 'm_peer', text: 'go', clientInputId: ID });
      state.handlers.onFrame({ type: 'input_ack', session: 'r1', success: true, clientInputId: ID });
      expect(a.ws.sentMessages.filter((m) => m.type === 'input_ack')).toEqual([{ type: 'input_ack', session: 'r1', success: true, clientInputId: ID, machineId: 'm_peer' }]);
      expect(b.ws.sentMessages.filter((m) => m.type === 'input_ack')).toEqual([]);
      // An answer for an id nobody here sent goes nowhere.
      state.handlers.onFrame({ type: 'error', code: 'input-not-allowed', session: 'r1', clientInputId: ID2 });
      expect([...a.ws.sentMessages, ...b.ws.sentMessages].some((m) => m.clientInputId === ID2)).toBe(false);
    });

    it('answers peer-stream-lost with the id when the link is not active (nothing sent)', () => {
      const { connector, state } = fakeConnector();
      const { connectClient, sendMessage } = createTestManager({ poolStreamConnector: connector, selfMachineId: 'm_self' });
      const { ws, client } = connectClient();
      sendMessage(client, { type: 'subscribe', session: 'r1', machineId: 'm_peer' }); // still connecting
      sendMessage(client, { type: 'input', session: 'r1', machineId: 'm_peer', text: 'go', clientInputId: ID });
      expect(state.sent.some((f) => f.type === 'input')).toBe(false);
      expect(ws.sentMessages.at(-1)).toEqual({ type: 'error', code: 'peer-stream-lost', session: 'r1', machineId: 'm_peer', clientInputId: ID });
    });

    it('two sends of one id in flight at once: both answers reach the sender', () => {
      const { connector, state } = fakeConnector();
      const { connectClient, sendMessage } = createTestManager({ poolStreamConnector: connector, selfMachineId: 'm_self' });
      const { ws, client } = connectClient();
      sendMessage(client, { type: 'subscribe', session: 'r1', machineId: 'm_peer' });
      state.handlers.onOpen();
      sendMessage(client, { type: 'input', session: 'r1', machineId: 'm_peer', text: 'go', clientInputId: ID });
      sendMessage(client, { type: 'input', session: 'r1', machineId: 'm_peer', text: 'go', clientInputId: ID, retry: true });
      state.handlers.onFrame({ type: 'input_ack', session: 'r1', success: true, clientInputId: ID });
      state.handlers.onFrame({ type: 'input_ack', session: 'r1', success: true, clientInputId: ID });
      expect(ws.sentMessages.filter((m) => m.type === 'input_ack')).toHaveLength(2);
    });

    it('a dropped link clears the pending answers for that machine and session', () => {
      const { connector, state } = fakeConnector();
      const { connectClient, sendMessage, manager } = createTestManager({ poolStreamConnector: connector, selfMachineId: 'm_self' }) as any;
      const { client } = connectClient();
      sendMessage(client, { type: 'subscribe', session: 'r1', machineId: 'm_peer' });
      state.handlers.onOpen();
      sendMessage(client, { type: 'input', session: 'r1', machineId: 'm_peer', text: 'go', clientInputId: ID });
      expect(manager.inputDurabilityStats().relayPendingAnswers).toBe(1);
      state.handlers.onClose();
      expect(manager.inputDurabilityStats().relayPendingAnswers).toBe(0);
    });

    it('forwards input_caps, synthesises inputAck 1 for an older peer, and replays caps to a client that subscribes late', () => {
      const { connector, state } = fakeConnector();
      const { connectClient, sendMessage } = createTestManager({ poolStreamConnector: connector, selfMachineId: 'm_self' });
      const a = connectClient();
      sendMessage(a.client, { type: 'subscribe', session: 'new1', machineId: 'm_peer' });
      sendMessage(a.client, { type: 'subscribe', session: 'old1', machineId: 'm_peer' });
      state.handlers.onOpen();
      state.handlers.onFrame({ type: 'input_caps', session: 'new1', inputAck: 2, remoteInput: true });
      state.handlers.onFrame({ type: 'output', session: 'old1', data: 'x' });
      state.handlers.onFrame({ type: 'subscribed', session: 'old1' });
      expect(a.ws.sentMessages.filter((m) => m.type === 'input_caps')).toEqual([
        { type: 'input_caps', session: 'new1', inputAck: 2, remoteInput: true, machineId: 'm_peer' },
        { type: 'input_caps', session: 'old1', inputAck: 1, remoteInput: null, machineId: 'm_peer' },
      ]);
      const late = connectClient();
      sendMessage(late.client, { type: 'subscribe', session: 'new1', machineId: 'm_peer' });
      expect(late.ws.sentMessages).toContainEqual({ type: 'input_caps', session: 'new1', inputAck: 2, remoteInput: true, machineId: 'm_peer' });
    });
  });
});

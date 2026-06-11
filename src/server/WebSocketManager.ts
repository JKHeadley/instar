/**
 * WebSocket Manager — real-time terminal streaming for the dashboard.
 *
 * Handles client subscriptions to tmux sessions, streams terminal output
 * via diff-based updates, and forwards input to sessions.
 *
 * Protocol (JSON messages):
 *
 * Client → Server:
 *   { type: 'subscribe', session: 'session-name' }
 *   { type: 'unsubscribe', session: 'session-name' }
 *   { type: 'history', session: 'session-name', lines: 5000 }
 *   { type: 'input', session: 'session-name', text: 'some input' }
 *   { type: 'key', session: 'session-name', key: 'C-c' }
 *   { type: 'ping' }
 *
 * Server → Client:
 *   { type: 'output', session: 'session-name', data: '...terminal output...' }
 *   { type: 'history', session: 'session-name', data: '...', lines: N }
 *   { type: 'sessions', sessions: [...] }
 *   { type: 'session_ended', session: 'session-name' }
 *   { type: 'subscribed', session: 'session-name' }
 *   { type: 'unsubscribed', session: 'session-name' }
 *   { type: 'input_ack', session: 'session-name', success: true }
 *   { type: 'pong' }
 *   { type: 'error', message: '...' }
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionManager } from '../core/SessionManager.js';
import type { StateManager } from '../core/StateManager.js';
import type { HookEventReceiver } from '../monitoring/HookEventReceiver.js';
import type { StreamTicketStore } from './StreamTicketStore.js';
import { PeerStreamProxy, type UpstreamTransport, type UpstreamHandlers } from './PeerStreamProxy.js';

/** Pool Dashboard Streaming §2.1: only tmux-safe session names ever reach tmux. */
const SAFE_SESSION_NAME = /^[A-Za-z0-9_.:@-]+$/;

/** Requesting side (§2.2): opens an upstream /pool-stream to a peer machine. The
 *  connector owns mint-ticket + ws-connect (it has the mesh client + peer URLs). */
export interface PoolStreamConnector {
  /** Open an upstream link to `machineId`'s /pool-stream (mint a ticket, connect).
   *  Returns null if the peer is unreachable / has no URL. */
  connect: (machineId: string, handlers: UpstreamHandlers) => UpstreamTransport | null;
}

interface ClientState {
  ws: WebSocket;
  subscriptions: Set<string>;
  isAlive: boolean;
  /** True when this connection is a PEER machine streaming over /pool-stream
   *  (not a local browser dashboard on /ws). Peer input is gated by
   *  poolStreamAllowRemoteInput (default off). */
  isPeer?: boolean;
  /** The authenticated peer machine id (from the consumed stream ticket). */
  peerMachineId?: string;
  /** Remote sessions this local browser client is streaming from peers
   *  (Pool Dashboard Streaming requesting side §2.2). Keyed `${machineId}::${session}`. */
  remoteSubs?: Set<string>;
}

export class WebSocketManager {
  private wss: WebSocketServer;
  private clients: Map<WebSocket, ClientState> = new Map();
  private sessionOutputCache: Map<string, string> = new Map();
  private streamInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private sessionBroadcastInterval: ReturnType<typeof setInterval> | null = null;
  private sessionManager: SessionManager;
  private state: StateManager;
  private authToken?: string;
  private registryPath?: string;
  private hookEventReceiver?: HookEventReceiver;
  /** Pool Dashboard Streaming (serving side): consumes one-time tickets on the
   *  /pool-stream upgrade. Absent → /pool-stream is refused (feature dark). */
  private streamTicketStore?: StreamTicketStore;
  /** Serving-side gate: may a PEER machine send input/key to a local session?
   *  Default false (security: keystroke forwarding is a lateral-movement vector). */
  private poolStreamAllowRemoteInput = false;
  /** Requesting side (§2.2): opens upstream /pool-stream links to peers. */
  private poolStreamConnector?: PoolStreamConnector;
  /** This machine's id — a subscribe whose machineId === this is served locally. */
  private selfMachineId?: string;
  /** One multiplexed upstream proxy per peer machine (requesting side). */
  private peerProxies = new Map<string, PeerStreamProxy>();

  constructor(options: {
    server: HttpServer;
    sessionManager: SessionManager;
    state: StateManager;
    authToken?: string;
    instarDir?: string;
    hookEventReceiver?: HookEventReceiver;
    streamTicketStore?: StreamTicketStore;
    poolStreamAllowRemoteInput?: boolean;
    poolStreamConnector?: PoolStreamConnector;
    selfMachineId?: string;
  }) {
    this.sessionManager = options.sessionManager;
    this.state = options.state;
    this.authToken = options.authToken;
    this.hookEventReceiver = options.hookEventReceiver;
    this.streamTicketStore = options.streamTicketStore;
    this.poolStreamAllowRemoteInput = options.poolStreamAllowRemoteInput ?? false;
    this.poolStreamConnector = options.poolStreamConnector;
    this.selfMachineId = options.selfMachineId;
    if (options.instarDir) {
      this.registryPath = path.join(options.instarDir, 'topic-session-registry.json');
    }

    this.wss = new WebSocketServer({
      noServer: true,
    });

    // Handle upgrade manually for auth
    options.server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

      // ── /pool-stream: a PEER machine streaming a remote session (§2.3) ──
      // Authenticated by a single-use bearer ticket minted over the machine-
      // authed `pool-stream-ticket` mesh verb; identity comes from the ticket's
      // mint record, never an unverified upgrade claim.
      if (url.pathname === '/pool-stream') {
        if (!this.streamTicketStore) {
          socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
          socket.destroy();
          return;
        }
        const ticket = url.searchParams.get('ticket') || (request.headers['x-pool-stream-ticket'] as string) || '';
        const res = this.streamTicketStore.consume(ticket);
        if (!res.ok) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        const peerMachineId = res.forMachineId;
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.wss.emit('connection', ws, request, { isPeer: true, peerMachineId });
        });
        return;
      }

      // ── /ws: a local browser dashboard ──
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }

      // Authenticate via query param or header
      if (this.authToken && !this.authenticate(request, url)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request);
      });
    });

    this.wss.on('connection', (ws, _request, peerCtx?: { isPeer: boolean; peerMachineId: string }) => {
      const client: ClientState = {
        ws,
        subscriptions: new Set(),
        isAlive: true,
        ...(peerCtx?.isPeer ? { isPeer: true, peerMachineId: peerCtx.peerMachineId } : {}),
      };
      this.clients.set(ws, client);

      // Send initial session list
      this.sendSessionList(ws);

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(client, msg);
        } catch {
          this.send(ws, { type: 'error', message: 'Invalid JSON' });
        }
      });

      ws.on('pong', () => {
        client.isAlive = true;
      });

      ws.on('close', () => {
        this.dropRemoteSubsForClient(client);
        this.clients.delete(ws);
      });

      ws.on('error', () => {
        this.dropRemoteSubsForClient(client);
        this.clients.delete(ws);
      });
    });

    // Start streaming terminal output to subscribers
    this.startStreaming();

    // Heartbeat to detect dead connections
    this.heartbeatInterval = setInterval(() => {
      for (const [ws, client] of this.clients) {
        if (!client.isAlive) {
          ws.terminate();
          this.clients.delete(ws);
          continue;
        }
        client.isAlive = false;
        ws.ping();
      }
    }, 30_000);
    this.heartbeatInterval.unref();

    // Broadcast session list periodically
    this.sessionBroadcastInterval = setInterval(() => {
      this.broadcastSessionList();
    }, 5_000);
    this.sessionBroadcastInterval.unref();
  }

  private authenticate(request: IncomingMessage, url: URL): boolean {
    if (!this.authToken) return true;

    // Check query param first (for browser WebSocket which can't set headers)
    const tokenParam = url.searchParams.get('token');
    if (tokenParam && this.verifyToken(tokenParam)) return true;

    // Check Authorization header
    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const token = header.slice(7);
      if (this.verifyToken(token)) return true;
    }

    return false;
  }

  private verifyToken(token: string): boolean {
    if (!this.authToken) return true;
    const ha = createHash('sha256').update(token).digest();
    const hb = createHash('sha256').update(this.authToken).digest();
    return timingSafeEqual(ha, hb);
  }

  /** §2.1: a session name must be tmux-safe before it ever reaches send-keys. */
  private isValidSessionName(session: string): boolean {
    return SAFE_SESSION_NAME.test(session);
  }

  /**
   * Gate a write (input/key) before it reaches tmux. Returns true if allowed.
   * On rejection it sends the honest error frame and returns false.
   *  - invalid name  → invalid-session (§2.1 injection guard);
   *  - PEER client + remote input disabled → input-not-allowed (§2.3 default-off);
   *  - session not running locally → session-not-found (never relay to tmux blind).
   */
  private gateWrite(client: ClientState, session: string): boolean {
    if (!this.isValidSessionName(session)) {
      this.send(client.ws, { type: 'error', code: 'invalid-session', session });
      return false;
    }
    if (client.isPeer && !this.poolStreamAllowRemoteInput) {
      this.send(client.ws, { type: 'error', code: 'input-not-allowed', session });
      return false;
    }
    const exists = this.sessionManager.listRunningSessions().some((s) => s.tmuxSession === session);
    if (!exists) {
      this.send(client.ws, { type: 'error', code: 'session-not-found', session });
      return false;
    }
    return true;
  }

  // ── Requesting side (§2.2): route a remote session through a peer proxy ──

  /** True when the subscribe targets a session on ANOTHER machine. */
  private isRemoteTarget(machineId: string | undefined, session: string): boolean {
    if (!machineId || !this.poolStreamConnector) return false;
    if (this.selfMachineId && machineId === this.selfMachineId) return false;
    // A session that actually exists locally is served locally even if the
    // client's machineId hint is stale (hint-staleness after a transfer, §2.1).
    const local = this.sessionManager.listRunningSessions().some((s) => s.tmuxSession === session);
    return !local;
  }

  /** Get-or-create the one multiplexed upstream proxy for a peer machine.
   *
   *  A cached proxy that reached `closed` (idle-grace close after the last
   *  viewer left, or machine-unreachable after the bounded reconnect failed)
   *  is EVICTED and replaced: a closed PeerStreamProxy ignores every further
   *  subscribe by design, so returning it made the peer permanently
   *  unstreamable until a server restart — the 2026-06-08 live bug ("connects
   *  but the terminal stays blank, and never recovers after a hiccup"). A
   *  fresh user-initiated subscribe is a fresh episode with its own bounded
   *  reconnect budget, so P19 (no reconnect storms) is preserved. */
  private peerProxyFor(machineId: string): PeerStreamProxy {
    let proxy = this.peerProxies.get(machineId);
    if (proxy && proxy.currentState !== 'closed') return proxy;
    if (proxy) this.peerProxies.delete(machineId);
    proxy = new PeerStreamProxy({
      peerMachineId: machineId,
      // The connector owns URL resolution; a non-null sentinel keeps the proxy's
      // url-change guard inert (one peer = one connector).
      resolveUrl: () => 'pool-stream',
      connect: (_url, handlers) => {
        const t = this.poolStreamConnector?.connect(machineId, handlers);
        if (!t) throw new Error(`no pool-stream connector route for ${machineId}`);
        return t;
      },
      onFrameToClients: (session, frame) => this.fanRemoteFrame(machineId, session, frame),
      onError: (session, code) => this.sendRemoteError(machineId, session, code),
      now: () => Date.now(),
      setTimer: (ms, fn) => { const h = setTimeout(fn, ms); return h as unknown as import('./PeerStreamProxy.js').TimerHandle; },
      clearTimer: (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>),
      logger: (m) => { void m; },
    });
    this.peerProxies.set(machineId, proxy);
    return proxy;
  }

  /** Fan a peer frame out to every LOCAL client subscribed to (machineId, session). */
  private fanRemoteFrame(machineId: string, session: string, frame: Record<string, unknown>): void {
    const key = `${machineId}::${session}`;
    for (const c of this.clients.values()) {
      if (c.remoteSubs?.has(key)) this.send(c.ws, { ...frame, machineId });
    }
  }

  /** Surface an honest error to every local client subscribed to (machineId, session). */
  private sendRemoteError(machineId: string, session: string, code: string): void {
    const key = `${machineId}::${session}`;
    for (const c of this.clients.values()) {
      if (c.remoteSubs?.has(key)) this.send(c.ws, { type: 'error', code, session, machineId });
    }
  }

  /** Tear down a client's remote subscriptions (on unsubscribe-all / close). */
  private dropRemoteSubsForClient(client: ClientState): void {
    if (!client.remoteSubs) return;
    const clientId = this.clientId(client);
    for (const key of client.remoteSubs) {
      const sep = key.indexOf('::');
      const machineId = key.slice(0, sep);
      const session = key.slice(sep + 2);
      this.peerProxies.get(machineId)?.unsubscribe(session, clientId);
    }
    client.remoteSubs.clear();
  }

  private handleMessage(client: ClientState, msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'subscribe': {
        const session = String(msg.session || '');
        if (!session) {
          this.send(client.ws, { type: 'error', message: 'Missing session name' });
          return;
        }
        // §2.1: never let a crafted session name reach tmux (target injection).
        if (!this.isValidSessionName(session)) {
          this.send(client.ws, { type: 'error', code: 'invalid-session', session });
          return;
        }
        // §2.2 requesting side: a session on ANOTHER machine routes through that
        // peer's upstream proxy instead of the local capture path.
        const subMachine = typeof msg.machineId === 'string' ? msg.machineId : undefined;
        if (this.isRemoteTarget(subMachine, session)) {
          (client.remoteSubs ??= new Set()).add(`${subMachine}::${session}`);
          this.peerProxyFor(subMachine!).subscribe(session, this.clientId(client));
          this.send(client.ws, { type: 'subscribed', session, machineId: subMachine });
          break;
        }
        client.subscriptions.add(session);
        // Send current output immediately — use large capture for initial load
        const output = this.sessionManager.captureOutput(session, 2000);
        if (output) {
          this.sessionOutputCache.set(`${this.clientId(client)}:${session}`, output);
          this.send(client.ws, { type: 'output', session, data: output });
        }
        this.send(client.ws, { type: 'subscribed', session });
        break;
      }

      case 'unsubscribe': {
        const session = String(msg.session || '');
        const unsubMachine = typeof msg.machineId === 'string' ? msg.machineId : undefined;
        if (unsubMachine && client.remoteSubs?.has(`${unsubMachine}::${session}`)) {
          client.remoteSubs.delete(`${unsubMachine}::${session}`);
          this.peerProxies.get(unsubMachine)?.unsubscribe(session, this.clientId(client));
          this.send(client.ws, { type: 'unsubscribed', session, machineId: unsubMachine });
          break;
        }
        client.subscriptions.delete(session);
        this.sessionOutputCache.delete(`${this.clientId(client)}:${session}`);
        this.send(client.ws, { type: 'unsubscribed', session });
        break;
      }

      case 'input': {
        const session = String(msg.session || '');
        const text = String(msg.text || '');
        if (!session || !text) {
          this.send(client.ws, { type: 'error', message: 'Missing session or text' });
          return;
        }
        const inMachine = typeof msg.machineId === 'string' ? msg.machineId : undefined;
        if (inMachine && client.remoteSubs?.has(`${inMachine}::${session}`)) {
          // Relay to the peer; the SERVING machine enforces its allowRemoteInput
          // gate and replies input_ack / input-not-allowed, which we fan back.
          this.peerProxies.get(inMachine)?.relayInput({ type: 'input', session, text });
          break;
        }
        if (!this.gateWrite(client, session)) return;
        const success = this.sessionManager.sendInput(session, text);
        this.send(client.ws, { type: 'input_ack', session, success });
        break;
      }

      case 'key': {
        const session = String(msg.session || '');
        const key = String(msg.key || '');
        if (!session || !key) {
          this.send(client.ws, { type: 'error', message: 'Missing session or key' });
          return;
        }
        const keyMachine = typeof msg.machineId === 'string' ? msg.machineId : undefined;
        if (keyMachine && client.remoteSubs?.has(`${keyMachine}::${session}`)) {
          this.peerProxies.get(keyMachine)?.relayInput({ type: 'key', session, key });
          break;
        }
        if (!this.gateWrite(client, session)) return;
        const success = this.sessionManager.sendKey(session, key);
        this.send(client.ws, { type: 'input_ack', session, success });
        break;
      }

      case 'history': {
        const session = String(msg.session || '');
        const rawLines = parseInt(String(msg.lines || '5000'), 10);
        const lines = Math.min(Math.max(rawLines, 1), 50_000);
        if (!session) {
          this.send(client.ws, { type: 'error', message: 'Missing session name' });
          return;
        }
        // §2.2: capture happens ONLY on the owning machine. A history request
        // for a remote-subscribed session relays upstream like input/key —
        // the peer's reply (a `history` frame carrying the session name) fans
        // back through onUpstreamFrame. Capturing locally here returned null
        // for every remote session (2026-06-08 live bug: the screen-text
        // fetch "only ever looked on the local machine").
        const histMachine = typeof msg.machineId === 'string' ? msg.machineId : undefined;
        if (histMachine && client.remoteSubs?.has(`${histMachine}::${session}`)) {
          this.peerProxies.get(histMachine)?.relayFrame({ type: 'history', session, lines });
          break;
        }
        const historyOutput = this.sessionManager.captureOutput(session, lines);
        if (historyOutput) {
          // Update the cache so streaming doesn't immediately overwrite with fewer lines
          this.sessionOutputCache.set(`${this.clientId(client)}:${session}`, historyOutput);
          this.send(client.ws, { type: 'history', session, data: historyOutput, lines });
        } else {
          // Carry session + code so the frame is relayable (a sessionless
          // error is dropped by the peer fan-out) and renders honestly.
          this.send(client.ws, { type: 'error', code: 'session-not-found', session, message: `No output for session "${session}"` });
        }
        break;
      }

      case 'ping':
        this.send(client.ws, { type: 'pong' });
        break;

      default:
        this.send(client.ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  }

  /**
   * Stream terminal output to subscribed clients.
   * Uses diff-based approach: only sends new content since last capture.
   */
  private startStreaming(): void {
    this.streamInterval = setInterval(() => {
      // Collect all unique session subscriptions across clients
      const subscribedSessions = new Set<string>();
      for (const client of this.clients.values()) {
        for (const session of client.subscriptions) {
          subscribedSessions.add(session);
        }
      }

      // Capture output for each subscribed session
      for (const session of subscribedSessions) {
        const output = this.sessionManager.captureOutput(session, 2000);

        // Broadcast to each subscribed client
        for (const [, client] of this.clients) {
          if (!client.subscriptions.has(session)) continue;

          const cacheKey = `${this.clientId(client)}:${session}`;
          const cached = this.sessionOutputCache.get(cacheKey);

          if (output === null) {
            // Session may have ended
            if (cached !== undefined) {
              this.send(client.ws, { type: 'session_ended', session });
              this.sessionOutputCache.delete(cacheKey);
            }
            continue;
          }

          // Only send if output changed
          if (output !== cached) {
            this.sessionOutputCache.set(cacheKey, output);
            this.send(client.ws, { type: 'output', session, data: output });
          }
        }
      }
    }, 500);
    this.streamInterval.unref();
  }

  /**
   * Resolve display names by cross-referencing the topic-session registry.
   * Maps tmux session names to their Telegram topic names.
   */
  private getTopicDisplayNames(): Map<string, string> {
    const map = new Map<string, string>();
    if (!this.registryPath) return map;
    try {
      const data = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
      const topicToSession: Record<string, string> = data.topicToSession || {};
      const topicToName: Record<string, string> = data.topicToName || {};
      // Build reverse map: tmux session name → topic display name
      for (const [topicId, tmuxSession] of Object.entries(topicToSession)) {
        const name = topicToName[topicId];
        if (name) {
          map.set(tmuxSession, name);
        }
      }
    } catch {
      // Registry missing or corrupt — skip
    }
    return map;
  }

  private buildSessionList() {
    const running = this.sessionManager.listRunningSessions();
    const displayNames = this.getTopicDisplayNames();
    return running.map(s => {
      const base: Record<string, unknown> = {
        id: s.id,
        name: displayNames.get(s.tmuxSession) || s.name,
        tmuxSession: s.tmuxSession,
        status: s.status,
        startedAt: s.startedAt,
        jobSlug: s.jobSlug,
        model: s.model,
        type: s.jobSlug ? 'job' : 'interactive',
      };

      // Enrich with hook event telemetry when available
      if (this.hookEventReceiver) {
        const summary = this.hookEventReceiver.getSessionSummary(s.tmuxSession);
        if (summary) {
          base.telemetry = {
            eventCount: summary.eventCount,
            toolsUsed: summary.toolsUsed,
            subagentsSpawned: summary.subagentsSpawned,
            lastActivity: summary.lastEvent,
          };
        }
      }

      return base;
    });
  }

  private sendSessionList(ws: WebSocket): void {
    const sessions = this.buildSessionList();
    this.send(ws, { type: 'sessions', sessions });
  }

  /**
   * Broadcast a custom event to all connected dashboard clients.
   * Used by PasteManager for paste_delivered / paste_acknowledged events.
   */
  broadcastEvent(event: Record<string, unknown>): void {
    // Notify in-process subscribers BEFORE the WebSocket fan-out so a
    // listener (e.g. the Layer 3 DeliveryFailureSentinel) reacts even
    // when no dashboard clients are connected. The sentinel does not
    // need a live WebSocket — it needs the event itself.
    for (const fn of this.eventSubscribers) {
      try {
        fn(event);
      } catch (err) {
        console.warn('[ws] in-process event subscriber threw:', err);
      }
    }
    if (this.clients.size === 0) return;
    const msg = JSON.stringify(event);
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg);
      }
    }
  }

  /**
   * Register an in-process subscriber for events broadcast through this
   * manager. Returns an unsubscribe handle.
   *
   * Used by the Layer 3 DeliveryFailureSentinel to receive
   * `delivery_failed` events emitted by the script-side detector
   * (Layer 2c). The sentinel reacts in <1s rather than waiting for
   * its 5-minute watchdog tick.
   */
  private eventSubscribers = new Set<(event: Record<string, unknown>) => void>();
  subscribeEvents(fn: (event: Record<string, unknown>) => void): () => void {
    this.eventSubscribers.add(fn);
    return () => {
      this.eventSubscribers.delete(fn);
    };
  }

  private broadcastSessionList(): void {
    if (this.clients.size === 0) return;
    const sessions = this.buildSessionList();
    const msg = JSON.stringify({ type: 'sessions', sessions });
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg);
      }
    }
  }

  private clientId(client: ClientState): string {
    // Use object identity via a WeakRef-friendly approach
    return String((client.ws as unknown as { _socket?: { remotePort?: number } })._socket?.remotePort || Math.random());
  }

  private send(ws: WebSocket, msg: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Graceful shutdown — close all connections and stop intervals.
   */
  shutdown(): void {
    if (this.streamInterval) clearInterval(this.streamInterval);
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.sessionBroadcastInterval) clearInterval(this.sessionBroadcastInterval);

    for (const [ws] of this.clients) {
      ws.close(1001, 'Server shutting down');
    }
    this.clients.clear();
    this.wss.close();
  }
}

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
 *   { type: 'input', session: 'session-name', text: 'some input', clientInputId?, retry? }
 *   { type: 'key', session: 'session-name', key: 'C-c', clientInputId? }
 *   { type: 'ping' }
 *
 * Server → Client:
 *   { type: 'output', session: 'session-name', data: '...terminal output...' }
 *   { type: 'history', session: 'session-name', data: '...', lines: N }
 *   { type: 'sessions', sessions: [...] }
 *   { type: 'session_ended', session: 'session-name' }
 *   { type: 'subscribed', session: 'session-name' }
 *   { type: 'unsubscribed', session: 'session-name' }
 *   { type: 'input_caps', session, inputAck: 2, remoteInput: boolean }   (first, per subscribe)
 *   { type: 'input_ack', session: 'session-name', success: true, clientInputId? }
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
import type { SessionPlatformInfo } from './sessionPlatform.js';
import { sessionDisplayName } from './sessionPlatform.js';
import { createSessionPresentationResolver, type SessionPresentationSources } from './sessionPresentation.js';
import { isVerifiedChannelName } from '../messaging/shared/channelIdentity.js';
import type { DesktopStreamManager } from './DesktopStreamManager.js';
import type { DesktopMeshBroker } from './DesktopMeshBroker.js';
import { DesktopMeshStreamRelay } from './DesktopMeshStreamRelay.js';
import { machineAuthMiddleware, type MachineAuthDeps, type MachineAuthContext } from './machineAuth.js';
import { isLoopbackPeer } from '../core/desktopTransport.js';
import { InputIdLedger, CLIENT_INPUT_ID, type InputAckFrame } from './InputIdLedger.js';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';

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
  private readonly desktopMeshRelay?: DesktopMeshStreamRelay;
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
  private sessionPresentationSources?: () => SessionPresentationSources;
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
  private resolveSessionPlatform?: (tmuxSession: string) => SessionPlatformInfo;
  /** §3e item 3 (serving side): seen input ids per session. */
  private readonly inputIds = new InputIdLedger<ClientState>();
  /** §3e item 3 (relay side): which browser client sent each pending relayed
   *  id, keyed `${machineId}::${session}::${id}`, so the serving machine's
   *  answer goes to that client alone. Entries leave on the answer, when the
   *  client disconnects or drops that remote subscription, and past the bound. */
  private readonly pendingRelayedInputs = new Map<string, { client: ClientState; outstanding: number }>();
  private static readonly PENDING_RELAYED_MAX = 4096;

  constructor(options: {
    server: HttpServer;
    sessionManager: SessionManager;
    state: StateManager;
    authToken?: string;
    instarDir?: string;
    sessionPresentationSources?: () => SessionPresentationSources;
    hookEventReceiver?: HookEventReceiver;
    streamTicketStore?: StreamTicketStore;
    desktopStreamManager?: DesktopStreamManager;
    desktopMeshBroker?: DesktopMeshBroker | null;
    desktopMeshSigningKeyPem?: string;
    desktopPeerAuth?: MachineAuthDeps;
    poolStreamAllowRemoteInput?: boolean;
    poolStreamConnector?: PoolStreamConnector;
    selfMachineId?: string;
    /** Which messaging platform a local session is bound to (the same
     *  derivation GET /sessions uses). Without it every local row lacks
     *  `platform` and the dashboard draws the headless icon. */
    resolveSessionPlatform?: (tmuxSession: string) => SessionPlatformInfo;
  }) {
    this.sessionManager = options.sessionManager;
    this.state = options.state;
    this.sessionPresentationSources = options.sessionPresentationSources;
    this.authToken = options.authToken;
    this.hookEventReceiver = options.hookEventReceiver;
    this.streamTicketStore = options.streamTicketStore;
    this.poolStreamAllowRemoteInput = options.poolStreamAllowRemoteInput ?? false;
    this.poolStreamConnector = options.poolStreamConnector;
    this.selfMachineId = options.selfMachineId;
    this.resolveSessionPlatform = options.resolveSessionPlatform;
    if (options.desktopMeshBroker && options.selfMachineId && options.desktopMeshSigningKeyPem) {
      this.desktopMeshRelay = new DesktopMeshStreamRelay(options.selfMachineId, options.desktopMeshSigningKeyPem);
    }
    if (options.instarDir) {
      this.registryPath = path.join(options.instarDir, 'topic-session-registry.json');
    }

    this.wss = new WebSocketServer({
      noServer: true,
    });

    // Handle upgrade manually for auth
    options.server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

      if (url.pathname === '/desktop-stream') {
        const offered = typeof request.headers['sec-websocket-protocol'] === 'string'
          ? request.headers['sec-websocket-protocol'].split(',').map(part => part.trim()) : [];
        const ticket = offered[0] === 'instar-desktop-v1' && offered[1]?.startsWith('ticket.')
          ? offered[1].slice(7) : '';
        if (!request.headers['x-machine-id'] && ticket && options.desktopMeshBroker) {
          const tlsSocket = 'encrypted' in socket && socket.encrypted === true;
          const loopback = isLoopbackPeer(request.socket?.remoteAddress);
          const scheme = tlsSocket || (loopback && request.headers['x-forwarded-proto'] === 'https')
            ? 'https' : 'http';
          if ((!tlsSocket && !loopback) || request.headers.origin !== `${scheme}://${request.headers.host}`) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
          }
          const remote = options.desktopMeshBroker.consumeTicket(ticket);
          if (remote && this.desktopMeshRelay) {
            this.desktopMeshRelay.handleUpgrade(request, socket, head, remote.requestId, ticket, remote.url);
            return;
          }
        }
        if (request.headers['x-machine-id']) {
          if (!options.desktopPeerAuth) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
          }
          const machineRequest = request as IncomingMessage & { body: object; machineAuth?: MachineAuthContext; desktopRelayMachineId?: string };
          machineRequest.body = {};
          let accepted = false;
          const refusal = { status: (_code: number) => refusal, json: (_body: unknown) => refusal };
          machineAuthMiddleware(options.desktopPeerAuth)(
            machineRequest as unknown as ExpressRequest,
            refusal as unknown as ExpressResponse,
            () => { accepted = true; },
          );
          if (!accepted || !machineRequest.machineAuth) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
          }
          machineRequest.desktopRelayMachineId = machineRequest.machineAuth.machineId;
        }
        if (!options.desktopStreamManager) {
          socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
          socket.destroy();
          return;
        }
        void options.desktopStreamManager.handleUpgrade(request, socket, head);
        return;
      }

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
      this.pruneInputIds();
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
  private gateWrite(client: ClientState, session: string, clientInputId?: string): boolean {
    const id = clientInputId ? { clientInputId } : {};
    if (!this.isValidSessionName(session)) {
      this.send(client.ws, { type: 'error', code: 'invalid-session', session, ...id });
      return false;
    }
    if (client.isPeer && !this.poolStreamAllowRemoteInput) {
      this.send(client.ws, { type: 'error', code: 'input-not-allowed', session, ...id });
      return false;
    }
    const exists = this.sessionManager.listRunningSessions().some((s) => s.tmuxSession === session);
    if (!exists) {
      this.send(client.ws, { type: 'error', code: 'session-not-found', session, ...id });
      return false;
    }
    return true;
  }

  /** §3e item 1: what this machine can do for input into `session`, said first
   *  on every subscribe. A peer link learns whether this machine accepts remote
   *  input; a local browser may always type into a local session. */
  private inputCapsFrame(client: ClientState, session: string): Record<string, unknown> {
    return { type: 'input_caps', session, inputAck: 2, remoteInput: client.isPeer ? this.poolStreamAllowRemoteInput : true };
  }

  /**
   * §3e item 3: a write that carries a `clientInputId`. The id is recorded
   * before the write; a repeated id gets the original acknowledgement on the
   * connection it came in on, without writing again; a flagged retry whose id
   * is not known is refused and not typed (the server cannot tell a first try
   * that never arrived from one it has forgotten).
   */
  private writeWithId(client: ClientState, session: string, id: string, retry: boolean, write: () => boolean): void {
    if (!this.isValidSessionName(session)) {
      this.send(client.ws, { type: 'error', code: 'invalid-session', session, clientInputId: id });
      return;
    }
    const known = this.inputIds.lookup(session, id);
    if (known.kind === 'done') { this.send(client.ws, { ...known.ack }); return; }
    if (known.kind === 'pending') { known.addWaiter(client); return; }
    if (!this.gateWrite(client, session, id)) return;
    if (retry) {
      this.inputIds.noteRetryUnknown(session);
      this.send(client.ws, { type: 'error', code: 'input-retry-unknown', session, clientInputId: id });
      return;
    }
    this.inputIds.begin(session, id);
    let success = false;
    try { success = write(); } catch { success = false; }
    const ack: InputAckFrame = { type: 'input_ack', session, success, clientInputId: id };
    const waiters = this.inputIds.complete(session, id, ack);
    this.send(client.ws, { ...ack });
    for (const w of waiters) this.send(w.ws, { ...ack });
  }

  /** Read the optional id of an input/key frame. `undefined` = none (legacy,
   *  id-less path); `null` = present but malformed (refused, never echoed). */
  private readInputId(msg: Record<string, unknown>): string | null | undefined {
    if (msg.clientInputId === undefined || msg.clientInputId === null) return undefined;
    return typeof msg.clientInputId === 'string' && CLIENT_INPUT_ID.test(msg.clientInputId) ? msg.clientInputId : null;
  }

  /** Relay an input/key frame to the serving machine; the answer for its id
   *  goes back to this client alone. Not sent → `peer-stream-lost` with the id. */
  private relayWrite(client: ClientState, machineId: string, session: string, frame: Record<string, unknown>, id: string | undefined): void {
    const pendingKey = id ? `${machineId}::${session}::${id}` : null;
    if (pendingKey) {
      // A repeat of an id still waiting (a retry before the first answer) waits for its own answer too.
      const prev = this.pendingRelayedInputs.get(pendingKey);
      this.pendingRelayedInputs.delete(pendingKey);
      this.pendingRelayedInputs.set(pendingKey, { client, outstanding: prev && prev.client === client ? prev.outstanding + 1 : 1 });
      while (this.pendingRelayedInputs.size > WebSocketManager.PENDING_RELAYED_MAX) {
        this.pendingRelayedInputs.delete(this.pendingRelayedInputs.keys().next().value as string);
      }
    }
    const sent = this.peerProxies.get(machineId)?.relayInput(frame) ?? false;
    if (!sent) {
      if (pendingKey) this.settlePending(pendingKey);
      this.send(client.ws, { type: 'error', code: 'peer-stream-lost', session, machineId, ...(id ? { clientInputId: id } : {}) });
    }
  }

  /** One answer (or one unsent frame) settles one outstanding send of that id; returns its tab. */
  private settlePending(pendingKey: string): ClientState | undefined {
    const p = this.pendingRelayedInputs.get(pendingKey);
    if (!p) return undefined;
    if (--p.outstanding <= 0) this.pendingRelayedInputs.delete(pendingKey);
    return p.client;
  }

  /** Forget ids of sessions that are no longer running here (§3e Left behind 16). */
  private pruneInputIds(): void {
    try {
      this.inputIds.prune(new Set(this.sessionManager.listRunningSessions().map((s) => s.tmuxSession)));
    } catch { /* @silent-fallback-ok: pruning is housekeeping; ids stay bounded per session */ }
  }

  /** §3e counters for the 2026-11-25 maturation check (serving side), plus the
   *  relay's count of answers still waiting. Privacy-safe: no text, no ids. */
  inputDurabilityStats(): Record<string, unknown> {
    const s = this.inputIds.stats();
    return {
      inputAck: 2,
      allowRemoteInput: this.poolStreamAllowRemoteInput,
      idsPerSession: s.idsPerSession,
      inputIdsEvicted: s.totals.evicted,
      inputRetryUnknown: s.totals.retryUnknown,
      inputIdsRepeated: s.totals.repeated,
      sessions: s.sessions,
      relayPendingAnswers: this.pendingRelayedInputs.size,
    };
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
    // §3e item 3: an answer that carries an input id goes to the client that
    // sent that id, and to no one else. An unknown id (its sender left) is dropped.
    if ((frame.type === 'input_ack' || frame.type === 'error') && typeof frame.clientInputId === 'string') {
      const pendingKey = `${key}::${frame.clientInputId}`;
      const sender = this.settlePending(pendingKey);
      if (sender && this.clients.has(sender.ws)) this.send(sender.ws, { ...frame, machineId });
      return;
    }
    for (const c of this.clients.values()) {
      if (c.remoteSubs?.has(key)) this.send(c.ws, { ...frame, machineId });
    }
  }

  /** Surface an honest error to every local client subscribed to (machineId, session). */
  private sendRemoteError(machineId: string, session: string, code: string): void {
    const key = `${machineId}::${session}`;
    // The link to that machine dropped: answers for ids sent on it will not come back here,
    // so their pending entries leave now (the tab keeps its draft and decides; §3e).
    const prefix = `${key}::`;
    for (const k of this.pendingRelayedInputs.keys()) if (k.startsWith(prefix)) this.pendingRelayedInputs.delete(k);
    for (const c of this.clients.values()) {
      if (c.remoteSubs?.has(key)) this.send(c.ws, { type: 'error', code, session, machineId });
    }
  }

  /** Tear down a client's remote subscriptions (on unsubscribe-all / close). */
  private dropRemoteSubsForClient(client: ClientState): void {
    for (const [k, p] of this.pendingRelayedInputs) if (p.client === client) this.pendingRelayedInputs.delete(k);
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
          const proxy = this.peerProxyFor(subMachine!);
          proxy.subscribe(session, this.clientId(client));
          this.send(client.ws, { type: 'subscribed', session, machineId: subMachine });
          // §3e item 1: the link is shared, so a client that subscribes after
          // the serving machine said what it can do gets that answer replayed.
          const caps = proxy.inputCaps(session);
          if (caps) this.send(client.ws, { ...caps, machineId: subMachine });
          break;
        }
        client.subscriptions.add(session);
        // §3e item 1: say what this machine can do for input, before anything else.
        this.send(client.ws, this.inputCapsFrame(client, session));
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
          const prefix = `${unsubMachine}::${session}::`;
          for (const [k, p] of this.pendingRelayedInputs) if (p.client === client && k.startsWith(prefix)) this.pendingRelayedInputs.delete(k);
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
        const inputId = this.readInputId(msg);
        if (inputId === null) {
          this.send(client.ws, { type: 'error', code: 'invalid-input-id', session });
          return;
        }
        const retry = inputId !== undefined && msg.retry === true;
        const inMachine = typeof msg.machineId === 'string' ? msg.machineId : undefined;
        if (inMachine && client.remoteSubs?.has(`${inMachine}::${session}`)) {
          // Relay to the peer; the SERVING machine enforces its allowRemoteInput
          // gate and answers input_ack / an error with the id, which goes back
          // to this client alone (fanRemoteFrame).
          this.relayWrite(client, inMachine, session, {
            type: 'input', session, text,
            ...(inputId ? { clientInputId: inputId } : {}),
            ...(retry ? { retry: true } : {}),
          }, inputId);
          break;
        }
        if (inputId) {
          this.writeWithId(client, session, inputId, retry, () => this.sessionManager.sendInput(session, text));
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
        // §3e item 7: a key gets an id and an answer, and is never retried
        // (a repeated Enter or Ctrl-C is an action), so `retry` is ignored here.
        const keyId = this.readInputId(msg);
        if (keyId === null) {
          this.send(client.ws, { type: 'error', code: 'invalid-input-id', session });
          return;
        }
        const keyMachine = typeof msg.machineId === 'string' ? msg.machineId : undefined;
        if (keyMachine && client.remoteSubs?.has(`${keyMachine}::${session}`)) {
          this.relayWrite(client, keyMachine, session, { type: 'key', session, key, ...(keyId ? { clientInputId: keyId } : {}) }, keyId);
          break;
        }
        if (keyId) {
          this.writeWithId(client, session, keyId, false, () => this.sessionManager.sendKey(session, key));
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
  private getTopicDisplayNames(): Map<string, { topicId: number; name: string }> {
    const map = new Map<string, { topicId: number; name: string }>();
    if (!this.registryPath) return map;
    try {
      const data = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
      const topicToSession: Record<string, string> = data.topicToSession || {};
      const topicToName: Record<string, string> = data.topicToName || {};
      // Build reverse map: tmux session name → topic display name
      for (const [topicId, tmuxSession] of Object.entries(topicToSession)) {
        const name = topicToName[topicId];
        if (isVerifiedChannelName('telegram', topicId, name)) {
          map.set(tmuxSession, { topicId: Number(topicId), name });
        }
      }
    } catch {
      // Registry missing or corrupt — skip
    }
    return map;
  }

  private buildSessionList() {
    const running = this.sessionManager.listRunningSessions();
    const presentSession = this.sessionPresentationSources ? createSessionPresentationResolver(this.sessionPresentationSources()) : null;
    const displayNames = presentSession ? new Map<string, { topicId: number; name: string }>() : this.getTopicDisplayNames();
    return running.map(s => {
      const base: Record<string, unknown> = {
        id: s.id,
        name: s.name,
        tmuxSession: s.tmuxSession,
        status: s.status,
        startedAt: s.startedAt,
        jobSlug: s.jobSlug,
        model: s.model,
        type: s.jobSlug ? 'job' : 'interactive',
      };

      if (presentSession) {
        Object.assign(base, presentSession(s));
      } else {
        if (this.resolveSessionPlatform) {
          try {
            Object.assign(base, this.resolveSessionPlatform(s.tmuxSession));
          } catch {
            // Adapter lookup failed — leave platform unset (dashboard shows headless)
          }
        }
        if ((!base.platform || base.platform === 'headless') && Number.isSafeInteger(s.telegramTopicId) && s.telegramTopicId! > 0) {
          base.platform = 'telegram';
          base.platformId = s.telegramTopicId;
        }
        const registeredTitle = displayNames.get(s.tmuxSession);
        if (base.platform === 'telegram' && !base.platformName && registeredTitle?.topicId === Number(base.platformId)) {
          base.platformName = registeredTitle.name;
        }
        base.name = sessionDisplayName(base.name, base as unknown as SessionPlatformInfo);
      }

      // Enrich with hook event telemetry when available
      if (this.hookEventReceiver) {
        const summary = this.hookEventReceiver.getSessionSummaryForTmux(s.tmuxSession);
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
  closeDesktopMeshRequest(requestId: string): void { this.desktopMeshRelay?.closeRequest(requestId); }

  shutdown(): void {
    this.desktopMeshRelay?.close();
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

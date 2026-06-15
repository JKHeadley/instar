/**
 * SocketModeClient — WebSocket connection manager for Slack Socket Mode.
 *
 * Handles the full lifecycle: connect, receive events, acknowledge,
 * reconnect with hardened strategy (exponential backoff, active heartbeat,
 * too_many_websockets handling, proactive rotation).
 *
 * Uses Node's built-in WebSocket (Node 22+) or falls back to 'ws' package.
 *
 * CONTRACT-EVIDENCE: EXEMPT — net #1 (_safeSend containment) touches NO Slack
 * Socket Mode API-contract surface. The bytes sent to Slack are byte-identical
 * (the same ack `{ envelope_id }`, the same `{"type":"ping"}`, the same queued
 * payloads); only the local non-OPEN-send guarding (readyState check + try/catch)
 * and the reconnect policy changed. No wire-protocol / envelope shape change, so
 * live-API contract evidence does not apply. Remove this marker when the file's
 * actual API surface next changes.
 */

import { SlackApiClient, SlackApiError } from './SlackApiClient.js';
import type { SocketModeEnvelope, SocketModeConnectionInfo } from './types.js';

// Polyfill WebSocket for Node <22 (global added in Node 22)
if (typeof globalThis.WebSocket === 'undefined') {
  const ws = await import('ws');
  // @ts-expect-error ws package is API-compatible but has different TS types
  globalThis.WebSocket = ws.default;
}

export interface SocketModeHandlers {
  onEvent: (type: string, payload: Record<string, unknown>) => Promise<void>;
  onInteraction: (payload: Record<string, unknown>) => Promise<void>;
  onConnected: () => void;
  onDisconnected: (reason: string) => void;
  onError: (error: Error, permanent: boolean) => void;
}

interface OutboundQueueItem {
  data: string;
  enqueuedAt: number;
}

const MAX_OUTBOUND_QUEUE = 100;
const HEARTBEAT_INTERVAL_MS = 30_000;   // Check connection health every 30s
const DEAD_SILENCE_MS = 300_000;        // 5 min with no events → send liveness probe
const MAX_BACKOFF_MS = 60_000;
const TOO_MANY_WS_DELAY_MS = 30_000;

export class SocketModeClient {
  private apiClient: SlackApiClient;
  private handlers: SocketModeHandlers;
  private ws: WebSocket | null = null;
  private started = false;
  private reconnecting = false;
  // Bumped on every deliberate teardown (disconnect / reconnect / forced /
  // Slack-requested). In-flight async work (an awaited apps.connections.open,
  // a sleeping backoff, a delayed too_many_websockets retry) captures the
  // epoch when it starts and aborts if it changed — a superseded path can
  // never open a connection the client no longer tracks (#1076).
  private epoch = 0;
  private consecutiveErrors = 0;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEventAt = 0;
  private outboundQueue: OutboundQueueItem[] = [];
  private connectionTime: number | null = null;

  constructor(apiClient: SlackApiClient, handlers: SocketModeHandlers) {
    this.apiClient = apiClient;
    this.handlers = handlers;
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    // Defensive: connect() on an already-live client is a reconnect. Without
    // this, a failing dial here would arm a backoff sleeper while the old
    // socket + heartbeat stay live, and the heartbeat's _forceReconnect would
    // then skip dialing (reconnecting=true) while the sleeper stands down on
    // epoch mismatch — no path left to re-dial.
    if (this.ws) this._teardownSocket(1000, 'superseded by connect()');
    this.started = true;
    await this._openConnection();
  }

  async disconnect(): Promise<void> {
    this.started = false;
    this._teardownSocket(1000, 'client disconnect');
  }

  /** Force-reconnect: tear down existing connection and establish a new one. */
  async reconnect(): Promise<void> {
    this.reconnecting = false;
    this.consecutiveErrors = 0;
    this._teardownSocket(1000, 'reconnect');
    this.started = true;
    await this._openConnection();
  }

  /**
   * Deliberately tear down the tracked socket. Bumps the epoch (so any
   * in-flight open/backoff aborts) and nulls `this.ws` BEFORE closing — the
   * socket's close event fires on a later tick, and the identity guard in the
   * close handler (`this.ws !== sock`) is what keeps that stale event from
   * touching whatever connection is current by then. A synchronous flag
   * save/restore cannot do this (#1076).
   */
  private _teardownSocket(code?: number, reason?: string): void {
    this.epoch++;
    this._clearHeartbeat();
    const sock = this.ws;
    this.ws = null;
    if (sock) {
      try { sock.close(code, reason); } catch { /* already dead */ }
    }
  }

  /**
   * The single funnel for EVERY WebSocket send in this client (net #1). A
   * `send()` on a socket that is not OPEN (CONNECTING / CLOSING / CLOSED) throws
   * synchronously — `"WebSocket is not open: readyState N"` on the Node 22+
   * built-in, `"Sent before connected"` on the `ws` polyfill — and these sends
   * run inside un-awaited event-listener callbacks, where an escaping throw
   * becomes an uncaughtException / unhandledRejection that can crash the whole
   * process. `_safeSend` contains that at the source.
   *
   * Reads `this.ws` ONCE into a local and sends on THAT local, so the readyState
   * check and the send target the same socket (no internal TOCTOU). Returns true
   * iff the frame was handed to the socket.
   *
   * - Not-OPEN precheck (the EXPECTED transient state during reconnect): returns
   *   false silently — no log, no reconnect. A non-OPEN socket short-circuits
   *   here, so repeated sends against a dead socket can never flood the log.
   * - A genuine throw on an OPEN socket (a rare race): logged message-only (never
   *   the payload). Only the liveness path (`reconnectOnFailure`) reconnects, and
   *   only if the socket we sent on is still current (`this.ws === sock`) — so a
   *   throw after a teardown-and-replace can never tear down a fresh healthy
   *   socket. Reuses the existing `_forceReconnect` guard (epoch model, #1076);
   *   never resurrects a torn-down socket.
   */
  private _safeSend(data: string, context: string, reconnectOnFailure = false): boolean {
    const sock = this.ws;
    if (!sock || sock.readyState !== WebSocket.OPEN) return false;
    try {
      sock.send(data);
      return true;
    } catch (err) {
      console.warn(
        `[slack-socket] ${context} send failed (readyState=${sock.readyState}): ${(err as Error).message}`,
      );
      if (reconnectOnFailure && this.started && !this.reconnecting && this.ws === sock) {
        this._forceReconnect();
      }
      return false;
    }
  }

  /** Queue an outbound message for sending (or send immediately if connected). */
  queueOutbound(data: string): void {
    // Send immediately if the socket is OPEN; otherwise (or on a lost TOCTOU
    // race) enqueue for the next drain instead of dropping the message.
    if (this._safeSend(data, 'outbound')) return;
    this.outboundQueue.push({ data, enqueuedAt: Date.now() });
    if (this.outboundQueue.length > MAX_OUTBOUND_QUEUE) {
      this.outboundQueue.shift(); // Drop oldest
    }
  }

  private async _openConnection(): Promise<void> {
    const myEpoch = this.epoch;
    try {
      const response = await this.apiClient.call(
        'apps.connections.open',
        {},
        { useAppToken: true },
      ) as unknown as SocketModeConnectionInfo;

      if (myEpoch !== this.epoch) return; // superseded while awaiting the API

      if (!response.url) {
        throw new Error('No WebSocket URL in apps.connections.open response');
      }

      this.connectionTime = response.approximate_connection_time ?? null;
      // Invariant: at most one tracked socket. If something is still here,
      // tear it down before replacing it rather than silently orphaning it.
      if (this.ws) this._teardownSocket(1000, 'superseded');
      this._connectWebSocket(response.url);
      this.consecutiveErrors = 0;
    } catch (err) {
      if (err instanceof SlackApiError && err.permanent) {
        this.handlers.onError(err, true);
        this.started = false; // Don't retry permanent failures
        return;
      }
      this.handlers.onError(err as Error, false);
      if (this.started && myEpoch === this.epoch) {
        await this._backoffReconnect();
      }
    }
  }

  private _connectWebSocket(url: string): void {
    // Handlers are bound to THIS socket instance, not to `this.ws` — close
    // (and open/message) events fire on a later tick, by which time the
    // tracked socket may already be a replacement. Events from a socket that
    // is no longer current are stale and must be ignored, otherwise a late
    // close orphans the live replacement and double-reconnects (#1076).
    const sock = new WebSocket(url);
    this.ws = sock;

    sock.addEventListener('open', () => {
      if (this.ws !== sock) return; // stale socket — replaced while connecting
      this.lastEventAt = Date.now();
      this._startHeartbeat();
      this._drainQueue();
      this.handlers.onConnected();
    });

    sock.addEventListener('message', (event: MessageEvent) => {
      if (this.ws !== sock) return; // stale socket — never ack/process on it
      this.lastEventAt = Date.now();
      this._handleRawMessage(typeof event.data === 'string' ? event.data : String(event.data));
    });

    sock.addEventListener('close', (event: Event & { reason?: string; code?: number }) => {
      if (this.ws !== sock) return; // stale socket — its teardown already ran
      // A natural close deliberately does NOT bump the epoch: if a backoff
      // sleeper is already in flight, the call below returns early
      // (reconnecting=true) and that sleeper must stay valid to perform the
      // re-dial — bumping here would strand the only reconnect path.
      this._clearHeartbeat();
      this.ws = null;
      this.handlers.onDisconnected(event.reason || 'connection closed');
      if (this.started) {
        const myEpoch = this.epoch;
        this._backoffReconnect().catch((err) => {
          console.error('[slack-socket] Reconnect failed:', (err as Error).message);
          // Schedule one more attempt after MAX_BACKOFF to avoid permanent death
          if (this.started) {
            setTimeout(() => {
              if (this.started && !this.reconnecting && this.epoch === myEpoch) {
                this._backoffReconnect().catch(() => {});
              }
            }, MAX_BACKOFF_MS);
          }
        });
      }
    });

    sock.addEventListener('error', () => {
      // Error event is always followed by close event — handle reconnection there
    });
  }

  private async _handleRawMessage(raw: string): Promise<void> {
    let envelope: SocketModeEnvelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      console.error('[slack-socket] Failed to parse WebSocket message');
      return;
    }


    // Handle disconnect events (no envelope_id to ack)
    if (envelope.type === 'disconnect') {
      const reason = (envelope.payload as Record<string, string>)?.reason
        ?? (envelope as unknown as Record<string, unknown>).reason as string
        ?? 'unknown';
      this._handleDisconnect(reason);
      return;
    }

    // Acknowledge immediately (must be within 3 seconds). Route through the
    // _safeSend funnel: during a reconnect race the socket can be mid-transition
    // (CONNECTING / CLOSING), and an unguarded send on a non-OPEN socket throws —
    // which, uncaught in this async message handler, crashed the whole server
    // (the observed "Sent before connected" FATAL after a sleep/wake reconnect).
    // No reconnect on a failed ack: a single failed ack does not prove the socket
    // is dead, and reconnecting per-envelope would risk an epoch-churn storm —
    // Slack redelivers the unacked event, and the 30s heartbeat is the recovery
    // bound for a genuinely-dead socket.
    if (envelope.envelope_id) {
      this._safeSend(JSON.stringify({ envelope_id: envelope.envelope_id }), 'ack');
    }

    // Process event with exception guard (post-ack — Slack won't redeliver)
    try {
      if (envelope.type === 'interactive') {
        await this.handlers.onInteraction(envelope.payload);
      } else if (envelope.type === 'events_api') {
        const event = (envelope.payload as Record<string, unknown>).event as Record<string, unknown> | undefined;
        const eventType = event?.type as string ?? 'unknown';
        await this.handlers.onEvent(eventType, envelope.payload);
      }
    } catch (err) {
      console.error('[slack-socket] Event processing failed after ack:', (err as Error).message);
    }
  }

  private _handleDisconnect(reason: string): void {
    // Deliberate teardown — bumps the epoch, so the socket's late close event
    // (identity-guarded) and any in-flight open/backoff are all superseded.
    this._teardownSocket(1000, reason);
    this.handlers.onDisconnected(reason);

    if (!this.started) return;
    const myEpoch = this.epoch;

    if (reason === 'refresh_requested') {
      // Slack container rotation — reconnect immediately
      this._openConnection();
    } else if (reason === 'too_many_websockets') {
      // Wait 30s before reconnecting
      setTimeout(() => {
        if (this.started && this.epoch === myEpoch) this._openConnection();
      }, TOO_MANY_WS_DELAY_MS);
    } else {
      this._backoffReconnect();
    }
  }

  private async _backoffReconnect(): Promise<void> {
    if (this.reconnecting || !this.started) return;
    const myEpoch = this.epoch;
    this.reconnecting = true;
    this.consecutiveErrors++;

    // Exponential backoff from first attempt: 1s, 2s, 4s, 8s... max 60s
    const delay = Math.min(1000 * Math.pow(2, this.consecutiveErrors - 1), MAX_BACKOFF_MS);
    await new Promise(r => setTimeout(r, delay));

    this.reconnecting = false;
    // An explicit reconnect()/disconnect() may have superseded this sleeper —
    // opening here anyway would create a second, untracked connection (#1076).
    if (this.started && this.epoch === myEpoch) {
      await this._openConnection();
    }
  }

  private _startHeartbeat(): void {
    this._clearHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      // 1. Check if WebSocket is still in OPEN state
      if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
        console.warn(`[slack-socket] WebSocket readyState=${this.ws.readyState} (not OPEN), forcing reconnect`);
        this._forceReconnect();
        return;
      }

      // 2. If no events for DEAD_SILENCE_MS, send a probe to test the connection.
      //    Slack Socket Mode has no application-level ping/pong — Slack will
      //    silently ignore any JSON we send. So we test with send(): if it
      //    throws, the socket is dead at the OS level → force reconnect.
      //    If send() succeeds, the TCP connection is alive — reset the silence
      //    timer and check again later.
      const sinceLastEvent = Date.now() - this.lastEventAt;
      if (sinceLastEvent > DEAD_SILENCE_MS) {
        console.log(`[slack-socket] No events for ${Math.round(sinceLastEvent / 60000)}m — sending liveness probe`);
        // Route through the funnel with reconnectOnFailure: a probe that throws
        // means the socket is dead at the OS level → _safeSend forces a reconnect.
        if (this._safeSend('{"type":"ping"}', 'liveness-probe', true)) {
          // send() succeeded → TCP connection is alive. Reset silence timer
          // so we don't immediately re-probe on the next tick.
          this.lastEventAt = Date.now();
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private _forceReconnect(): void {
    this._teardownSocket(1000, 'force reconnect');
    // Trigger reconnect directly instead of relying on close event — the
    // torn-down socket's close is identity-guarded and will be ignored.
    if (this.started && !this.reconnecting) {
      this._backoffReconnect().catch(() => {});
    }
  }

  private _clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private _drainQueue(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Iterate a snapshot by index. If a send fails mid-drain (socket went down),
    // retain the unsent tail (this item + the rest) for the next 'open' drain
    // rather than silently dropping it. Remove-only — never grows the queue, so
    // length stays <= MAX_OUTBOUND_QUEUE. Single-threaded synchronous loop, so
    // no concurrent queueOutbound can interleave with the reassignment.
    const pending = this.outboundQueue;
    for (let k = 0; k < pending.length; k++) {
      if (!this._safeSend(pending[k].data, 'drain')) {
        this.outboundQueue = pending.slice(k);
        return;
      }
    }
    this.outboundQueue = [];
  }
}

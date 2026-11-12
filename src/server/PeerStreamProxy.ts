/**
 * PeerStreamProxy — phase 1 of Pool Dashboard Streaming
 * (POOL-DASHBOARD-STREAM-SPEC §2.2, the scalability core).
 *
 * ONE multiplexed upstream connection per PEER machine, shared by every local
 * dashboard client and every remote session on that peer. The local
 * WebSocketManager (phase 2) owns local clients and the browser WS; this class
 * owns ONLY the single upstream link and the bookkeeping that makes it correct:
 *
 *  - reference-counted subscriptions (per (session) → set of local clientIds);
 *  - a 60s idle grace after the last unsubscribe, cancelled if a subscribe
 *    arrives during it (no thrash opening/closing on a flapping client);
 *  - ONE bounded reconnect on an upstream drop, resubscribing every current
 *    subscription; a reconnect that does not open within reconnectTimeoutMs, or
 *    a second drop, surfaces `machine-unreachable` (P19 — never a reconnect
 *    storm);
 *  - subscriptions that arrive mid-(re)connect are QUEUED and merged into the
 *    resubscribe batch the moment the link opens — never lost;
 *  - the peer URL is re-resolved on every subscribe; a changed URL tears the
 *    old link down and opens a new one (no stale-URL duplicate links).
 *
 * Everything external is injected (transport, timers, clock) so the whole state
 * machine is deterministically unit-testable without real sockets or wall time.
 * This module performs NO tmux capture and NO local fan-out polling — capture
 * happens only on the owning machine; fan-out to local clients is the injected
 * `onFrameToClients`. (TAP POINT, ops#1: remote subs never enter the local
 * polling loop.)
 */

// E2E-PAIRING: EXEMPT — phase-1 module with NO route/boot wiring (zero runtime
// reachability yet). The Tier-3 "feature is alive" e2e lands in phase 2, when
// the WebSocketManager consumes this proxy and the /pool-stream route exists.
// Phase 1 is exhaustively covered at Tier 1 (tests/unit/PeerStreamProxy.test.ts).
export type ProxyState = 'idle' | 'connecting' | 'active' | 'idle-scheduled' | 'closing' | 'closed';

/** A live upstream connection handle (one peer's /ws/pool-stream). */
export interface UpstreamTransport {
  /** Send a frame to the peer (subscribe/unsubscribe/input/key/history). */
  send(frame: Record<string, unknown>): void;
  /** Tear the connection down. Idempotent. */
  close(): void;
}

/** Handlers the proxy gives the transport at connect time. */
export interface UpstreamHandlers {
  /** The link opened and is ready to carry frames. */
  onOpen(): void;
  /** A frame arrived from the peer (output/history/session_ended/error/…). */
  onFrame(frame: Record<string, unknown>): void;
  /** The link closed (clean or error). */
  onClose(): void;
}

export type TimerHandle = { __brand: 'PeerStreamProxyTimer' };

export interface PeerStreamProxyDeps {
  peerMachineId: string;
  /** Resolve the peer's CURRENT url (re-read each subscribe for URL-change detection). */
  resolveUrl: () => string | null;
  /** Open an upstream link to `url`; the returned transport drives `handlers`. */
  connect: (url: string, handlers: UpstreamHandlers) => UpstreamTransport;
  /** Fan a peer frame out to every LOCAL client subscribed to (session). */
  onFrameToClients: (session: string, frame: Record<string, unknown>) => void;
  /** Surface an error to every local client subscribed to (session). */
  onError: (session: string, code: 'peer-stream-lost' | 'machine-unreachable', detail?: string) => void;
  now: () => number;
  setTimer: (ms: number, fn: () => void) => TimerHandle;
  clearTimer: (t: TimerHandle) => void;
  /** Idle grace before closing an unsubscribed link (default 60_000). */
  idleGraceMs?: number;
  /** Reconnect open deadline (default 10_000). */
  reconnectTimeoutMs?: number;
  logger?: (line: string) => void;
}

const DEFAULT_IDLE_GRACE_MS = 60_000;
const DEFAULT_RECONNECT_TIMEOUT_MS = 10_000;

export class PeerStreamProxy {
  private state: ProxyState = 'idle';
  private transport: UpstreamTransport | null = null;
  private connectedUrl: string | null = null;
  /** session → set of local clientIds subscribed to it. THE source of truth:
   *  on every (re)open we resubscribe from this map, so a subscribe that
   *  arrives mid-connect is never lost and a mid-connect unsubscribe is never
   *  replayed. */
  private readonly subs = new Map<string, Set<string>>();
  private idleTimer: TimerHandle | null = null;
  private reconnectTimer: TimerHandle | null = null;
  private reconnectUsed = false;
  /** native-conversation-any-machine-access §3e item 1: the last `input_caps`
   *  per session for the CURRENT link, replayed to a client that subscribes
   *  after the link is active. Cleared whenever the link or the session's
   *  upstream subscription goes away. */
  private readonly caps = new Map<string, Record<string, unknown>>();
  /** Sessions whose upstream `subscribe` has been sent on the current link and
   *  whose serving machine has not yet said what it can do. */
  private readonly awaitingCaps = new Set<string>();

  constructor(private readonly d: PeerStreamProxyDeps) {}

  get currentState(): ProxyState {
    return this.state;
  }
  /** Total live subscriptions across all sessions (refcount). */
  get refCount(): number {
    let n = 0;
    for (const set of this.subs.values()) n += set.size;
    return n;
  }
  /** Snapshot of session → clientIds (tests / introspection). */
  sessionsView(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [s, set] of this.subs) out[s] = [...set];
    return out;
  }

  private log(line: string): void {
    this.d.logger?.(`[peer-stream-proxy ${this.d.peerMachineId}] ${line}`);
  }

  // ── subscribe / unsubscribe (refcounted) ───────────────────────────────

  /** A local client subscribes to a remote session on this peer. */
  subscribe(session: string, clientId: string): void {
    if (this.state === 'closed') {
      this.log('subscribe after close — ignored');
      return;
    }
    // Cancel a pending idle close — we have demand again.
    if (this.idleTimer) {
      this.d.clearTimer(this.idleTimer);
      this.idleTimer = null;
      if (this.state === 'idle-scheduled') this.state = 'active';
    }
    let set = this.subs.get(session);
    if (!set) {
      set = new Set();
      this.subs.set(session, set);
    }
    const firstForSession = set.size === 0;
    set.add(clientId);

    // URL re-resolution (stale-URL guard): if the peer moved, reconnect fresh.
    const url = this.d.resolveUrl();
    if (this.state === 'active' && this.connectedUrl && url && url !== this.connectedUrl) {
      this.log(`peer url changed (${this.connectedUrl} → ${url}); reconnecting`);
      this.teardownTransport();
      this.openFresh(url);
      return; // openFresh replays ALL current subs (incl. this one) on open
    }

    if (this.state === 'idle' || this.state === 'closing') {
      // No link yet → open one; openFresh flushes all subs on open.
      if (!url) {
        // No reachable URL — honest failure, drop the just-added sub for it.
        set.delete(clientId);
        if (set.size === 0) this.subs.delete(session);
        this.d.onError(session, 'machine-unreachable', 'no url for peer');
        return;
      }
      this.openFresh(url);
      return;
    }
    if (this.state === 'active') {
      // Link is live → forward only when this is the first client for the
      // session (the upstream is already streaming it for any later client).
      if (firstForSession) this.sendSubscribe(session);
      return;
    }
    // connecting → the sub is now in `subs`; onUpstreamOpen resubscribes from
    // `subs`, so it is automatically included in the batch (never lost).
  }

  /** A local client unsubscribes (or disconnects). */
  unsubscribe(session: string, clientId: string): void {
    const set = this.subs.get(session);
    if (!set) return;
    set.delete(clientId);
    if (set.size === 0) {
      this.subs.delete(session);
      this.caps.delete(session);
      this.awaitingCaps.delete(session);
      if (this.state === 'active') this.transport?.send({ type: 'unsubscribe', session });
    }
    if (this.refCount === 0) this.scheduleIdleClose();
  }

  /** Forward an input/key frame for a session (the SERVING machine gates
   *  allowRemoteInput). Returns false when the frame was not sent: the link is
   *  not active, so the input is dropped (we never queue keystrokes across a
   *  reconnect — stale input is worse than none) and the caller answers
   *  `peer-stream-lost` to the sender (§3e item 3). */
  relayInput(frame: Record<string, unknown>): boolean {
    return this.relayFrame(frame);
  }

  /** The serving machine's last `input_caps` for this session on the current
   *  link, for replay to a client that subscribes after the link is active.
   *  Null while the link is not active or the machine has not answered yet. */
  inputCaps(session: string): Record<string, unknown> | null {
    if (this.state !== 'active' && this.state !== 'idle-scheduled') return null;
    return this.caps.get(session) ?? null;
  }

  /** Forward a read-only request frame (e.g. a `history` scrollback fetch) to
   *  the owning machine. Spec §2.2: capture happens ONLY on the owning machine
   *  — history for a remote session must travel upstream, never hit local
   *  tmux. Dropped unless the link is active (a request racing a reconnect is
   *  simply re-issued by the user's next scroll; stale queued requests are
   *  worse than none). */
  relayFrame(frame: Record<string, unknown>): boolean {
    if (this.state !== 'active' || !this.transport) return false;
    try {
      this.transport.send(frame);
      return true;
    } catch (e) {
      this.log(`relay send threw: ${(e as Error)?.message ?? e}`);
      return false;
    }
  }

  /** Send the upstream subscribe and start waiting for the serving machine's
   *  `input_caps` for this session on this link. */
  private sendSubscribe(session: string): void {
    this.caps.delete(session);
    this.awaitingCaps.add(session);
    this.transport?.send({ type: 'subscribe', session });
  }

  // ── connection lifecycle ───────────────────────────────────────────────

  private openFresh(url: string, reconnect = false): void {
    // A user-initiated open resets the one-shot reconnect budget; a reconnect
    // leaves `reconnectUsed` true so a further drop → machine-unreachable.
    if (!reconnect) this.reconnectUsed = false;
    this.state = 'connecting';
    this.connectedUrl = url;
    const handlers: UpstreamHandlers = {
      onOpen: () => this.onUpstreamOpen(),
      onFrame: (f) => this.onUpstreamFrame(f),
      onClose: () => this.onUpstreamClose(),
    };
    try {
      this.transport = this.d.connect(url, handlers);
    } catch (e) {
      this.log(`connect threw: ${(e as Error)?.message ?? e}`);
      this.onUpstreamClose();
    }
  }

  private onUpstreamOpen(): void {
    if (this.state === 'closed') {
      this.transport?.close();
      return;
    }
    this.state = 'active';
    if (this.reconnectTimer) {
      this.d.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Resubscribe from `subs` (the source of truth) — this naturally includes
    // any subscribe that arrived mid-connect and excludes any mid-connect
    // unsubscribe. No stale snapshot to lose.
    this.caps.clear();
    this.awaitingCaps.clear();
    for (const session of this.subs.keys()) this.sendSubscribe(session);
    // If nothing is subscribed anymore (all unsubscribed during connect), idle-close.
    if (this.refCount === 0) this.scheduleIdleClose();
  }

  private onUpstreamFrame(frame: Record<string, unknown>): void {
    const session = typeof frame.session === 'string' ? frame.session : null;
    if (!session) return; // peer frames without a session are not fan-out-able
    // Only fan out to sessions we still have local subscribers for.
    if (!this.subs.has(session)) return;
    if (frame.type === 'input_caps') {
      // A current serving machine says what it can do, first, for each subscribe.
      this.awaitingCaps.delete(session);
      const caps = { type: 'input_caps', session, inputAck: frame.inputAck === 2 ? 2 : 1, remoteInput: frame.remoteInput === true ? true : frame.remoteInput === false ? false : null };
      this.caps.set(session, caps);
      this.d.onFrameToClients(session, caps);
      return;
    }
    if (this.awaitingCaps.has(session) && frame.type === 'subscribed') {
      // An older serving machine answers the subscribe without `input_caps`: it
      // cannot acknowledge by id or recognise a repeat, so say so for it.
      this.awaitingCaps.delete(session);
      const caps = { type: 'input_caps', session, inputAck: 1, remoteInput: null };
      this.caps.set(session, caps);
      this.d.onFrameToClients(session, caps);
    }
    this.d.onFrameToClients(session, frame);
  }

  private onUpstreamClose(): void {
    if (this.state === 'closed' || this.state === 'closing') {
      this.state = 'closed';
      return;
    }
    this.transport = null;
    this.caps.clear();
    this.awaitingCaps.clear();
    // Nothing subscribed → just go idle, no reconnect.
    if (this.refCount === 0) {
      this.state = 'idle';
      return;
    }
    if (this.reconnectUsed) {
      // Second failure → declare the peer unreachable for every affected session.
      this.log('second upstream drop → machine-unreachable');
      this.failAll('machine-unreachable', 'peer unreachable after reconnect');
      return;
    }
    // First drop → tell clients, attempt ONE bounded reconnect.
    for (const session of this.subs.keys()) this.d.onError(session, 'peer-stream-lost', 'upstream dropped');
    this.reconnectUsed = true;
    const url = this.d.resolveUrl();
    if (!url) {
      this.failAll('machine-unreachable', 'no url on reconnect');
      return;
    }
    this.openFresh(url, true);
    // Bound the reconnect: if it doesn't open in time, declare unreachable.
    this.reconnectTimer = this.d.setTimer(this.d.reconnectTimeoutMs ?? DEFAULT_RECONNECT_TIMEOUT_MS, () => {
      this.reconnectTimer = null;
      if (this.state !== 'active') {
        this.log('reconnect timed out → machine-unreachable');
        this.teardownTransport();
        this.failAll('machine-unreachable', 'reconnect timed out');
      }
    });
  }

  private scheduleIdleClose(): void {
    if (this.idleTimer || this.state === 'closed') return;
    if (this.state === 'active') this.state = 'idle-scheduled';
    this.idleTimer = this.d.setTimer(this.d.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS, () => {
      this.idleTimer = null;
      if (this.refCount === 0) {
        this.log('idle grace elapsed → closing');
        this.teardownTransport();
        this.state = 'closed';
      }
    });
  }

  private failAll(code: 'machine-unreachable' | 'peer-stream-lost', detail: string): void {
    for (const session of this.subs.keys()) this.d.onError(session, code, detail);
    this.subs.clear();
    this.teardownTransport();
    this.state = 'closed';
  }

  private teardownTransport(): void {
    this.caps.clear();
    this.awaitingCaps.clear();
    if (this.reconnectTimer) {
      this.d.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.transport?.close();
    } catch { /* @silent-fallback-ok: closing an already-dead upstream is best-effort */ }
    this.transport = null;
    this.connectedUrl = null;
  }

  /** Force-close (peer removed, server shutdown). Idempotent. */
  close(): void {
    if (this.idleTimer) {
      this.d.clearTimer(this.idleTimer);
      this.idleTimer = null;
    }
    this.subs.clear();
    this.teardownTransport();
    this.state = 'closed';
  }
}

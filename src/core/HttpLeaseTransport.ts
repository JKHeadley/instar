/**
 * HttpLeaseTransport — the low-latency wire path for the fenced lease (spec §6:
 * "the low-latency authoritative copy of the lease travels over the tunnel").
 *
 * Implements LeaseTransport over the existing authenticated machine-to-machine
 * HTTP channel (signRequest + machineAuthMiddleware, the same path /api/heartbeat
 * uses). The git copy remains the durable audit/CAS substrate; this transport
 * ACCELERATES acquisition + carries renewals, and a holder that cannot reach
 * peers for > leaseTtlMs self-suspends (the renewal-requires-medium rule).
 *
 * observed() returns the freshest lease this machine has RECEIVED from a peer
 * (fed by the /api/lease endpoint via recordObserved) plus the per-holder nonce
 * map for replay detection. isReachable() reflects whether a recent broadcast
 * reached at least one peer.
 *
 * The HTTP layer is injected (fetchImpl) so the broadcast/observe/reachability
 * logic is unit-testable without a network.
 */

import { signRequest, verifyLeaseAck, verifyLeaseAckIdentity, newReqNonce, type LeaseAck } from '../server/machineAuth.js';
import { PeerFailureLogGate } from './PeerFailureLogGate.js';
import type { PeerEndpointResolver, ResolvedEndpoint } from './PeerEndpointResolver.js';
import type { PeerEndpointRecorder } from './PeerEndpointRecorder.js';
import type { LeaseTransport } from './LeaseCoordinator.js';
import type { LeaseRecord, MeshEndpoint } from './types.js';

export interface LeasePeer {
  machineId: string;
  /** Base URL of the peer (its lastKnownUrl / tunnel URL — the cloudflare rope). */
  url: string;
  /**
   * multi-transport-mesh-comms — the peer's advertised endpoint set (Tailscale/
   * LAN/Cloudflare). When present + the resolver is injected, the transport hedges
   * across these ropes. Absent ⇒ resolves to the single `url` (today's behavior).
   */
  endpoints?: MeshEndpoint[];
  /** The peer's Ed25519 public key (PEM) — required to verify its accept-ack. */
  publicKeyPem?: string | null;
  /**
   * True when the peer is known to support the freshness-bound accept-ack (its
   * protocolVersion is at/above the mesh-ack version). When true the transport
   * REQUIRES a verified ack to count a rope confirmed (fail-closed); when false
   * (an un-upgraded peer) it accepts a 2xx (back-compat for a rolling deploy).
   */
  meshAckCapable?: boolean;
}

export interface HttpLeaseTransportDeps {
  selfMachineId: string;
  signingKeyPem: string;
  /** Resolve the current set of reachable peers (excludes self). */
  peers: () => LeasePeer[];
  /** Monotonic per-request sequence (reuse the machine's nonce/sequence source). */
  nextSequence: () => number;
  /** Injected fetch (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** How recent a successful broadcast counts as "reachable". Default = leaseTtlMs. */
  reachabilityWindowMs?: number;
  /**
   * Per-request abort timeout (P19 brake: a hung socket must not wedge the
   * caller's fixed-cadence loop — the pull loop's `leasePulling` guard would
   * otherwise stay held forever). Default 30s: the timeout must sit ABOVE the
   * fleet's documented 5–40s receiver-side event-loop-stall envelope's bulk —
   * a slow-but-alive peer must NOT be converted into "no medium", because a
   * failed broadcast feeds the renewal path's self-suspend (second-pass
   * reviewer finding). A truly hung socket never returns, so 30s bounds the
   * wedge exactly as well as a smaller value would. server.ts derives this
   * from leaseTtlMs (min(ttl/2, 30s)).
   */
  requestTimeoutMs?: number;
  /**
   * Coarse-reminder interval for the per-peer failure log gate (P19 brake:
   * per-attempt logging is amplification — a down peer at a 5s cadence wrote
   * ~17k lines/day). Default 360 consecutive failures (~30min at 5s).
   */
  failureLogEveryN?: number;
  now?: () => number;
  logger?: (msg: string) => void;
  /**
   * multi-transport-mesh-comms — when present, the transport hedges across each
   * peer's resolved endpoints (Layer 2). Absent ⇒ the legacy single-`url` path
   * (byte-for-byte today's behavior). Gated live by `meshTransportEnabled`.
   */
  resolver?: PeerEndpointResolver;
  /** Read live: false ⇒ legacy single-rope path even when a resolver is wired. Default true when resolver present. */
  meshTransportEnabled?: () => boolean;
  /** Hedge delay before firing the remaining ropes in parallel. Default 1500ms. */
  hedgeDelayMs?: number;
  /**
   * mesh-endpoint-http-propagation — this machine's OWN validated self-endpoints,
   * carried INSIDE the signed lease RPC body (broadcast + pull request bodies, and
   * the pull RESPONSE the holder serves) so a git-less peer learns our fast ropes
   * over the lease channel instead of via the inert git registry-sync path. Absent
   * (or returns undefined/[]) ⇒ the field is simply omitted (un-upgraded behavior).
   */
  getSelfEndpoints?: () => MeshEndpoint[] | undefined;
  /**
   * mesh-endpoint-http-propagation — the chokepoint that records a peer's advertised
   * endpoints into THIS machine's registry. Used on the pull RESPONSE path: after a
   * CONFIRMED pull (responder identity cryptographically verified by interpretResponse),
   * the holder's endpoints from the response body are recorded against the dialed
   * `peer.machineId` (the verified responder). Absent ⇒ pull-response recording is a
   * no-op (the receiver routes still record request-direction endpoints).
   */
  peerEndpointRecorder?: PeerEndpointRecorder;
}

export class HttpLeaseTransport implements LeaseTransport {
  private readonly d: HttpLeaseTransportDeps;
  private lastObserved: LeaseRecord | null = null;
  private lastNonceByHolder: Record<string, number> = {};
  private lastBroadcastOkAt = 0;
  private lastPullOkAt = 0;
  private readonly windowMs: number;
  private readonly requestTimeoutMs: number;
  /** State-change failure logging (first/Nth/recovery) — never per-attempt. */
  private readonly logGate: PeerFailureLogGate;

  constructor(deps: HttpLeaseTransportDeps) {
    this.d = deps;
    this.windowMs = deps.reachabilityWindowMs ?? 60_000;
    this.requestTimeoutMs = deps.requestTimeoutMs ?? 30_000;
    this.logGate = new PeerFailureLogGate(deps.failureLogEveryN ?? 360);
  }

  /** Gated failure/recovery logging — emits only on state changes + coarse reminders. */
  private logFailure(key: string, detail: string): void {
    const line = this.logGate.failed(key, detail);
    if (line) this.log(line);
  }
  private logSuccess(key: string): void {
    const line = this.logGate.succeeded(key);
    if (line) this.log(line);
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }
  private log(m: string): void {
    this.d.logger?.(`[lease-wire] ${m}`);
  }

  /**
   * Broadcast our lease to every peer over the authenticated channel. Resolves
   * true if at least one peer accepted (we have a live medium); false if none
   * were reachable.
   */
  async broadcast(lease: LeaseRecord): Promise<boolean> {
    const peers = this.d.peers();
    if (peers.length === 0) {
      // No peers → a single-machine mesh; treat as "reachable" (nothing to fail).
      this.lastBroadcastOkAt = this.now();
      return true;
    }
    const results = await Promise.all(
      peers.map((peer) => this.dialPeer(peer, '/api/lease', { lease }, lease.epoch)),
    );
    const anyOk = results.some((r) => r.confirmed);
    if (anyOk) this.lastBroadcastOkAt = this.now();
    return anyOk;
  }

  private meshOn(): boolean {
    if (!this.d.resolver) return false;
    return this.d.meshTransportEnabled ? this.d.meshTransportEnabled() : true;
  }

  /**
   * Dial one peer over its resolved endpoints with hedged failover (Decision 3):
   * try the best (last-known-good / due) rope first; after `hedgeDelayMs` fire the
   * remaining ropes in parallel; the first rope that genuinely CONFIRMS wins and
   * the losers are aborted. Confirmation = a verified accept-ack from the expected
   * peer (Decision 9) for an ack-capable peer, else a 2xx (back-compat). When the
   * mesh path is off (no resolver / disabled) it is the legacy single-`url` dial.
   */
  private async dialPeer(
    peer: LeasePeer,
    path: '/api/lease' | '/api/lease/pull',
    bodyBase: Record<string, unknown>,
    sentEpoch: number | null,
  ): Promise<{ confirmed: boolean; lease: LeaseRecord | null }> {
    const fetchImpl = this.d.fetchImpl ?? fetch;
    // mesh-endpoint-http-propagation — carry our own validated self-endpoints inside
    // the SIGNED body (covered by signRequest's body hash). Omit the field entirely
    // when we have none, so an un-upgraded peer sees byte-for-byte today's body.
    const selfEndpoints = this.d.getSelfEndpoints?.();
    const withSelf =
      Array.isArray(selfEndpoints) && selfEndpoints.length > 0
        ? { ...bodyBase, endpoints: selfEndpoints }
        : bodyBase;
    bodyBase = withSelf;
    if (!this.meshOn()) {
      return this.legacyDial(peer, path, bodyBase, fetchImpl);
    }
    const resolved = this.d.resolver!.resolve(peer.machineId, peer.endpoints, peer.url);
    if (resolved.length === 0) return { confirmed: false, lease: null };

    const attempt = async (ep: ResolvedEndpoint, signal: AbortSignal) => {
      const reqNonce = newReqNonce();
      const body = { ...bodyBase, reqNonce };
      const headers = signRequest(this.d.selfMachineId, this.d.signingKeyPem, body, this.d.nextSequence());
      const started = this.now();
      try {
        const res = await fetchImpl(`${ep.url.replace(/\/$/, '')}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(body),
          signal: mergeSignals(signal, AbortSignal.timeout(this.requestTimeoutMs)),
        });
        const httpOk = !!res && (res as Response).ok;
        const data = httpOk ? ((await (res as Response).json().catch(() => null)) as MeshAckResponse | null) : null;
        const outcome = this.interpretResponse(peer, path, reqNonce, sentEpoch, data, httpOk);
        this.d.resolver!.recordResult(peer.machineId, ep.kind, outcome.confirmed, this.now() - started);
        if (outcome.confirmed) this.logSuccess(`${path} ${peer.machineId}/${ep.kind}`);
        else this.logFailure(`${path} ${peer.machineId}/${ep.kind}`, 'unconfirmed');
        return outcome;
      } catch (err) {
        // U4.3 R-r2-1 (REQUIRED transport fix) — hedge-abort neutrality: when the
        // hedge WINNER's finish() aborted this loser attempt (the hedge controller's
        // `signal` is aborted and the rejection is abort-shaped), record NEUTRALLY —
        // never recordResult(false). Without this, a recovering rope dialed as a
        // hedge loser had its recoveryStreak reset perpetually by its healthy
        // sibling's win (the week-long presumed-dead Tailscale rope). A real dial
        // failure (network error, or OUR per-attempt timeout — whose abort fires the
        // MERGED signal, not the hedge controller's) still records failure.
        const abortedByWinner = signal.aborted && isAbortShapedError(err);
        if (!abortedByWinner) {
          this.d.resolver!.recordResult(peer.machineId, ep.kind, false, this.now() - started);
          this.logFailure(`${path} ${peer.machineId}/${ep.kind}`, err instanceof Error ? err.message : String(err));
        }
        return { confirmed: false, lease: null as LeaseRecord | null };
      }
    };

    return this.hedge(resolved, attempt);
  }

  /** Legacy single-`url` dial — byte-for-byte today (2xx = confirmed, no ack). */
  private async legacyDial(
    peer: LeasePeer,
    path: '/api/lease' | '/api/lease/pull',
    bodyBase: Record<string, unknown>,
    fetchImpl: typeof fetch,
  ): Promise<{ confirmed: boolean; lease: LeaseRecord | null }> {
    try {
      const headers = signRequest(this.d.selfMachineId, this.d.signingKeyPem, bodyBase, this.d.nextSequence());
      const res = await fetchImpl(`${peer.url.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(bodyBase),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      const httpOk = !!res && (res as Response).ok;
      if (!httpOk) {
        this.logFailure(`${path} to ${peer.machineId}`, `status ${(res as Response)?.status}`);
        return { confirmed: false, lease: null };
      }
      this.logSuccess(`${path} to ${peer.machineId}`);
      if (path === '/api/lease/pull') {
        const data = (await (res as Response).json().catch(() => null)) as { lease?: LeaseRecord | null } | null;
        return { confirmed: true, lease: data?.lease ?? null };
      }
      return { confirmed: true, lease: null };
    } catch (err) {
      this.logFailure(`${path} to ${peer.machineId}`, err instanceof Error ? err.message : String(err));
      return { confirmed: false, lease: null };
    }
  }

  /** Interpret a mesh response (accept-ack semantics, Decision 9). */
  private interpretResponse(
    peer: LeasePeer,
    path: '/api/lease' | '/api/lease/pull',
    sentReqNonce: string,
    sentEpoch: number | null,
    data: MeshAckResponse | null,
    httpOk: boolean,
  ): { confirmed: boolean; lease: LeaseRecord | null } {
    if (!httpOk) return { confirmed: false, lease: null };
    const ackCapable = !!peer.meshAckCapable && !!peer.publicKeyPem;
    if (path === '/api/lease/pull') {
      const folded = data?.lease ?? null;
      if (!ackCapable) return { confirmed: true, lease: folded }; // legacy 2xx
      const idOk = verifyLeaseAckIdentity(data?.ack, data?.sig, peer.machineId, sentReqNonce, peer.publicKeyPem as string);
      // mesh-endpoint-http-propagation (pull RESPONSE, the live-bug fix): record the
      // HOLDER's advertised endpoints ONLY when the responder identity is verified
      // (idOk). Bound to the DIALED `peer.machineId` — never a self-asserted body
      // field — so a compromised responder can't inject a third machine's ropes. The
      // recorder is itself gated (meshTransport), validating, and idempotent.
      if (idOk && this.d.peerEndpointRecorder) {
        this.d.peerEndpointRecorder.record(peer.machineId, data?.endpoints);
      }
      return { confirmed: idOk, lease: idOk ? folded : null };
    }
    // /api/lease (broadcast) — epoch-equality confirmation.
    if (!ackCapable) return { confirmed: true, lease: null }; // legacy 2xx back-compat
    const verdict = verifyLeaseAck(
      data?.ack,
      data?.sig,
      peer.machineId,
      sentReqNonce,
      sentEpoch ?? -1,
      peer.publicKeyPem as string,
    );
    // 'higher-epoch' is a real takeover signal — NOT a renewal confirmation.
    return { confirmed: verdict === 'confirmed', lease: null };
  }

  /**
   * Hedged race over an ordered endpoint list: fire endpoint[0] immediately, then
   * after hedgeDelayMs fire the rest in parallel; resolve on the FIRST confirmed
   * (aborting the losers), else return the last outcome once all settle.
   */
  private async hedge(
    endpoints: ResolvedEndpoint[],
    attempt: (ep: ResolvedEndpoint, signal: AbortSignal) => Promise<{ confirmed: boolean; lease: LeaseRecord | null }>,
  ): Promise<{ confirmed: boolean; lease: LeaseRecord | null }> {
    const controller = new AbortController();
    const hedgeMs = this.d.hedgeDelayMs ?? 1500;
    return new Promise((resolve) => {
      let settled = false;
      let pending = 0;
      let last: { confirmed: boolean; lease: LeaseRecord | null } = { confirmed: false, lease: null };
      const finish = (r: { confirmed: boolean; lease: LeaseRecord | null }) => {
        if (settled) return;
        settled = true;
        controller.abort();
        clearTimeout(hedgeTimer);
        resolve(r);
      };
      const fire = (ep: ResolvedEndpoint) => {
        pending += 1;
        attempt(ep, controller.signal)
          .then((r) => {
            last = r;
            if (r.confirmed) finish(r);
          })
          .catch(() => {})
          .finally(() => {
            pending -= 1;
            if (!settled && pending === 0 && !firedRest) {
              // first rope settled unconfirmed before the hedge timer → fire the rest now
              fireRest();
            } else if (!settled && pending === 0 && firedRest) {
              finish(last);
            }
          });
      };
      let firedRest = false;
      const fireRest = () => {
        if (firedRest) return;
        firedRest = true;
        const rest = endpoints.slice(1);
        if (rest.length === 0) {
          if (pending === 0) finish(last);
          return;
        }
        for (const ep of rest) fire(ep);
      };
      const hedgeTimer = setTimeout(() => {
        if (!settled) fireRest();
      }, hedgeMs);
      // kick off the best rope
      fire(endpoints[0]);
    });
  }

  observed(): { lease: LeaseRecord | null; lastNonceByHolder: Record<string, number> } {
    return { lease: this.lastObserved, lastNonceByHolder: { ...this.lastNonceByHolder } };
  }

  isReachable(): boolean {
    // Reachability is bidirectional: a successful broadcast (we pushed to a peer) OR
    // a successful pull (we reached a peer to read its lease) both prove a live
    // medium. A standby behind a one-way NAT — can pull but can't be pushed to — is
    // now correctly seen as connected.
    const last = Math.max(this.lastBroadcastOkAt, this.lastPullOkAt);
    return this.now() - last <= this.windowMs;
  }

  /**
   * Record a lease received from a peer (called by the /api/lease endpoint after
   * machine-auth verification). Keeps only the highest-epoch observed lease and
   * advances the per-holder nonce watermark (replay detection happens in
   * FencedLease.acceptTunnelLease which reads this map).
   *
   * multi-transport-mesh-comms — returns the resulting highest observed epoch (or
   * the just-folded lease's epoch), so the /api/lease receiver can sign a
   * freshness-bound accept-ack proving WHAT it folded (Decision 9). When this
   * machine already holds a HIGHER epoch than the broadcast (a takeover the
   * broadcaster hasn't seen), the returned epoch is that higher value — which the
   * caller reads as a stand-down signal, never a confirmation.
   */
  recordObserved(lease: LeaseRecord): number | undefined {
    if (!lease || typeof lease.epoch !== 'number') return undefined;
    const prevNonce = this.lastNonceByHolder[lease.holder] ?? -1;
    // Only accept a strictly-newer nonce for this holder (drop replays here too).
    if (lease.nonce <= prevNonce && this.lastObserved && this.lastObserved.epoch >= lease.epoch) {
      return this.lastObserved?.epoch;
    }
    if (lease.nonce > prevNonce) this.lastNonceByHolder[lease.holder] = lease.nonce;
    if (!this.lastObserved || lease.epoch >= this.lastObserved.epoch) {
      this.lastObserved = lease;
    }
    // The resulting observed epoch = max(what we held, the folded lease).
    return Math.max(this.lastObserved?.epoch ?? lease.epoch, lease.epoch);
  }

  /**
   * Active PULL (Cross-Machine Coherence): GET a peer's current lease over the
   * authenticated channel and fold it into our effective view via the SAME
   * recordObserved path the push receiver uses. This lets a standby *ask* for the
   * holder's lease instead of only waiting to be pushed to — so a quiet or one-way
   * network can't blind it. Returns the peer's lease (may name a third machine as
   * holder — re-served), or null when the peer has none / is unreachable.
   *
   * Uses POST /api/lease/pull with a signed empty body: machine-auth is body-hash
   * based (signs SHA256(body)), so a POST with `{}` authenticates cleanly where a
   * GET (whose body fetch would drop) cannot. A successful pull — even one that
   * returns no lease — proves reachability.
   */
  async pullPeer(peer: LeasePeer): Promise<LeaseRecord | null> {
    const outcome = await this.dialPeer(peer, '/api/lease/pull', {}, null);
    if (!outcome.confirmed) return null;
    // A confirmed pull (verified reachability) proves the medium is live.
    this.lastPullOkAt = this.now();
    const lease = outcome.lease;
    if (lease && typeof lease.epoch === 'number') {
      this.recordObserved(lease);
      return lease;
    }
    return null;
  }

  /**
   * Best-effort fan-out pull of every peer's lease. Failures are advisory (a peer
   * being unreachable is data, not an error) — mirrors broadcast()'s tolerance.
   * Cadence/jitter is owned by the caller (the standby loop), not here.
   */
  async pullAllPeers(): Promise<void> {
    const peers = this.d.peers();
    if (peers.length === 0) return;
    await Promise.all(peers.map((p) => this.pullPeer(p).catch(() => null)));
  }
}

/** The accept-ack-bearing shape of an /api/lease[/pull] response (Decision 9). */
interface MeshAckResponse {
  ok?: boolean;
  lease?: LeaseRecord | null;
  ack?: LeaseAck;
  sig?: string;
  /** mesh-endpoint-http-propagation — the holder's advertised endpoints (pull RESPONSE). */
  endpoints?: unknown;
}

/**
 * U4.3 R-r2-1 — is this rejection abort-shaped (a cancelled dial), as opposed to a
 * real network/protocol failure? fetch rejects an aborted request with a DOMException
 * named 'AbortError' (AbortSignal.timeout yields 'TimeoutError', which is a REAL
 * per-attempt failure — but that abort fires only the merged signal, so the caller's
 * hedge-controller `signal.aborted` check already excludes it unless a winner also
 * confirmed, in which case neutrality is the correct call anyway).
 */
export function isAbortShapedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  const code = (err as { code?: unknown }).code;
  return name === 'AbortError' || code === 'ABORT_ERR' || code === 20;
}

/** Combine two AbortSignals — aborts when either does (Node 20.3+ AbortSignal.any, with fallback). */
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn([a, b]);
  const c = new AbortController();
  const onAbort = () => c.abort();
  if (a.aborted || b.aborted) c.abort();
  else {
    a.addEventListener('abort', onAbort, { once: true });
    b.addEventListener('abort', onAbort, { once: true });
  }
  return c.signal;
}

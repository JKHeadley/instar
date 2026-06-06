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

import { signRequest } from '../server/machineAuth.js';
import { PeerFailureLogGate } from './PeerFailureLogGate.js';
import type { LeaseTransport } from './LeaseCoordinator.js';
import type { LeaseRecord } from './types.js';

export interface LeasePeer {
  machineId: string;
  /** Base URL of the peer (its lastKnownUrl / tunnel URL). */
  url: string;
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
    const fetchImpl = this.d.fetchImpl ?? fetch;
    let anyOk = false;
    await Promise.all(
      peers.map(async (peer) => {
        try {
          const body = { lease };
          const headers = signRequest(this.d.selfMachineId, this.d.signingKeyPem, body, this.d.nextSequence());
          const res = await fetchImpl(`${peer.url.replace(/\/$/, '')}/api/lease`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
            // P19 brake: a hung socket aborts instead of holding the caller open.
            signal: AbortSignal.timeout(this.requestTimeoutMs),
          });
          if (res && (res as Response).ok) {
            anyOk = true;
            this.logSuccess(`broadcast to ${peer.machineId}`);
          } else {
            this.logFailure(`broadcast to ${peer.machineId}`, `status ${(res as Response)?.status}`);
          }
        } catch (err) {
          this.logFailure(`broadcast to ${peer.machineId}`, err instanceof Error ? err.message : String(err));
        }
      }),
    );
    if (anyOk) this.lastBroadcastOkAt = this.now();
    return anyOk;
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
   */
  recordObserved(lease: LeaseRecord): void {
    if (!lease || typeof lease.epoch !== 'number') return;
    const prevNonce = this.lastNonceByHolder[lease.holder] ?? -1;
    // Only accept a strictly-newer nonce for this holder (drop replays here too).
    if (lease.nonce <= prevNonce && this.lastObserved && this.lastObserved.epoch >= lease.epoch) {
      return;
    }
    if (lease.nonce > prevNonce) this.lastNonceByHolder[lease.holder] = lease.nonce;
    if (!this.lastObserved || lease.epoch >= this.lastObserved.epoch) {
      this.lastObserved = lease;
    }
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
    const fetchImpl = this.d.fetchImpl ?? fetch;
    try {
      const body = {};
      const headers = signRequest(this.d.selfMachineId, this.d.signingKeyPem, body, this.d.nextSequence());
      const res = await fetchImpl(`${peer.url.replace(/\/$/, '')}/api/lease/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        // P19 brake: the pull loop's `leasePulling` guard means a hung socket
        // would wedge ALL future pulls — abort instead.
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (!res || !(res as Response).ok) {
        this.logFailure(`pull from ${peer.machineId}`, `status ${(res as Response)?.status}`);
        return null;
      }
      const data = (await (res as Response).json().catch(() => null)) as { lease?: LeaseRecord | null } | null;
      // A successful response (even one carrying no lease) proves the medium is live.
      this.lastPullOkAt = this.now();
      this.logSuccess(`pull from ${peer.machineId}`);
      const lease = data?.lease ?? null;
      if (lease && typeof lease.epoch === 'number') {
        this.recordObserved(lease);
        return lease;
      }
      return null;
    } catch (err) {
      this.logFailure(`pull from ${peer.machineId}`, err instanceof Error ? err.message : String(err));
      return null;
    }
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

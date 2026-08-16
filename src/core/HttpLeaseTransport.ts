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

  constructor(deps: HttpLeaseTransportDeps) {
    this.d = deps;
    this.windowMs = deps.reachabilityWindowMs ?? 60_000;
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
          });
          if (res && (res as Response).ok) anyOk = true;
        } catch (err) {
          this.log(`broadcast to ${peer.machineId} failed: ${err instanceof Error ? err.message : String(err)}`);
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
      });
      if (!res || !(res as Response).ok) return null;
      const data = (await (res as Response).json().catch(() => null)) as { lease?: LeaseRecord | null } | null;
      // A successful response (even one carrying no lease) proves the medium is live.
      this.lastPullOkAt = this.now();
      const lease = data?.lease ?? null;
      if (lease && typeof lease.epoch === 'number') {
        this.recordObserved(lease);
        return lease;
      }
      return null;
    } catch (err) {
      this.log(`pull from ${peer.machineId} failed: ${err instanceof Error ? err.message : String(err)}`);
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

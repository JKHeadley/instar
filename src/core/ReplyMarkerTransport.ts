/**
 * ReplyMarkerTransport — propagates the `reply_committed` marker from the lease
 * holder to the standby peer(s) over the authenticated machine channel (spec §8
 * G3a, "dual-medium sent-marker"). The cross-machine half of exactly-once.
 *
 * When the holder commits a reply, it broadcasts a small marker
 * {dedupeKey, replyIdempotencyKey, epoch, topic} to each standby. The standby
 * applies it via MessageProcessingLedger.applyRemoteReplyMarker, so AFTER a
 * handoff/failover the newly-awake machine already knows that event was answered
 * — a provider redelivery of the same inbound is then dropped by the dedup gate,
 * closing the cross-machine double-reply window the lease alone can't (a
 * redelivery arriving at the new holder for a message the OLD holder answered).
 *
 * The marker carries NO conversation content (just the dedupeKey + the
 * deterministic idempotency key + the fencing epoch), so unlike the live-tail it
 * is NOT encrypted — it rides the signed channel for authentication only. The
 * tunnel is the low-latency medium; git-committed ledger state is the slower
 * belt-and-suspenders (the residual is the documented Two-Generals floor).
 *
 * Single-machine safe: no peers → broadcast is a reachable no-op. fetch/clock
 * injected for testability.
 */

import { signRequest } from '../server/machineAuth.js';

export interface ReplyMarkerPeer {
  machineId: string;
  /** Base URL of the peer (its lastKnownUrl / tunnel URL). */
  url: string;
}

export interface ReplyMarker {
  dedupeKey: string;
  platform: string;
  replyIdempotencyKey: string;
  epoch: number;
  topic?: string | null;
}

export interface ReplyMarkerTransportDeps {
  selfMachineId: string;
  signingKeyPem: string;
  /** Resolve the standby peer(s) to propagate markers to (excludes self). */
  peers: () => ReplyMarkerPeer[];
  /** Monotonic per-request sequence for machine-auth replay protection. */
  nextSequence: () => number;
  fetchImpl?: typeof fetch;
  logger?: (msg: string) => void;
}

export class ReplyMarkerTransport {
  private readonly d: ReplyMarkerTransportDeps;

  constructor(deps: ReplyMarkerTransportDeps) {
    this.d = deps;
  }

  private log(m: string): void {
    this.d.logger?.(`[reply-marker] ${m}`);
  }

  /**
   * POST the marker to every standby peer over the signed channel. Resolves true
   * if at least one peer accepted (a live medium carried it); false if none was
   * reachable. No peers → reachable no-op (true). Never throws — propagation is
   * best-effort; the provider's at-least-once redelivery + the dedup gate are the
   * backstop if a marker is lost.
   */
  async broadcast(marker: ReplyMarker): Promise<boolean> {
    const peers = this.d.peers();
    if (peers.length === 0) return true;
    const fetchImpl = this.d.fetchImpl ?? fetch;
    let anyOk = false;
    await Promise.all(
      peers.map(async (peer) => {
        try {
          const body = { marker };
          const headers = signRequest(this.d.selfMachineId, this.d.signingKeyPem, body, this.d.nextSequence());
          const res = await fetchImpl(`${peer.url.replace(/\/$/, '')}/api/message-marker`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
          });
          if (res && (res as Response).ok) anyOk = true;
          else this.log(`peer ${peer.machineId} rejected marker ${marker.dedupeKey} (status ${(res as Response)?.status})`);
        } catch (err) {
          this.log(`broadcast to ${peer.machineId} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
    return anyOk;
  }
}

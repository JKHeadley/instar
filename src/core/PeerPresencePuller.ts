/**
 * PeerPresencePuller (Multi-Machine Session Pool — HTTP presence transport).
 *
 * The pool registry's notion of which peer machines are ONLINE was originally
 * fed only by the git-synced MachineHeartbeat: each machine writes its heartbeat
 * into the shared agent repo, peers pull it, and recency ⇒ online. That breaks
 * for a *credential-less standby* — a machine paired into the mesh over HTTP but
 * WITHOUT push access to the shared repo (e.g. a second machine gh-authed to a
 * different account). Its heartbeat never reaches the router, so the router
 * marks it offline and the placement engine refuses to transfer to it, even
 * though the two machines can reach each other perfectly over their tunnels.
 *
 * This puller closes that gap with a pull-based HTTP presence channel: on a
 * cadence, ask each reachable peer for its self-capacity over the signed
 * /mesh/rpc `session-status` command (a read-class command any registered peer
 * may issue) and record the answer into the local pool registry. A peer that
 * answers is, by definition, reachable + alive — so it goes online without ever
 * touching git. Symmetric by design: every mesh machine runs one, so each keeps
 * its own HTTP-sourced view of peer liveness, parallel to (and idempotent with)
 * the git-synced path for credentialed peers.
 *
 * Fully injected (peers, fetch, record, clock) so the loop logic is unit-testable
 * without a live mesh. `pullOnce()` NEVER throws — an unreachable peer simply is
 * not recorded this pass and ages out of `online` naturally via the registry's
 * failover threshold.
 */

/** A peer to consider polling: its machine id + resolved tunnel URL (null ⇒ unreachable). */
export interface PeerPresenceMachine {
  machineId: string;
  url: string | null;
}

/** The slice of a peer's self-capacity the puller records (from `session-status`). */
export interface PeerCapacity {
  selfReportedLastSeen?: string;
  loadAvg?: number;
}

export interface PeerPresencePullerDeps {
  /** This machine's id — never pulled (a machine doesn't poll itself). */
  selfMachineId: string;
  /** The current mesh peers (id + resolved URL). Re-read each pass so newly paired peers are picked up. */
  listPeers: () => PeerPresenceMachine[];
  /**
   * Send a signed `session-status` read to a peer and resolve its self-capacity,
   * or `null` if the peer did not answer / rejected. May reject; `pullOnce`
   * treats a rejection identically to a `null` (peer not recorded this pass).
   */
  fetchPeerCapacity: (machineId: string, url: string) => Promise<PeerCapacity | null>;
  /** Record an observed peer heartbeat into the pool registry (marks it online for the failover window). */
  recordHeartbeat: (obs: { machineId: string; selfReportedLastSeen: string; loadAvg?: number }) => void;
  /** Wall clock — injectable for tests. Defaults to `Date`. */
  now?: () => Date;
  /** Optional structured log line per pass (e.g. for the boot log). */
  log?: (line: string) => void;
}

export class PeerPresencePuller {
  constructor(private readonly d: PeerPresencePullerDeps) {}

  /**
   * One presence pass: poll every reachable peer in parallel and record any that
   * answer into the pool registry. Resolves with the ids recorded this pass.
   * Never rejects.
   */
  async pullOnce(): Promise<{ recorded: string[] }> {
    const peers = this.d.listPeers().filter((m) => m.machineId !== this.d.selfMachineId && !!m.url);
    const results = await Promise.all(
      peers.map(async (m): Promise<string | null> => {
        let cap: PeerCapacity | null = null;
        try {
          cap = await this.d.fetchPeerCapacity(m.machineId, m.url as string);
        } catch {
          cap = null; // unreachable / rejected → not recorded; ages out of online
        }
        if (!cap) return null;
        const seen = cap.selfReportedLastSeen ?? (this.d.now?.() ?? new Date()).toISOString();
        this.d.recordHeartbeat({ machineId: m.machineId, selfReportedLastSeen: seen, loadAvg: cap.loadAvg });
        return m.machineId;
      }),
    );
    const recorded = results.filter((r): r is string => r !== null);
    if (recorded.length && this.d.log) this.d.log(`recorded ${recorded.length} peer(s) online over HTTP: ${recorded.join(', ')}`);
    return { recorded };
  }
}

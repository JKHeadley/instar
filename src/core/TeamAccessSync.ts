/**
 * TeamAccessSync — how machines share the access log (team-roles-and-access, "Step 2b").
 *
 * Not the journal: that treats another machine's entry as forged and serves only a machine's own
 * stream, and rows here must be able to reach a machine through whoever has them. So a peer is asked
 * for what this machine lacks, by vector, and rows verify themselves on arrival.
 *
 * Nothing runs this yet: a second machine is still refused at the join.
 */
import type { TeamAccessLog, TeamAccessRow } from './TeamAccessLog.js';

export interface PeerRows { rows: TeamAccessRow[]; vector: Record<string, number> }

export interface SyncPeer { machineId: string; fetchRows(have: Record<string, number>): Promise<PeerRows> }

export interface PeerOutcome { machineId: string; answered: boolean; added: number; refused: number }

export type PullResult = { outcomes: PeerOutcome[]; anyAnswered: boolean; lastAnsweredAt: number | null };

/** Ask each peer for what is missing. A peer that does not answer is not an error: laptops sleep. */
export async function pullFromPeers(log: Pick<TeamAccessLog, 'vector' | 'ingest'>, peers: ReadonlyArray<SyncPeer>, now: () => number = Date.now): Promise<PullResult> {
  const outcomes: PeerOutcome[] = [];
  let lastAnsweredAt: number | null = null;
  for (const peer of peers) {
    try {
      const { rows } = await peer.fetchRows(log.vector());
      const { added, refused } = log.ingest(rows);
      outcomes.push({ machineId: peer.machineId, answered: true, added, refused });
      lastAnsweredAt = now();
    } catch {
      // @silent-fallback-ok — an unanswered pull is recorded in the outcome; pullStalenessBound judges it.
      outcomes.push({ machineId: peer.machineId, answered: false, added: 0, refused: 0 });
    }
  }
  return { outcomes, anyAnswered: outcomes.some((o) => o.answered), lastAnsweredAt };
}

/** Evidence a peer is awake: a heartbeat or a signed row. A closed lid produces none. */
export const AWAKE_EVIDENCE_MS = 5 * 60_000;
export const PULL_STALENESS_BOUND_MS = 15 * 60_000;

export interface PeerLiveness { machineId: string; lastEvidenceAt: number | null; firstUnansweredAt: number | null }

/**
 * Should this machine refuse its team phones? Only when a peer is known to be awake and has gone
 * unanswered past the bound. A laptop's closed lid gives no evidence, so it never stops anything;
 * a peer that is not pullable answers by pushing, which clears `firstUnansweredAt`.
 */
export function shouldRefuseForStaleness(peers: ReadonlyArray<PeerLiveness>, now: number): boolean {
  return peers.some((p) => p.lastEvidenceAt !== null && now - p.lastEvidenceAt <= AWAKE_EVIDENCE_MS
    && p.firstUnansweredAt !== null && now - p.firstUnansweredAt >= PULL_STALENESS_BOUND_MS);
}

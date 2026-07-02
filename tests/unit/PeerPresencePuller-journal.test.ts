/**
 * PeerPresencePuller — REPLICATION-GATED journal-delta drive (COHERENCE-JOURNAL-
 * SPEC §3.4 rule 5). The puller's presence pass, AFTER recording a peer online,
 * may request + apply a coherence-journal delta when (and only when) the server
 * wired the delta deps — which it does ONLY when replication.enabled === true.
 * These tests pin that gate + the drive semantics with injected fakes:
 *
 *  - GATE OFF (no delta deps): never requests, never applies — even when the
 *    peer's advert is ahead. This is the dark-on-merge guarantee.
 *  - GATE ON + peer ahead: requests the delta for the ahead kind from our held
 *    lastSeq, then applies the served batch (sender = the peer machine id).
 *  - GATE ON + peer NOT ahead: nothing requested (same incarnation, same seq).
 *  - GATE ON + we hold nothing for the kind: requests from seq 0.
 *  - A failing delta fetch never throws and never applies (presence pass still
 *    completes, peer still recorded).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  PeerPresencePuller,
  type PeerPresenceMachine,
  type PeerCapacity,
  type JournalDeltaStream,
} from '../../src/core/PeerPresencePuller.js';

const URL_MINI = 'https://mini.example.dev';

interface DeltaDeps {
  requestJournalDelta: (m: string, u: string, k: string, f: number) => Promise<JournalDeltaStream | null>;
  applyDelta: (sender: string, batch: JournalDeltaStream[]) => void;
  localAdvertFor: (m: string) => Record<string, { incarnation: string; lastSeq: number }>;
}

function basePuller(opts: {
  peerCapacity: PeerCapacity | null;
  delta?: Partial<DeltaDeps>;
  peers?: PeerPresenceMachine[];
}) {
  const recorded: string[] = [];
  const puller = new PeerPresencePuller({
    selfMachineId: 'm_self',
    listPeers: () => opts.peers ?? [{ machineId: 'm_mini', url: URL_MINI }],
    fetchPeerCapacity: async () => opts.peerCapacity,
    recordHeartbeat: (obs) => recorded.push(obs.machineId),
    ...(opts.delta ?? {}),
  });
  return { puller, recorded };
}

describe('PeerPresencePuller — journal-delta drive (REPLICATION-GATED)', () => {
  it('GATE OFF: does NOTHING with the journal advert when delta deps are absent (dark on merge)', async () => {
    // The peer advertises a stream far ahead of anything we hold, but with no
    // delta deps wired the puller must not request or apply anything.
    const { puller, recorded } = basePuller({
      peerCapacity: {
        loadAvg: 0.3,
        journalAdvert: { 'topic-placement': { incarnation: 'inc-A', lastSeq: 42 } },
      },
      // delta: undefined → no requestJournalDelta / applyDelta / localAdvertFor
    });

    const res = await puller.pullOnce();

    // Presence still works (peer recorded), but no journal side effects.
    expect(res.recorded).toEqual(['m_mini']);
    expect(recorded).toEqual(['m_mini']);
  });

  it('GATE ON + peer ahead: requests the delta from our held lastSeq and applies it', async () => {
    const served: JournalDeltaStream = {
      kind: 'topic-placement',
      incarnation: 'inc-A',
      entries: [{ seq: 6, ts: '2026-06-05T00:00:00.000Z', machine: 'm_mini', kind: 'topic-placement', data: {} }],
    };
    const requestJournalDelta = vi.fn(async () => served);
    const applyDelta = vi.fn();
    const localAdvertFor = vi.fn(() => ({ 'topic-placement': { incarnation: 'inc-A', lastSeq: 5 } }));

    const { puller } = basePuller({
      peerCapacity: {
        loadAvg: 0.3,
        journalAdvert: { 'topic-placement': { incarnation: 'inc-A', lastSeq: 9 } },
      },
      delta: { requestJournalDelta, applyDelta, localAdvertFor },
    });

    await puller.pullOnce();

    // Requested for the ahead kind, from OUR lastSeq (5), against the peer.
    expect(requestJournalDelta).toHaveBeenCalledTimes(1);
    expect(requestJournalDelta).toHaveBeenCalledWith('m_mini', URL_MINI, 'topic-placement', 5);
    // Applied under the PEER's machine id (first-hop sender binding).
    expect(applyDelta).toHaveBeenCalledTimes(1);
    expect(applyDelta).toHaveBeenCalledWith('m_mini', [served]);
  });

  it('GATE ON + peer NOT ahead (same incarnation, same seq): requests nothing', async () => {
    const requestJournalDelta = vi.fn(async () => null);
    const applyDelta = vi.fn();
    const localAdvertFor = vi.fn(() => ({ 'topic-placement': { incarnation: 'inc-A', lastSeq: 9 } }));

    const { puller } = basePuller({
      peerCapacity: {
        journalAdvert: { 'topic-placement': { incarnation: 'inc-A', lastSeq: 9 } },
      },
      delta: { requestJournalDelta, applyDelta, localAdvertFor },
    });

    await puller.pullOnce();

    expect(requestJournalDelta).not.toHaveBeenCalled();
    expect(applyDelta).not.toHaveBeenCalled();
  });

  it('GATE ON + we hold nothing for the kind: requests from seq 0', async () => {
    const served: JournalDeltaStream = { kind: 'session-lifecycle', incarnation: 'inc-Z', entries: [] };
    const requestJournalDelta = vi.fn(async () => served);
    const applyDelta = vi.fn();
    const localAdvertFor = vi.fn(() => ({})); // we hold nothing for this peer

    const { puller } = basePuller({
      peerCapacity: {
        journalAdvert: { 'session-lifecycle': { incarnation: 'inc-Z', lastSeq: 3 } },
      },
      delta: { requestJournalDelta, applyDelta, localAdvertFor },
    });

    await puller.pullOnce();

    expect(requestJournalDelta).toHaveBeenCalledWith('m_mini', URL_MINI, 'session-lifecycle', 0);
    expect(applyDelta).toHaveBeenCalledWith('m_mini', [served]);
  });

  it('a failing delta fetch never throws and never applies (presence pass still completes)', async () => {
    const requestJournalDelta = vi.fn(async () => {
      throw new Error('ETIMEDOUT');
    });
    const applyDelta = vi.fn();
    const localAdvertFor = vi.fn(() => ({}));

    const { puller, recorded } = basePuller({
      peerCapacity: {
        journalAdvert: { 'topic-placement': { incarnation: 'inc-A', lastSeq: 9 } },
      },
      delta: { requestJournalDelta, applyDelta, localAdvertFor },
    });

    const res = await puller.pullOnce(); // must resolve, not reject

    expect(res.recorded).toEqual(['m_mini']); // peer still recorded
    expect(recorded).toEqual(['m_mini']);
    expect(requestJournalDelta).toHaveBeenCalledTimes(1);
    expect(applyDelta).not.toHaveBeenCalled(); // fetch failed → nothing applied
  });

  it('a different incarnation is still pulled (the applier fences it on apply, not the puller)', async () => {
    const served: JournalDeltaStream = { kind: 'topic-placement', incarnation: 'inc-B', entries: [] };
    const requestJournalDelta = vi.fn(async () => served);
    const applyDelta = vi.fn();
    const localAdvertFor = vi.fn(() => ({ 'topic-placement': { incarnation: 'inc-A', lastSeq: 9 } }));

    const { puller } = basePuller({
      peerCapacity: {
        journalAdvert: { 'topic-placement': { incarnation: 'inc-B', lastSeq: 9 } }, // same seq, NEW incarnation
      },
      delta: { requestJournalDelta, applyDelta, localAdvertFor },
    });

    await puller.pullOnce();

    // Even though lastSeq is equal, the incarnation differs → still requested
    // (from our lastSeq); incarnation fencing/quarantine is the applier's job.
    expect(requestJournalDelta).toHaveBeenCalledWith('m_mini', URL_MINI, 'topic-placement', 9);
    expect(applyDelta).toHaveBeenCalledWith('m_mini', [served]);
  });
});

describe('forged-heartbeat-from-non-owner-rejected (U4.2 — freshness binds to the DIALED identity)', () => {
  it('a response body smuggling a foreign machineId can NEVER refresh that foreign machine\'s observation', async () => {
    // U4.2's death evidence keys on observer-stamped freshness folded in from
    // THIS pull path. The observation is recorded under the id of the machine
    // WE dialed (m.machineId from the registered peer entry) — never an id the
    // response body asserts. So a live peer cannot keep a dead owner looking
    // alive (or vice versa) by impersonating it in its capacity payload.
    const recorded: string[] = [];
    const forged = {
      loadAvg: 0.1,
      selfReportedLastSeen: new Date().toISOString(),
      // Smuggled identity claim — NOT a PeerCapacity field; cast to prove the
      // puller ignores unknown body fields entirely.
      machineId: 'm_owner',
    } as unknown as PeerCapacity;
    const puller = new PeerPresencePuller({
      selfMachineId: 'm_self',
      listPeers: () => [{ machineId: 'm_mini', url: URL_MINI }],
      fetchPeerCapacity: async () => forged,
      recordHeartbeat: (obs) => recorded.push(obs.machineId),
    });
    const res = await puller.pullOnce();
    expect(res.recorded).toEqual(['m_mini']);
    expect(recorded).toEqual(['m_mini']);
    expect(recorded).not.toContain('m_owner');
  });
});

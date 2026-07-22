/**
 * sessionPool FAILOVER E2E — two real nodes, a real owner-offline takeover.
 *
 * The 2026-07-22 incident: an agent whose primary machine slept had a standby
 * node that could only WATCH — it never took over, so the conversation went dark
 * for hours. The sessionPool rollout gate is supposed to promote an agent from
 * `shadow` (watch-only) to `live-transfer` (real migration) ONLY after a real
 * failover test proves the handoff works — but that test was an explicit unbuilt
 * track-H follow-up ("real-hardware / test-as-self proof"). This is that test.
 *
 * It runs on the REAL two-node ownership harness (two AgentServers over real HTTP,
 * durable LocalSessionOwnershipStore per node, an un-stubbed signed replication
 * hop). The failover is NOT simulated at the assertion layer: node A actually
 * `stop()`s (server + journal closed — the "machine slept"), and node B takes
 * over through the REAL fenced ownership FSM (`force-claim`, the WS1.3 dead-owner
 * takeover path), then serves the conversation itself.
 *
 * Recurring regression guard (Priority B): this runs in CI on every commit, so if
 * cross-machine failover ever breaks, CI goes red — the break trips automatically
 * instead of being discovered by losing a night of work.
 *
 * The green result this proves is what the sessionPool StageAdvancer gate consumes
 * to promote shadow → live-transfer; wiring a rollout runner to feed
 * SessionPoolE2EResultStore.recordResult from a run of this test is the follow-up
 * increment (the driver that acts on the result already merged separately).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTwoNodeHarness, HARNESS_AUTH } from '../support/twoNodeOwnershipHarness.js';
import type { TwoNodeHarness } from '../support/twoNodeOwnershipHarness.js';

async function authedJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${HARNESS_AUTH}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return (await r.json()) as T;
}

describe('sessionPool failover — two-node (owner offline → standby takes over)', () => {
  let h: TwoNodeHarness;

  beforeAll(async () => {
    h = await makeTwoNodeHarness();
  });

  afterAll(async () => {
    // Node A is stopped mid-test; teardown stops it again + node B + rms the tmp
    // dir. srv.close's callback resolves even when already-closed, so the double
    // stop is safe; the catch is belt-and-suspenders so a benign double-close
    // never fails the suite.
    await h?.teardown().catch(() => {});
  });

  it('A owns+serves a topic; A goes offline; B force-claims the dead owner and serves it', async () => {
    const TOPIC = 4242;
    const sk = String(TOPIC);

    // ── 1. Node A owns and serves the conversation (place → claim → active),
    //       and journals the placement (the emit IS the replication source).
    const place = h.a.registry.cas(
      { type: 'place', machineId: h.a.machineId },
      { sessionKey: sk, sender: h.a.machineId, nonce: 'place-4242' },
    );
    expect(place.ok).toBe(true);
    const claim = h.a.registry.cas(
      { type: 'claim', machineId: h.a.machineId },
      { sessionKey: sk, sender: h.a.machineId, nonce: 'claim-4242' },
    );
    expect(claim.ok).toBe(true);
    if (claim.ok) {
      h.a.journal.emitPlacement(TOPIC, { owner: h.a.machineId, epoch: claim.record.ownershipEpoch, reason: 'placed' });
    }
    h.a.addLiveSession(TOPIC);
    expect(h.a.registry.ownerOf(sk)).toBe(h.a.machineId);

    // ── 2. State syncs to B WHILE BOTH ARE ALIVE — the precondition for a
    //       clean failover (B must already hold A's ownership record to take
    //       over durably). One un-stubbed signed hop, then B materializes it.
    const hop = await h.replicate(h.a, h.b);
    expect(hop.applied).toBeGreaterThanOrEqual(1);
    expect(hop.forgedEntries).toBe(0);
    const mat = h.applierTick(h.b);
    expect(mat.materialized).toBeGreaterThanOrEqual(1);

    // Through B's OWN real HTTP surface: B now knows A owns the topic.
    const bViewBefore = await authedJson<{ owner: string | null }>(`${h.b.url}/pool/ownership-view?key=${sk}`);
    expect(bViewBefore.owner).toBe(h.a.machineId);
    expect(h.b.registry.ownerOf(sk)).toBe(h.a.machineId);

    // ── 3. Node A goes OFFLINE — the "machine slept": server + journal closed.
    await h.a.stop();
    // Death evidence: A's HTTP surface is now unreachable (the caller-validated
    // precondition the force-claim FSM path requires).
    let aReachable = true;
    try {
      await fetch(`${h.a.url}/sessions`, { headers: { Authorization: `Bearer ${HARNESS_AUTH}` } });
    } catch {
      aReachable = false;
    }
    expect(aReachable).toBe(false);

    // ── 4. Node B FAILS OVER — the fenced dead-owner takeover (WS1.3
    //       force-claim, the ONLY legitimate non-cooperative claim) — then
    //       serves the conversation itself.
    const takeover = h.b.registry.cas(
      { type: 'force-claim', machineId: h.b.machineId },
      { sessionKey: sk, sender: h.b.machineId, nonce: 'failover-4242' },
    );
    expect(takeover.ok).toBe(true);
    if (takeover.ok) {
      // The fenced epoch strictly advances past A's — a resurrected A cannot reclaim.
      expect(takeover.record.ownershipEpoch).toBeGreaterThan(claim.ok ? claim.record.ownershipEpoch : 0);
      h.b.journal.emitPlacement(TOPIC, { owner: h.b.machineId, epoch: takeover.record.ownershipEpoch, reason: 'failover' });
    }
    // The conversation resumes on the survivor.
    h.b.addLiveSession(TOPIC);

    // ── ASSERT THE MIGRATION ──────────────────────────────────────────────
    // Ownership moved to B (the durable registry + B's own HTTP view agree).
    expect(h.b.registry.ownerOf(sk)).toBe(h.b.machineId);
    const bViewAfter = await authedJson<{ owner: string | null; epoch: number }>(
      `${h.b.url}/pool/ownership-view?key=${sk}`,
    );
    expect(bViewAfter.owner).toBe(h.b.machineId);

    // B now SERVES the conversation — the in-flight work resumed on the survivor,
    // read through B's real Bearer-authed /sessions (never a direct store read).
    const bSessions = await authedJson<Array<Record<string, unknown>>>(`${h.b.url}/sessions`);
    const served = (Array.isArray(bSessions) ? bSessions : []).some(
      (s) => s.platform === 'telegram' && String(s.platformId) === sk,
    );
    expect(served).toBe(true);
  });
});

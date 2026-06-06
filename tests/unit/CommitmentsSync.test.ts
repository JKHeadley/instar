// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
// safe-fs-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Tier-1 unit tests for CommitmentsSync (P1.5a) —
 * COMMITMENTS-COHERENCE-SPEC §3.1 (composite identity), §3.2 (paged deltas,
 * incarnation fencing, first-hop with teeth, redaction), §3.3 (merge).
 *
 * Plus the CommitmentTracker P1.5 bookkeeping: replicationSeq bumps on
 * state-meaningful mutations and NOT on beacon bookkeeping; legacy
 * backfill seeds a full first pull; rewind re-mints the incarnation;
 * origin stamping at creation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildCommitmentsSyncPage,
  CommitmentReplicaStore,
  mergeCommitmentViews,
  resolveBareId,
  compositeKey,
  type ReplicatedCommitment,
} from '../../src/core/CommitmentsSync.js';
import { CommitmentTracker, type Commitment } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commitments-sync-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function fakeCommitment(over: Partial<Commitment> = {}): Commitment {
  return {
    id: 'CMT-001',
    type: 'follow-up',
    status: 'pending',
    userRequest: 'do the thing',
    createdAt: '2026-06-06T00:00:00.000Z',
    correctionCount: 0,
    correctionHistory: [],
    escalated: false,
    version: 0,
    ...over,
  } as Commitment;
}

const ADVERT = { incarnation: 'inc-1', replicationSeq: 10 };

describe('buildCommitmentsSyncPage — paged deltas (§3.2)', () => {
  it('serves only records past the EXCLUSIVE cursor, ordered, with done honesty', () => {
    const records = [
      fakeCommitment({ id: 'CMT-001', lastMutatedSeq: 2 }),
      fakeCommitment({ id: 'CMT-002', lastMutatedSeq: 5 }),
      fakeCommitment({ id: 'CMT-003', lastMutatedSeq: 3 }),
    ];
    const page = buildCommitmentsSyncPage({ sinceSeq: 2 }, { ownMachineId: 'm_a', records, advert: ADVERT });
    expect(page.records.map((r) => r.id)).toEqual(['CMT-003', 'CMT-002']); // seq order, exclusive of 2
    expect(page.nextSinceSeq).toBe(5);
    expect(page.done).toBe(true);
  });

  it('pages at the byte cap with at least one record per page; multi-page catch-up converges', () => {
    const big = 'x'.repeat(400);
    const records = [1, 2, 3, 4].map((i) =>
      fakeCommitment({ id: `CMT-00${i}`, lastMutatedSeq: i, userRequest: big }),
    );
    const deps = { ownMachineId: 'm_a', records, advert: ADVERT, syncPageBytes: 900 };
    let cursor = 0;
    const got: string[] = [];
    for (let i = 0; i < 10 && got.length < 4; i++) {
      const page = buildCommitmentsSyncPage({ sinceSeq: cursor, incarnation: 'inc-1' }, deps);
      got.push(...page.records.map((r) => r.id));
      cursor = page.nextSinceSeq;
      if (page.done) break;
    }
    expect(got).toEqual(['CMT-001', 'CMT-002', 'CMT-003', 'CMT-004']); // full catch-up over pages
  });

  it('a stale incarnation is fenced: incarnationChanged + re-pull from 0', () => {
    const page = buildCommitmentsSyncPage(
      { sinceSeq: 99, incarnation: 'inc-OLD' },
      { ownMachineId: 'm_a', records: [fakeCommitment()], advert: ADVERT },
    );
    expect(page.incarnationChanged).toBe(true);
    expect(page.records).toEqual([]);
    expect(page.nextSinceSeq).toBe(0);
  });

  it('serve-time stamping: legacy rows get the serving machine id; credential-shaped text ships REDACTED with the record intact', () => {
    const records = [
      fakeCommitment({ id: 'CMT-007', lastMutatedSeq: 3, userRequest: 'use api_key = "abcdef123456789012345" for the job' }),
    ];
    const page = buildCommitmentsSyncPage({ sinceSeq: 0 }, { ownMachineId: 'm_a', records, advert: ADVERT });
    const row = page.records[0];
    expect(row.originMachineId).toBe('m_a'); // legacy stamp
    expect(row.textRedacted).toBe(true);
    expect(row.userRequest).toContain('[redacted:'); // field redacted
    expect(row.id).toBe('CMT-007'); // record still replicates — closeability intact
  });
});

describe('CommitmentReplicaStore — receive side (§3.2)', () => {
  function servedRow(over: Partial<ReplicatedCommitment> = {}): ReplicatedCommitment {
    return { ...fakeCommitment(), originMachineId: 'm_peer', ...over } as ReplicatedCommitment;
  }

  it('applies a page, persists atomically, survives a new instance (restart-proof)', () => {
    const a = new CommitmentReplicaStore({ stateDir: tmpDir });
    const r = a.applyPage('m_peer', { incarnation: 'inc-1', replicationSeq: 5, records: [servedRow()], nextSinceSeq: 5, done: true });
    expect(r.applied).toBe(1);
    const b = new CommitmentReplicaStore({ stateDir: tmpDir });
    expect(b.cursorFor('m_peer')).toEqual({ sinceSeq: 5, incarnation: 'inc-1' });
    expect(b.allReplicas()[0].records[0].id).toBe('CMT-001');
  });

  it('FIRST-HOP WITH TEETH: rows claiming another machine are rejected + counted, never applied', () => {
    const store = new CommitmentReplicaStore({ stateDir: tmpDir });
    const r = store.applyPage('m_peer', {
      incarnation: 'inc-1',
      replicationSeq: 5,
      records: [servedRow(), servedRow({ id: 'CMT-099', originMachineId: 'm_third_party' })],
      nextSinceSeq: 5,
      done: true,
    });
    expect(r.applied).toBe(1);
    expect(r.forgedRows).toBe(1);
    expect(store.allReplicas()[0].records.map((c) => c.id)).toEqual(['CMT-001']);
  });

  it('incarnation change replaces the replica WHOLESALE (the restored-backup fence)', () => {
    const store = new CommitmentReplicaStore({ stateDir: tmpDir });
    store.applyPage('m_peer', { incarnation: 'inc-1', replicationSeq: 5, records: [servedRow()], nextSinceSeq: 5, done: true });
    const r = store.applyPage('m_peer', { incarnation: 'inc-2', replicationSeq: 1, records: [servedRow({ id: 'CMT-002' })], nextSinceSeq: 1, done: true });
    expect(r.replaced).toBe(true);
    const rows = store.allReplicas()[0].records;
    expect(rows.map((c) => c.id)).toEqual(['CMT-002']); // old rows gone, never merged
  });

  it('corrupt replica file → quarantined + fresh re-pull cursor, never silently merged', () => {
    const store = new CommitmentReplicaStore({ stateDir: tmpDir });
    store.applyPage('m_peer', { incarnation: 'inc-1', replicationSeq: 5, records: [servedRow()], nextSinceSeq: 5, done: true });
    const file = path.join(tmpDir, 'state', 'commitment-replicas', 'm_peer.json');
    fs.writeFileSync(file, '{not json');
    const fresh = new CommitmentReplicaStore({ stateDir: tmpDir });
    expect(fresh.cursorFor('m_peer')).toEqual({ sinceSeq: 0 }); // full re-pull
    const quarantined = fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.corrupt-'));
    expect(quarantined).toHaveLength(1);
  });
});

describe('mergeCommitmentViews + resolveBareId (§3.1/§3.3)', () => {
  it('cross-machine id collision: two CMT-007s merge as TWO rows; bare-id resolution is 409-ambiguous; ?origin resolves', () => {
    const rows = mergeCommitmentViews({
      ownMachineId: 'm_a',
      own: [fakeCommitment({ id: 'CMT-007', originMachineId: 'm_a' })],
      replicas: [{
        ownerMachineId: 'm_b',
        receivedAt: new Date().toISOString(),
        records: [{ ...fakeCommitment({ id: 'CMT-007' }), originMachineId: 'm_b' } as ReplicatedCommitment],
      }],
    });
    expect(rows).toHaveLength(2); // NEVER collapsed — the round-1 headline catch
    expect(resolveBareId(rows, 'CMT-007')).toBe('ambiguous');
    const resolved = resolveBareId(rows, 'CMT-007', 'm_b');
    expect(resolved).not.toBe('ambiguous');
    expect((resolved as { originMachineId: string }).originMachineId).toBe('m_b');
  });

  it('replica rows carry viewSource + stalenessMs; pendingMutation is COMPUTED from the ledger join', () => {
    const past = new Date(Date.now() - 120_000).toISOString();
    const rows = mergeCommitmentViews({
      ownMachineId: 'm_a',
      own: [],
      replicas: [{ ownerMachineId: 'm_b', receivedAt: past, records: [{ ...fakeCommitment(), originMachineId: 'm_b' } as ReplicatedCommitment] }],
      pendingKeys: new Set([compositeKey('m_b', 'CMT-001')]),
    });
    expect(rows[0].viewSource).toBe('replica');
    expect(rows[0].stalenessMs).toBeGreaterThanOrEqual(120_000);
    expect(rows[0].pendingMutation).toBe(true);
  });

  it('possibleDuplicateOf flags cross-machine same-topic open pairs (heuristic, both directions)', () => {
    const rows = mergeCommitmentViews({
      ownMachineId: 'm_a',
      own: [fakeCommitment({ id: 'CMT-003', topicId: 42, originMachineId: 'm_a' })],
      replicas: [{
        ownerMachineId: 'm_b',
        receivedAt: new Date().toISOString(),
        records: [{ ...fakeCommitment({ id: 'CMT-009', topicId: 42 }), originMachineId: 'm_b' } as ReplicatedCommitment],
      }],
    });
    expect(rows[0].possibleDuplicateOf).toEqual([compositeKey('m_b', 'CMT-009')]);
    expect(rows[1].possibleDuplicateOf).toEqual([compositeKey('m_a', 'CMT-003')]);
  });
});

describe('CommitmentTracker — P1.5 bookkeeping (§3.1/§3.2)', () => {
  function makeTracker(origin?: string): CommitmentTracker {
    return new CommitmentTracker({
      stateDir: tmpDir,
      liveConfig: new LiveConfig(tmpDir),
      ...(origin ? { originMachineId: origin } : {}),
    });
  }

  it('stamps originMachineId at creation; replicationSeq bumps on creation + state mutation', async () => {
    const t = makeTracker('m_self');
    const c = t.record({ userRequest: 'promise X', type: 'follow-up', source: 'manual' } as Parameters<CommitmentTracker['record']>[0]);
    expect(c.originMachineId).toBe('m_self');
    const seqAfterCreate = t.getReplicationAdvert()!.replicationSeq;
    expect(c.lastMutatedSeq).toBe(seqAfterCreate);
    await t.mutate(c.id, (d) => ({ ...d, status: 'delivered' as const }));
    expect(t.getReplicationAdvert()!.replicationSeq).toBeGreaterThan(seqAfterCreate);
  });

  it('beacon-bookkeeping writes do NOT bump replicationSeq (write-amplification guard)', async () => {
    const t = makeTracker('m_self');
    const c = t.record({ userRequest: 'promise Y', type: 'follow-up', source: 'manual' } as Parameters<CommitmentTracker['record']>[0]);
    const seq = t.getReplicationAdvert()!.replicationSeq;
    await t.mutate(c.id, (d) => ({ ...d, lastHeartbeatAt: new Date().toISOString(), heartbeatCount: 5, consecutiveUnchanged: 2 }));
    expect(t.getReplicationAdvert()!.replicationSeq).toBe(seq); // unchanged
  });

  it('legacy store backfill: seeds replicationSeq + incarnation + per-record lastMutatedSeq (full first pull)', () => {
    const storeDir = path.join(tmpDir, 'state');
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(
      path.join(storeDir, 'commitments.json'),
      JSON.stringify({ version: 2, commitments: [fakeCommitment()], lastModified: new Date().toISOString() }),
    );
    const t = makeTracker();
    const advert = t.getReplicationAdvert();
    expect(advert).not.toBeNull();
    expect(advert!.replicationSeq).toBe(1);
    expect(advert!.incarnation).toBeTruthy();
    expect(t.getAll()[0].lastMutatedSeq).toBe(1); // serves on a from-0 pull
  });

  it('rewind detection: a store restored BELOW the meta high-water re-mints the incarnation', () => {
    const t1 = makeTracker('m_self');
    const c = t1.record({ userRequest: 'Z', type: 'follow-up', source: 'manual' } as Parameters<CommitmentTracker['record']>[0]);
    void c;
    const inc1 = t1.getReplicationAdvert()!.incarnation;
    // Simulate a backup-restore: rewind the store's replicationSeq below the
    // meta sidecar's high-water.
    const storeFile = path.join(tmpDir, 'state', 'commitments.json');
    const data = JSON.parse(fs.readFileSync(storeFile, 'utf-8'));
    data.replicationSeq = 1;
    fs.writeFileSync(storeFile, JSON.stringify(data));
    fs.writeFileSync(`${storeFile}.meta.json`, JSON.stringify({ highWaterSeq: 99 }));
    const t2 = makeTracker('m_self');
    expect(t2.getReplicationAdvert()!.incarnation).not.toBe(inc1); // re-minted
  });
});

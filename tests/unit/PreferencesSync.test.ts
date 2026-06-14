// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
// safe-fs-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildPreferencesSyncPage,
  PreferenceReplicaStore,
  mergePreferenceViews,
  type ServeablePreference,
  type PreferencesSyncPage,
  type ReplicatedPreference,
} from '../../src/core/PreferencesSync.js';
import type { PreferenceEntry } from '../../src/core/PreferencesManager.js';

function pref(over: Partial<ServeablePreference> = {}): ServeablePreference {
  return {
    learning: 'Lead with the one action, no preamble.',
    provenance: 'correction-loop',
    dedupeKey: 'tone:abc123',
    recordedAt: '2026-06-12T10:00:00.000Z',
    confidence: 0.7,
    dedupeCount: 3,
    lastMutatedSeq: 1,
    ...over,
  };
}

describe('buildPreferencesSyncPage — serve side', () => {
  const advert = { incarnation: 'inc-1', replicationSeq: 5 };

  it('returns delta records past the exclusive cursor, seq-ordered', () => {
    const records = [
      pref({ dedupeKey: 'a', lastMutatedSeq: 1 }),
      pref({ dedupeKey: 'b', lastMutatedSeq: 2 }),
      pref({ dedupeKey: 'c', lastMutatedSeq: 3 }),
    ];
    const page = buildPreferencesSyncPage({ sinceSeq: 1 }, { ownMachineId: 'm_a', records, advert });
    expect(page.records.map((r) => r.dedupeKey)).toEqual(['b', 'c']);
    expect(page.nextSinceSeq).toBe(3);
    expect(page.done).toBe(true);
    expect(page.records.every((r) => r.originMachineId === 'm_a')).toBe(true);
  });

  it('fences a stale incarnation → incarnationChanged, re-pull from 0', () => {
    const page = buildPreferencesSyncPage(
      { sinceSeq: 9, incarnation: 'OLD' },
      { ownMachineId: 'm_a', records: [pref()], advert },
    );
    expect(page.incarnationChanged).toBe(true);
    expect(page.records).toEqual([]);
    expect(page.nextSinceSeq).toBe(0);
    expect(page.done).toBe(false);
  });

  it('treats absent lastMutatedSeq as 0 so a legacy store replicates from 0', () => {
    const legacy = pref({ dedupeKey: 'x' });
    delete (legacy as { lastMutatedSeq?: number }).lastMutatedSeq;
    const page = buildPreferencesSyncPage({ sinceSeq: 0 }, { ownMachineId: 'm_a', records: [legacy], advert });
    // seq 0 is NOT > sinceSeq 0 → not served until it gets a real seq.
    expect(page.records).toEqual([]);
    expect(page.done).toBe(true);
  });

  it('byte-caps a page but always emits at least one record', () => {
    const big = pref({ dedupeKey: 'big', lastMutatedSeq: 1, learning: 'x'.repeat(2000) });
    const next = pref({ dedupeKey: 'next', lastMutatedSeq: 2 });
    const page = buildPreferencesSyncPage(
      { sinceSeq: 0 },
      { ownMachineId: 'm_a', records: [big, next], advert, syncPageBytes: 100 },
    );
    expect(page.records).toHaveLength(1);
    expect(page.records[0].dedupeKey).toBe('big');
    expect(page.done).toBe(false); // 'next' remains
    expect(page.nextSinceSeq).toBe(1);
  });

  it('credential-redacts the learning text at serve time and flags it', () => {
    const leak = pref({
      dedupeKey: 'leak',
      lastMutatedSeq: 1,
      learning: 'Use the key sk-AAAABBBBCCCCDDDDEEEEFFFFGGGG when calling.',
    });
    const page = buildPreferencesSyncPage({ sinceSeq: 0 }, { ownMachineId: 'm_a', records: [leak], advert });
    expect(page.records[0].textRedacted).toBe(true);
    expect(page.records[0].learning).not.toContain('sk-AAAABBBBCCCCDDDD');
  });
});

describe('PreferenceReplicaStore — receive side', () => {
  let dir: string;
  let store: PreferenceReplicaStore;
  const T = '2026-06-13T00:00:00.000Z';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefsync-'));
    store = new PreferenceReplicaStore({ stateDir: dir, now: () => new Date(T) });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function page(over: Partial<PreferencesSyncPage> = {}): PreferencesSyncPage {
    return { incarnation: 'inc-1', replicationSeq: 1, records: [], nextSinceSeq: 0, done: true, ...over };
  }
  function rep(over: Partial<ReplicatedPreference> = {}): ReplicatedPreference {
    return { ...pref(), originMachineId: 'm_b', lastMutatedSeq: 1, ...over } as ReplicatedPreference;
  }

  it('applies owner-stamped rows and advances the cursor', () => {
    const r = store.applyPage('m_b', page({ records: [rep({ dedupeKey: 'k1' })], nextSinceSeq: 1 }));
    expect(r.applied).toBe(1);
    expect(r.forgedRows).toBe(0);
    expect(store.cursorFor('m_b')).toEqual({ sinceSeq: 1, incarnation: 'inc-1' });
  });

  it('rejects + counts a row whose origin ≠ the authenticated sender (forged)', () => {
    const r = store.applyPage('m_b', page({ records: [rep({ originMachineId: 'm_c', dedupeKey: 'k1' })] }));
    expect(r.applied).toBe(0);
    expect(r.forgedRows).toBe(1);
  });

  it('wholesale-replaces the replica on an incarnation change', () => {
    store.applyPage('m_b', page({ incarnation: 'inc-1', records: [rep({ dedupeKey: 'old' })], nextSinceSeq: 1 }));
    const r = store.applyPage('m_b', page({ incarnation: 'inc-2', records: [rep({ dedupeKey: 'new' })], nextSinceSeq: 1 }));
    expect(r.replaced).toBe(true);
    const rows = store.allReplicas()[0].records.map((x) => x.dedupeKey);
    expect(rows).toEqual(['new']);
  });

  it('answers an incarnationChanged page by resetting the cursor to 0', () => {
    store.applyPage('m_b', page({ incarnation: 'inc-1', records: [rep()], nextSinceSeq: 4 }));
    const r = store.applyPage('m_b', page({ incarnationChanged: true, incarnation: 'inc-9' }));
    expect(r.replaced).toBe(true);
    expect(store.cursorFor('m_b')).toEqual({ sinceSeq: 0, incarnation: 'inc-9' });
  });

  it('quarantines a corrupt replica file and re-pulls fresh', () => {
    store.applyPage('m_b', page({ records: [rep()], nextSinceSeq: 1 }));
    const file = path.join(dir, 'state', 'preference-replicas', 'm_b.json');
    fs.writeFileSync(file, '{ this is not json');
    const fresh = new PreferenceReplicaStore({ stateDir: dir, now: () => new Date(T) });
    expect(fresh.cursorFor('m_b')).toEqual({ sinceSeq: 0 }); // fresh re-pull
    const quarantined = fs.readdirSync(path.join(dir, 'state', 'preference-replicas')).filter((n) => n.includes('.corrupt-'));
    expect(quarantined.length).toBe(1);
  });

  it('enforces the per-peer bound on NEW keys but still updates existing ones', () => {
    const bounded = new PreferenceReplicaStore({ stateDir: dir, now: () => new Date(T), maxRecordsPerPeer: 2 });
    bounded.applyPage('m_b', page({ records: [rep({ dedupeKey: 'k1' }), rep({ dedupeKey: 'k2' })], nextSinceSeq: 2 }));
    const r = bounded.applyPage('m_b', page({
      records: [rep({ dedupeKey: 'k3' }), rep({ dedupeKey: 'k1', confidence: 0.95 })],
      nextSinceSeq: 4,
    }));
    expect(r.dropped).toBe(1); // k3 dropped (bound)
    expect(r.applied).toBe(1); // k1 updated
    const recs = bounded.allReplicas()[0].records;
    expect(recs.find((x) => x.dedupeKey === 'k1')?.confidence).toBe(0.95);
    expect(recs.some((x) => x.dedupeKey === 'k3')).toBe(false);
  });
});

describe('mergePreferenceViews — collapse by dedupeKey', () => {
  const ownM = 'm_a';

  function repRow(over: Partial<ReplicatedPreference>): ReplicatedPreference {
    return { ...pref(), originMachineId: 'm_b', lastMutatedSeq: 1, ...over } as ReplicatedPreference;
  }

  it('collapses the same dedupeKey across machines into one row; dedupeCount sums', () => {
    const own: PreferenceEntry[] = [pref({ dedupeKey: 'shared', dedupeCount: 3, recordedAt: '2026-06-12T10:00:00Z' })];
    const replicas = [
      {
        ownerMachineId: 'm_b',
        receivedAt: '2026-06-13T00:00:00Z',
        records: [repRow({ dedupeKey: 'shared', dedupeCount: 2, recordedAt: '2026-06-12T09:00:00Z', confidence: 0.4 })],
      },
    ];
    const merged = mergePreferenceViews({ ownMachineId: ownM, own, replicas });
    expect(merged).toHaveLength(1);
    expect(merged[0].dedupeCount).toBe(5); // 3 + 2
    expect(merged[0].contributingMachines).toEqual(['m_a', 'm_b']);
    // own is newer (10:00 > 09:00) → own fields win.
    expect(merged[0].winningMachineId).toBe('m_a');
    expect(merged[0].confidence).toBe(0.7);
  });

  it('newest recordedAt wins the fields (replica can beat own)', () => {
    const own: PreferenceEntry[] = [pref({ dedupeKey: 'shared', recordedAt: '2026-06-12T08:00:00Z', learning: 'old' })];
    const replicas = [
      {
        ownerMachineId: 'm_b',
        receivedAt: '2026-06-13T00:00:00Z',
        records: [repRow({ dedupeKey: 'shared', recordedAt: '2026-06-12T20:00:00Z', learning: 'new' })],
      },
    ];
    const merged = mergePreferenceViews({ ownMachineId: ownM, own, replicas });
    expect(merged[0].learning).toBe('new');
    expect(merged[0].winningMachineId).toBe('m_b');
  });

  it('keeps distinct dedupeKeys separate and skips our own echo replica', () => {
    const own: PreferenceEntry[] = [pref({ dedupeKey: 'a' })];
    const replicas = [
      { ownerMachineId: 'm_b', receivedAt: '2026-06-13T00:00:00Z', records: [repRow({ dedupeKey: 'b' })] },
      // an echo of our own machine id — must be ignored.
      { ownerMachineId: ownM, receivedAt: '2026-06-13T00:00:00Z', records: [repRow({ originMachineId: ownM, dedupeKey: 'a' })] },
    ];
    const merged = mergePreferenceViews({ ownMachineId: ownM, own, replicas });
    expect(merged.map((m) => m.dedupeKey).sort()).toEqual(['a', 'b']);
    expect(merged.find((m) => m.dedupeKey === 'a')!.contributingMachines).toEqual(['m_a']);
  });

  it('propagates the redaction flag when any contributing row was redacted', () => {
    const own: PreferenceEntry[] = [];
    const replicas = [
      { ownerMachineId: 'm_b', receivedAt: '2026-06-13T00:00:00Z', records: [repRow({ dedupeKey: 'z', textRedacted: true })] },
    ];
    const merged = mergePreferenceViews({ ownMachineId: ownM, own, replicas });
    expect(merged[0].textRedacted).toBe(true);
  });
});

describe('WS2.1 security-review fixes', () => {
  const advert = { incarnation: 'inc-1', replicationSeq: 5 };

  it('finding #1: violationPattern (local-only) is NEVER replicated to peers', () => {
    const withPattern = pref({
      dedupeKey: 'vp',
      lastMutatedSeq: 1,
      violationPattern: 'regex:api_key|secret|token',
    });
    const page = buildPreferencesSyncPage({ sinceSeq: 0 }, { ownMachineId: 'm_a', records: [withPattern], advert });
    expect(page.records).toHaveLength(1);
    expect('violationPattern' in page.records[0]).toBe(false);
    expect(JSON.stringify(page.records[0])).not.toContain('api_key');
  });

  it('finding #2: a future-clock-skewed peer does NOT win a dedupeKey collision over a genuine recent write', () => {
    const NOW = new Date('2026-06-13T00:00:00.000Z');
    // Own machine wrote it 1 minute ago (genuine, recent).
    const own: PreferenceEntry[] = [pref({ dedupeKey: 'k', recordedAt: '2026-06-12T23:59:00.000Z', learning: 'real' })];
    // Hostile/skewed peer claims a YEAR in the future.
    const replicas = [
      {
        ownerMachineId: 'm_evil',
        receivedAt: NOW.toISOString(),
        records: [{ ...pref({ dedupeKey: 'k', recordedAt: '2027-06-13T00:00:00.000Z', learning: 'hijack' }), originMachineId: 'm_evil', lastMutatedSeq: 1 } as ReplicatedPreference],
      },
    ];
    const merged = mergePreferenceViews({ ownMachineId: 'm_a', own, replicas, now: () => NOW });
    expect(merged).toHaveLength(1);
    // The future timestamp is capped to ~now, so it cannot beat the genuine recent own write.
    expect(merged[0].learning).toBe('real');
    expect(merged[0].winningMachineId).toBe('m_a');
  });

  it('finding #2: a legitimately-newer peer (within skew tolerance) still wins', () => {
    const NOW = new Date('2026-06-13T00:00:00.000Z');
    const own: PreferenceEntry[] = [pref({ dedupeKey: 'k', recordedAt: '2026-06-12T10:00:00.000Z', learning: 'old' })];
    const replicas = [
      {
        ownerMachineId: 'm_b',
        receivedAt: NOW.toISOString(),
        records: [{ ...pref({ dedupeKey: 'k', recordedAt: '2026-06-12T20:00:00.000Z', learning: 'newer' }), originMachineId: 'm_b', lastMutatedSeq: 1 } as ReplicatedPreference],
      },
    ];
    const merged = mergePreferenceViews({ ownMachineId: 'm_a', own, replicas, now: () => NOW });
    expect(merged[0].learning).toBe('newer'); // genuine recency still respected
  });
});
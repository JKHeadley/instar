// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
// safe-fs-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PreferencesManager } from '../../src/core/PreferencesManager.js';
import { buildPreferencesSyncPage } from '../../src/core/PreferencesSync.js';

describe('PreferencesManager — WS2.1 replication bookkeeping', () => {
  let dir: string;
  let mgr: PreferencesManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefmgr-repl-'));
    mgr = new PreferencesManager(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('bumps replicationSeq and stamps lastMutatedSeq on every upsert (monotonic)', () => {
    const a = mgr.recordPreference({ learning: 'one', dedupeKey: 'k1' });
    const b = mgr.recordPreference({ learning: 'two', dedupeKey: 'k2' });
    expect(a.lastMutatedSeq).toBeGreaterThanOrEqual(1);
    expect(b.lastMutatedSeq).toBeGreaterThan(a.lastMutatedSeq!);
    // re-upserting k1 advances its seq past the current max.
    const a2 = mgr.recordPreference({ learning: 'one-again', dedupeKey: 'k1' });
    expect(a2.lastMutatedSeq).toBeGreaterThan(b.lastMutatedSeq!);
  });

  it('getReplicationAdvert returns a stable incarnation and the current seq', () => {
    mgr.recordPreference({ learning: 'one', dedupeKey: 'k1' });
    const ad1 = mgr.getReplicationAdvert();
    mgr.recordPreference({ learning: 'two', dedupeKey: 'k2' });
    const ad2 = mgr.getReplicationAdvert();
    expect(ad1.incarnation).toBe(ad2.incarnation); // stable across normal writes
    expect(ad2.replicationSeq).toBeGreaterThan(ad1.replicationSeq);
  });

  it('writes the highWaterSeq meta sidecar', () => {
    mgr.recordPreference({ learning: 'one', dedupeKey: 'k1' });
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'preferences.json.meta.json'), 'utf-8'));
    expect(meta.highWaterSeq).toBe(mgr.getReplicationAdvert().replicationSeq);
  });

  it('re-mints the incarnation when the store is rewound below the high-water seq (restore)', () => {
    mgr.recordPreference({ learning: 'one', dedupeKey: 'k1' });
    mgr.recordPreference({ learning: 'two', dedupeKey: 'k2' });
    const before = mgr.getReplicationAdvert().incarnation;
    // Simulate a backup restore: overwrite the store with an EARLIER (lower-seq)
    // snapshot while the meta sidecar still remembers the higher high-water seq.
    const storePath = path.join(dir, 'preferences.json');
    fs.writeFileSync(
      storePath,
      JSON.stringify({ schemaVersion: 1, preferences: [], replicationSeq: 1, storeIncarnation: before }),
    );
    const after = mgr.getReplicationAdvert().incarnation;
    expect(after).not.toBe(before); // rewind detected → fresh incarnation
  });

  it('seeds a legacy store (no seq fields) to seq=1 and backfills lastMutatedSeq=1', () => {
    const storePath = path.join(dir, 'preferences.json');
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        schemaVersion: 1,
        preferences: [{ learning: 'legacy', provenance: 'correction-loop', dedupeKey: 'old', recordedAt: '2026-01-01T00:00:00Z', confidence: 0.5, dedupeCount: 1 }],
      }),
    );
    const store = mgr.read();
    expect(store.replicationSeq).toBe(1);
    expect(typeof store.storeIncarnation).toBe('string');
    expect(store.preferences[0].lastMutatedSeq).toBe(1);
  });

  it('getAllForSync feeds buildPreferencesSyncPage end-to-end (a delta page over a real store)', () => {
    mgr.recordPreference({ learning: 'one', dedupeKey: 'k1' });
    mgr.recordPreference({ learning: 'two', dedupeKey: 'k2' });
    const advert = mgr.getReplicationAdvert();
    const all = mgr.getAllForSync();
    // a full pull from 0 returns both, origin-stamped.
    const page = buildPreferencesSyncPage({ sinceSeq: 0 }, { ownMachineId: 'm_a', records: all, advert });
    expect(page.records.map((r) => r.dedupeKey).sort()).toEqual(['k1', 'k2']);
    expect(page.records.every((r) => r.originMachineId === 'm_a')).toBe(true);
    expect(page.incarnation).toBe(advert.incarnation);
    // a delta from the first seq returns only the newer one.
    const firstSeq = Math.min(...all.map((p) => p.lastMutatedSeq ?? 0));
    const delta = buildPreferencesSyncPage({ sinceSeq: firstSeq }, { ownMachineId: 'm_a', records: all, advert });
    expect(delta.records).toHaveLength(1);
  });
});
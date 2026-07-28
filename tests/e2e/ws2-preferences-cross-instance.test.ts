// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * E2E — WS2 send-side: a learned PREFERENCE recorded on instance A is READABLE on
 * instance B (the proven round-trip shape applied to the `preferences` store — WS2-SEND-3,
 * the LAST of the 7 replicated stores). PUT-ONLY by construction: recordPreference is the
 * sole writer and upserts on dedupeKey; there is no delete path. Identity = the dedupeKey.
 *
 * This is the store that required AUTHORING the emit seam (PreferencesManager had none —
 * it rode the deprecated preferences-sync verb). Proves the new seam fires + crosses.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { JournalSyncApplier } from '../../src/core/JournalSyncApplier.js';
import { ReplicatedPeerStreamReader } from '../../src/core/ReplicatedPeerStreamReader.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { ReplicatedStoreReader } from '../../src/core/ReplicatedStoreReader.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ConflictStore } from '../../src/core/ConflictStore.js';
import { DroppedOriginRegistry } from '../../src/core/RollbackUnmerge.js';
import { PreferencesManager } from '../../src/core/PreferencesManager.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import {
  PREF_KIND_REGISTRATION,
  PREF_RECORD_KIND,
  PREF_STORE_KEY,
  prefTierOf,
  buildPrefRecordData,
} from '../../src/core/PreferencesReplicatedStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const A = 'm_laptop';
const B = 'm_mac_mini';

function reg(): ReplicatedKindRegistry {
  const r = new ReplicatedKindRegistry();
  r.register(PREF_KIND_REGISTRATION);
  return r;
}

interface Instance {
  dir: string;
  journal: CoherenceJournal;
  applier: JournalSyncApplier;
  reader: ReplicatedPeerStreamReader;
  prefs: PreferencesManager;
  unionReader: ReplicatedStoreReader;
}

function makeInstance(machineId: string, label: string): Instance {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ws2e2e-pref-${label}-`));
  const registry = reg();
  const journal = new CoherenceJournal({ stateDir: dir, machineId, flushIntervalMs: 1_000_000 });
  journal.open();
  journal.setReplicatedKindRegistry(registry);
  const applier = new JournalSyncApplier({ stateDir: dir, replicatedRegistry: registry });
  const reader = new ReplicatedPeerStreamReader({ stateDir: dir, registry, selfMachineId: machineId });
  const prefs = new PreferencesManager(dir);

  // Emitter (the SEND wiring) — emission ENABLED for preferences. Attaches to the AUTHORED seam.
  const emitter = new ReplicatedRecordEmitter({
    journal,
    clock: new HybridLogicalClock({ node: machineId, now: () => Date.now() }),
    registry,
    origin: machineId,
    stores: () => ({ preferences: { enabled: true } }),
    loadWitness: (store, rk) => reader.loadWitness(store, rk),
  });
  prefs.setReplicationEmitter({
    emitPut: (entry) => emitter.emit(PREF_STORE_KEY, entry.dedupeKey,
      (hlc, o, observed) => buildPrefRecordData({ entry, hlc, op: 'put', origin: o, observed })),
  });

  const unionReader = new ReplicatedStoreReader({
    registry,
    stores: { preferences: { enabled: true } },
    tierOf: prefTierOf,
    loadOriginRecords: (store, rk) => reader.loadOriginRecords(store, rk),
    listRecordKeys: (store) => reader.listRecordKeys(store),
    droppedOrigins: new DroppedOriginRegistry({ stateDir: dir }),
    conflictStore: new ConflictStore({ stateDir: dir, now: () => new Date() }),
  });

  return { dir, journal, applier, reader, prefs, unionReader };
}

function replicate(from: Instance, fromMachineId: string, to: Instance, fromSeq: number): number {
  from.journal.flush();
  const served = from.applier.buildServeBatch(PREF_RECORD_KIND, fromSeq, fromMachineId);
  if (served.entries.length === 0) return fromSeq;
  to.applier.apply(fromMachineId, [served]);
  return served.entries[served.entries.length - 1].seq;
}

describe('E2E — a learned preference recorded on A is readable on B (WS2.1 send-side, authored seam)', () => {
  let a: Instance;
  let b: Instance;

  beforeEach(() => {
    a = makeInstance(A, 'a');
    b = makeInstance(B, 'b');
  });
  afterEach(() => {
    for (const inst of [a, b]) {
      try { inst.journal.close(); } catch { /* best-effort */ }
      SafeFsExecutor.safeRmSync(inst.dir, { recursive: true, force: true, operation: 'tests/e2e/ws2-preferences-cross-instance.test.ts' });
    }
  });

  it('recordPreference on A becomes readable through B\'s union reader as a foreign-origin record (dedupeKey-keyed)', () => {
    a.prefs.recordPreference({ learning: 'Lead with the action, not the preamble.', dedupeKey: 'lead-with-action', confidence: 0.8 });
    const rk = 'lead-with-action';

    expect(b.unionReader.read(PREF_STORE_KEY, rk).value).toBeNull();
    replicate(a, A, b, 0);

    const result = b.unionReader.read(PREF_STORE_KEY, rk);
    expect(result.value).not.toBeNull();
    expect(result.value!.origin).toBe(A);
    expect(result.value!.data.learning).toBe('Lead with the action, not the preamble.');
    expect(b.unionReader.readAll(PREF_STORE_KEY).has(rk)).toBe(true);
  });

  it('an upsert (same dedupeKey) on A re-replicates the refreshed learning + bumped confidence (put-only)', () => {
    a.prefs.recordPreference({ learning: 'Be concise.', dedupeKey: 'concise', confidence: 0.5 });
    const rk = 'concise';
    let cursor = replicate(a, A, b, 0);
    expect(b.unionReader.read(PREF_STORE_KEY, rk).value!.data.learning).toBe('Be concise.');

    // Re-record the same dedupeKey — upsert refreshes the learning + raises confidence; re-emits.
    a.prefs.recordPreference({ learning: 'Be concise; plain English only.', dedupeKey: 'concise', confidence: 0.9 });
    cursor = replicate(a, A, b, cursor);
    expect(cursor).toBeGreaterThan(0);

    const result = b.unionReader.read(PREF_STORE_KEY, rk);
    expect(result.value!.data.learning).toBe('Be concise; plain English only.');
    expect(result.value!.data.confidence).toBe(0.9);
  });
});

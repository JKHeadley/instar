/**
 * Tier-1 unit + WIRING-INTEGRITY tests for ReplicatedStoreReader — the LOWEST
 * store-access funnel (WS2 replicated-store foundation, §7.2).
 *
 * Spec §12 #11 (wiring-integrity): every store read routes through the union-reader
 * primitive; the HLC/quarantine/snapshot deps are dependency-injected and NOT null
 * / NOT no-ops. Plus §12 #6 read side: a dropped origin is excluded from the union
 * LIVE — a surviving read resolves with ZERO refs to the dropped origin.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ReplicatedStoreReader } from '../../src/core/ReplicatedStoreReader.js';
import { ReplicatedKindRegistry, type StoreFieldSchema } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ConflictStore } from '../../src/core/ConflictStore.js';
import { DroppedOriginRegistry } from '../../src/core/RollbackUnmerge.js';
import type { OriginRecord } from '../../src/core/UnionReader.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';

function hlc(p: number, l: number, n: string): HlcTimestamp {
  return { physical: p, logical: l, node: n };
}
function oRec(origin: string, h: HlcTimestamp, observed?: HlcTimestamp): OriginRecord {
  return {
    origin,
    envelope: { recordKey: 'k', hlc: h, op: 'put', origin, ...(observed ? { observed } : {}) },
    data: { v: origin },
  };
}

const passSchema: StoreFieldSchema = { knownFields: ['v'], validate: (raw) => ({ v: (raw as { v?: unknown }).v }) };

let dir: string;
function buildReader(records: OriginRecord[], opts: { enabled?: boolean; dropped?: DroppedOriginRegistry; conflictStore?: ConflictStore } = {}) {
  const registry = new ReplicatedKindRegistry();
  registry.register({ kind: 'pref-record', store: 'pref', schema: passSchema });
  const dropped = opts.dropped ?? new DroppedOriginRegistry({ stateDir: dir });
  const conflictStore = opts.conflictStore ?? new ConflictStore({ stateDir: dir, now: () => new Date() });
  const reader = new ReplicatedStoreReader({
    registry,
    stores: { pref: { enabled: opts.enabled ?? true } },
    tierOf: () => 'high',
    loadOriginRecords: () => records,
    listRecordKeys: () => ['k'],
    droppedOrigins: dropped,
    conflictStore,
  });
  return { reader, dropped, conflictStore };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-'));
});

describe('wiring-integrity (§12 #11)', () => {
  it('REFUSES construction with a null registry seam (not a no-op)', () => {
    expect(() => new ReplicatedStoreReader({
      registry: null as never,
      stores: {},
      tierOf: () => 'high',
      loadOriginRecords: () => [],
      listRecordKeys: () => [],
      droppedOrigins: new DroppedOriginRegistry({ stateDir: dir }),
      conflictStore: new ConflictStore({ stateDir: dir, now: () => new Date() }),
    })).toThrow(/registry/);
  });

  it('REFUSES construction with a non-function loadOriginRecords seam (not a no-op)', () => {
    expect(() => new ReplicatedStoreReader({
      registry: new ReplicatedKindRegistry(),
      stores: {},
      tierOf: () => 'high',
      loadOriginRecords: null as never,
      listRecordKeys: () => [],
      droppedOrigins: new DroppedOriginRegistry({ stateDir: dir }),
      conflictStore: new ConflictStore({ stateDir: dir, now: () => new Date() }),
    })).toThrow(/loadOriginRecords/);
  });
});

describe('read — routes through the union (§7.2)', () => {
  it('disabled store ⇒ strict no-op (no record)', () => {
    const { reader } = buildReader([oRec('A', hlc(1, 0, 'A'))], { enabled: false });
    expect(reader.read('pref', 'k').value).toBeNull();
  });

  it('single origin ⇒ that record', () => {
    const { reader } = buildReader([oRec('A', hlc(1, 0, 'A'))]);
    expect(reader.read('pref', 'k').value?.origin).toBe('A');
  });

  it('HIGH-impact concurrent ⇒ conflict recorded in the ledger (idempotent)', () => {
    const { reader, conflictStore } = buildReader([
      oRec('A', hlc(100, 0, 'A')),
      oRec('B', hlc(999, 0, 'B'), hlc(50, 0, 'B')), // concurrent
    ]);
    const u = reader.read('pref', 'k');
    expect(u.conflict).not.toBeNull();
    expect(conflictStore.listOpen()).toHaveLength(1);
    // re-read ⇒ no third copy
    reader.read('pref', 'k');
    expect(conflictStore.listOpen()).toHaveLength(1);
  });

  it('readAll returns every key through the funnel', () => {
    const { reader } = buildReader([oRec('A', hlc(1, 0, 'A'))]);
    const all = reader.readAll('pref');
    expect(all.get('k')?.value?.origin).toBe('A');
  });
});

describe('post-unmerge zero-dangling-refs (§12 #6 read side)', () => {
  it('a dropped origin is excluded from the union LIVE — surviving read reverts to remaining origin', () => {
    const dropped = new DroppedOriginRegistry({ stateDir: dir });
    const { reader } = buildReader([
      oRec('A', hlc(100, 0, 'A')),
      oRec('B', hlc(999, 0, 'B')), // B would win by HLC but is concurrent
    ], { dropped });
    // Before the drop: concurrent ⇒ conflict (value null).
    expect(reader.read('pref', 'k').value).toBeNull();
    // Drop B ⇒ the union recomputes live, A is the sole survivor.
    dropped.add('pref', 'B', new Date().toISOString());
    const after = reader.read('pref', 'k');
    expect(after.value?.origin).toBe('A'); // ZERO refs to dropped origin B
    expect(after.conflict).toBeNull();
  });

  it('dropping the ONLY other origin can leave "no record" cleanly', () => {
    const dropped = new DroppedOriginRegistry({ stateDir: dir });
    const { reader } = buildReader([oRec('B', hlc(1, 0, 'B'))], { dropped });
    dropped.add('pref', 'B', new Date().toISOString());
    expect(reader.read('pref', 'k').value).toBeNull();
  });
});

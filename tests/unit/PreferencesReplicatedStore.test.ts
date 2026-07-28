/**
 * Tier-1 unit + §12 WIRING-INTEGRITY tests for PreferencesReplicatedStore — the
 * FIRST concrete consumer of the HLC replicated-store foundation (WS2.1,
 * multi-machine-replicated-store-foundation §4 + §7.2 + §15.1).
 *
 * Coverage:
 *   - DUAL-REGISTRY coupling: pref-record in BOTH ReplicatedKindRegistry +
 *     JOURNAL_KINDS (the silent-no-replication ratchet).
 *   - The pref-record store schema: strict typed validation on top of the envelope
 *     (reject free text, jail a path-shaped provenance, narrow/clamp fields).
 *   - The emit builder: recordKey=dedupeKey, violationPattern NEVER replicated,
 *     learning credential-scrubbed.
 *   - THE LOAD-BEARING ADVISORY RECONCILIATION (§15.1): mergeUnionToPreferences /
 *     buildUnionSessionContext inject BOTH variants on an OPEN conflict — proven to
 *     NEVER suppress a usable hint waiting on operator resolution.
 *   - The union-reader-CANNOT-be-bypassed wiring: a read for preferences routes
 *     through ReplicatedStoreReader (the no-clobber funnel), and an open HIGH-impact
 *     conflict is recorded idempotently on a STABLE conflictId.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PREF_STORE_KEY,
  PREF_RECORD_KIND,
  PREF_IMPACT_TIER,
  PREF_RECORD_BOUNDS,
  PREF_KIND_REGISTRATION,
  prefRecordStoreSchema,
  buildPrefRecordData,
  prefEntryToOriginRecord,
  prefEntryFromOriginRecord,
  mergeUnionToPreferences,
  buildUnionSessionContext,
  prefTierOf,
  prefContributingKinds,
} from '../../src/core/PreferencesReplicatedStore.js';
import {
  validateReplicatedEnvelope,
  ReplicatedKindRegistry,
  type EnvelopeValidationCounters,
} from '../../src/core/ReplicatedRecordEnvelope.js';
import { JOURNAL_KINDS, DEFAULT_RETENTION } from '../../src/core/CoherenceJournal.js';
import { ReplicatedStoreReader } from '../../src/core/ReplicatedStoreReader.js';
import { ConflictStore } from '../../src/core/ConflictStore.js';
import { DroppedOriginRegistry } from '../../src/core/RollbackUnmerge.js';
import { DEFAULT_AGGREGATE_JOURNAL_BUDGET_BYTES } from '../../src/core/stateSyncConfig.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import type { OriginRecord, UnionResult } from '../../src/core/UnionReader.js';
import { readUnion } from '../../src/core/UnionReader.js';
import type { PreferenceEntry } from '../../src/core/PreferencesManager.js';

function hlc(p: number, l: number, n: string): HlcTimestamp {
  return { physical: p, logical: l, node: n };
}
function entry(over: Partial<PreferenceEntry> = {}): PreferenceEntry {
  return {
    learning: 'Lead with the action, no preamble.',
    provenance: 'correction-loop',
    dedupeKey: 'lead-with-action',
    recordedAt: '2026-06-13T00:00:00.000Z',
    confidence: 0.8,
    dedupeCount: 3,
    ...over,
  };
}
interface TestCounters extends EnvelopeValidationCounters {
  schema: number;
  dropped: number;
  jail: number;
}
function counters(): TestCounters {
  const c: TestCounters = {
    schema: 0,
    dropped: 0,
    jail: 0,
    bumpSchemaReject() { c.schema++; },
    bumpDroppedField() { c.dropped++; },
    bumpJailReject() { c.jail++; },
  };
  return c;
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefstore-'));
});

// ───────────────────────────────────────────────────────────────────────────
describe('identity + dual-registry coupling (§4)', () => {
  it('the store key + kind are the documented constants', () => {
    expect(PREF_STORE_KEY).toBe('preferences');
    expect(PREF_RECORD_KIND).toBe('pref-record');
    expect(PREF_IMPACT_TIER).toBe('high');
    expect(prefContributingKinds()).toEqual(['pref-record']);
    expect(prefTierOf('preferences')).toBe('high');
    expect(prefTierOf('anything-else')).toBe('high'); // conservative default
  });

  it('pref-record is in JOURNAL_KINDS (the STATIC half of the dual registry)', () => {
    expect((JOURNAL_KINDS as string[]).includes('pref-record')).toBe(true);
    // and the journal ships a retention entry for it (no missing-kind tsc hole).
    expect(DEFAULT_RETENTION['pref-record']).toBeDefined();
  });

  it('PREF_KIND_REGISTRATION registers cleanly onto a ReplicatedKindRegistry (the DYNAMIC half)', () => {
    const reg = new ReplicatedKindRegistry();
    expect(() => reg.register(PREF_KIND_REGISTRATION)).not.toThrow();
    expect(reg.getByStore('preferences')?.kind).toBe('pref-record');
    expect(reg.getByKind('pref-record')?.store).toBe('preferences');
    // The coupling ratchet: a registry holding the real registration reports NO
    // uncoupled kind against JOURNAL_KINDS.
    const missing = reg.kinds().filter((k) => !(JOURNAL_KINDS as string[]).includes(k));
    expect(missing).toEqual([]);
  });

  it('per-kind bounds are tight + under the aggregate journal budget (§8 / §10.2 per-kind ≤ aggregate)', () => {
    expect(PREF_RECORD_BOUNDS.retention.maxFileBytes).toBeLessThanOrEqual(DEFAULT_AGGREGATE_JOURNAL_BUDGET_BYTES);
    expect(PREF_RECORD_BOUNDS.rateCap.capacity).toBeGreaterThan(0);
    expect(PREF_RECORD_BOUNDS.rateCap.refillPerSec).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('pref-record store schema (§4 strict typed validation)', () => {
  function validate(data: Record<string, unknown>) {
    const c = counters();
    const result = validateReplicatedEnvelope(data, prefRecordStoreSchema, c);
    return { result, c };
  }
  const base = () => ({
    learning: 'plainer please',
    confidence: 0.7,
    dedupeCount: 2,
    provenance: 'correction-loop',
    recordedAt: '2026-06-13T00:00:00.000Z',
    recordKey: 'k1',
    hlc: hlc(10, 0, 'A'),
    op: 'put' as const,
    origin: 'A',
  });

  it('a well-formed pref-record validates + reconstructs deterministically', () => {
    const { result } = validate(base());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.recordKey).toBe('k1');
    expect(result.storeFields.learning).toBe('plainer please');
    expect(result.storeFields.confidence).toBe(0.7);
    expect(result.data.op).toBe('put');
  });

  it('an empty learning REJECTS the whole record', () => {
    const { result, c } = validate({ ...base(), learning: '' });
    expect(result.ok).toBe(false);
    expect(c.schema).toBeGreaterThan(0);
  });

  it('a path-shaped provenance is JAILED (whole record rejected)', () => {
    const { result, c } = validate({ ...base(), provenance: '../etc/passwd' });
    expect(result.ok).toBe(false);
    expect(c.jail).toBeGreaterThan(0);
  });

  it('a confidence out of [0,1] is CLAMPED, not rejected', () => {
    const { result } = validate({ ...base(), confidence: 5 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.storeFields.confidence).toBe(1);
  });

  it('an unknown extra field is DROPPED + counted (not carried into data)', () => {
    const { result, c } = validate({ ...base(), violationPattern: 'regex:secret', surprise: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.storeFields.violationPattern).toBeUndefined(); // local-only → never replicated
      expect(result.storeFields.surprise).toBeUndefined();
    }
    expect(c.dropped).toBeGreaterThanOrEqual(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('emit builder (§4) — recordKey=dedupeKey, local-only stripping, scrub', () => {
  it('recordKey is the dedupeKey; envelope fields are present', () => {
    const data = buildPrefRecordData({ entry: entry(), hlc: hlc(5, 0, 'A'), op: 'put', origin: 'A' });
    expect(data.recordKey).toBe('lead-with-action');
    expect(data.op).toBe('put');
    expect(data.origin).toBe('A');
    expect(data.hlc).toEqual(hlc(5, 0, 'A'));
  });

  it('violationPattern is NEVER included in the emitted data (local-only, finding #1)', () => {
    const withPattern = { ...entry(), violationPattern: 'regex:api_key|secret' } as PreferenceEntry;
    const data = buildPrefRecordData({ entry: withPattern, hlc: hlc(5, 0, 'A'), op: 'put', origin: 'A' });
    expect('violationPattern' in data).toBe(false);
  });

  it('learning is credential-scrubbed when a scrubber flags it (finding #5: still replicates)', () => {
    const data = buildPrefRecordData({
      entry: entry({ learning: 'use token sk-ABCDEF for the api' }),
      hlc: hlc(5, 0, 'A'),
      op: 'put',
      origin: 'A',
      scrub: (s) => (s.includes('sk-') ? { text: 'use token [REDACTED] for the api', redactedCount: 1 } : { text: s, redactedCount: 0 }),
    });
    expect(data.learning).toBe('use token [REDACTED] for the api');
  });

  it('observed witness rides the envelope when supplied; absent when not', () => {
    const withObs = buildPrefRecordData({ entry: entry(), hlc: hlc(5, 0, 'A'), op: 'put', origin: 'A', observed: hlc(3, 0, 'B') });
    expect(withObs.observed).toEqual(hlc(3, 0, 'B'));
    const noObs = buildPrefRecordData({ entry: entry(), hlc: hlc(5, 0, 'A'), op: 'put', origin: 'A' });
    expect('observed' in noObs).toBe(false);
  });

  it('round-trips through prefEntryToOriginRecord → prefEntryFromOriginRecord', () => {
    const rec = prefEntryToOriginRecord(entry(), 'A');
    expect(rec.envelope.recordKey).toBe('lead-with-action');
    const back = prefEntryFromOriginRecord(rec);
    expect(back.learning).toBe('Lead with the action, no preamble.');
    expect(back.dedupeKey).toBe('lead-with-action');
    expect(back.confidence).toBeCloseTo(0.8);
    expect(back.dedupeCount).toBe(3);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('THE LOAD-BEARING advisory reconciliation (§15.1) — both variants on an open conflict', () => {
  // Two origins edited the SAME dedupeKey CONCURRENTLY (neither carries a witness of
  // the other) → readUnion('high') returns a HIGH-impact conflict (value=null).
  function concurrentUnion(): Map<string, UnionResult> {
    const recA: OriginRecord = {
      origin: 'A',
      envelope: { recordKey: 'k', hlc: hlc(10, 0, 'A'), op: 'put', origin: 'A' }, // no observed ⇒ concurrent
      data: { learning: 'plainer', confidence: 0.9, dedupeCount: 2, provenance: 'correction-loop', recordedAt: '2026-06-13T00:00:00.000Z' },
    };
    const recB: OriginRecord = {
      origin: 'B',
      envelope: { recordKey: 'k', hlc: hlc(11, 0, 'B'), op: 'put', origin: 'B' }, // no observed ⇒ concurrent
      data: { learning: 'be terse', confidence: 0.7, dedupeCount: 1, provenance: 'correction-loop', recordedAt: '2026-06-13T01:00:00.000Z' },
    };
    const result = readUnion('k', [recA, recB], 'high');
    expect(result.conflict).not.toBeNull(); // sanity: it IS an open conflict
    expect(result.value).toBeNull();        // sanity: neither clobbers
    return new Map([['k', result]]);
  }

  it('an OPEN conflict yields BOTH variants — it NEVER suppresses a usable hint', () => {
    const merged = mergeUnionToPreferences(concurrentUnion());
    const learnings = merged.map((p) => p.learning).sort();
    expect(learnings).toEqual(['be terse', 'plainer']); // BOTH hints survive
  });

  it('buildUnionSessionContext injects BOTH variants into the session block (the §12 proof)', () => {
    const out = buildUnionSessionContext(concurrentUnion(), 4000);
    expect(out.present).toBe(true);
    expect(out.scope).toBe('mesh');
    expect(out.count).toBe(2);
    expect(out.block).toContain('plainer');
    expect(out.block).toContain('be terse');
  });

  it('a RESOLVED single value injects exactly that one hint', () => {
    const rec: OriginRecord = {
      origin: 'A',
      envelope: { recordKey: 'k', hlc: hlc(10, 0, 'A'), op: 'put', origin: 'A' },
      data: { learning: 'just one', confidence: 0.5, dedupeCount: 1, provenance: 'correction-loop', recordedAt: '2026-06-13T00:00:00.000Z' },
    };
    const union = new Map([['k', readUnion('k', [rec], 'high')]]);
    const merged = mergeUnionToPreferences(union);
    expect(merged.map((p) => p.learning)).toEqual(['just one']);
  });

  it('a delete-tombstone winner injects NO hint for that key (nothing usable)', () => {
    const rec: OriginRecord = {
      origin: 'A',
      envelope: { recordKey: 'k', hlc: hlc(10, 0, 'A'), op: 'delete', origin: 'A' },
      data: {},
    };
    const union = new Map([['k', readUnion('k', [rec], 'high')]]);
    expect(mergeUnionToPreferences(union)).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('wiring-integrity (§12): the union reader CANNOT be bypassed for preferences', () => {
  function buildPrefReader(records: OriginRecord[], enabled = true) {
    const registry = new ReplicatedKindRegistry();
    registry.register(PREF_KIND_REGISTRATION);
    const dropped = new DroppedOriginRegistry({ stateDir: dir });
    const conflictStore = new ConflictStore({ stateDir: dir, now: () => new Date() });
    const reader = new ReplicatedStoreReader({
      registry,
      stores: { preferences: { enabled } },
      tierOf: prefTierOf,
      loadOriginRecords: () => records,
      listRecordKeys: () => ['k'],
      droppedOrigins: dropped,
      conflictStore,
    });
    return { reader, conflictStore };
  }

  it('a disabled preferences store ⇒ strict no-op (the dark default)', () => {
    const { reader } = buildPrefReader([prefEntryToOriginRecord(entry(), 'A')], false);
    expect(reader.read('preferences', 'k').value).toBeNull();
  });

  it('a single-origin read returns the local record (single-machine = no-op union)', () => {
    const rec = prefEntryToOriginRecord(entry({ dedupeKey: 'k' }), 'A');
    const { reader } = buildPrefReader([rec]);
    const r = reader.read('preferences', 'k');
    expect(r.value?.origin).toBe('A');
    expect(r.conflict).toBeNull();
  });

  it('an OPEN HIGH-impact conflict is RECORDED idempotently on a STABLE conflictId', () => {
    const recA: OriginRecord = { origin: 'A', envelope: { recordKey: 'k', hlc: hlc(10, 0, 'A'), op: 'put', origin: 'A' }, data: { learning: 'a' } };
    const recB: OriginRecord = { origin: 'B', envelope: { recordKey: 'k', hlc: hlc(11, 0, 'B'), op: 'put', origin: 'B' }, data: { learning: 'b' } };
    const { reader, conflictStore } = buildPrefReader([recA, recB]);

    const first = reader.read('preferences', 'k');
    expect(first.conflict).not.toBeNull();
    const id = first.conflict!.conflictId;
    const open1 = conflictStore.listOpen();
    expect(open1).toHaveLength(1);
    expect(open1[0].conflictId).toBe(id);

    // Re-reading the SAME open conflict must NOT append a third copy (idempotent on
    // the stable conflictId) — the recurrence count bumps, the ledger stays at one.
    reader.read('preferences', 'k');
    reader.read('preferences', 'k');
    const open2 = conflictStore.listOpen();
    expect(open2).toHaveLength(1);
    expect(open2[0].conflictId).toBe(id);
  });

  it('post-unmerge: a dropped origin leaves ZERO dangling refs in the read (§7.4 read side)', () => {
    const recA: OriginRecord = { origin: 'A', envelope: { recordKey: 'k', hlc: hlc(10, 0, 'A'), op: 'put', origin: 'A' }, data: { learning: 'a' } };
    const recB: OriginRecord = { origin: 'B', envelope: { recordKey: 'k', hlc: hlc(11, 0, 'B'), op: 'put', origin: 'B' }, data: { learning: 'b' } };
    const registry = new ReplicatedKindRegistry();
    registry.register(PREF_KIND_REGISTRATION);
    const dropped = new DroppedOriginRegistry({ stateDir: dir });
    const conflictStore = new ConflictStore({ stateDir: dir, now: () => new Date() });
    const reader = new ReplicatedStoreReader({
      registry,
      stores: { preferences: { enabled: true } },
      tierOf: prefTierOf,
      loadOriginRecords: () => [recA, recB],
      listRecordKeys: () => ['k'],
      droppedOrigins: dropped,
      conflictStore,
    });
    // Before the un-merge: the two origins are concurrent ⇒ conflict.
    expect(reader.read('preferences', 'k').conflict).not.toBeNull();
    // Drop origin B (the §7.4 live exclusion). Now only A participates ⇒ A wins,
    // no conflict, and the resolved value references ONLY the surviving origin.
    dropped.add('preferences', 'B', new Date().toISOString());
    const after = reader.read('preferences', 'k');
    expect(after.conflict).toBeNull();
    expect(after.value?.origin).toBe('A'); // ZERO refs to dropped origin B
  });
});

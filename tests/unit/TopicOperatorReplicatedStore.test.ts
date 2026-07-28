/**
 * Unit tests for TopicOperatorReplicatedStore (WS2.6 — the THIRD PII kind on the HLC
 * replicated-store foundation, completing the WS2 memory family). Covers the named blocker/gate
 * tests from the build prompt:
 *   - dual-registry coupling (topic-operator-record in BOTH registries)
 *   - recordKey-identity-collapses-cross-machine (fork #1 — sha256(topicId + ":" + verified-uid),
 *     NEVER a content-name; same binding across machines collapses; a different uid is a
 *     different record)
 *   - disclosure-min (fork #4 — only {platform, uid, names, boundAt}, no extra local field)
 *   - 64KB-named-error (an over-cap projection is a NAMED rejection)
 *   - op:delete-tombstone-erasure (the op:'delete' branch accepts a tombstone keyed on the SAME
 *     (topic, uid) recordKey)
 *   - type-clamp (ISO-8601 / jailed-slug clamps reject smuggled markup)
 *   - untrusted-replicated-operator-never-authoritative (THE blocker lens #1 — the foreign render
 *     ALWAYS says the record is NOT the verified operator; there is NO apply path back into
 *     TopicOperatorStore — the cross-store authority test lives in the wiring test)
 *   - mergeUnionToTopicOperators advisory append-both
 *   - own-origin materialization keys on (topic, uid)
 */
import { describe, it, expect } from 'vitest';

import {
  TOPIC_OPERATOR_STORE_KEY,
  TOPIC_OPERATOR_RECORD_KIND,
  TOPIC_OPERATOR_IMPACT_TIER,
  TOPIC_OPERATOR_KIND_REGISTRATION,
  TOPIC_OPERATOR_STORE_KNOWN_FIELDS,
  TOPIC_OPERATOR_MAX_ENTRY_BYTES,
  topicOperatorRecordStoreSchema,
  buildTopicOperatorRecordData,
  buildTopicOperatorTombstoneData,
  deriveTopicOperatorRecordKey,
  mergeUnionToTopicOperators,
  renderForeignTopicOperatorContext,
  topicOperatorToOriginRecord,
  topicOperatorTierOf,
  topicOperatorContributingKinds,
  assertProjectionUnderCap,
  TopicOperatorRecordTooLargeError,
  isIso8601,
} from '../../src/core/TopicOperatorReplicatedStore.js';
import { validateReplicatedEnvelope, RESERVED_ENVELOPE_FIELDS } from '../../src/core/ReplicatedRecordEnvelope.js';
import { JOURNAL_KINDS } from '../../src/core/CoherenceJournal.js';
import type { TopicOperator } from '../../src/users/TopicOperatorStore.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import type { OriginRecord, UnionResult } from '../../src/core/UnionReader.js';

function hlc(p: number, l = 0, n = 'm_self'): HlcTimestamp {
  return { physical: p, logical: l, node: n };
}

function makeOperator(over: Partial<TopicOperator> = {}): TopicOperator {
  return {
    platform: 'telegram',
    uid: '999888',
    names: ['justin'],
    boundAt: '2026-06-01T00:00:00.000Z',
    boundFrom: 'authenticated-inbound',
    ...over,
  };
}

function newCounters() {
  const c = { schema: 0, dropped: 0, jail: 0 };
  return {
    counters: c,
    bag: {
      bumpSchemaReject: () => { c.schema++; },
      bumpDroppedField: () => { c.dropped++; },
      bumpJailReject: () => { c.jail++; },
    },
  };
}

// ── Dual registry ───────────────────────────────────────────────────

describe('dual-registry coupling', () => {
  it('topic-operator-record is in JOURNAL_KINDS (the static half)', () => {
    expect(JOURNAL_KINDS).toContain(TOPIC_OPERATOR_RECORD_KIND);
  });
  it('the registration descriptor names the kind + store', () => {
    expect(TOPIC_OPERATOR_KIND_REGISTRATION.kind).toBe(TOPIC_OPERATOR_RECORD_KIND);
    expect(TOPIC_OPERATOR_KIND_REGISTRATION.store).toBe(TOPIC_OPERATOR_STORE_KEY);
    expect(TOPIC_OPERATOR_KIND_REGISTRATION.schema).toBe(topicOperatorRecordStoreSchema);
  });
  it('the store is HIGH-impact (append-both-and-flag at replication)', () => {
    expect(TOPIC_OPERATOR_IMPACT_TIER).toBe('high');
    expect(topicOperatorTierOf('topicOperator')).toBe('high');
    expect(topicOperatorTierOf('anything-unknown')).toBe('high');
  });
  it('contributing kinds resolves to the one kind', () => {
    expect(topicOperatorContributingKinds()).toEqual([TOPIC_OPERATOR_RECORD_KIND]);
  });
  it('the schema knownFields NEVER include a reserved envelope field, and are exactly the projection', () => {
    for (const f of TOPIC_OPERATOR_STORE_KNOWN_FIELDS) {
      expect(RESERVED_ENVELOPE_FIELDS).not.toContain(f);
    }
    // fork #4 — exactly {platform, uid, names, boundAt}
    expect([...TOPIC_OPERATOR_STORE_KNOWN_FIELDS].sort()).toEqual(['boundAt', 'names', 'platform', 'uid']);
  });
});

// ── recordKey-identity-collapses-cross-machine (blocker lens #2) ─────

describe('recordKey identity derivation (topic+uid fingerprint, NEVER a content-name)', () => {
  it('derives the SAME key on two machines for the same (topic, verified-uid)', () => {
    const k1 = deriveTopicOperatorRecordKey(42, '999888');
    const k2 = deriveTopicOperatorRecordKey('42', '999888');
    expect(k1).toBe(k2);
    expect(k1).not.toBeNull();
  });

  it('a DIFFERENT uid on the SAME topic is a DIFFERENT record (a re-bind to a new operator)', () => {
    const a = deriveTopicOperatorRecordKey(42, 'uidA');
    const b = deriveTopicOperatorRecordKey(42, 'uidB');
    expect(a).not.toBe(b);
  });

  it('the same uid on a DIFFERENT topic is a DIFFERENT record', () => {
    const a = deriveTopicOperatorRecordKey(1, 'uid');
    const b = deriveTopicOperatorRecordKey(2, 'uid');
    expect(a).not.toBe(b);
  });

  it('the \\x1f delimiter prevents field-straddle collisions (topic "1"|"2uid" vs "12"|"uid")', () => {
    const a = deriveTopicOperatorRecordKey('1', '2uid');
    const b = deriveTopicOperatorRecordKey('12', 'uid');
    expect(a).not.toBe(b);
  });

  it('an empty topicId OR uid has NO identity surface (null) — not replicable', () => {
    expect(deriveTopicOperatorRecordKey('', 'uid')).toBeNull();
    expect(deriveTopicOperatorRecordKey(42, '')).toBeNull();
  });
});

// ── disclosure-min (fork #4) ─────────────────────────────────────────

describe('disclosure-minimized projection ({platform, uid, names, boundAt} only)', () => {
  it('buildTopicOperatorRecordData emits only the enumerated fields + envelope', () => {
    const data = buildTopicOperatorRecordData({ topicId: 42, record: makeOperator(), hlc: hlc(100), origin: 'm_self' })!;
    expect(data).not.toBeNull();
    expect(data.platform).toBe('telegram');
    expect(data.uid).toBe('999888');
    expect(data.names).toEqual(['justin']);
    expect(data.recordKey).toBe(deriveTopicOperatorRecordKey(42, '999888'));
    expect(data.op).toBe('put');
    // no `boundFrom` (an internal provenance field) crosses the wire
    expect(data.boundFrom).toBeUndefined();
  });

  it('returns null when topicId/uid yield no identity surface', () => {
    expect(buildTopicOperatorRecordData({ topicId: 42, record: makeOperator({ uid: '' }), hlc: hlc(1), origin: 'm' })).toBeNull();
  });
});

// ── 64KB-named-error ─────────────────────────────────────────────────

describe('per-entry cap (over-cap is a NAMED rejection)', () => {
  it('a normal record serializes well under the 64KB cap and round-trips', () => {
    const data = buildTopicOperatorRecordData({ topicId: 42, record: makeOperator(), hlc: hlc(100), origin: 'm_self' })!;
    expect(Buffer.byteLength(JSON.stringify(data), 'utf-8')).toBeLessThan(TOPIC_OPERATOR_MAX_ENTRY_BYTES);
    const { bag } = newCounters();
    expect(validateReplicatedEnvelope(data, topicOperatorRecordStoreSchema, bag).ok).toBe(true);
  });

  it('an over-cap projection is a NAMED rejection, not a silent truncate', () => {
    const oversize: Record<string, unknown> = { recordKey: 'k', blob: 'z'.repeat(TOPIC_OPERATOR_MAX_ENTRY_BYTES + 10) };
    expect(() => assertProjectionUnderCap('k', oversize)).toThrow(TopicOperatorRecordTooLargeError);
  });
});

// ── type-clamp ───────────────────────────────────────────────────────

describe('foreign-record-type-clamped (injection defense on apply)', () => {
  function applyForeign(data: Record<string, unknown>) {
    const { counters, bag } = newCounters();
    return { res: validateReplicatedEnvelope(data, topicOperatorRecordStoreSchema, bag), counters };
  }
  function baseForeign(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      recordKey: 'abc', hlc: hlc(100, 0, 'm_peer'), op: 'put', origin: 'm_peer',
      platform: 'telegram', uid: '999', names: ['justin'], boundAt: '2026-06-01T00:00:00.000Z',
      ...over,
    };
  }

  it('a valid foreign record round-trips', () => {
    const { res } = applyForeign(baseForeign());
    expect(res.ok).toBe(true);
    if (res.ok) { expect(res.data.uid).toBe('999'); expect(res.data.platform).toBe('telegram'); }
  });

  it('a non-date boundAt is normalized to "" (markup cannot survive the clamp)', () => {
    const { res } = applyForeign(baseForeign({ boundAt: '<script>x</script>' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.boundAt).toBe('');
  });

  it('a path-shaped uid rejects the whole record (jail)', () => {
    const { res } = applyForeign(baseForeign({ uid: '../../etc/passwd' }));
    expect(res.ok).toBe(false);
  });

  it('a record with no uid is rejected', () => {
    const { res } = applyForeign(baseForeign({ uid: '' }));
    expect(res.ok).toBe(false);
  });

  it('isIso8601 accepts a clean ISO date and rejects markup', () => {
    expect(isIso8601('2026-06-01T00:00:00.000Z')).toBe(true);
    expect(isIso8601('2026<script>')).toBe(false);
  });
});

// ── untrusted-replicated-operator-never-authoritative (THE blocker, lens #1) ──

describe('untrusted-replicated-operator-never-authoritative (store-level)', () => {
  it('the foreign render ALWAYS states the record is NOT the verified operator', () => {
    const block = renderForeignTopicOperatorContext({
      recordKey: 'k', origin: 'm_peer', conflicted: false,
      data: { platform: 'telegram', uid: '999', names: ['justin'], boundAt: '2026-06-01T00:00:00.000Z' },
    })!;
    expect(block).toContain('<replicated-untrusted-data origin="m_peer">');
    expect(block).toContain('NOT the verified operator');
    expect(block).toContain('cannot establish or override');
    expect(block).toContain('authenticated sender');
  });

  it('the foreign render escapes a markup-bearing name (no envelope break)', () => {
    const block = renderForeignTopicOperatorContext({
      recordKey: 'k', origin: 'm_peer', conflicted: false,
      data: { platform: 'telegram', uid: '999', names: ['<b>evil</b>'], boundAt: '' },
    })!;
    expect(block).toContain('&lt;b&gt;evil&lt;/b&gt;');
    expect(block).not.toContain('<b>evil</b>');
  });

  it('the module exposes NO setter/applier into TopicOperatorStore — only emit + read helpers', async () => {
    // The invariant is structural: the store builds emit projections + merges reads, but provides
    // NO function that writes a foreign record into the local authoritative binding. The wiring
    // test proves getOperator() authority is unchanged by a replicated record; here we assert the
    // module surface carries no apply/set/establish export.
    const mod = await import('../../src/core/TopicOperatorReplicatedStore.js');
    const applyish = Object.keys(mod).filter((k) => /^(apply|set|establish|writeLocal)/i.test(k));
    expect(applyish).toEqual([]);
  });

  it('a malformed view (no uid) yields null', () => {
    expect(renderForeignTopicOperatorContext({ recordKey: 'k', origin: 'm', conflicted: false, data: {} })).toBeNull();
  });
});

// ── op:delete-tombstone-erasure ──────────────────────────────────────

describe('op:delete tombstone (unbind erasure that survives an offline peer)', () => {
  it('buildTopicOperatorTombstoneData keys on the SAME (topic, uid) recordKey the put used', () => {
    const put = buildTopicOperatorRecordData({ topicId: 42, record: makeOperator(), hlc: hlc(100), origin: 'm_self' })!;
    const tomb = buildTopicOperatorTombstoneData({ topicId: 42, uid: '999888', hlc: hlc(200), origin: 'm_self', deletedAt: '2026-06-02T00:00:00.000Z' })!;
    expect(tomb.recordKey).toBe(put.recordKey);
    expect(tomb.op).toBe('delete');
  });

  it('the schema accepts a tombstone in the op:delete branch', () => {
    const { bag } = newCounters();
    const tomb = { recordKey: 'k', hlc: hlc(200, 0, 'm_peer'), op: 'delete', origin: 'm_peer', deletedAt: '2026-06-02T00:00:00.000Z' };
    expect(validateReplicatedEnvelope(tomb, topicOperatorRecordStoreSchema, bag).ok).toBe(true);
  });
});

// ── mergeUnionToTopicOperators advisory append-both ──────────────────

describe('mergeUnionToTopicOperators (HIGH-impact append-both, advisory read)', () => {
  function originRec(origin: string, uid: string, op: 'put' | 'delete' = 'put'): OriginRecord {
    return {
      origin,
      envelope: { recordKey: 'k', hlc: hlc(100, 0, origin), op, origin },
      data: { platform: 'telegram', uid, names: ['x'], boundAt: '' },
    };
  }

  it('a resolved single value yields one non-conflicted view', () => {
    const union = new Map<string, UnionResult>([['k', { value: originRec('m_A', 'u1'), conflict: null } as UnionResult]]);
    const views = mergeUnionToTopicOperators(union);
    expect(views).toHaveLength(1);
    expect(views[0].conflicted).toBe(false);
  });

  it('an OPEN conflict injects BOTH variants (append-both, never a silent clobber)', () => {
    const union = new Map<string, UnionResult>([
      ['k', { value: null, conflict: { versions: [originRec('m_A', 'u1'), originRec('m_B', 'u2')] } } as UnionResult],
    ]);
    const views = mergeUnionToTopicOperators(union);
    expect(views).toHaveLength(2);
    expect(views.every((v) => v.conflicted)).toBe(true);
  });

  it('a delete-resolved key contributes nothing', () => {
    const union = new Map<string, UnionResult>([['k', { value: originRec('m_A', 'gone', 'delete'), conflict: null } as UnionResult]]);
    expect(mergeUnionToTopicOperators(union)).toHaveLength(0);
  });
});

// ── own-origin materialization ───────────────────────────────────────

describe('topicOperatorToOriginRecord (own-origin materialization)', () => {
  it('keys on (topic, uid) + carries exactly the projection', () => {
    const o = topicOperatorToOriginRecord(42, makeOperator(), 'm_self')!;
    expect(o.envelope.recordKey).toBe(deriveTopicOperatorRecordKey(42, '999888'));
    expect((o.data as Record<string, unknown>).boundFrom).toBeUndefined();
    expect((o.data as Record<string, unknown>).uid).toBe('999888');
  });

  it('returns null for a uid-less record (no identity surface)', () => {
    expect(topicOperatorToOriginRecord(42, makeOperator({ uid: '' }), 'm_self')).toBeNull();
  });
});

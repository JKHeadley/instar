/**
 * Unit tests for UserRegistryReplicatedStore (WS2.6 — the SECOND PII kind on the HLC
 * replicated-store foundation). Covers the named blocker/gate tests from the build prompt:
 *   - dual-registry coupling (user-record in BOTH registries)
 *   - recordKey-identity-collapses-cross-machine (fork #1 — channel-set fingerprint, NEVER the
 *     local userId; same user across machines collapses; collision-resistant)
 *   - disclosure-min-strips-local-id (fork #3 — no `userId`, no field outside the projection)
 *   - 64KB-named-error (a fat profile replicates; an over-cap projection is a NAMED rejection)
 *   - op:delete-tombstone-erasure (the op:'delete' schema branch accepts a tombstone, keyed on
 *     the SAME channel-set recordKey the put used)
 *   - type-clamp (ISO-8601 / finite-number / jailed-channel clamps reject smuggled markup)
 *   - mergeUnionToUsers advisory append-both (open conflict injects BOTH, never blocks)
 *   - foreign render safety (quoted untrusted data)
 *   - own-origin materialization keys on the channel set, never the local id
 */
import { describe, it, expect } from 'vitest';

import {
  USER_STORE_KEY,
  USER_RECORD_KIND,
  USER_IMPACT_TIER,
  USER_KIND_REGISTRATION,
  USER_STORE_KNOWN_FIELDS,
  USER_MAX_ENTRY_BYTES,
  MAX_CHANNELS,
  userRecordStoreSchema,
  buildUserRecordData,
  buildUserTombstoneData,
  deriveUserRecordKey,
  channelUid,
  mergeUnionToUsers,
  renderForeignUserContext,
  userToOriginRecord,
  userTierOf,
  userContributingKinds,
  assertProjectionUnderCap,
  UserRecordTooLargeError,
  isIso8601,
} from '../../src/core/UserRegistryReplicatedStore.js';
import { validateReplicatedEnvelope, RESERVED_ENVELOPE_FIELDS } from '../../src/core/ReplicatedRecordEnvelope.js';
import { JOURNAL_KINDS } from '../../src/core/CoherenceJournal.js';
import type { UserProfile } from '../../src/core/types.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import type { OriginRecord, UnionResult } from '../../src/core/UnionReader.js';

function hlc(p: number, l = 0, n = 'm_self'): HlcTimestamp {
  return { physical: p, logical: l, node: n };
}

function makeUser(over: Partial<UserProfile> = {}): UserProfile {
  return {
    id: 'usr_local_abc',
    name: 'Justin',
    channels: [{ type: 'telegram', identifier: '12345' }],
    permissions: ['admin'],
    preferences: {},
    createdAt: '2026-06-01T00:00:00.000Z',
    telegramUserId: 999,
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
  it('user-record is in JOURNAL_KINDS (the static half)', () => {
    expect(JOURNAL_KINDS).toContain(USER_RECORD_KIND);
  });
  it('the registration descriptor names the kind + store', () => {
    expect(USER_KIND_REGISTRATION.kind).toBe(USER_RECORD_KIND);
    expect(USER_KIND_REGISTRATION.store).toBe(USER_STORE_KEY);
    expect(USER_KIND_REGISTRATION.schema).toBe(userRecordStoreSchema);
  });
  it('the store is HIGH-impact (append-both-and-flag at replication)', () => {
    expect(USER_IMPACT_TIER).toBe('high');
    expect(userTierOf('userRegistry')).toBe('high');
    expect(userTierOf('anything-unknown')).toBe('high'); // conservative default
  });
  it('contributing kinds resolves to the one kind', () => {
    expect(userContributingKinds()).toEqual([USER_RECORD_KIND]);
  });
  it('the schema knownFields NEVER include a reserved envelope field or the local id', () => {
    for (const f of USER_STORE_KNOWN_FIELDS) {
      expect(RESERVED_ENVELOPE_FIELDS).not.toContain(f);
    }
    expect(USER_STORE_KNOWN_FIELDS).not.toContain('id');
  });
});

// ── recordKey-identity-collapses-cross-machine (blocker lens #2) ─────

describe('recordKey identity derivation (channel-set fingerprint, NEVER the local userId)', () => {
  it('derives the SAME key on two machines for the same channel set, regardless of the local id', () => {
    const a = makeUser({ id: 'usr_A' });
    const b = makeUser({ id: 'usr_B' }); // different machine's userId, same channels
    expect(deriveUserRecordKey(a.channels)).toBe(deriveUserRecordKey(b.channels));
    expect(deriveUserRecordKey(a.channels)).not.toBeNull();
  });

  it('order-independent: the same channel set in a different order collapses to ONE key', () => {
    const k1 = deriveUserRecordKey([{ type: 'telegram', identifier: '1' }, { type: 'slack', identifier: 'U2' }]);
    const k2 = deriveUserRecordKey([{ type: 'slack', identifier: 'U2' }, { type: 'telegram', identifier: '1' }]);
    expect(k1).toBe(k2);
  });

  it('absorbs trivial channel-type case drift (channelUid lowercases type)', () => {
    expect(channelUid({ type: 'Telegram', identifier: '12345' })).toBe('telegram:12345');
    const k1 = deriveUserRecordKey([{ type: 'TELEGRAM', identifier: '12345' }]);
    const k2 = deriveUserRecordKey([{ type: 'telegram', identifier: '12345' }]);
    expect(k1).toBe(k2);
  });

  it('two DIFFERENT users (different channels) get DIFFERENT keys (no collision)', () => {
    const a = deriveUserRecordKey([{ type: 'telegram', identifier: '1' }]);
    const b = deriveUserRecordKey([{ type: 'telegram', identifier: '2' }]);
    expect(a).not.toBe(b);
  });

  it('a user with NO channels has NO identity surface (null) — not replicable', () => {
    expect(deriveUserRecordKey([])).toBeNull();
  });
});

// ── disclosure-min-strips-local-id (blocker lens #3) ─────────────────

describe('disclosure-minimized projection (the local userId NEVER replicated)', () => {
  it('buildUserRecordData strips the local userId + emits only the enumerated fields', () => {
    const rec = makeUser({ id: 'usr_SECRET_LOCAL', context: 'should not leak', bio: 'private' });
    const data = buildUserRecordData({ record: rec, hlc: hlc(100), origin: 'm_self' })!;
    expect(data).not.toBeNull();
    expect(JSON.stringify(data)).not.toContain('usr_SECRET_LOCAL');
    expect(data.id).toBeUndefined();
    expect(data.context).toBeUndefined();
    expect(data.bio).toBeUndefined();
    // the projection carries the channel-set identity + merge-relevant fields
    expect(data.name).toBe('Justin');
    expect(data.recordKey).toBe(deriveUserRecordKey(rec.channels));
    expect(data.op).toBe('put');
  });

  it('returns null for a channel-less record (no identity surface ⇒ caller skips emission)', () => {
    expect(buildUserRecordData({ record: makeUser({ channels: [] }), hlc: hlc(1), origin: 'm' })).toBeNull();
  });
});

// ── 64KB-named-error ─────────────────────────────────────────────────

describe('per-entry cap (fat profile replicates; over-cap is a NAMED rejection)', () => {
  it('fat-record-replicates: the LARGEST legal projection serializes UNDER the 64KB cap and round-trips', () => {
    const channels = Array.from({ length: MAX_CHANNELS }, (_, i) => ({ type: 'telegram', identifier: String(i) }));
    const rec = makeUser({ channels, permissions: Array.from({ length: 50 }, (_, i) => `perm-${i}`) });
    const data = buildUserRecordData({ record: rec, hlc: hlc(100), origin: 'm_self' })!;
    expect(data).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(data), 'utf-8')).toBeLessThan(USER_MAX_ENTRY_BYTES);
    const { bag } = newCounters();
    expect(validateReplicatedEnvelope(data, userRecordStoreSchema, bag).ok).toBe(true);
  });

  it('fat-record-does-not-wedge-stream: an over-cap projection is a NAMED rejection, not a silent truncate', () => {
    const oversize: Record<string, unknown> = { recordKey: 'k', blob: 'z'.repeat(USER_MAX_ENTRY_BYTES + 10) };
    expect(() => assertProjectionUnderCap('k', oversize)).toThrow(UserRecordTooLargeError);
    try {
      assertProjectionUnderCap('k', oversize);
    } catch (e) {
      expect(e).toBeInstanceOf(UserRecordTooLargeError);
      expect((e as UserRecordTooLargeError).recordKey).toBe('k');
    }
  });
});

// ── type-clamp (injection defense on apply) ──────────────────────────

describe('foreign-record-type-clamped (injection defense on apply)', () => {
  function applyForeign(data: Record<string, unknown>) {
    const { counters, bag } = newCounters();
    const res = validateReplicatedEnvelope(data, userRecordStoreSchema, bag);
    return { res, counters };
  }

  function baseForeign(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      recordKey: 'abc123',
      hlc: hlc(100, 0, 'm_peer'),
      op: 'put',
      origin: 'm_peer',
      name: 'evil user',
      channels: [{ type: 'telegram', identifier: '12345' }],
      permissions: ['user'],
      ...over,
    };
  }

  it('a valid foreign record round-trips with channels + permissions intact', () => {
    const { res } = applyForeign(baseForeign({ telegramUserId: 42 }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.name).toBe('evil user');
      expect(res.data.telegramUserId).toBe(42);
      expect(Array.isArray(res.data.channels)).toBe(true);
    }
  });

  it('a non-date createdAt is DROPPED (markup cannot survive the clamp)', () => {
    const { res } = applyForeign(baseForeign({ createdAt: '<script>alert(1)</script>' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.createdAt).toBeUndefined();
  });

  it('a string telegramUserId (markup attempt) is DROPPED (number slot)', () => {
    const { res } = applyForeign(baseForeign({ telegramUserId: '<b>999</b>' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.telegramUserId).toBeUndefined();
  });

  it('a path-shaped channel type rejects the whole record (jail)', () => {
    const { res } = applyForeign(baseForeign({ channels: [{ type: '../../etc/passwd', identifier: 'x' }] }));
    expect(res.ok).toBe(false);
  });

  it('a record with no name is rejected', () => {
    const { res } = applyForeign(baseForeign({ name: '' }));
    expect(res.ok).toBe(false);
  });

  it('isIso8601 accepts a clean ISO date and rejects markup', () => {
    expect(isIso8601('2026-06-01T00:00:00.000Z')).toBe(true);
    expect(isIso8601('2026-06-01<script>')).toBe(false);
    expect(isIso8601('not a date')).toBe(false);
  });
});

// ── op:delete-tombstone-erasure ──────────────────────────────────────

describe('op:delete tombstone (erasure that survives an offline peer)', () => {
  it('buildUserTombstoneData keys the tombstone on the SAME channel-set recordKey the put used', () => {
    const rec = makeUser();
    const put = buildUserRecordData({ record: rec, hlc: hlc(100), origin: 'm_self' })!;
    const tomb = buildUserTombstoneData({ channels: rec.channels, hlc: hlc(200), origin: 'm_self', deletedAt: '2026-06-02T00:00:00.000Z' })!;
    expect(tomb).not.toBeNull();
    expect(tomb.recordKey).toBe(put.recordKey);
    expect(tomb.op).toBe('delete');
    expect(tomb.deletedAt).toBe('2026-06-02T00:00:00.000Z');
  });

  it('the schema accepts a tombstone in the op:delete branch (coexists with the value schema)', () => {
    const { bag } = newCounters();
    const tomb = { recordKey: 'k', hlc: hlc(200, 0, 'm_peer'), op: 'delete', origin: 'm_peer', deletedAt: '2026-06-02T00:00:00.000Z' };
    const res = validateReplicatedEnvelope(tomb, userRecordStoreSchema, bag);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.deletedAt).toBe('2026-06-02T00:00:00.000Z');
  });

  it('a channel-less user has no identity surface to tombstone (null)', () => {
    expect(buildUserTombstoneData({ channels: [], hlc: hlc(1), origin: 'm', deletedAt: '2026-06-02T00:00:00.000Z' })).toBeNull();
  });
});

// ── mergeUnionToUsers advisory append-both ───────────────────────────

describe('mergeUnionToUsers (HIGH-impact append-both, advisory read)', () => {
  function originRec(origin: string, name: string, op: 'put' | 'delete' = 'put'): OriginRecord {
    return {
      origin,
      envelope: { recordKey: 'k', hlc: hlc(100, 0, origin), op, origin },
      data: { name, channels: [{ type: 'telegram', identifier: '1' }], permissions: [] },
    };
  }

  it('a resolved single value yields one non-conflicted view entry', () => {
    const union = new Map<string, UnionResult>([
      ['k', { value: originRec('m_A', 'Justin'), conflict: null } as UnionResult],
    ]);
    const views = mergeUnionToUsers(union);
    expect(views).toHaveLength(1);
    expect(views[0].data.name).toBe('Justin');
    expect(views[0].conflicted).toBe(false);
  });

  it('an OPEN conflict injects BOTH put variants (append-both, never a silent clobber)', () => {
    const union = new Map<string, UnionResult>([
      ['k', { value: null, conflict: { versions: [originRec('m_A', 'JustinA'), originRec('m_B', 'JustinB')] } } as UnionResult],
    ]);
    const views = mergeUnionToUsers(union);
    expect(views).toHaveLength(2);
    expect(views.every((v) => v.conflicted)).toBe(true);
    expect(new Set(views.map((v) => v.data.name))).toEqual(new Set(['JustinA', 'JustinB']));
  });

  it('a delete-resolved key contributes nothing (the tombstone wins)', () => {
    const union = new Map<string, UnionResult>([
      ['k', { value: originRec('m_A', 'gone', 'delete'), conflict: null } as UnionResult],
    ]);
    expect(mergeUnionToUsers(union)).toHaveLength(0);
  });
});

// ── foreign render safety ────────────────────────────────────────────

describe('renderForeignUserContext (quoted untrusted data)', () => {
  it('wraps a foreign record in the <replicated-untrusted-data> envelope + escapes every field', () => {
    const block = renderForeignUserContext({
      recordKey: 'k', origin: 'm_peer', conflicted: false,
      data: { name: 'Evil <b>User</b>', channels: [{ type: 'telegram', identifier: '1' }], permissions: ['admin'] },
    })!;
    expect(block).toContain('<replicated-untrusted-data origin="m_peer">');
    expect(block).toContain('</replicated-untrusted-data>');
    expect(block).toContain('Evil &lt;b&gt;User&lt;/b&gt;');
    expect(block).not.toContain('<b>User</b>');
  });

  it('a malformed view (no name) yields null', () => {
    expect(renderForeignUserContext({ recordKey: 'k', origin: 'm', conflicted: false, data: {} })).toBeNull();
  });
});

// ── own-origin materialization ───────────────────────────────────────

describe('userToOriginRecord (own-origin materialization, never the local id)', () => {
  it('keys on the channel set + never carries the local userId into the replicated namespace', () => {
    const rec = makeUser({ id: 'usr_LOCAL_ONLY' });
    const o = userToOriginRecord(rec, 'm_self')!;
    expect(o).not.toBeNull();
    expect(o.envelope.recordKey).toBe(deriveUserRecordKey(rec.channels));
    expect(JSON.stringify(o.data)).not.toContain('usr_LOCAL_ONLY');
    expect((o.data as Record<string, unknown>).id).toBeUndefined();
  });

  it('returns null for a channel-less record (no identity surface)', () => {
    expect(userToOriginRecord(makeUser({ channels: [] }), 'm_self')).toBeNull();
  });
});

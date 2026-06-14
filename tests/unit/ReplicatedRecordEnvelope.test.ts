/**
 * Tier-1 unit tests for the replicated-record envelope substrate (WS2
 * replicated-store foundation, Component 2 — build-order step 2).
 *
 * Spec: docs/specs/multi-machine-replicated-store-foundation.md §4 (the envelope
 * + strict validator + flag-gated + flag-coherence-gated emission), §10.2 (config
 * invariants), §13 build-order item 2, §14 (safety posture).
 *
 * This module is generic substrate with NO concrete store kind (the registry
 * ships EMPTY). The applicable tier is unit (its consumers — concrete stores —
 * arrive with WS2.1, which brings the route/integration tier). Wiring-integrity
 * is covered for the DI'd advert self-report logic.
 *
 * Covers, per the Testing Integrity Standard's both-sides-of-every-boundary rule:
 *   - validator: valid put/delete; missing recordKey/hlc rejected; malformed hlc;
 *     observed present-valid / present-malformed-rejected / absent-legal;
 *     unknown-field-dropped-and-counted; path-shaped field jailed; free text /
 *     non-object rejected; store-schema rejection.
 *   - flag-gated emission: enabled=false ⇒ no emission; enabled=true ⇒ emits.
 *   - flag-coherence: advertising ⇒ emit; non-advertising ⇒ withhold + surface;
 *     N-peer mix (3+) ⇒ per-peer correctness + ONE coalesced surface.
 *   - validateStateSyncInvariants: maxDriftMs floor/ceiling clamp + in-range.
 *   - registry: unregistered kind absent; conflict throws; idempotent re-register.
 *   - wiring-integrity: advert reflects registered+enabled stores, not a hardcode.
 */

import { describe, it, expect } from 'vitest';

import {
  validateReplicatedEnvelope,
  isPathShaped,
  jailStoreStringField,
  ReplicatedKindRegistry,
  isStoreEmissionEnabled,
  peerAdvertisesStore,
  shouldEmitToPeer,
  checkPoolFlagCoherence,
  RESERVED_ENVELOPE_FIELDS,
  MAX_RECORD_KEY_LENGTH,
  type StoreFieldSchema,
  type StoreValidateContext,
  type EnvelopeValidationCounters,
  type PeerStateSyncAdvert,
  type StateSyncStores,
} from '../../src/core/ReplicatedRecordEnvelope.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { JOURNAL_KINDS } from '../../src/core/CoherenceJournal.js';
import {
  validateStateSyncInvariants,
  resolveStateSyncConfig,
  assertStateSyncInvariants,
  StateSyncConfigError,
  MIN_MAX_DRIFT_MS,
  MAX_MAX_DRIFT_MS,
} from '../../src/core/stateSyncConfig.js';

// ── helpers ────────────────────────────────────────────────────────────────

const HLC: HlcTimestamp = { physical: 1_700_000_000_000, logical: 3, node: 'machine-a' };
const OBSERVED: HlcTimestamp = { physical: 1_699_999_999_000, logical: 1, node: 'machine-b' };

function makeCounters() {
  const counts = { schemaRejects: 0, droppedFields: 0, jailRejects: 0 };
  const counters: EnvelopeValidationCounters = {
    bumpSchemaReject: () => { counts.schemaRejects++; },
    bumpDroppedField: () => { counts.droppedFields++; },
    bumpJailReject: () => { counts.jailRejects++; },
  };
  return { counts, counters };
}

/** A minimal store schema: one extra string field `value`, length-capped. */
function valueSchema(): StoreFieldSchema {
  return {
    knownFields: ['value'],
    validate(raw) {
      const value = raw.value;
      if (value === undefined) return { }; // value optional → empty store fields
      if (typeof value !== 'string' || value.length > 256) return null;
      return { value };
    },
  };
}

/** A store schema that always rejects (to exercise the store-rejection branch). */
function alwaysRejectSchema(): StoreFieldSchema {
  return { knownFields: [], validate: () => null };
}

function validEnvelope(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { recordKey: 'pref-123', hlc: { ...HLC }, op: 'put', origin: 'machine-a', ...extra };
}

// ── A. envelope validator ────────────────────────────────────────────────────

describe('validateReplicatedEnvelope', () => {
  it('accepts a valid PUT with all envelope fields', () => {
    const { counts, counters } = makeCounters();
    const r = validateReplicatedEnvelope(validEnvelope({ value: 'hi' }), valueSchema(), counters);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.recordKey).toBe('pref-123');
    expect(r.envelope.op).toBe('put');
    expect(r.envelope.origin).toBe('machine-a');
    expect(r.envelope.hlc).toEqual(HLC);
    expect(r.envelope.observed).toBeUndefined();
    expect(r.storeFields).toEqual({ value: 'hi' });
    // reconstructed data carries envelope + store fields, observed omitted.
    expect(r.data).toEqual({ recordKey: 'pref-123', hlc: HLC, op: 'put', origin: 'machine-a', value: 'hi' });
    expect(counts.schemaRejects).toBe(0);
    expect(counts.droppedFields).toBe(0);
  });

  it('accepts a valid DELETE (tombstone)', () => {
    const { counters } = makeCounters();
    const r = validateReplicatedEnvelope(validEnvelope({ op: 'delete' }), valueSchema(), counters);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.envelope.op).toBe('delete');
  });

  it('rejects a non-object (and free text)', () => {
    const { counts, counters } = makeCounters();
    expect(validateReplicatedEnvelope('just a string', valueSchema(), counters).ok).toBe(false);
    expect(validateReplicatedEnvelope(42, valueSchema(), counters).ok).toBe(false);
    expect(validateReplicatedEnvelope(null, valueSchema(), counters).ok).toBe(false);
    expect(validateReplicatedEnvelope(['array'], valueSchema(), counters).ok).toBe(false);
    expect(counts.schemaRejects).toBe(4);
  });

  it('rejects a missing/empty/oversized recordKey', () => {
    const { counters } = makeCounters();
    const noKey = validEnvelope(); delete noKey.recordKey;
    expect(validateReplicatedEnvelope(noKey, valueSchema(), counters).ok).toBe(false);
    expect(validateReplicatedEnvelope(validEnvelope({ recordKey: '' }), valueSchema(), counters).ok).toBe(false);
    const big = 'x'.repeat(MAX_RECORD_KEY_LENGTH + 1);
    const rBig = validateReplicatedEnvelope(validEnvelope({ recordKey: big }), valueSchema(), counters);
    expect(rBig.ok).toBe(false);
    if (!rBig.ok) expect(rBig.reason).toBe('bad-record-key');
  });

  it('jails a path-shaped recordKey (the §4 path-jail)', () => {
    const { counts, counters } = makeCounters();
    const r = validateReplicatedEnvelope(validEnvelope({ recordKey: '../etc/passwd' }), valueSchema(), counters);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('record-key-path-shaped');
    expect(counts.jailRejects).toBe(1);
    expect(counts.schemaRejects).toBe(1);
  });

  it('rejects a missing or malformed hlc', () => {
    const { counters } = makeCounters();
    const noHlc = validEnvelope(); delete noHlc.hlc;
    expect(validateReplicatedEnvelope(noHlc, valueSchema(), counters).ok).toBe(false);
    // malformed: negative physical
    const bad1 = validateReplicatedEnvelope(validEnvelope({ hlc: { physical: -1, logical: 0, node: 'x' } }), valueSchema(), counters);
    expect(bad1.ok).toBe(false);
    if (!bad1.ok) expect(bad1.reason).toBe('bad-hlc');
    // malformed: missing node
    expect(validateReplicatedEnvelope(validEnvelope({ hlc: { physical: 1, logical: 0 } }), valueSchema(), counters).ok).toBe(false);
    // malformed: not an object
    expect(validateReplicatedEnvelope(validEnvelope({ hlc: 'nope' }), valueSchema(), counters).ok).toBe(false);
  });

  it('rejects a bad op (enum enforced — free text excluded)', () => {
    const { counters } = makeCounters();
    const r = validateReplicatedEnvelope(validEnvelope({ op: 'upsert' }), valueSchema(), counters);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad-op');
  });

  it('rejects a missing/empty/path-shaped origin', () => {
    const { counters } = makeCounters();
    const noOrigin = validEnvelope(); delete noOrigin.origin;
    expect(validateReplicatedEnvelope(noOrigin, valueSchema(), counters).ok).toBe(false);
    expect(validateReplicatedEnvelope(validEnvelope({ origin: '' }), valueSchema(), counters).ok).toBe(false);
    const rPath = validateReplicatedEnvelope(validEnvelope({ origin: '/abs/path' }), valueSchema(), counters);
    expect(rPath.ok).toBe(false);
    if (!rPath.ok) expect(rPath.reason).toBe('bad-origin');
  });

  it('accepts a present, well-formed observed witness', () => {
    const { counters } = makeCounters();
    const r = validateReplicatedEnvelope(validEnvelope({ observed: { ...OBSERVED } }), valueSchema(), counters);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.envelope.observed).toEqual(OBSERVED);
      expect(r.data.observed).toEqual(OBSERVED);
    }
  });

  it('rejects a present-but-malformed observed witness', () => {
    const { counters } = makeCounters();
    const r = validateReplicatedEnvelope(validEnvelope({ observed: { physical: 'x', logical: 0, node: 'n' } }), valueSchema(), counters);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad-observed');
  });

  it('treats an ABSENT observed as legal (no prior witness ⇒ flag-on-conflict, the safe direction)', () => {
    const { counters } = makeCounters();
    const r = validateReplicatedEnvelope(validEnvelope(), valueSchema(), counters);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.envelope.observed).toBeUndefined();
    // null observed is also treated as absent (legal).
    const rNull = validateReplicatedEnvelope(validEnvelope({ observed: null }), valueSchema(), counters);
    expect(rNull.ok).toBe(true);
    if (rNull.ok) expect(rNull.envelope.observed).toBeUndefined();
  });

  it('drops unknown fields and COUNTS each drop (free text structurally excluded)', () => {
    const { counts, counters } = makeCounters();
    const r = validateReplicatedEnvelope(
      validEnvelope({ value: 'ok', freeText: 'arbitrary note', secret: 'sk-123', another: 1 }),
      valueSchema(),
      counters,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      // unknown fields are NOT carried into the validated data.
      expect(r.data).not.toHaveProperty('freeText');
      expect(r.data).not.toHaveProperty('secret');
      expect(r.data).not.toHaveProperty('another');
      expect(r.data.value).toBe('ok');
    }
    expect(counts.droppedFields).toBe(3); // freeText, secret, another
  });

  it('rejects the whole record when the store schema rejects', () => {
    const { counters } = makeCounters();
    const r = validateReplicatedEnvelope(validEnvelope({ value: 'x' }), alwaysRejectSchema(), counters);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('store-schema-rejected');
  });

  it('isPathShaped flags separators, traversal, absolute; passes plain ids', () => {
    expect(isPathShaped('pref-123')).toBe(false);
    expect(isPathShaped('a.b.c')).toBe(false);
    expect(isPathShaped('a/b')).toBe(true);
    expect(isPathShaped('a\\b')).toBe(true);
    expect(isPathShaped('..')).toBe(true);
    expect(isPathShaped('a/../b')).toBe(true);
    expect(isPathShaped('/abs')).toBe(true);
    expect(isPathShaped('.')).toBe(true);
  });

  it('RESERVED_ENVELOPE_FIELDS names exactly the envelope keys', () => {
    expect([...RESERVED_ENVELOPE_FIELDS].sort()).toEqual(['hlc', 'observed', 'op', 'origin', 'recordKey']);
  });
});

// ── A2. data-clobber defense (adversarial Q1+Q6): a store schema's validate()
//        can NEVER override a load-bearing envelope field on the reconstructed
//        `data`, and a path-shaped store value cannot reach the serialization
//        target via a reserved key. Both sides of the boundary. ─────────────────

describe('validateReplicatedEnvelope — store cannot clobber reserved envelope fields', () => {
  /** A hostile store schema that ECHOES reserved envelope keys with un-validated,
   *  un-jailed, mutated values (the exact attack from finding #1). */
  function reservedKeyEchoSchema(): StoreFieldSchema {
    return {
      knownFields: ['value'],
      validate() {
        return {
          value: 'legit',
          // reserved keys the store has NO business returning — all should be
          // stripped + counted, never reach data.*
          op: 'delete',
          recordKey: '../escape',
          hlc: { physical: 9, logical: 9, node: 'evil' },
          origin: '/abs',
          observed: { physical: 7, logical: 7, node: 'evil-witness' },
        } as Record<string, unknown>;
      },
    };
  }

  it('reserved keys returned by a store are STRIPPED; data.* equals the VALIDATED envelope.* (finding #1)', () => {
    const { counts, counters } = makeCounters();
    const r = validateReplicatedEnvelope(
      { recordKey: 'safe', hlc: { ...HLC }, op: 'put', origin: 'machine-a' },
      reservedKeyEchoSchema(),
      counters,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The envelope keeps the validated values …
    expect(r.envelope.op).toBe('put');
    expect(r.envelope.recordKey).toBe('safe');
    expect(r.envelope.hlc).toEqual(HLC);
    expect(r.envelope.origin).toBe('machine-a');
    expect(r.envelope.observed).toBeUndefined();
    // … and data NO LONGER diverges: the store's evil reserved values are gone.
    expect(r.data.op).toBe('put');
    expect(r.data.recordKey).toBe('safe');         // NOT '../escape'
    expect(r.data.hlc).toEqual(HLC);               // NOT the evil HLC
    expect(r.data.origin).toBe('machine-a');       // NOT '/abs'
    expect(r.data).not.toHaveProperty('observed'); // absent observed stays absent
    // The legitimate store field survives.
    expect(r.data.value).toBe('legit');
    expect(r.storeFields).toEqual({ value: 'legit' }); // reserved keys stripped here too
    // Each stripped reserved key counts as a dropped field (5 reserved echoed).
    expect(counts.droppedFields).toBe(5);
  });

  it('a store CANNOT loosen a DELETE into a PUT (op authority stays with the envelope)', () => {
    const { counters } = makeCounters();
    const r = validateReplicatedEnvelope(
      { recordKey: 'k', hlc: { ...HLC }, op: 'delete', origin: 'm' },
      reservedKeyEchoSchema(), // tries to return op:'delete' but envelope op wins regardless
      counters,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.envelope.op).toBe('delete');
      expect(r.data.op).toBe('delete'); // the VALIDATED op, not whatever the store returned
    }
  });
});

// ── A3. store-field jail (finding #3): reusable path-jail machinery for store
//        fields — declarative (pathSensitiveFields) + imperative
//        (jailStoreStringField). Both sides. ─────────────────────────────────────

describe('store-field path-jail (reusable machinery, finding #3)', () => {
  it('a DECLARED pathSensitiveFields entry that is path-shaped rejects the whole record + bumps jail counter', () => {
    const { counts, counters } = makeCounters();
    const schema: StoreFieldSchema = {
      knownFields: ['filePath'],
      pathSensitiveFields: ['filePath'],
      validate(raw) {
        return { filePath: raw.filePath };
      },
    };
    const r = validateReplicatedEnvelope(
      { recordKey: 'k', hlc: { ...HLC }, op: 'put', origin: 'm', filePath: '../../etc/passwd' },
      schema,
      counters,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('store-field-path-shaped');
    expect(counts.jailRejects).toBe(1);
    expect(counts.schemaRejects).toBe(1);
  });

  it('a DECLARED pathSensitiveFields entry that is a plain id PASSES (the safe side)', () => {
    const { counts, counters } = makeCounters();
    const schema: StoreFieldSchema = {
      knownFields: ['filePath'],
      pathSensitiveFields: ['filePath'],
      validate(raw) {
        return { filePath: raw.filePath };
      },
    };
    const r = validateReplicatedEnvelope(
      { recordKey: 'k', hlc: { ...HLC }, op: 'put', origin: 'm', filePath: 'plain-id' },
      schema,
      counters,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.filePath).toBe('plain-id');
    expect(counts.jailRejects).toBe(0);
  });

  it('jailStoreStringField returns null + bumps the SHARED jail counter on a path-shaped value', () => {
    let jailRejects = 0;
    const ctx: StoreValidateContext = {
      countDroppedField: () => {},
      countJailReject: () => { jailRejects++; },
    };
    expect(jailStoreStringField('../escape', ctx)).toBeNull();
    expect(jailRejects).toBe(1);
    // a non-path string passes through unchanged, no jail bump.
    expect(jailStoreStringField('ok-id', ctx)).toBe('ok-id');
    // a non-string is returned unchanged (the store does its own type check).
    expect(jailStoreStringField(42, ctx)).toBe(42);
    expect(jailRejects).toBe(1);
  });

  it('a store using jailStoreStringField imperatively feeds the validator jail counter', () => {
    const { counts, counters } = makeCounters();
    const schema: StoreFieldSchema = {
      knownFields: ['note'],
      validate(raw, ctx) {
        const note = jailStoreStringField(raw.note, ctx);
        if (note === null) return null; // path-shaped → reject whole record
        return { note };
      },
    };
    const r = validateReplicatedEnvelope(
      { recordKey: 'k', hlc: { ...HLC }, op: 'put', origin: 'm', note: '/abs/path' },
      schema,
      counters,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('store-schema-rejected'); // store returned null
    expect(counts.jailRejects).toBe(1); // imperative jail bumped the SAME counter
  });
});

// ── B. registry ──────────────────────────────────────────────────────────────

describe('ReplicatedKindRegistry', () => {
  it('ships EMPTY (the Step-2 substrate-only state — no concrete kind)', () => {
    const reg = new ReplicatedKindRegistry();
    expect(reg.size).toBe(0);
    expect(reg.kinds()).toEqual([]);
    expect(reg.stores()).toEqual([]);
  });

  it('an unregistered kind is absent (isReplicatedKind=false, getByKind=undefined)', () => {
    const reg = new ReplicatedKindRegistry();
    expect(reg.isReplicatedKind('pref-record')).toBe(false);
    expect(reg.getByKind('pref-record')).toBeUndefined();
    expect(reg.getByStore('pref')).toBeUndefined();
  });

  it('registers a kind and exposes it by kind + store', () => {
    const reg = new ReplicatedKindRegistry();
    reg.register({ kind: 'pref-record', store: 'pref', schema: valueSchema() });
    expect(reg.size).toBe(1);
    expect(reg.isReplicatedKind('pref-record')).toBe(true);
    expect(reg.getByKind('pref-record')?.store).toBe('pref');
    expect(reg.getByStore('pref')?.kind).toBe('pref-record');
    expect(reg.kinds()).toEqual(['pref-record']);
    expect(reg.stores()).toEqual(['pref']);
  });

  it('is idempotent for an identical re-registration', () => {
    const reg = new ReplicatedKindRegistry();
    reg.register({ kind: 'pref-record', store: 'pref', schema: valueSchema() });
    expect(() => reg.register({ kind: 'pref-record', store: 'pref', schema: valueSchema() })).not.toThrow();
    expect(reg.size).toBe(1);
  });

  it('THROWS on a conflicting registration (a kind already owned by another store)', () => {
    const reg = new ReplicatedKindRegistry();
    reg.register({ kind: 'pref-record', store: 'pref', schema: valueSchema() });
    expect(() => reg.register({ kind: 'pref-record', store: 'other', schema: valueSchema() })).toThrow(/already registered/);
  });

  it('THROWS when a store tries to own a second kind', () => {
    const reg = new ReplicatedKindRegistry();
    reg.register({ kind: 'pref-record', store: 'pref', schema: valueSchema() });
    expect(() => reg.register({ kind: 'pref-record-2', store: 'pref', schema: valueSchema() })).toThrow(/already owns/);
  });

  it('rejects a malformed registration (empty kind/store, bad schema)', () => {
    const reg = new ReplicatedKindRegistry();
    expect(() => reg.register({ kind: '', store: 'pref', schema: valueSchema() })).toThrow();
    expect(() => reg.register({ kind: 'k', store: '', schema: valueSchema() })).toThrow();
    expect(() => reg.register({ kind: 'k', store: 's', schema: { knownFields: [] } as unknown as StoreFieldSchema })).toThrow();
  });

  it('THROWS when a schema claims a RESERVED envelope field in knownFields (finding #2)', () => {
    const reg = new ReplicatedKindRegistry();
    // The exact loosening attempt: a schema that opts reserved keys into its own
    // control surface — rejected at wiring time, not trusted to self-check.
    for (const reserved of [...RESERVED_ENVELOPE_FIELDS]) {
      expect(() =>
        reg.register({
          kind: `k-${reserved}`,
          store: `s-${reserved}`,
          schema: { knownFields: [reserved], validate: () => ({}) },
        }),
      ).toThrow(/reserved envelope field/);
    }
    // A schema claiming MULTIPLE reserved keys (the full-set attack) also throws,
    // and nothing was registered.
    expect(() =>
      reg.register({
        kind: 'evil',
        store: 'evil',
        schema: { knownFields: ['op', 'recordKey', 'hlc', 'origin', 'observed', 'value'], validate: () => ({}) },
      }),
    ).toThrow(/reserved envelope field/);
    expect(reg.size).toBe(0);
  });

  it('a schema with ONLY non-reserved knownFields registers fine (the safe side)', () => {
    const reg = new ReplicatedKindRegistry();
    expect(() =>
      reg.register({ kind: 'k', store: 's', schema: { knownFields: ['value', 'filePath'], validate: () => ({}) } }),
    ).not.toThrow();
    expect(reg.size).toBe(1);
  });
});

// ── C. flag-gated emission ───────────────────────────────────────────────────

describe('isStoreEmissionEnabled (flag-gated emission, ships dark per store)', () => {
  it('enabled=false (or absent) ⇒ NO emission (strict no-op)', () => {
    expect(isStoreEmissionEnabled(undefined, 'pref')).toBe(false);
    expect(isStoreEmissionEnabled({}, 'pref')).toBe(false);
    expect(isStoreEmissionEnabled({ pref: {} }, 'pref')).toBe(false);
    expect(isStoreEmissionEnabled({ pref: { enabled: false } }, 'pref')).toBe(false);
  });

  it('enabled=true ⇒ emission allowed for that store only', () => {
    const stores: StateSyncStores = { pref: { enabled: true }, relationship: { enabled: false } };
    expect(isStoreEmissionEnabled(stores, 'pref')).toBe(true);
    expect(isStoreEmissionEnabled(stores, 'relationship')).toBe(false);
    expect(isStoreEmissionEnabled(stores, 'unknown')).toBe(false);
  });
});

// ── D. flag-coherence-gated emission ────────────────────────────────────────

describe('shouldEmitToPeer (flag-coherence gating, per-peer)', () => {
  const enabled: StateSyncStores = { pref: { enabled: true } };

  it('store disabled ⇒ withhold (store-disabled)', () => {
    const peer: PeerStateSyncAdvert = { machineId: 'b', online: true, stateSyncReceive: { pref: true } };
    expect(shouldEmitToPeer({ pref: { enabled: false } }, 'pref', peer)).toEqual({ emit: false, reason: 'store-disabled' });
  });

  it('peer advertises ⇒ EMIT', () => {
    const peer: PeerStateSyncAdvert = { machineId: 'b', online: true, stateSyncReceive: { pref: true } };
    expect(shouldEmitToPeer(enabled, 'pref', peer)).toEqual({ emit: true, reason: 'emit' });
  });

  it('peer does NOT advertise ⇒ WITHHOLD (the named skew mode)', () => {
    const peer: PeerStateSyncAdvert = { machineId: 'b', online: true, stateSyncReceive: { } };
    expect(shouldEmitToPeer(enabled, 'pref', peer)).toEqual({ emit: false, reason: 'peer-not-advertising' });
    const peerNoFlags: PeerStateSyncAdvert = { machineId: 'c', online: true };
    expect(shouldEmitToPeer(enabled, 'pref', peerNoFlags).emit).toBe(false);
  });

  it('offline peer ⇒ withhold (peer-offline)', () => {
    const peer: PeerStateSyncAdvert = { machineId: 'b', online: false, stateSyncReceive: { pref: true } };
    expect(shouldEmitToPeer(enabled, 'pref', peer)).toEqual({ emit: false, reason: 'peer-offline' });
  });

  it('peerAdvertisesStore reads the per-store flag', () => {
    expect(peerAdvertisesStore({ machineId: 'b', stateSyncReceive: { pref: true } }, 'pref')).toBe(true);
    expect(peerAdvertisesStore({ machineId: 'b', stateSyncReceive: { pref: false } }, 'pref')).toBe(false);
    expect(peerAdvertisesStore({ machineId: 'b' }, 'pref')).toBe(false);
  });
});

describe('checkPoolFlagCoherence (boot-time, N-peer, coalesced)', () => {
  function reg(): ReplicatedKindRegistry {
    const r = new ReplicatedKindRegistry();
    r.register({ kind: 'pref-record', store: 'pref', schema: valueSchema() });
    return r;
  }

  it('EMPTY registry ⇒ strict no-op (no stores, no surface)', () => {
    const v = checkPoolFlagCoherence(new ReplicatedKindRegistry(), { pref: { enabled: true } }, [
      { machineId: 'b', online: true },
    ]);
    expect(v.stores).toEqual([]);
    expect(v.mixedStores).toEqual([]);
    expect(v.summary).toEqual([]);
  });

  it('store locally disabled ⇒ no coherence concern (cannot emit, cannot skew)', () => {
    const v = checkPoolFlagCoherence(reg(), { pref: { enabled: false } }, [
      { machineId: 'b', online: true, stateSyncReceive: {} },
    ]);
    expect(v.stores).toEqual([]);
    expect(v.mixedStores).toEqual([]);
  });

  it('all peers advertise ⇒ coherent (no mixed surface)', () => {
    const v = checkPoolFlagCoherence(reg(), { pref: { enabled: true } }, [
      { machineId: 'b', online: true, stateSyncReceive: { pref: true } },
      { machineId: 'c', online: true, stateSyncReceive: { pref: true } },
    ]);
    expect(v.mixedStores).toEqual([]);
    expect(v.summary).toEqual([]);
    expect(v.stores[0].advertising).toEqual(['b', 'c']);
    expect(v.stores[0].notAdvertising).toEqual([]);
  });

  it('one non-advertiser ⇒ MIXED + ONE coalesced surface line', () => {
    const v = checkPoolFlagCoherence(reg(), { pref: { enabled: true } }, [
      { machineId: 'b', online: true, stateSyncReceive: { pref: true } },
      { machineId: 'c', online: true, stateSyncReceive: {} },
    ]);
    expect(v.mixedStores).toEqual(['pref']);
    expect(v.summary.length).toBe(1);
    expect(v.summary[0]).toContain('stateSync.pref');
    expect(v.summary[0]).toContain('c'); // the non-advertiser id named
  });

  it('N-peer mix (3+ peers, some advertising, some not, one offline) ⇒ correct per-peer + ONE surface', () => {
    const v = checkPoolFlagCoherence(reg(), { pref: { enabled: true } }, [
      { machineId: 'b', online: true, stateSyncReceive: { pref: true } },   // advertises
      { machineId: 'c', online: true, stateSyncReceive: {} },               // does not
      { machineId: 'd', online: true, stateSyncReceive: { pref: true } },   // advertises
      { machineId: 'e', online: true },                                     // does not (no flags)
      { machineId: 'f', online: false, stateSyncReceive: {} },              // offline → excluded
    ]);
    expect(v.stores[0].advertising.sort()).toEqual(['b', 'd']);
    expect(v.stores[0].notAdvertising.sort()).toEqual(['c', 'e']); // f excluded (offline)
    expect(v.mixedStores).toEqual(['pref']);
    // Coalesced: exactly ONE summary line for the one mixed store, never per-peer.
    expect(v.summary.length).toBe(1);
    expect(v.summary[0]).toContain('2 peer(s) ready');
    expect(v.summary[0]).toContain('2 peer(s) cannot receive');
  });

  it('multiple mixed stores ⇒ one line PER store (still coalesced, never per-peer)', () => {
    const r = new ReplicatedKindRegistry();
    r.register({ kind: 'pref-record', store: 'pref', schema: valueSchema() });
    r.register({ kind: 'rel-record', store: 'relationship', schema: valueSchema() });
    const v = checkPoolFlagCoherence(
      r,
      { pref: { enabled: true }, relationship: { enabled: true } },
      [
        { machineId: 'b', online: true, stateSyncReceive: { pref: true } }, // missing relationship
        { machineId: 'c', online: true, stateSyncReceive: {} },             // missing both
      ],
    );
    expect(v.mixedStores.sort()).toEqual(['pref', 'relationship']);
    expect(v.summary.length).toBe(2);
  });
});

// ── E. config invariants ─────────────────────────────────────────────────────

describe('validateStateSyncInvariants (§10.2)', () => {
  it('default/absent config is valid', () => {
    expect(validateStateSyncInvariants(undefined)).toEqual([]);
    expect(validateStateSyncInvariants({} as never)).toEqual([]);
  });

  it('maxDriftMs below the 60s floor is REJECTED (not silently clamped)', () => {
    const errors = validateStateSyncInvariants({ stateSync: { maxDriftMs: 1000 } } as never);
    expect(errors.some((e) => e.includes('maxDriftMs'))).toBe(true);
  });

  it('maxDriftMs above the 15min ceiling is REJECTED', () => {
    const errors = validateStateSyncInvariants({ stateSync: { maxDriftMs: 999_999_999 } } as never);
    expect(errors.some((e) => e.includes('maxDriftMs'))).toBe(true);
  });

  it('maxDriftMs in-range (e.g. 5min) is accepted; resolved value untouched', () => {
    expect(validateStateSyncInvariants({ stateSync: { maxDriftMs: 5 * 60_000 } } as never)).toEqual([]);
    expect(resolveStateSyncConfig({ stateSync: { maxDriftMs: 5 * 60_000 } } as never).maxDriftMs).toBe(5 * 60_000);
    // exact floor + ceiling both in-range.
    expect(validateStateSyncInvariants({ stateSync: { maxDriftMs: MIN_MAX_DRIFT_MS } } as never)).toEqual([]);
    expect(validateStateSyncInvariants({ stateSync: { maxDriftMs: MAX_MAX_DRIFT_MS } } as never)).toEqual([]);
  });

  it('a non-finite maxDriftMs is rejected', () => {
    const errors = validateStateSyncInvariants({ stateSync: { maxDriftMs: Number.NaN } } as never);
    expect(errors.some((e) => e.includes('maxDriftMs'))).toBe(true);
  });

  it('a non-positive aggregate budget / cache ceiling is rejected', () => {
    expect(validateStateSyncInvariants({ stateSync: { aggregateJournalBudgetBytes: 0 } } as never).length).toBeGreaterThan(0);
    expect(validateStateSyncInvariants({ stateSync: { maxCachedSnapshots: 0 } } as never).length).toBeGreaterThan(0);
    expect(validateStateSyncInvariants({ stateSync: { maxCacheBytes: -1 } } as never).length).toBeGreaterThan(0);
  });

  it('resolveStateSyncConfig clamps a raw out-of-range maxDriftMs for the live primitive', () => {
    // resolution clamps (so the clock always gets an in-range value) even though
    // validation rejects — the two-layer defense (§10.2).
    expect(resolveStateSyncConfig({ stateSync: { maxDriftMs: 10 } } as never).maxDriftMs).toBe(MIN_MAX_DRIFT_MS);
    expect(resolveStateSyncConfig({ stateSync: { maxDriftMs: 10 ** 12 } } as never).maxDriftMs).toBe(MAX_MAX_DRIFT_MS);
  });

  it('assertStateSyncInvariants throws StateSyncConfigError on a bad config, returns resolved on a good one', () => {
    expect(() => assertStateSyncInvariants({ stateSync: { maxDriftMs: 5 } } as never)).toThrow(StateSyncConfigError);
    const resolved = assertStateSyncInvariants(undefined);
    expect(resolved.maxDriftMs).toBe(5 * 60_000);
    expect(resolved.aggregateJournalBudgetBytes).toBeGreaterThan(0);
  });
});

// ── F. wiring-integrity: the advert self-report reflects machinery presence ──

describe('wiring-integrity: stateSyncReceive advert reflects registered+enabled stores', () => {
  // Mirror the server's selfStateSyncReceive() logic: a store is advertised IFF
  // its kind is registered (machinery present) AND it is enabled in config — NOT
  // a hardcoded true. This is the exact decision the heartbeat self-report makes.
  function selfAdvert(registry: ReplicatedKindRegistry, stores: StateSyncStores | undefined): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const store of registry.stores()) {
      if (stores?.[store]?.enabled === true) out[store] = true;
    }
    return out;
  }

  it('empty registry ⇒ advert is {} (non-participant for every store — the no-store-yet state)', () => {
    expect(selfAdvert(new ReplicatedKindRegistry(), { pref: { enabled: true } })).toEqual({});
  });

  it('registered but DISABLED ⇒ NOT advertised (machinery present, but cannot apply ⇒ honest non-advert)', () => {
    const reg = new ReplicatedKindRegistry();
    reg.register({ kind: 'pref-record', store: 'pref', schema: valueSchema() });
    expect(selfAdvert(reg, { pref: { enabled: false } })).toEqual({});
    expect(selfAdvert(reg, undefined)).toEqual({});
  });

  it('registered AND enabled ⇒ advertised true (driven by presence, not a hardcode)', () => {
    const reg = new ReplicatedKindRegistry();
    reg.register({ kind: 'pref-record', store: 'pref', schema: valueSchema() });
    reg.register({ kind: 'rel-record', store: 'relationship', schema: valueSchema() });
    expect(selfAdvert(reg, { pref: { enabled: true }, relationship: { enabled: false } })).toEqual({ pref: true });
  });
});

// ── G. dual-registry coupling (finding #4b): a kind registered into
//        ReplicatedKindRegistry but absent from the static JOURNAL_KINDS would
//        advertise receive=true yet serve/apply/pull NOTHING (silent
//        no-replication). This ratchet asserts the two registries stay coupled. ──

describe('wiring-integrity: every replicated kind must also be in JOURNAL_KINDS (finding #4b)', () => {
  // Seed a registry with the eventual concrete WS2.x kinds the spec §4 names.
  // As each store PR lands its kind, it MUST also add the kind to JOURNAL_KINDS
  // (CoherenceJournal.ts) or this test reds — making the coupling a CI ratchet
  // instead of a memory item. Step 2 ships the registry EMPTY (no concrete kind),
  // so the live coupling is vacuously true today; this test documents + enforces
  // the invariant for the consumer PRs by checking a CONSTRUCTED registry.
  it('a registry seeded with a kind NOT in JOURNAL_KINDS is detectable (the silent no-replication trap)', () => {
    const reg = new ReplicatedKindRegistry();
    // Use a SYNTHETIC future kind that is NOT (yet) in JOURNAL_KINDS — this is
    // exactly the trap a future store PR must avoid: registering here without
    // extending JOURNAL_KINDS. (Post-WS2.1/WS2.3, the REAL 'pref-record' and
    // 'relationship-record' kinds ARE in JOURNAL_KINDS — see the coupling assertions
    // below — so they can no longer stand in for the uncoupled case; use a
    // deliberately-fictional future kind here.)
    reg.register({ kind: 'future-store-record', store: 'future-store', schema: valueSchema() });
    const missing = reg.kinds().filter((k) => !(JOURNAL_KINDS as string[]).includes(k));
    expect(missing).toEqual(['future-store-record']); // the ratchet SEES the gap
  });

  it('the WS2.1 pref-record kind IS coupled in BOTH registries (the post-WS2.1 ratchet)', async () => {
    // The REAL coupling: the consumer's PREF_KIND_REGISTRATION registers
    // 'pref-record' AND CoherenceJournal.JOURNAL_KINDS now lists it. A registry
    // holding the real registration must report NO uncoupled kind — this is the
    // CI ratchet that would RED if a future edit removed 'pref-record' from
    // JOURNAL_KINDS while leaving it registered (the silent no-replication trap).
    const { PREF_KIND_REGISTRATION } = await import('../../src/core/PreferencesReplicatedStore.js');
    const reg = new ReplicatedKindRegistry();
    reg.register(PREF_KIND_REGISTRATION);
    const missing = reg.kinds().filter((k) => !(JOURNAL_KINDS as string[]).includes(k));
    expect(missing).toEqual([]); // pref-record coupled in both registries
    expect((JOURNAL_KINDS as string[]).includes('pref-record')).toBe(true);
  });

  it('once a kind is present in BOTH registries, the coupling check passes', () => {
    // Simulate the post-WS2.1 state: the registry holds only kinds that ARE in
    // JOURNAL_KINDS. Use an existing JOURNAL_KIND as the stand-in so the assertion
    // is real (no need to mutate the static const in a unit test).
    const reg = new ReplicatedKindRegistry();
    const existing = JOURNAL_KINDS[0]; // a kind that IS in the static registry
    reg.register({ kind: existing, store: 'stand-in', schema: valueSchema() });
    const missing = reg.kinds().filter((k) => !(JOURNAL_KINDS as string[]).includes(k));
    expect(missing).toEqual([]); // coupled → no silent-no-replication gap
  });

  it('the Step-2 EMPTY registry has the coupling invariant vacuously satisfied', () => {
    const reg = new ReplicatedKindRegistry();
    const missing = reg.kinds().filter((k) => !(JOURNAL_KINDS as string[]).includes(k));
    expect(missing).toEqual([]); // empty registry → no kind can be uncoupled
  });
});

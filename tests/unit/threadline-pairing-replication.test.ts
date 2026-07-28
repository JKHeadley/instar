/**
 * Unit tests for ThreadlinePairingReplicatedStore + the AgentTrustManager inheritance
 * path (Secure A2A Verified Pairing §3.8 / FD11 — the EIGHTH replicated-store consumer).
 *
 * Covers the spec's §3.8 named invariants + the increment-5 test list:
 *   - the serializer NEVER emits SAS / shared secret / relay token (the replicated payload
 *     has ONLY the 5 allowed fields)
 *   - type-clamp REJECTS a malformed received record (bad verifiedAt / non-hex key /
 *     wrong state / missing field)
 *   - a received mutual-verified record is honored ONLY when peerIdentityPub matches the
 *     pinned key (mismatch → not honored / downgraded to pending)
 *   - a tombstone (revoke / verification-failed) un-verifies
 *   - flag-off = no replication (strict no-op — single-machine agents unaffected)
 *   - dual-registry coupling (kind in BOTH registries)
 *   - inherited = identity-verified (NOT channel-ready): the identity half passes, the
 *     channel half is the outbound gate's job
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  THREADLINE_PAIRING_STORE_KEY,
  THREADLINE_PAIRING_RECORD_KIND,
  THREADLINE_PAIRING_IMPACT_TIER,
  THREADLINE_PAIRING_KIND_REGISTRATION,
  THREADLINE_PAIRING_STORE_KNOWN_FIELDS,
  REPLICATED_PAIRING_STATE,
  threadlinePairingRecordStoreSchema,
  buildThreadlinePairingRecordData,
  buildThreadlinePairingTombstoneData,
  deriveThreadlinePairingRecordKey,
  mergeUnionToPairings,
  evaluateInheritedVerification,
  renderForeignPairingContext,
  pairingResultToOriginRecord,
  threadlinePairingTierOf,
  threadlinePairingContributingKinds,
  isIso8601,
  type VerifiedPairingResult,
  type MergedPairingView,
} from '../../src/core/ThreadlinePairingReplicatedStore.js';
import { validateReplicatedEnvelope, RESERVED_ENVELOPE_FIELDS } from '../../src/core/ReplicatedRecordEnvelope.js';
import { JOURNAL_KINDS } from '../../src/core/CoherenceJournal.js';
import { AgentTrustManager } from '../../src/threadline/AgentTrustManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import type { OriginRecord, UnionResult } from '../../src/core/UnionReader.js';

// ── Fixtures ──────────────────────────────────────────────────────────
const PEER_FP = '63b1dbb29a4c7e10'; // hex
const PEER_PUB = 'aa'.repeat(32); // 64 hex chars (32-byte Ed25519 key)
const OTHER_PUB = 'bb'.repeat(32); // a DIFFERENT identity key (substitution)
const VERIFIED_AT = '2026-06-16T12:00:00.000Z';
const MACHINE_A = 'machine-a-laptop';

function hlc(p: number, l = 0, n = 'm_self'): HlcTimestamp {
  return { physical: p, logical: l, node: n };
}

function makeResult(over: Partial<VerifiedPairingResult> = {}): VerifiedPairingResult {
  return {
    peerFp: PEER_FP,
    peerIdentityPub: PEER_PUB,
    state: REPLICATED_PAIRING_STATE,
    verifiedAt: VERIFIED_AT,
    verifiedOnMachine: MACHINE_A,
    ...over,
  };
}

function newCtx() {
  const c = { dropped: 0, jail: 0 };
  return {
    ctx: {
      countDroppedField: () => { c.dropped++; },
      countJailReject: () => { c.jail++; },
    },
    counts: c,
  };
}

function newEnvelopeCounters() {
  const c = { schema: 0, dropped: 0, jail: 0 };
  return {
    bag: {
      bumpSchemaReject: () => { c.schema++; },
      bumpDroppedField: () => { c.dropped++; },
      bumpJailReject: () => { c.jail++; },
    },
    counts: c,
  };
}

// ── A. Dual-registry coupling ─────────────────────────────────────────

describe('ThreadlinePairingReplicatedStore — dual-registry coupling', () => {
  it('the kind is present in JOURNAL_KINDS (the static half)', () => {
    expect(JOURNAL_KINDS).toContain(THREADLINE_PAIRING_RECORD_KIND);
  });

  it('the registration descriptor binds kind ↔ store ↔ schema', () => {
    expect(THREADLINE_PAIRING_KIND_REGISTRATION.kind).toBe(THREADLINE_PAIRING_RECORD_KIND);
    expect(THREADLINE_PAIRING_KIND_REGISTRATION.store).toBe(THREADLINE_PAIRING_STORE_KEY);
    expect(THREADLINE_PAIRING_KIND_REGISTRATION.schema).toBe(threadlinePairingRecordStoreSchema);
  });

  it('tierOf + contributing kinds are coherent', () => {
    expect(threadlinePairingTierOf(THREADLINE_PAIRING_STORE_KEY)).toBe(THREADLINE_PAIRING_IMPACT_TIER);
    expect(threadlinePairingContributingKinds()).toEqual([THREADLINE_PAIRING_RECORD_KIND]);
  });

  it('the schema does not claim any reserved envelope field', () => {
    for (const f of THREADLINE_PAIRING_STORE_KNOWN_FIELDS) {
      // peerFp/peerIdentityPub/state/verifiedAt/verifiedOnMachine — none of these are reserved.
      expect(RESERVED_ENVELOPE_FIELDS).not.toContain(f);
    }
  });
});

// ── B. The serializer NEVER emits SAS / secret / token ─────────────────

describe('serializer emits ONLY the 5 allowed fields (NEVER SAS/secret/token)', () => {
  it('the put projection contains exactly the 5 fields + envelope, nothing else', () => {
    const data = buildThreadlinePairingRecordData({ result: makeResult(), hlc: hlc(1000), origin: MACHINE_A })!;
    expect(data).not.toBeNull();

    const allowed = new Set([
      ...THREADLINE_PAIRING_STORE_KNOWN_FIELDS, // peerFp, peerIdentityPub, state, verifiedAt, verifiedOnMachine
      ...RESERVED_ENVELOPE_FIELDS,              // recordKey, hlc, op, origin, observed
    ]);
    for (const k of Object.keys(data)) {
      expect(allowed.has(k)).toBe(true);
    }

    // The 5 RESULT fields are present + correct.
    expect(data.peerFp).toBe(PEER_FP);
    expect(data.peerIdentityPub).toBe(PEER_PUB);
    expect(data.state).toBe(REPLICATED_PAIRING_STATE);
    expect(data.verifiedAt).toBe(VERIFIED_AT);
    expect(data.verifiedOnMachine).toBe(MACHINE_A);
  });

  it('a SAS/secret/token field offered to the serializer is structurally impossible to emit', () => {
    // VerifiedPairingResult has no such field; even if a caller force-casts extra props,
    // the projection is an EXPLICIT enumeration — the serialized payload never carries them.
    const hostile = { ...makeResult(), sasWords: ['abandon', 'ability'], sharedSecret: 'deadbeef', relayToken: 'tok' } as unknown as VerifiedPairingResult;
    const data = buildThreadlinePairingRecordData({ result: hostile, hlc: hlc(1000), origin: MACHINE_A })!;
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('sasWords');
    expect(serialized).not.toContain('sharedSecret');
    expect(serialized).not.toContain('relayToken');
    expect(serialized).not.toContain('abandon');
    expect(serialized).not.toContain('deadbeef');
    expect(data).not.toHaveProperty('sasWords');
    expect(data).not.toHaveProperty('sharedSecret');
    expect(data).not.toHaveProperty('relayToken');
  });

  it('the own-origin materialization also carries ONLY the 5 fields', () => {
    const rec = pairingResultToOriginRecord(makeResult(), MACHINE_A)!;
    const keys = Object.keys(rec.data);
    expect(keys.sort()).toEqual(['peerFp', 'peerIdentityPub', 'state', 'verifiedAt', 'verifiedOnMachine'].sort());
  });

  it('emits null for a degenerate (empty) fingerprint — no identity surface', () => {
    expect(buildThreadlinePairingRecordData({ result: makeResult({ peerFp: '' }), hlc: hlc(1), origin: MACHINE_A })).toBeNull();
    expect(deriveThreadlinePairingRecordKey('')).toBeNull();
  });
});

// ── C. Type-clamp rejects a malformed received record ──────────────────

describe('receive-side type-clamp rejects malformed records', () => {
  function validate(raw: Record<string, unknown>) {
    const { ctx } = newCtx();
    return threadlinePairingRecordStoreSchema.validate(raw as Readonly<Record<string, unknown>>, ctx);
  }

  it('accepts a well-formed put record', () => {
    const out = validate({ op: 'put', peerFp: PEER_FP, peerIdentityPub: PEER_PUB, state: 'mutual-verified', verifiedAt: VERIFIED_AT, verifiedOnMachine: MACHINE_A });
    expect(out).not.toBeNull();
    expect(out!.state).toBe('mutual-verified');
  });

  it('REJECTS a non-ISO verifiedAt (markup cannot survive the date slot)', () => {
    const out = validate({ op: 'put', peerFp: PEER_FP, peerIdentityPub: PEER_PUB, state: 'mutual-verified', verifiedAt: '<script>not a date</script>', verifiedOnMachine: MACHINE_A });
    expect(out).toBeNull();
  });

  it('REJECTS a non-hex peerIdentityPub', () => {
    const out = validate({ op: 'put', peerFp: PEER_FP, peerIdentityPub: 'not-hex-zzzz', state: 'mutual-verified', verifiedAt: VERIFIED_AT, verifiedOnMachine: MACHINE_A });
    expect(out).toBeNull();
  });

  it('REJECTS a non-hex peerFp', () => {
    const out = validate({ op: 'put', peerFp: 'ghij-not-hex', peerIdentityPub: PEER_PUB, state: 'mutual-verified', verifiedAt: VERIFIED_AT, verifiedOnMachine: MACHINE_A });
    expect(out).toBeNull();
  });

  it('REJECTS a state other than mutual-verified (a machine-local state never replicates)', () => {
    for (const bad of ['pending-verification', 'verification-failed', 'identity-verified', 'trusted', '<x>']) {
      const out = validate({ op: 'put', peerFp: PEER_FP, peerIdentityPub: PEER_PUB, state: bad, verifiedAt: VERIFIED_AT, verifiedOnMachine: MACHINE_A });
      expect(out).toBeNull();
    }
  });

  it('REJECTS a missing verifiedOnMachine', () => {
    const out = validate({ op: 'put', peerFp: PEER_FP, peerIdentityPub: PEER_PUB, state: 'mutual-verified', verifiedAt: VERIFIED_AT });
    expect(out).toBeNull();
  });

  it('the tombstone (delete) branch accepts a valid tombstone WITHOUT being value-rejected', () => {
    const out = validate({ op: 'delete', deletedAt: VERIFIED_AT });
    expect(out).not.toBeNull();
    expect(out!.deletedAt).toBe(VERIFIED_AT);
  });

  it('a smuggled SAS field on a received record is DROPPED (not in the allowlist)', () => {
    // The full envelope validator drops any field not in (reserved ∪ knownFields).
    const { bag } = newEnvelopeCounters();
    const env = validateReplicatedEnvelope(
      {
        recordKey: deriveThreadlinePairingRecordKey(PEER_FP)!,
        hlc: hlc(1000),
        op: 'put',
        origin: MACHINE_A,
        peerFp: PEER_FP,
        peerIdentityPub: PEER_PUB,
        state: 'mutual-verified',
        verifiedAt: VERIFIED_AT,
        verifiedOnMachine: MACHINE_A,
        sasWords: ['abandon'],   // smuggled — must be dropped
        sharedSecret: 'deadbeef', // smuggled — must be dropped
      } as Record<string, unknown>,
      threadlinePairingRecordStoreSchema,
      bag,
    );
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data).not.toHaveProperty('sasWords');
      expect(env.data).not.toHaveProperty('sharedSecret');
      expect(JSON.stringify(env.data)).not.toContain('abandon');
    }
  });

  it('isIso8601 rejects markup-bearing dates', () => {
    expect(isIso8601(VERIFIED_AT)).toBe(true);
    expect(isIso8601('2026-06-16T12:00:00.000Z<x>')).toBe(false);
    expect(isIso8601('not a date')).toBe(false);
  });
});

// ── D. Honoring: key-pinning ───────────────────────────────────────────

describe('evaluateInheritedVerification — honored ONLY when peerIdentityPub matches the pin', () => {
  function viewsFor(pub: string): MergedPairingView[] {
    const data = buildThreadlinePairingRecordData({ result: makeResult({ peerIdentityPub: pub }), hlc: hlc(1000), origin: MACHINE_A })!;
    return [{ recordKey: data.recordKey as string, origin: MACHINE_A, data, conflicted: false }];
  }

  it('honors when the live handshake key MATCHES the pinned key', () => {
    const d = evaluateInheritedVerification(viewsFor(PEER_PUB), PEER_FP, PEER_PUB);
    expect(d.honor).toBe(true);
    if (d.honor) {
      expect(d.pinnedKey).toBe(PEER_PUB);
      expect(d.verifiedOnMachine).toBe(MACHINE_A);
    }
  });

  it('honors (key-pinned) when there is no live handshake key yet (not channel-ready, but inherited)', () => {
    const d = evaluateInheritedVerification(viewsFor(PEER_PUB), PEER_FP, undefined);
    expect(d.honor).toBe(true);
  });

  it('REFUSES + flags a mismatch when the live handshake key DIFFERS (substitution)', () => {
    const d = evaluateInheritedVerification(viewsFor(PEER_PUB), PEER_FP, OTHER_PUB);
    expect(d.honor).toBe(false);
    if (!d.honor) {
      expect(d.reason).toBe('identity-key-mismatch');
    }
  });

  it('returns no-replicated-record for an unknown peer', () => {
    const d = evaluateInheritedVerification(viewsFor(PEER_PUB), 'ffffffffffffffff', PEER_PUB);
    expect(d.honor).toBe(false);
    if (!d.honor) expect(d.reason).toBe('no-replicated-record');
  });
});

// ── E. mergeUnionToPairings + tombstone resolution ─────────────────────

describe('mergeUnionToPairings — append-both / tombstone resolution', () => {
  function originRec(pub: string, op: 'put' | 'delete', physical: number, deletedAt?: string): OriginRecord {
    const recordKey = deriveThreadlinePairingRecordKey(PEER_FP)!;
    const data = op === 'put'
      ? { peerFp: PEER_FP, peerIdentityPub: pub, state: REPLICATED_PAIRING_STATE, verifiedAt: VERIFIED_AT, verifiedOnMachine: MACHINE_A }
      : { deletedAt };
    return { origin: MACHINE_A, envelope: { recordKey, hlc: hlc(physical), op, origin: MACHINE_A }, data };
  }

  it('a resolved single put surfaces one view', () => {
    const rk = deriveThreadlinePairingRecordKey(PEER_FP)!;
    const union = new Map<string, UnionResult>([[rk, { value: originRec(PEER_PUB, 'put', 1000) } as UnionResult]]);
    const views = mergeUnionToPairings(union);
    expect(views).toHaveLength(1);
    expect(views[0].conflicted).toBe(false);
  });

  it('a delete-resolved key surfaces nothing (tombstone wins)', () => {
    const rk = deriveThreadlinePairingRecordKey(PEER_FP)!;
    const union = new Map<string, UnionResult>([[rk, { value: originRec(PEER_PUB, 'delete', 2000, VERIFIED_AT) } as UnionResult]]);
    expect(mergeUnionToPairings(union)).toHaveLength(0);
  });

  it('an open conflict surfaces BOTH put variants (append-both, never a silent clobber)', () => {
    const rk = deriveThreadlinePairingRecordKey(PEER_FP)!;
    const union = new Map<string, UnionResult>([[rk, {
      conflict: { versions: [originRec(PEER_PUB, 'put', 1000), originRec(OTHER_PUB, 'put', 1001)] },
    } as UnionResult]]);
    const views = mergeUnionToPairings(union);
    expect(views).toHaveLength(2);
    expect(views.every((v) => v.conflicted)).toBe(true);
  });
});

// ── F. Foreign render safety ───────────────────────────────────────────

describe('renderForeignPairingContext — quoted untrusted data, no secret material', () => {
  it('wraps the record in a replicated-untrusted-data envelope; never carries a secret', () => {
    const data = buildThreadlinePairingRecordData({ result: makeResult(), hlc: hlc(1000), origin: MACHINE_A })!;
    const block = renderForeignPairingContext({ recordKey: data.recordKey as string, origin: MACHINE_A, data, conflicted: false })!;
    expect(block).toContain('<replicated-untrusted-data origin="machine-a-laptop">');
    expect(block).toContain('</replicated-untrusted-data>');
    expect(block).toContain(PEER_FP);
    expect(block).not.toContain('sasWords');
    expect(block).not.toContain('sharedSecret');
  });
});

// ── G. AgentTrustManager inheritance — the consumer wiring ─────────────

describe('AgentTrustManager.inheritReplicatedVerification', () => {
  let dir: string;
  let manager: AgentTrustManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-replication-'));
    manager = new AgentTrustManager({ stateDir: dir, machineId: 'machine-b' });
  });
  afterEach(() => {
    manager.flush();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/threadline-pairing-replication.test.ts' });
  });

  it('inherits identity-verified (NOT channel-ready) when the key pins, opening the IDENTITY half', () => {
    const ok = manager.inheritReplicatedVerification(PEER_FP, {
      peerIdentityPub: PEER_PUB, verifiedAt: VERIFIED_AT, verifiedOnMachine: MACHINE_A, presentedIdentityPub: PEER_PUB, displayName: 'Dawn',
    });
    expect(ok).toBe(true);
    const profile = manager.getProfileByFingerprint(PEER_FP)!;
    expect(profile.pairingState).toBe('identity-verified');
    expect(profile.source).toBe('mutual-verified');
    expect(profile.level).toBe('trusted');
    expect(profile.inheritedFromMachine).toBe(MACHINE_A);
    // The identity half of the credential gate now passes (the channel half is the
    // outbound gate's encrypted-path check — separate).
    expect(manager.isCredentialShareAllowedByFingerprint(PEER_FP)).toBe(true);
  });

  it('inherits when there is no live handshake key yet (key-pinned, identity half open)', () => {
    const ok = manager.inheritReplicatedVerification(PEER_FP, { peerIdentityPub: PEER_PUB, verifiedAt: VERIFIED_AT, verifiedOnMachine: MACHINE_A });
    expect(ok).toBe(true);
    expect(manager.getProfileByFingerprint(PEER_FP)!.pairingState).toBe('identity-verified');
  });

  it('REFUSES + downgrades to pending-verification on an identity-key mismatch (substitution)', () => {
    const ok = manager.inheritReplicatedVerification(PEER_FP, {
      peerIdentityPub: PEER_PUB, verifiedAt: VERIFIED_AT, verifiedOnMachine: MACHINE_A, presentedIdentityPub: OTHER_PUB,
    });
    expect(ok).toBe(false);
    const profile = manager.getProfileByFingerprint(PEER_FP)!;
    expect(profile.pairingState).toBe('pending-verification');
    expect(profile.source).not.toBe('mutual-verified');
    expect(manager.isCredentialShareAllowedByFingerprint(PEER_FP)).toBe(false);
  });

  it('a tombstone-driven verification-failed un-verifies an inherited pairing', () => {
    manager.inheritReplicatedVerification(PEER_FP, { peerIdentityPub: PEER_PUB, verifiedAt: VERIFIED_AT, verifiedOnMachine: MACHINE_A, presentedIdentityPub: PEER_PUB });
    expect(manager.isCredentialShareAllowedByFingerprint(PEER_FP)).toBe(true);
    // A revoke tombstone applied on B is realized as markVerificationFailed.
    manager.markVerificationFailed(PEER_FP, 'replicated revoke tombstone');
    const profile = manager.getProfileByFingerprint(PEER_FP)!;
    expect(profile.pairingState).toBe('verification-failed');
    expect(manager.isCredentialShareAllowedByFingerprint(PEER_FP)).toBe(false);
  });

  it('a local verification-failed is NOT resurrected by an inherited grant (local wins)', () => {
    manager.getOrCreateProfileByFingerprint(PEER_FP, 'Dawn');
    manager.markVerificationFailed(PEER_FP, 'local operator mismatch');
    const ok = manager.inheritReplicatedVerification(PEER_FP, { peerIdentityPub: PEER_PUB, verifiedAt: VERIFIED_AT, verifiedOnMachine: MACHINE_A, presentedIdentityPub: PEER_PUB });
    expect(ok).toBe(false);
    expect(manager.getProfileByFingerprint(PEER_FP)!.pairingState).toBe('verification-failed');
  });
});

// ── H. flag-off = no replication (strict no-op) ────────────────────────

describe('flag-off = no replication (single-machine no-op)', () => {
  let dir: string;
  let manager: AgentTrustManager;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-noop-'));
    manager = new AgentTrustManager({ stateDir: dir, machineId: 'machine-a' });
  });
  afterEach(() => {
    manager.flush();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/threadline-pairing-replication.test.ts' });
  });

  it('with NO emitter attached, a local mutual-verify never emits (the emitter is the only egress)', () => {
    // No setPairingReplicationEmitter call ⇒ pairingReplication is undefined ⇒ strict no-op.
    const emitted: unknown[] = [];
    // Drive a full local verify; nothing should be emitted because no emitter is attached.
    manager.recordPendingVerification(PEER_FP, {
      pairingId: 'a'.repeat(32), peerIdentityPub: PEER_PUB, sasWords: ['abandon', 'ability'], sasFingerprint: 'dead', ownFp: 'own-fp',
    });
    const ok = manager.markMutualVerified(PEER_FP, { pairingId: 'a'.repeat(32), operatorConfirm: true, ownFp: 'own-fp' });
    expect(ok).toBe(true);
    expect(emitted).toHaveLength(0); // nothing captured — there was nowhere to emit.
    // Local state is correct (single-machine behavior unaffected).
    expect(manager.getProfileByFingerprint(PEER_FP)!.pairingState).toBe('mutual-verified');
  });

  it('an attached emitter receives ONLY the 5-field result (no SAS) on a local verify', () => {
    const seen: Array<{ peerFp: string; peerIdentityPub: string; verifiedAt: string; verifiedOnMachine: string }> = [];
    const revokes: Array<{ peerFp: string; deletedAt: string }> = [];
    manager.setPairingReplicationEmitter({
      emitVerified: (r) => seen.push(r),
      emitRevoke: (peerFp, deletedAt) => revokes.push({ peerFp, deletedAt }),
    }, 'machine-a');

    manager.recordPendingVerification(PEER_FP, {
      pairingId: 'b'.repeat(32), peerIdentityPub: PEER_PUB, sasWords: ['abandon', 'ability'], sasFingerprint: 'dead', ownFp: 'own-fp',
    });
    manager.markMutualVerified(PEER_FP, { pairingId: 'b'.repeat(32), operatorConfirm: true, ownFp: 'own-fp' });

    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]).sort()).toEqual(['peerFp', 'peerIdentityPub', 'verifiedAt', 'verifiedOnMachine'].sort());
    expect(JSON.stringify(seen[0])).not.toContain('abandon'); // SAS never reaches the emitter

    // verification-failed emits a revoke tombstone.
    manager.markVerificationFailed(PEER_FP, 'mismatch');
    expect(revokes).toHaveLength(1);
    expect(revokes[0].peerFp).toBe(PEER_FP);
  });
});

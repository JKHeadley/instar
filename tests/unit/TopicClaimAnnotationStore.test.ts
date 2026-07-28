/**
 * U4.2 §2.4 (R-r3-1/R-r3-2) — the `topic-claim-annotation` replicated kind:
 * claim suspension + per-topic claim budget + declined-demote, keyed
 * `${topic}:${episodeId}`, epoch-INDEPENDENT (its own HLC via the generic
 * envelope — never an ownership CAS), additive across versions (a new
 * registered KIND — no unknown-FIELD surface on the placement stream).
 *
 * Covers: strict schema clamps (both sides of each boundary), recordKey
 * derivation + jail discipline, PUT/tombstone builders, and the merged
 * per-topic read (highest-HLC per recordKey, then highest-HLC surviving PUT
 * per topic) — the read that makes budgets + refusals survive lease movement
 * (R-r2-4: `declined-demote-and-budget-survive-lease-move`).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  topicClaimAnnotationStoreSchema,
  buildClaimAnnotationPut,
  buildClaimAnnotationTombstone,
  mergeUnionToClaimAnnotations,
  deriveClaimAnnotationRecordKey,
  TOPIC_CLAIM_ANNOTATION_KIND_REGISTRATION,
  TOPIC_CLAIM_ANNOTATION_KIND,
  TOPIC_CLAIM_ANNOTATION_STORE_KEY,
  claimSuspensionExcludesPin,
} from '../../src/core/TopicClaimAnnotationStore.js';
import { JOURNAL_KINDS } from '../../src/core/CoherenceJournal.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';

const hlc = (physical: number, logical = 0, node = 'm_a'): HlcTimestamp => ({ physical, logical, node });
const ctx = () => ({ countDroppedField: () => {}, countJailReject: () => {} });

describe('TopicClaimAnnotationStore — schema validate (strict clamps)', () => {
  const good = { topic: 700, episodeId: 'm-owner-1000', suspended: true, claimedBy: 'm_self', claimCount: 2, backoffUntilMs: 5_000, declinedDemote: false };

  it('accepts a well-formed PUT (all clamps pass)', () => {
    expect(topicClaimAnnotationStoreSchema.validate(good, ctx())).toEqual(good);
  });
  it('rejects a non-numeric topic', () => {
    expect(topicClaimAnnotationStoreSchema.validate({ ...good, topic: '700' }, ctx())).toBeNull();
  });
  it('rejects a path-shaped / overlong episodeId (jail discipline — never path-shaped)', () => {
    expect(topicClaimAnnotationStoreSchema.validate({ ...good, episodeId: '../etc/passwd' }, ctx())).toBeNull();
    expect(topicClaimAnnotationStoreSchema.validate({ ...good, episodeId: 'x'.repeat(80) }, ctx())).toBeNull();
    expect(topicClaimAnnotationStoreSchema.validate({ ...good, episodeId: '' }, ctx())).toBeNull();
  });
  it('rejects a non-boolean suspended and a malformed claimedBy machine id', () => {
    expect(topicClaimAnnotationStoreSchema.validate({ ...good, suspended: 'yes' }, ctx())).toBeNull();
    expect(topicClaimAnnotationStoreSchema.validate({ ...good, claimedBy: 'a/b' }, ctx())).toBeNull();
  });
  it('rejects a negative / non-finite claimCount and a non-numeric backoffUntilMs', () => {
    expect(topicClaimAnnotationStoreSchema.validate({ ...good, claimCount: -1 }, ctx())).toBeNull();
    expect(topicClaimAnnotationStoreSchema.validate({ ...good, claimCount: Number.NaN }, ctx())).toBeNull();
    expect(topicClaimAnnotationStoreSchema.validate({ ...good, backoffUntilMs: 'soon' }, ctx())).toBeNull();
  });
  it('rejects a non-boolean declinedDemote (the operator refusal is a strict boolean)', () => {
    expect(topicClaimAnnotationStoreSchema.validate({ ...good, declinedDemote: 1 }, ctx())).toBeNull();
  });
  it('optional fields may be absent (minimal PUT)', () => {
    expect(topicClaimAnnotationStoreSchema.validate({ topic: 700, episodeId: 'e1', suspended: false, claimCount: 0 }, ctx()))
      .toEqual({ topic: 700, episodeId: 'e1', suspended: false, claimCount: 0 });
  });
  it('accepts a DELETE tombstone (only deletedAt is a legal store field)', () => {
    expect(topicClaimAnnotationStoreSchema.validate({ op: 'delete', deletedAt: '2026-07-01T00:00:00Z' }, ctx()))
      .toEqual({ deletedAt: '2026-07-01T00:00:00Z' });
  });
});

describe('TopicClaimAnnotationStore — registration is additive (R-r3-1)', () => {
  it('registration names the kind + store + schema (the generic-envelope path, like topic-pin-record)', () => {
    expect(TOPIC_CLAIM_ANNOTATION_KIND_REGISTRATION.kind).toBe('topic-claim-annotation');
    expect(TOPIC_CLAIM_ANNOTATION_KIND_REGISTRATION.store).toBe('topicClaimAnnotations');
    expect(TOPIC_CLAIM_ANNOTATION_KIND_REGISTRATION.schema).toBe(topicClaimAnnotationStoreSchema);
    expect(TOPIC_CLAIM_ANNOTATION_KIND).toBe('topic-claim-annotation');
    expect(TOPIC_CLAIM_ANNOTATION_STORE_KEY).toBe('topicClaimAnnotations');
  });
  it('the kind is registered in the static journal-kind registry (dual-registry invariant)', () => {
    expect(JOURNAL_KINDS).toContain('topic-claim-annotation');
  });
  it('annotation-kind-never-touches-placement-schema: the annotation rides its OWN kind, never a topic-placement field', () => {
    // The load-bearing R-r3-1 grounding: the placement receive-validation
    // strictly rejects unknown fields, so the suspension must NEVER ride the
    // ownership record. Assert the source keeps that promise: the store module
    // never references the placement kind or the ownership record type.
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/core/TopicClaimAnnotationStore.ts'), 'utf-8');
    expect(src).not.toMatch(/'topic-placement'/);
    // No CODE dependency on the ownership record (prose may cite it — the
    // grounding note explains WHY the kind exists — but never an import).
    expect(src).not.toMatch(/import[^;]*SessionOwnership/);
  });
  it('annotation-write-never-bumps-ownership-epoch (R-r3-2): the PUT carries NO epoch field', () => {
    const data = buildClaimAnnotationPut({ topic: 700, episodeId: 'e1', suspended: true, claimCount: 1 })(hlc(1000), 'm_a')!;
    expect(Object.keys(data)).not.toContain('ownershipEpoch');
    expect(Object.keys(data)).not.toContain('epoch');
    expect(data).toMatchObject({ recordKey: '700:e1', op: 'put', origin: 'm_a' });
    expect((data as { hlc: HlcTimestamp }).hlc.physical).toBe(1000); // its OWN HLC, never the ownership fence
  });
});

describe('TopicClaimAnnotationStore — recordKey + builders', () => {
  it('recordKey = `${topic}:${episodeId}` (per-(topic, episode) identity)', () => {
    expect(deriveClaimAnnotationRecordKey(700, 'ep-1')).toBe('700:ep-1');
    expect(deriveClaimAnnotationRecordKey('700', 'ep-1')).toBe('700:ep-1');
    expect(deriveClaimAnnotationRecordKey('nope', 'ep-1')).toBeNull();
    expect(deriveClaimAnnotationRecordKey(700, '../jail')).toBeNull();
  });
  it('buildClaimAnnotationPut refuses malformed inputs (fail closed, no partial record)', () => {
    expect(buildClaimAnnotationPut({ topic: Number.NaN, episodeId: 'e', suspended: true, claimCount: 0 })(hlc(1), 'm_a')).toBeNull();
    expect(buildClaimAnnotationPut({ topic: 700, episodeId: 'e', suspended: true, claimedBy: 'a b', claimCount: 0 })(hlc(1), 'm_a')).toBeNull();
    expect(buildClaimAnnotationPut({ topic: 700, episodeId: 'e', suspended: true, claimCount: -2 })(hlc(1), 'm_a')).toBeNull();
  });
  it('buildClaimAnnotationTombstone emits an op:delete envelope for the episode record', () => {
    const data = buildClaimAnnotationTombstone(700, 'ep-1', '2026-07-01T00:00:00Z')(hlc(2000), 'm_a');
    expect(data).toMatchObject({ op: 'delete', recordKey: '700:ep-1', deletedAt: '2026-07-01T00:00:00Z' });
  });
});

describe('TopicClaimAnnotationStore — merged per-topic read (HLC-highest-wins)', () => {
  const put = (topic: number, episodeId: string, h: HlcTimestamp, origin: string, extra?: Partial<Parameters<typeof buildClaimAnnotationPut>[0]>) => ({
    data: buildClaimAnnotationPut({ topic, episodeId, suspended: true, claimCount: 1, ...extra })(h, origin)!,
    origin,
  });

  it('the highest-HLC record per topic wins across episodes (skew-proof)', () => {
    const merged = mergeUnionToClaimAnnotations([
      put(700, 'ep-old', hlc(1000), 'm_a', { claimCount: 1 }),
      put(700, 'ep-new', hlc(2000), 'm_b', { claimCount: 3 }),
    ]);
    expect(merged.get(700)).toMatchObject({ episodeId: 'ep-new', claimCount: 3, origin: 'm_b' });
  });

  it("declined-demote-and-budget-survive-lease-move (R-r2-4): another machine's record is read identically", () => {
    // The claimer role moved with the lease: machine B recorded the operator's
    // "no" + the budget. Machine A (the NEW lease holder) reads the SAME merged
    // view — the refusal follows the topic, not the deciding machine.
    const merged = mergeUnionToClaimAnnotations([
      put(700, 'ep-1', hlc(1000, 0, 'm_b'), 'm_b', { declinedDemote: true, claimCount: 4, backoffUntilMs: 99_000 }),
    ]);
    expect(merged.get(700)).toMatchObject({ declinedDemote: true, claimCount: 4, backoffUntilMs: 99_000, origin: 'm_b' });
  });

  it('a winning tombstone removes that episode record; an older episode does not resurrect', () => {
    const tomb = { data: buildClaimAnnotationTombstone(700, 'ep-1', '2026-07-01T00:00:00Z')(hlc(3000), 'm_a')!, origin: 'm_a' };
    const merged = mergeUnionToClaimAnnotations([put(700, 'ep-1', hlc(1000), 'm_a'), tomb]);
    expect(merged.get(700)).toBeUndefined();
  });

  it('an older tombstone does NOT suppress a newer PUT on the same recordKey', () => {
    const tomb = { data: buildClaimAnnotationTombstone(700, 'ep-1', '2026-07-01T00:00:00Z')(hlc(500), 'm_a')!, origin: 'm_a' };
    const merged = mergeUnionToClaimAnnotations([tomb, put(700, 'ep-1', hlc(1000), 'm_a')]);
    expect(merged.get(700)).toMatchObject({ episodeId: 'ep-1' });
  });

  it('malformed entries (missing hlc / recordKey / bad episodeId) are skipped, never a crash', () => {
    const merged = mergeUnionToClaimAnnotations([
      { data: { topic: 700, episodeId: 'e', suspended: true }, origin: 'm_a' }, // no hlc/recordKey
      put(701, 'ok', hlc(1000), 'm_a'),
    ]);
    expect(merged.size).toBe(1);
    expect(merged.get(701)).toBeTruthy();
  });
});

describe('claimSuspensionExcludesPin — the ONE §2.4 comparison authority (reconciler effectivePins + closeout veto)', () => {
  it('a live suspension excludes a pin whose HLC is NOT strictly newer (suspended-pending-owner-return)', () => {
    // Older pin ⇒ excluded.
    expect(claimSuspensionExcludesPin(hlc(1_000), { suspended: true, hlc: hlc(2_000, 0, 'm_b') })).toBe(true);
    // EQUAL HLC ⇒ still excluded (the pin must be STRICTLY newer to win).
    expect(claimSuspensionExcludesPin(hlc(2_000, 0, 'm_b'), { suspended: true, hlc: hlc(2_000, 0, 'm_b') })).toBe(true);
  });

  it('a fresher operator re-pin WINS (the operator\'s newer statement clears the suspension)', () => {
    expect(claimSuspensionExcludesPin(hlc(3_000), { suspended: true, hlc: hlc(2_000, 0, 'm_b') })).toBe(false);
  });

  it('no suspension / suspended:false ⇒ the pin stands (both sides of the gate)', () => {
    expect(claimSuspensionExcludesPin(hlc(1_000), undefined)).toBe(false);
    expect(claimSuspensionExcludesPin(hlc(1_000), null)).toBe(false);
    expect(claimSuspensionExcludesPin(hlc(1_000), { suspended: false, hlc: hlc(2_000, 0, 'm_b') })).toBe(false);
  });
});

/**
 * Fix #2 — replicate the topic PIN (move-intent) to the owning machine so its reconciler
 * can start the cross-machine transfer. This consumer rides the WS2 replicated-record
 * machinery (HLC ordering, tombstone-on-clear). Tests cover both sides of each boundary.
 */
import { describe, it, expect } from 'vitest';
import {
  topicPinRecordStoreSchema, buildTopicPinPut, buildTopicPinTombstone,
  mergeUnionToPins, compareHlc, deriveTopicPinRecordKey, TOPIC_PIN_KIND_REGISTRATION,
} from '../../src/core/TopicPinReplicatedStore.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';

const hlc = (physical: number, logical = 0, node = 'm_a'): HlcTimestamp => ({ physical, logical, node });
const ctx = () => ({ countDroppedField: () => {}, countJailReject: () => {} });

describe('TopicPinReplicatedStore — schema validate', () => {
  it('accepts a well-formed PUT', () => {
    expect(topicPinRecordStoreSchema.validate({ topic: 700, preferredMachine: 'm_b', pinned: true }, ctx()))
      .toEqual({ topic: 700, preferredMachine: 'm_b', pinned: true });
  });
  it('rejects a non-numeric topic', () => {
    expect(topicPinRecordStoreSchema.validate({ topic: 'x', preferredMachine: 'm_b', pinned: true }, ctx())).toBeNull();
  });
  it('rejects a path-shaped / non-machine-id preferredMachine', () => {
    expect(topicPinRecordStoreSchema.validate({ topic: 700, preferredMachine: '../etc/passwd', pinned: true }, ctx())).toBeNull();
    expect(topicPinRecordStoreSchema.validate({ topic: 700, preferredMachine: '', pinned: true }, ctx())).toBeNull();
  });
  it('rejects a non-boolean pinned', () => {
    expect(topicPinRecordStoreSchema.validate({ topic: 700, preferredMachine: 'm_b', pinned: 'yes' }, ctx())).toBeNull();
  });
  it('accepts a DELETE tombstone (only deletedAt is a legal store field)', () => {
    expect(topicPinRecordStoreSchema.validate({ op: 'delete', deletedAt: '2026-06-30T00:00:00Z' }, ctx()))
      .toEqual({ deletedAt: '2026-06-30T00:00:00Z' });
  });
  it('registration names the kind + store + schema', () => {
    expect(TOPIC_PIN_KIND_REGISTRATION.kind).toBe('topic-pin-record');
    expect(TOPIC_PIN_KIND_REGISTRATION.store).toBe('topicPins');
    expect(TOPIC_PIN_KIND_REGISTRATION.schema).toBe(topicPinRecordStoreSchema);
  });
});

describe('TopicPinReplicatedStore — build + recordKey', () => {
  it('recordKey is the numeric topic id as a string', () => {
    expect(deriveTopicPinRecordKey(700)).toBe('700');
    expect(deriveTopicPinRecordKey('700')).toBe('700');
    expect(deriveTopicPinRecordKey('not-a-number')).toBeNull();
  });
  it('buildTopicPinPut emits the value + envelope (HLC, never wall-clock)', () => {
    const data = buildTopicPinPut(700, 'm_b', true)(hlc(1000), 'm_a');
    expect(data).toMatchObject({ topic: 700, preferredMachine: 'm_b', pinned: true, recordKey: '700', op: 'put', origin: 'm_a' });
    expect((data as { hlc: HlcTimestamp }).hlc.physical).toBe(1000);
  });
  it('buildTopicPinTombstone emits an op:delete envelope', () => {
    const data = buildTopicPinTombstone(700, '2026-06-30T00:00:00Z')(hlc(2000), 'm_a');
    expect(data).toMatchObject({ op: 'delete', recordKey: '700', deletedAt: '2026-06-30T00:00:00Z' });
  });
});

describe('TopicPinReplicatedStore — mergeUnionToPins (HLC-highest-wins)', () => {
  const put = (topic: number, machine: string, h: HlcTimestamp, origin = 'm_x') => ({ data: buildTopicPinPut(topic, machine, true)(h, origin)!, origin });
  const del = (topic: number, h: HlcTimestamp, origin = 'm_x') => ({ data: buildTopicPinTombstone(topic, '2026-06-30T00:00:00Z')(h, origin)!, origin });

  it('the highest-HLC pin wins (skew-proof, NOT wall-clock)', () => {
    const merged = mergeUnionToPins([put(700, 'm_a', hlc(1000)), put(700, 'm_b', hlc(2000))], compareHlc);
    expect(merged.get(700)?.preferredMachine).toBe('m_b'); // newer HLC
  });
  it('a winning TOMBSTONE resolves to NO pin (the clear superseded the set)', () => {
    const merged = mergeUnionToPins([put(700, 'm_b', hlc(1000)), del(700, hlc(2000))], compareHlc);
    expect(merged.has(700)).toBe(false);
  });
  it('an OLDER tombstone does NOT suppress a newer set (re-pin after clear)', () => {
    const merged = mergeUnionToPins([del(700, hlc(1000)), put(700, 'm_b', hlc(2000))], compareHlc);
    expect(merged.get(700)?.preferredMachine).toBe('m_b');
  });
  it('compareHlc orders physical, then logical, then node', () => {
    expect(compareHlc(hlc(2, 0), hlc(1, 9))).toBeGreaterThan(0);
    expect(compareHlc(hlc(1, 2), hlc(1, 1))).toBeGreaterThan(0);
    expect(compareHlc(hlc(1, 1, 'm_b'), hlc(1, 1, 'm_a'))).toBeGreaterThan(0);
  });
});

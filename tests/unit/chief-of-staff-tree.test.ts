/**
 * The Chief of Staff tree fold (docs/specs/chief-of-staff-topic.md §1.1/§1.4): last writer by HLC per
 * conversation, a tombstone removes the node, malformed records are ignored, and the loop's `tree()`
 * view is empty (never throws) when the union cannot be read.
 */
import { describe, it, expect } from 'vitest';
import { foldTreeState, buildTreePut, buildTreeTombstone, chiefOfStaffRecordStoreSchema, type UnionEntry } from '../../src/core/ChiefOfStaffStore.js';
import { ChiefOfStaffLoop, CHIEF_OF_STAFF_LOOP_DEFAULTS } from '../../src/core/ChiefOfStaffLoop.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';

const ctx = () => ({ countDroppedField: () => {}, countJailReject: () => {} });
function emit(entries: UnionEntry[], physical: number, build: (hlc: HlcTimestamp, origin: string) => Record<string, unknown> | null, origin = 'm_a') {
  const hlc: HlcTimestamp = { physical, logical: 0, node: origin };
  const data = build(hlc, origin); if (!data) return;
  const v = chiefOfStaffRecordStoreSchema.validate(data, ctx()); if (!v) return;
  entries.push({ data: { ...v, recordKey: data.recordKey, hlc, op: data.op, origin }, origin });
}

describe('foldTreeState', () => {
  it('last writer by HLC wins per conversation; the CoS node is the root; a tombstone removes a node', () => {
    const e: UnionEntry[] = [];
    emit(e, 1, buildTreePut('telegram:9', null, 'chief-of-staff'));
    emit(e, 2, buildTreePut('telegram:1', 'telegram:9', 'project'));
    emit(e, 3, buildTreePut('telegram:2', 'telegram:1', 'sub-topic'));
    emit(e, 4, buildTreePut('telegram:2', 'telegram:9', 'project'), 'm_b'); // re-parented on another machine, later
    emit(e, 5, buildTreePut('telegram:3', 'telegram:9', 'project'));
    emit(e, 6, buildTreeTombstone('telegram:3', new Date(6).toISOString()));
    const t = foldTreeState(e);
    expect(t.get('telegram:9')).toEqual({ conversationKey: 'telegram:9', parentConversationKey: null, role: 'chief-of-staff' });
    expect(t.get('telegram:1')?.parentConversationKey).toBe('telegram:9');
    expect(t.get('telegram:2')).toEqual({ conversationKey: 'telegram:2', parentConversationKey: 'telegram:9', role: 'project' });
    expect(t.has('telegram:3')).toBe(false);
  });
  it('an older write arriving later does not override a newer one (HLC, not arrival order)', () => {
    const e: UnionEntry[] = [];
    emit(e, 10, buildTreePut('telegram:1', 'telegram:9', 'project'));
    emit(e, 5, buildTreePut('telegram:1', null), 'm_b');
    expect(foldTreeState(e).get('telegram:1')?.parentConversationKey).toBe('telegram:9');
  });
  it('malformed tree records are dropped by the schema and never reach the fold', () => {
    const e: UnionEntry[] = [];
    emit(e, 1, buildTreePut('nonsense key', 'telegram:9'));
    emit(e, 2, buildTreePut('telegram:1', 'telegram:9', 'manager' as never));
    expect(foldTreeState(e).size).toBe(0);
  });
});

describe('ChiefOfStaffLoop.tree()', () => {
  const deps = (loadUnion: () => UnionEntry[]) => new ChiefOfStaffLoop({
    now: () => 0, machineId: 'm_a', enabled: () => true, holdsLease: () => true, config: () => CHIEF_OF_STAFF_LOOP_DEFAULTS,
    journal: { emit: () => ({ outcome: 'emitted', seq: 1 }), loadUnion },
    verifyRenewal: () => false, gather: async () => { throw new Error('n/a'); }, judge: async () => null,
    protocol: { claim: async () => ({ outcome: 'rejected', reason: 'n/a' }), standDown: () => null, settleOpenIntent: async () => 'lost', operatorLeaseLive: () => false } as never,
    mirrorInitiativeStatus: () => {}, sendNote: async () => {}, sendImmediate: async () => {}, statusUrl: () => 'x', localHour: () => 0,
  });
  it('returns the fold over the union', () => {
    const e: UnionEntry[] = []; emit(e, 1, buildTreePut('telegram:1', 'telegram:9', 'project'));
    expect(deps(() => e).tree().get('telegram:1')?.parentConversationKey).toBe('telegram:9');
  });
  it('an unreadable union yields an empty tree, never a throw', () => {
    expect(deps(() => { throw new Error('disk'); }).tree().size).toBe(0);
  });
});

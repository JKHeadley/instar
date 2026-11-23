/**
 * ChiefOfStaffLoop.boundProjectContents (docs/specs/conversation-groups-phone.md §3 step 2): the read a phone
 * "make this group a project" confirm decides from. It FAILS CLOSED: a journal that is unreadable or could not
 * be read completely (journal.loadUnionComplete() → null), or no complete reader at all, answers
 * null, never "no projects", because "not bound" is what lets the confirm write. It never uses the tail read.
 */
import { describe, it, expect } from 'vitest';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { chiefOfStaffRecordStoreSchema, buildBindingPut, type UnionEntry } from '../../src/core/ChiefOfStaffStore.js';
import { ChiefOfStaffLoop, CHIEF_OF_STAFF_LOOP_DEFAULTS, clampLoopConfig, type ChiefOfStaffLoopDeps } from '../../src/core/ChiefOfStaffLoop.js';

const CK = 'telegram:5150';
const ctx = () => ({ countDroppedField: () => {}, countJailReject: () => {} });

function setup(opts: { incomplete?: boolean; throws?: boolean; noComplete?: boolean } = {}) {
  const entries: UnionEntry[] = [];
  let clock = 1;
  const emit = (recordKey: string, build: (hlc: HlcTimestamp, origin: string) => Record<string, unknown> | null) => {
    const hlc: HlcTimestamp = { physical: ++clock, logical: 0, node: 'm_a' };
    const data = build(hlc, 'm_a'); if (!data) return { outcome: 'dropped' };
    const v = chiefOfStaffRecordStoreSchema.validate(data, ctx()); if (!v) return { outcome: 'dropped:schema' };
    entries.push({ data: { ...v, recordKey, hlc, op: 'put', origin: 'm_a' }, origin: 'm_a' }); return { outcome: 'emitted', seq: clock };
  };
  const config = clampLoopConfig({ ...CHIEF_OF_STAFF_LOOP_DEFAULTS });
  const deps = {
    now: () => Date.parse('2026-11-17T12:00:00Z'), machineId: 'm_a', enabled: () => true, holdsLease: () => true, config: () => config,
    // The tail read sees nothing (as a cut tail would): only the complete read may answer.
    journal: { emit, loadUnion: () => [], ...(opts.noComplete ? {} : { loadUnionComplete: () => { if (opts.throws) throw new Error('unreadable'); return opts.incomplete ? null : entries.slice(); } }) },
    verifyRenewal: () => true,
  } as unknown as ChiefOfStaffLoopDeps;
  const loop = new ChiefOfStaffLoop(deps);
  emit(`binding:${CK}`, (hlc, origin) => buildBindingPut({ conversationKey: CK, goal: 'Ship the shop', checkCadenceHours: 24,
    doneDefinition: [{ id: 'd1', kind: 'judgment', text: 'Live', certify: 'owner-confirms' }], linked: { repos: ['acme/shop'], branches: [], domains: [] },
    confirmedBy: 'owner', confirmedAt: '2026-11-17T11:00:00.000Z' } as never)(hlc, origin));
  return loop;
}

describe('ChiefOfStaffLoop.boundProjectContents', () => {
  it('returns each bound project\'s goal, done items and repos from a complete read', () => {
    const contents = setup().boundProjectContents();
    expect(contents?.get(CK)).toEqual({ goal: 'Ship the shop', doneDefinition: [{ id: 'd1', kind: 'judgment', text: 'Live', certify: 'owner-confirms' }], repos: ['acme/shop'] });
  });
  it('fails closed on an incomplete or unreadable journal, and when no complete reader is wired', () => {
    expect(setup({ incomplete: true }).boundProjectContents()).toBeNull();
    expect(setup({ throws: true }).boundProjectContents()).toBeNull();
    expect(setup({ noComplete: true }).boundProjectContents()).toBeNull();
  });
});

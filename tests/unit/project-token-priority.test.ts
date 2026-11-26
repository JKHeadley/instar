import { describe, expect, it } from 'vitest';
import { buildProjectPriorityPut, foldProjectPriorities, chiefOfStaffRecordStoreSchema, buildBindingPut, foldBindingState, type UnionEntry } from '../../src/core/ChiefOfStaffStore.js';
const key = 'telegram:144201';
const at = '2026-11-23T06:00:00.000Z';
function row(priority: 'high' | 'normal' | 'low', physical: number, node = 'a'): UnionEntry {
  const data = buildProjectPriorityPut({ conversationKey: key, priority, confirmedBy: 'owner', confirmedAt: at })({ physical, logical: 0, node }, node)!;
  expect(chiefOfStaffRecordStoreSchema.validate(data, { countDroppedField() {}, countJailReject() {} })).not.toBeNull();
  return { data, origin: node };
}
describe('explicit project priority signal', () => {
  it('merges by the existing HLC order independently of arrival order', () => {
    const high = row('high', 10); const low = row('low', 11);
    expect(foldProjectPriorities([high, low]).get(key)?.priority).toBe('low');
    expect(foldProjectPriorities([low, high]).get(key)?.priority).toBe('low');
    expect(foldProjectPriorities([row('high', 10, 'a'), row('low', 10, 'b')]).get(key)?.priority).toBe('low');
    expect(foldProjectPriorities([]).get(key)).toBeUndefined();
  });
  it('refuses invalid priority, identity, or owner attestation', () => {
    for (const patch of [{ priority: 'urgent' }, { conversationKey: '../x' }, { confirmedBy: 'agent' }, { confirmedAt: 'yesterday' }]) {
      const raw = { ...row('high', 1).data, ...patch };
      expect(chiefOfStaffRecordStoreSchema.validate(raw, { countDroppedField() {}, countJailReject() {} })).toBeNull();
    }
  });
  it('does not rewrite the binding or its check identity when priority changes', () => {
    const data = buildBindingPut({ conversationKey: key, goal: 'A goal', doneDefinition: [{ id: 'done', kind: 'deterministic', text: 'Done' }], checkCadenceHours: 24, linked: {}, confirmedBy: 'owner', confirmedAt: at })({ physical: 1, logical: 0, node: 'a' }, 'a')!;
    const binding = { data, origin: 'a' };
    expect(foldBindingState([binding, row('high', 20)]).get(key)).toEqual(foldBindingState([binding]).get(key));
  });
});

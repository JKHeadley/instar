import { describe, expect, it } from 'vitest';
import { matchManagedCodexStopReceipt as match } from '../../src/core/ManagedCodexStopReceipt.js';

function row(marker: string, turn = 'turn', itemType = 'HookPrompt'): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'item_completed', turn_id: turn,
      item: { type: itemType, id: 'receipt', fragments: [{ text: 'Continue ' + marker }] },
    },
  }) + '\n';
}

describe('managed Codex Stop receipt', () => {
  it('matches a fresh native receipt in the expected turn', () => {
    const old = row('marker-old');
    const rollout = old + row('marker-new');
    expect(match(rollout.slice(old.length), 'turn', 'marker-new')).toBe('receipt');
    expect(match(rollout.slice(old.length), 'turn', 'marker-old')).toBeUndefined();
  });

  it('rejects ordinary prompts, another turn and partial marker matches', () => {
    expect(match(row('marker', 'turn', 'UserMessage'), 'turn', 'marker')).toBeUndefined();
    expect(match(row('marker', 'other'), 'turn', 'marker')).toBeUndefined();
    expect(match(row('marker-other'), 'turn', 'marker')).toBeUndefined();
  });

  it('rejects duplicate, malformed and incomplete records', () => {
    const receipt = row('marker');
    expect(match(receipt + receipt, 'turn', 'marker')).toBeUndefined();
    expect(match('{broken\n' + receipt, 'turn', 'marker')).toBeUndefined();
    expect(match(receipt.trimEnd(), 'turn', 'marker')).toBeUndefined();
  });
});

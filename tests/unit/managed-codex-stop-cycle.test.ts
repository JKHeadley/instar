import { describe, expect, it } from 'vitest';
import { attributeManagedCodexStopCycle as attribute } from '../../src/core/ManagedCodexStopCycle.js';

function assistant(turn: string, id: string, text: string): string {
  return JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'item_completed', turn_id: turn,
      item: { type: 'AgentMessage', id, content: [{ type: 'Text', text }] },
    },
  }) + '\n';
}

describe('native managed Stop cycle attribution', () => {
  it('attributes the newest callback at the exact native byte offset', () => {
    const prior = assistant('turn', 'provider-id', 'earlier ☀');
    const current = assistant('turn', 'provider-id', 'current');
    expect(attribute(prior + current, 'turn', 'current')).toEqual({
      assistantItemId: 'provider-id', byteOffset: Buffer.byteLength(prior), turnId: 'turn',
    });
    expect(attribute(prior + current, 'turn', 'earlier ☀')).toBeUndefined();
  });

  it('refuses ambiguity before considering either occurrence for dispatch', () => {
    const prior = assistant('turn', 'one', 'same output');
    const current = assistant('turn', 'two', 'same output');
    expect(attribute(prior + current, 'turn', 'same output')).toBeUndefined();
  });

  it('rejects a callback from an older turn and records with incomplete framing', () => {
    const prior = assistant('old', 'one', 'old output');
    const current = assistant('new', 'two', 'new output');
    expect(attribute(prior + current, 'old', 'old output')).toBeUndefined();
    expect(attribute(current.trimEnd(), 'new', 'new output')).toBeUndefined();
    expect(attribute('bad record\n' + current, 'new', 'new output')).toBeUndefined();
  });
});

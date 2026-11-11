/** App conversations learn their documents through dispatch notes (instar-document-viewer §3.7). */
import { describe, expect, it } from 'vitest';
import { dispatchStoredAppMessage } from '../../src/core/appConversationPool.js';

function fakeService(documentNotes: (k: string) => string[] | null, seen: Array<Record<string, unknown>>) {
  return {
    deps: { dispatch: () => async (msg: Record<string, unknown>) => { seen.push(msg); return 'delivered'; }, documentNotes },
    pendingContext: () => ({ lines: ['(a file)'], ack: () => {} }),
    verify: () => 'verified',
    originClient: () => null,
    sessionLinesFor: async () => [],
  } as never;
}
const input = { key: 'k1', alias: 1, title: 'T', ownerName: 'J', memoryPersonId: null, event: { kind: 'message', messageId: 'm1', text: 'hi' } } as never;

describe('documents in app dispatch notes', () => {
  it('puts the documents block before the pending file lines', async () => {
    const seen: Array<Record<string, unknown>> = [];
    await dispatchStoredAppMessage(fakeService(() => ['Documents in this conversation:', '- "Plan" (version 2, 1 open comment)'], seen), input);
    expect(seen[0].notes).toEqual(['Documents in this conversation:', '- "Plan" (version 2, 1 open comment)', '(a file)']);
  });
  it('a failing documents source never blocks the message', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const r = await dispatchStoredAppMessage(fakeService(() => { throw new Error('x'); }, seen), input);
    expect(r.outcome).toBe('delivered');
    expect(seen[0].notes).toEqual(['(a file)']);
  });
});

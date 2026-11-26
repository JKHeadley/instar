import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { verifySealedJournalPrefix, type SealedJournalPrefix } from '../../src/core/SealedJournalPrefix.js';

const first = '{"op":"one","seq":1}\n';
const second = '{"op":"two","seq":2}\n';
const digest = createHash('sha256').update('instar-journal-prefix-v1\0');
for (const [index, line] of [first, second].entries()) {
  const frame = Buffer.alloc(16);
  frame.writeBigUInt64BE(BigInt(index + 1), 0);
  frame.writeBigUInt64BE(BigInt(Buffer.byteLength(line)), 8);
  digest.update(frame).update(line);
}
const seal: SealedJournalPrefix = {
  agent: 'echo', store: 'needs-you', transitionId: 'transition-2',
  predecessor: { stream: 'needs', incarnation: 'first', writer: 'studio', leaseEpoch: 1 },
  digestFormat: 'instar-journal-prefix-v1', terminalSequence: 2, prefixDigest: digest.digest('hex'),
};

it('verifies the complete canonical sealed bytes and treats unavailable storage distinctly', () => {
  expect(verifySealedJournalPrefix(seal, seal, Buffer.from(first + second))).toBe('verified');
  expect(verifySealedJournalPrefix(seal, seal, null)).toBe('unavailable');
  for (const changed of [first, first + first, second + first, first + second.trimEnd(),
    first + second.replace('two', 'bad'), first + second.replace(',"seq"', ', "seq"')]) {
    expect(verifySealedJournalPrefix(seal, seal, Buffer.from(changed))).toBe('pending');
  }
  const replay = { ...seal, predecessor: { ...seal.predecessor, incarnation: 'other' } };
  expect(verifySealedJournalPrefix(seal, replay, Buffer.from(first + second))).toBe('pending');
});

it('requires the explicit empty genesis seal', () => {
  const empty = { ...seal, terminalSequence: 0, prefixDigest: createHash('sha256').update('instar-journal-prefix-v1\0').digest('hex') };
  expect(verifySealedJournalPrefix(seal, empty, Buffer.alloc(0))).toBe('verified');
  expect(verifySealedJournalPrefix(seal, seal, Buffer.alloc(0))).toBe('pending');
});

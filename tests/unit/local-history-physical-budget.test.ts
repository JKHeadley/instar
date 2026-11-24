import { expect, it } from 'vitest';
import { estimateLocalHistoryPhysicalBytes } from '../../src/import/LocalHistoryPhysicalBudget.js';

const policy = { blockBytes: 4096, perWriteMetadataBytes: 4096, maxReservationBytes: 32 * 4096, maxAttachments: 2 };
it('rounds separate attachments and includes the existing partial append block', () => {
  expect(estimateLocalHistoryPhysicalBytes({ kind: 'conversation', appendBytes: 4096, attachmentBytes: [1, 1] }, policy))
    .toBe(5 * 4096);
});
it('counts a full replacement and both SQLite database write passes', () => {
  expect(estimateLocalHistoryPhysicalBytes({ kind: 'manifest', replacementBytes: 4097 }, policy)).toBe(3 * 4096);
  expect(estimateLocalHistoryPhysicalBytes({ kind: 'source-claim', databaseCeilingBytes: 8192, journalBytes: 4097 }, policy))
    .toBe(7 * 4096);
});
it.each([
  { kind: 'conversation', appendBytes: 0, attachmentBytes: [1, 1, 1] },
  { kind: 'conversation', appendBytes: 0, attachmentBytes: Array(1) },
  { kind: 'manifest', replacementBytes: Number.MAX_SAFE_INTEGER },
  { kind: 'manifest', replacementBytes: -1 },
  { kind: 'manifest', replacementBytes: 1, path: 'unexpected' },
])('refuses malformed or excessive allocation metadata', input => {
  expect(() => estimateLocalHistoryPhysicalBytes(input, policy)).toThrow('local-history-physical-budget');
});

import { expect, it } from 'vitest';
import { summarizeLocalHistoryPreviewProjects } from '../../src/import/LocalHistoryPreviewProjects.js';

const previewFile = {
  fileId: 'first', source: 'codex', projectPath: '/synthetic/project', messages: 3, newMessages: 2,
  redactions: 1, destinationFingerprint: null,
} as const;
const preparedFile = {
  fileId: 'first', rssProtection: 'sampled',
  counts: { records: 9, malformed: 1, excluded: 2, duplicateMessages: 4, toolCalls: 1 },
} as const;

it('groups by project and source and preserves distinct parser and destination counts', () => {
  const projects = summarizeLocalHistoryPreviewProjects([
    previewFile,
    { ...previewFile, fileId: 'second' },
    { ...previewFile, fileId: 'third', source: 'claude-code' },
  ], [
    preparedFile,
    { ...preparedFile, fileId: 'second', rssProtection: 'unavailable' },
    { ...preparedFile, fileId: 'third' },
  ]);
  expect(projects).toHaveLength(2);
  expect(projects[0]).toEqual({
    source: 'codex', projectPath: '/synthetic/project', files: 2, messages: 6, newMessages: 4,
    existingMessages: 2, parserExclusions: 4, malformedRecords: 2, parserDuplicates: 8,
    toolCalls: 2, redactions: 2, rssProtectionUnavailable: true,
  });
  expect(projects[1]).toMatchObject({ source: 'claude-code', files: 1, rssProtectionUnavailable: false });
});

it('refuses mismatched file identity and incomplete receipts', () => {
  expect(() => summarizeLocalHistoryPreviewProjects([previewFile], [])).toThrow('file-binding');
  expect(() => summarizeLocalHistoryPreviewProjects([previewFile], [{ ...preparedFile, fileId: 'different' }]))
    .toThrow('file-binding');
});

it('refuses totals outside safe integer range', () => {
  const excessive = { ...preparedFile, counts: { ...preparedFile.counts, excluded: Number.MAX_SAFE_INTEGER } };
  expect(() => summarizeLocalHistoryPreviewProjects([previewFile, { ...previewFile, fileId: 'second' }], [
    excessive, { ...preparedFile, fileId: 'second' },
  ])).toThrow('project-capacity');
});

import type { LocalHistoryParseReceipt } from './LocalHistoryParseJob.js';
import type { LocalHistoryPreparedPreviewFile } from './LocalHistoryPreparedPreview.js';

interface ProjectSummary {
  source: LocalHistoryPreparedPreviewFile['source'];
  projectPath: string;
  files: number;
  messages: number;
  newMessages: number;
  existingMessages: number;
  parserExclusions: number;
  malformedRecords: number;
  parserDuplicates: number;
  toolCalls: number;
  redactions: number;
  rssProtectionUnavailable: boolean;
}

/** Internal metadata for the sealed preview. The HTTP contract maps this
 * separately and does not need any artifact identifier or destination digest. */
export function summarizeLocalHistoryPreviewProjects(
  files: readonly LocalHistoryPreparedPreviewFile[],
  prepared: readonly (Pick<LocalHistoryParseReceipt, 'counts' | 'rssProtection'> & { fileId: string })[],
): ProjectSummary[] {
  if (files.length !== prepared.length) throw new Error('local-history-preview-file-binding');
  const projects = new Map<string, ProjectSummary>();
  for (const [index, file] of files.entries()) {
    const parser = prepared[index];
    if (parser.fileId !== file.fileId) throw new Error('local-history-preview-file-binding');
    const key = JSON.stringify([file.source, file.projectPath]);
    let summary = projects.get(key);
    if (!summary) {
      summary = {
        source: file.source, projectPath: file.projectPath, files: 0, messages: 0, newMessages: 0,
        existingMessages: 0, parserExclusions: 0, malformedRecords: 0, parserDuplicates: 0,
        toolCalls: 0, redactions: 0, rssProtectionUnavailable: false,
      };
      projects.set(key, summary);
    }
    summary.files++;
    summary.messages += file.messages;
    summary.newMessages += file.newMessages;
    summary.existingMessages += file.messages - file.newMessages;
    summary.parserExclusions += parser.counts.excluded;
    summary.malformedRecords += parser.counts.malformed;
    summary.parserDuplicates += parser.counts.duplicateMessages;
    summary.toolCalls += parser.counts.toolCalls;
    summary.redactions += file.redactions;
    summary.rssProtectionUnavailable ||= parser.rssProtection === 'unavailable';
  }
  for (const project of projects.values()) {
    if (Object.values(project).some(value => typeof value === 'number' && !Number.isSafeInteger(value))) {
      throw new Error('local-history-preview-project-capacity');
    }
  }
  return [...projects.values()];
}

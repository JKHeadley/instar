import type { ParsedLaneReport } from './laneReport.js';

/** One private diagnostic per kept failed checkout; never used to decide a verdict. */
export const FAILURE_EVIDENCE_BYTES = 64 * 1024;
export const FAILURE_EVIDENCE_FILE = '.local-verify-failures.json';

export class FailureEvidence {
  private failures: Array<{ lane: string; file: string; test?: string; message: string }> = [];
  private truncated = false;
  private bytes = 0;

  capture(lane: string, report: ParsedLaneReport): void {
    for (const [file, counts] of report.files) {
      if (!counts.failed) continue;
      const tests = counts.failedTests ?? [];
      if ((counts.assertionFailures ?? 0) > tests.length) this.truncated = true;
      const messages: Array<{ lane: string; file: string; test?: string; message: string }> = tests.map(t => ({ lane, file, test: t.name, message: t.full }));
      if (!tests.length || counts.fileLevelFailure) messages.push({ lane, file, test: undefined, message: counts.message ?? 'File failed without an assertion message' });
      for (const entry of messages) {
        const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
        // Reserve space for the envelope and disclosure. Never slice serialized JSON.
        if (this.bytes + size > FAILURE_EVIDENCE_BYTES - 512) { this.truncated = true; continue; }
        this.failures.push(entry);
        this.bytes += size;
      }
    }
  }

  serialize(): string {
    return JSON.stringify({ version: 1, truncated: this.truncated, failures: this.failures }) + '\n';
  }
}

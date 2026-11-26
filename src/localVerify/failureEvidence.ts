import type { ParsedLaneReport } from './laneReport.js';

/** One private diagnostic per kept failed checkout; never used to decide a verdict. */
export const FAILURE_EVIDENCE_BYTES = 64 * 1024;
export const FAILURE_EVIDENCE_FILE = '.local-verify-failures.json';

interface ProcessExit {
  step: string;
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

interface ProcessFailure extends ProcessExit {
  unhandled?: { count: number; messages: string[] };
}

export class FailureEvidence {
  private failures: Array<{ lane: string; file: string; test?: string; message: string }> = [];
  private processFailures: ProcessFailure[] = [];
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

  captureUnitExit(process: ProcessExit, reporterJson: string | null): void {
    const tail = (output: string): string => {
      if (output.length <= 2048) return output;
      this.truncated = true;
      return output.slice(-2048);
    };
    const entry: ProcessFailure = { ...process, stdout: tail(process.stdout), stderr: tail(process.stderr) };
    if (reporterJson && reporterJson.length <= 16 * 1024) {
      try {
        const report = JSON.parse(reporterJson);
        if (report?.v === 1 && Number.isSafeInteger(report.unhandledErrors) && report.unhandledErrors > 0) {
          const messages = Array.isArray(report.messages)
            ? report.messages.slice(0, 5).filter((message: unknown): message is string => typeof message === 'string').map((message: string) => message.slice(0, 400))
            : [];
          entry.unhandled = { count: report.unhandledErrors, messages };
        }
      } catch { /* A malformed optional reporter file cannot erase the process evidence. */ }
    }
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
    const processBytes = this.processFailures.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item)) + 1, 0);
    if (processBytes + size > FAILURE_EVIDENCE_BYTES - 512) {
      this.truncated = true;
      return;
    }
    while (this.bytes + size > FAILURE_EVIDENCE_BYTES - 512) {
      const omitted = this.failures.pop();
      this.truncated = true;
      if (!omitted) return;
      this.bytes -= Buffer.byteLength(JSON.stringify(omitted)) + 1;
    }
    this.processFailures.push(entry);
    this.bytes += size;
  }

  serialize(): string {
    return JSON.stringify({ version: 1, truncated: this.truncated, failures: this.failures, ...(this.processFailures.length ? { processFailures: this.processFailures } : {}) }) + '\n';
  }
}

import type { ParsedLaneReport } from './laneReport.js';
import { boundedTail } from '../core/boundedInput.js';
import { maskCredentials } from '../messaging/outbound-credential-guard.js';

/** Private diagnostics share the retained checkout's existing eviction lifetime. */
export const FAILURE_SUMMARY_BYTES = 64 * 1024;
export const FAILURE_DIAGNOSTIC_BYTES = 64 * 1024;
export const FAILURE_EVIDENCE_BYTES = FAILURE_SUMMARY_BYTES + FAILURE_DIAGNOSTIC_BYTES;
export const FAILURE_EVIDENCE_FILE = '.local-verify-failures.json';
const DIAGNOSTIC_TEXT_CHARS = 2048;
const MASK_INPUT_BYTES = 1_000_000;
const MAX_DIAGNOSTICS = 64;

type Diagnostic = { kind: 'process' | 'report' | 'reporter'; step: string; [key: string]: unknown };
interface ProcessFailure {
  status: number | null;
  signal?: string | null;
  stdout: string;
  stderr: string;
  deadlineKilled: boolean;
  aborted?: boolean;
}

export class FailureEvidence {
  private failures: Array<{ lane: string; file: string; test?: string; message: string }> = [];
  private diagnostics: Diagnostic[] = [];
  private truncated = false;
  private diagnosticsTruncated = false;
  private bytes = 0;
  private diagnosticBytes = 0;
  private diagnosticEntriesOmitted = 0;

  /** Known provider-credential shapes only; private mode remains the boundary. */
  private scrub(text: string): string {
    try {
      if (Buffer.byteLength(text) > MASK_INPUT_BYTES) throw new Error('diagnostic scan bound');
      return maskCredentials(text).text;
    } catch {
      this.truncated = true;
      return '[Diagnostic text omitted because credential masking was unavailable or exceeded its input bound]';
    }
  }

  private diagnosticText(text: string): string {
    const safe = this.scrub(text);
    if (safe.length > DIAGNOSTIC_TEXT_CHARS || safe !== text && safe.startsWith('[Diagnostic text omitted')) {
      this.truncated = true;
      this.diagnosticsTruncated = true;
    }
    return boundedTail(safe, DIAGNOSTIC_TEXT_CHARS);
  }

  private appendDiagnostic(entry: Diagnostic): void {
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (size > FAILURE_DIAGNOSTIC_BYTES - 512) {
      this.truncated = true; this.diagnosticsTruncated = true; this.diagnosticEntriesOmitted++;
      return;
    }
    this.diagnostics.push(entry); this.diagnosticBytes += size;
    // Diagnostics are chronological: keep the newest evidence and disclose loss.
    while (this.diagnosticBytes > FAILURE_DIAGNOSTIC_BYTES - 512 || this.diagnostics.length > MAX_DIAGNOSTICS) {
      this.diagnosticBytes -= Buffer.byteLength(JSON.stringify(this.diagnostics.shift()!)) + 1;
      this.truncated = true; this.diagnosticsTruncated = true; this.diagnosticEntriesOmitted++;
    }
  }

  capture(lane: string, report: ParsedLaneReport): void {
    for (const [file, counts] of report.files) {
      if (!counts.failed) continue;
      const tests = counts.failedTests ?? [];
      if ((counts.assertionFailures ?? 0) > tests.length) this.truncated = true;
      const messages: Array<{ lane: string; file: string; test?: string; message: string }> = tests.map(t => ({ lane, file: this.scrub(file), test: this.scrub(t.name), message: this.scrub(t.full) }));
      if (!tests.length || counts.fileLevelFailure) messages.push({ lane, file: this.scrub(file), test: undefined, message: this.scrub(counts.message ?? 'File failed without an assertion message') });
      for (const entry of messages) {
        const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
        // Preserve the original summary allowance independently of diagnostics.
        if (this.bytes + size > FAILURE_SUMMARY_BYTES - 512) { this.truncated = true; continue; }
        this.failures.push(entry); this.bytes += size;
      }
    }
  }

  captureProcess(step: string, result: ProcessFailure): void {
    if (result.status === 0 && !result.deadlineKilled && !result.aborted) return;
    this.appendDiagnostic({ kind: 'process', step, status: result.status, signal: result.signal ?? null,
      deadlineKilled: result.deadlineKilled, aborted: result.aborted ?? false,
      stdout: this.diagnosticText(result.stdout), stderr: this.diagnosticText(result.stderr) });
  }

  captureReporter(step: string, text: string | null, unhandledErrors: number | null, available: boolean): void {
    const state = !available ? 'unavailable' : text === null ? 'missing' : unhandledErrors === null ? 'malformed' : 'present';
    this.appendDiagnostic({ kind: 'reporter', step, state, unhandledErrors,
      text: text === null ? null : this.diagnosticText(text) });
  }

  captureReport(step: string, text: string | null): void {
    if (text === null) { this.appendDiagnostic({ kind: 'report', step, state: 'missing' }); return; }
    let parsed: { testResults?: unknown; success?: unknown; error?: unknown; errors?: unknown };
    try { parsed = JSON.parse(text); }
    catch { this.appendDiagnostic({ kind: 'report', step, state: 'malformed', text: this.diagnosticText(text) }); return; }
    if (!parsed || !Array.isArray(parsed.testResults)) {
      this.appendDiagnostic({ kind: 'report', step, state: 'malformed', text: this.diagnosticText(text) }); return;
    }
    let failed = 0;
    for (const raw of parsed.testResults) {
      if (!raw || typeof raw !== 'object' || raw.status !== 'failed') continue;
      failed++;
      // Raw suite-level fields preserve collection/hook details lost by the
      // verdict parser, without copying all passing assertions or their output.
      const context = { name: raw.name, status: raw.status, message: raw.message, failureMessage: raw.failureMessage, errors: raw.errors };
      this.appendDiagnostic({ kind: 'report', step, state: 'failed-suite', text: this.diagnosticText(JSON.stringify(context)) });
    }
    if (!failed) this.appendDiagnostic({ kind: 'report', step, state: 'no-failed-suite',
      text: this.diagnosticText(JSON.stringify({ success: parsed.success, error: parsed.error, errors: parsed.errors })) });
  }

  serialize(): string {
    // Each independent allowance reserves 512 bytes; fixed envelope metadata is
    // far smaller than that total reserve, including JSON escaping and LF.
    return JSON.stringify({ version: 1, truncated: this.truncated, failures: this.failures,
      diagnosticsTruncated: this.diagnosticsTruncated, diagnosticEntriesOmitted: this.diagnosticEntriesOmitted,
      diagnostics: this.diagnostics }) + '\n';
  }
}

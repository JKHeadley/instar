/**
 * A vitest reporter the verifier adds to every lane and isolation re-run (trusted side: it
 * is loaded from the installed server's own dist by absolute path, never from the PR).
 *
 * vitest's JSON reporter does not include unhandled errors, and vitest exits 1 for both a
 * failed test and an unhandled error, so the exit code alone cannot say which happened.
 * This reporter writes the unhandled-error count (and the first few messages, bounded) to
 * the file named by LOCAL_VERIFY_UNHANDLED_ERRORS_FILE, so the orchestrator never lets an
 * isolation re-run hide an unhandled error (spec Throughput budget, flaky files).
 */

import fs from 'node:fs';

export interface UnhandledErrorsFile {
  v: 1;
  unhandledErrors: number;
  messages: string[];
}

export default class LocalVerifyUnhandledErrorsReporter {
  onFinished(_files?: unknown, errors: unknown[] = []): void {
    const out = process.env.LOCAL_VERIFY_UNHANDLED_ERRORS_FILE;
    if (!out) return;
    const body: UnhandledErrorsFile = {
      v: 1,
      unhandledErrors: errors.length,
      messages: errors.slice(0, 5).map((e) => String((e as { message?: unknown })?.message ?? e).slice(0, 400)),
    };
    fs.writeFileSync(out, JSON.stringify(body));
  }
}

/** Parse the file the reporter wrote; null when absent or unreadable (unknown ⇒ never re-run). */
export function readUnhandledErrors(text: string | null): number | null {
  if (text === null) return null;
  try {
    const o = JSON.parse(text) as Partial<UnhandledErrorsFile>;
    return o.v === 1 && Number.isInteger(o.unhandledErrors) && (o.unhandledErrors as number) >= 0 ? (o.unhandledErrors as number) : null;
  } catch {
    return null;
  }
}

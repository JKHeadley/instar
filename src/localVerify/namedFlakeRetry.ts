import { withoutNames, type FileCounts, type ParsedLaneReport } from './laneReport.js';

/** Only uniquely identified assertion failures can be corrected by a filtered run. */
export function namedFlakeRetrySelection(report: ParsedLaneReport, files: readonly string[]): Map<string, string[]> | null {
  const selected = new Map<string, string[]>();
  for (const file of files) {
    const counts = report.files.get(file);
    if (!counts || counts.failed < 1 || counts.assertionFailures !== counts.failed || counts.nonAssertionFailure
      || counts.fileLevelFailure !== false || counts.duplicateFailedName !== false) return null;
    const names = counts.failedTests?.map((test) => test.name);
    if (!names || names.length !== counts.failed || new Set(names).size !== names.length) return null;
    selected.set(file, names);
  }
  return selected;
}

/** Quote every name literally and match the full test name, including its suite. */
export function namedFlakeRetryPattern(names: readonly string[]): string {
  return `^(?:${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`;
}

export function namedFlakeRetryPassed(report: ParsedLaneReport | null, file: string, names: readonly string[]): boolean {
  if (report?.files.size !== 1) return false;
  const counts = report.files.get(file);
  if (!counts || counts.failed !== 0 || counts.nonAssertionFailure || counts.passed !== names.length
    || counts.passedTests?.length !== names.length) return false;
  const passed = new Set(counts.passedTests);
  return names.every((name) => passed.has(name)) && !counts.notPassedTests?.some((test) => passed.has(test.name));
}

/** A filtered run proves the selected failures recovered. It cannot replace the file inventory. */
export function clearNamedFlakeFailures(first: FileCounts): FileCounts {
  return { ...withoutNames(first), passed: first.passed + first.failed, failed: 0, assertionFailures: 0, message: '' };
}

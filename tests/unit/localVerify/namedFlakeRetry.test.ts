import { readUnhandledErrors } from '../../../src/localVerify/unhandledErrorsReporter.js';
import { describe, expect, it } from 'vitest';
import { clearNamedFlakeFailures, namedFlakeRetryPassed, namedFlakeRetryPattern, namedFlakeRetrySelection } from '../../../src/localVerify/namedFlakeRetry.js';
import type { FileCounts } from '../../../src/localVerify/laneReport.js';

const file = 'tests/unit/example.test.ts';
const name = 'suite a[1] + (x)';
const original: FileCounts = {
  passed: 23, failed: 1, skipped: 2, todo: 1, assertionFailures: 1, message: 'timed out',
  duplicateFailedName: false, fileLevelFailure: false, failedTests: [{ name, line: 'line', full: 'failure' }],
};
const report = (counts: FileCounts) => ({ files: new Map([[file, counts]]) });

describe('named flake retry', () => {
  it('selects an exact failed assertion and quotes regex syntax literally', () => {
    expect(namedFlakeRetrySelection(report(original), [file])?.get(file)).toEqual([name]);
    const filter = new RegExp(namedFlakeRetryPattern([name, 'suite other']));
    expect(filter.test(name)).toBe(true);
    expect(filter.test(`${name} suffix`)).toBe(false);
    expect(filter.test('suite a1 + (x)')).toBe(false);
    expect(filter.test('suite other')).toBe(true);
  });

  it.each([{ duplicateFailedName: true }, { fileLevelFailure: true }, { assertionFailures: 0 }, { failedTests: [] }])(
    'refuses unproven failures %j', (override) => {
      expect(namedFlakeRetrySelection(report({ ...original, ...override }), [file])).toBeNull();
    },
  );

  it('uses exact passing names and retains the unrelated file counts', () => {
    const filtered = { passed: 1, failed: 0, skipped: 26, todo: 0, passedTests: [name] };
    expect(namedFlakeRetryPassed(report(filtered), file, [name])).toBe(true);
    expect(namedFlakeRetryPassed(report({ ...filtered, passedTests: ['other'] }), file, [name])).toBe(false);
    expect(namedFlakeRetryPassed(report({ ...filtered, notPassedTests: [{ name, status: 'skipped' }] }), file, [name])).toBe(false);
    expect(clearNamedFlakeFailures(original)).toMatchObject({ passed: 24, failed: 0, skipped: 2, todo: 1, assertionFailures: 0 });
  });
});

it('only accepts a zero error count with an empty message list in named mode', () => {
  expect(readUnhandledErrors('{"v":1,"unhandledErrors":0,"messages":[]}', true)).toBe(0);
  expect(readUnhandledErrors('{"v":1,"unhandledErrors":0,"messages":["worker failure"]}', true)).toBeNull();
  expect(readUnhandledErrors('{"v":1,"unhandledErrors":0}', true)).toBeNull();
});

import { describe, expect, it } from 'vitest';
import { effectivePreflightMode, parsePreflightList, preflightAssertionFailures, preflightBreadth, repeatedFailedFile } from '../../../src/localVerify/preflight.js';

const root = '/tmp/lv-run';
const file = `${root}/tests/unit/example.test.ts`;
const report = (status: string, assertions: string[]) => JSON.stringify({ testResults: [{ name: file, status, assertionResults: assertions.map((s) => ({ status: s })) }] });

describe('bounded verifier preflight decisions', () => {
  it('leaves main and untrusted manual PRs out of enforce mode', () => {
    expect(effectivePreflightMode('enforce', 'main', true)).toBe('off');
    expect(effectivePreflightMode('enforce', 'pr', false)).toBe('observe');
    expect(effectivePreflightMode('enforce', 'pr', true)).toBe('enforce');
    expect(effectivePreflightMode('unknown', 'pr', true)).toBe('off');
  });
  it('bounds breadth and treats zero selection as a skip', () => {
    expect(preflightBreadth(40, 5, 200)).toBeNull();
    expect(preflightBreadth(41, 5, 200)).toBe('changed-files-cap');
    expect(preflightBreadth(40, 6, 200)).toBe('selected-files-cap');
    expect(preflightBreadth(40, 5, 201)).toBe('selected-cases-cap');
    expect(preflightBreadth(0, 0, 0)).toBe('no-selected-tests');
  });
  it('accepts exact selected files and rejects paths outside the run', () => {
    expect(parsePreflightList(JSON.stringify([{ file }]), root, true)).toEqual({ files: ['tests/unit/example.test.ts'], cases: 0 });
    expect(parsePreflightList(JSON.stringify([{ file, name: 'case' }]), root, false)).toEqual({ files: ['tests/unit/example.test.ts'], cases: 1 });
    expect(parsePreflightList(JSON.stringify([{ file: '/tmp/other/a.test.ts' }]), root, true)).toBeNull();
    expect(parsePreflightList('bad json', root, true)).toBeNull();
  });
  it('requires two actual assertion failures in one selected file and zero unhandled errors', () => {
    const selected = ['tests/unit/example.test.ts'];
    const red = preflightAssertionFailures(report('failed', ['failed']), root, selected);
    expect(red).toEqual(selected);
    expect(repeatedFailedFile(red, red, 0, 0)).toBe(selected[0]);
    expect(repeatedFailedFile(red, red, null, 0)).toBeNull();
    expect(repeatedFailedFile(red, [], 0, 0)).toBeNull();
    expect(preflightAssertionFailures(report('failed', []), root, selected)).toBeNull();
    expect(preflightAssertionFailures(report('passed', ['passed']), root, selected)).toEqual([]);
    expect(preflightAssertionFailures(report('failed', ['failed']), root, ['tests/unit/other.test.ts'])).toBeNull();
  });
  it('rejects incomplete and contradictory run reports before they can establish an early red', () => {
    const selected = ['tests/unit/example.test.ts'];
    expect(preflightAssertionFailures(JSON.stringify({ testResults: [] }), root, selected)).toBeNull();
    expect(preflightAssertionFailures(JSON.stringify({ testResults: [
      { name: file, status: 'failed', assertionResults: [{ status: 'failed' }] },
      { name: file, status: 'failed', assertionResults: [{ status: 'failed' }] },
    ] }), root, selected)).toBeNull();
    expect(preflightAssertionFailures(report('failed', ['passed']), root, selected)).toBeNull();
    expect(preflightAssertionFailures(report('passed', ['failed']), root, selected)).toBeNull();
    expect(preflightAssertionFailures(report('pending', ['failed']), root, selected)).toBeNull();
    expect(preflightAssertionFailures(report('failed', ['pending']), root, selected)).toBeNull();
    expect(preflightAssertionFailures('{bad', root, selected)).toBeNull();
    expect(preflightAssertionFailures(' '.repeat(2 * 1024 * 1024 + 1), root, selected)).toBeNull();
  });
  it('rejects duplicate, missing-name, and escaped list identities', () => {
    expect(parsePreflightList(JSON.stringify([{ file }, { file }]), root, true)).toBeNull();
    expect(parsePreflightList(JSON.stringify([{ file }]), root, false)).toBeNull();
    expect(parsePreflightList(JSON.stringify([{ file: `${root}/../elsewhere/a.test.ts` }]), root, true)).toBeNull();
    expect(parsePreflightList(JSON.stringify([{ file: `${root}/src/a.ts` }]), root, true)).toBeNull();
  });
});

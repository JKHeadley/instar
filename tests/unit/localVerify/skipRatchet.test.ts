/**
 * Tier-1 tests for the static skip/removal ratchet (spec
 * local-verify-merge-authority.md §2 step 5). Real TypeScript parser.
 */

import { describe, it, expect } from 'vitest';
import { countSkips, evaluateSkipRatchet } from '../../../src/localVerify/skipRatchet.js';

const BASE = `
import { describe, it, expect } from 'vitest';
describe('thing', () => {
  it('works', () => { expect(1).toBe(1); });
  it('also works', async () => { expect(2).toBe(2); });
});
`;

describe('countSkips', () => {
  it('counts plain registrations, no skips', () => {
    expect(countSkips(BASE)).toEqual({ tests: 2, suites: 1, skips: 0 });
  });
  it('counts .skip/.todo/.skipIf/.runIf anywhere in the chain', () => {
    const src = `
      it.skip('a', () => {});
      it.todo('b');
      it.concurrent.skip('c', () => {});
      test.skipIf(process.platform === 'win32')('d', () => {});
      describe.runIf(hasTmux)('e', () => { it('inner', () => {}); });
      suite.skip('f', () => {});
    `;
    expect(countSkips(src)).toEqual({ tests: 5, suites: 2, skips: 6 });
  });
  it('counts xit/xtest/xdescribe as skips', () => {
    expect(countSkips(`xit('a', () => {}); xtest('b', () => {}); xdescribe('c', () => {});`)).toEqual({ tests: 2, suites: 1, skips: 3 });
  });
  it('walks parameterised .each forms as one registration each', () => {
    const src = `
      test.each([1, 2])('n=%i', (n) => {});
      test.skip.each([1, 2])('s=%i', (n) => {});
      it.each\`
        a | b
        \${1} | \${2}
      \`('tpl', () => {});
      describe.each([[1]])('d', () => {});
    `;
    expect(countSkips(src)).toEqual({ tests: 3, suites: 1, skips: 1 });
  });
  it('counts ctx.skip()/context.skip() and a destructured skip inside test bodies and hooks', () => {
    const src = `
      it('a', (ctx) => { if (!x) ctx.skip(); });
      it('b', async (context) => { context.skip(); });
      test('c', ({ skip }) => { skip(); });
      test('d', ({ skip: bail }) => { bail(); });
      beforeEach((ctx) => { ctx.skip(); });
    `;
    expect(countSkips(src)).toEqual({ tests: 4, suites: 0, skips: 5 });
  });
  it('comments and strings never count', () => {
    const src = `
      // it.skip('commented', () => {});
      /* xit('block', () => {}) */
      const s = "it.skip('in a string', () => {})";
      const t = \`describe.skip('template')\`;
      it('real', () => { expect(s).toContain('skip'); });
    `;
    expect(countSkips(src)).toEqual({ tests: 1, suites: 0, skips: 0 });
  });
  it('a .skip() on something that is not the test context does not count', () => {
    const src = `it('a', (ctx) => { other.skip(); stream.skip(3); });`;
    expect(countSkips(src)).toEqual({ tests: 1, suites: 0, skips: 0 });
  });
  it('non-registration chains (test.extend, regex.test) are not tests', () => {
    const src = `const myTest = test.extend({}); const ok = /a/.test('a'); re.test('x'); it('real', () => {});`;
    expect(countSkips(src)).toEqual({ tests: 1, suites: 0, skips: 0 });
  });
});

describe('evaluateSkipRatchet', () => {
  const path = 'tests/unit/thing.test.ts';

  it('no change → no flags', () => {
    const r = evaluateSkipRatchet([{ path, base: BASE, head: BASE }]);
    expect(r).toMatchObject({ netSkipsAdded: 0, netTestsRemoved: 0, netFilesRemoved: 0, skipsAdded: false, testsRemoved: false });
  });
  it('turning a test into a skip flags skipsAdded but not testsRemoved', () => {
    const r = evaluateSkipRatchet([{ path, base: BASE, head: BASE.replace("it('works'", "it.skip('works'") }]);
    expect(r).toMatchObject({ netSkipsAdded: 1, skipsAdded: true, testsRemoved: false });
  });
  it('removing a skip is fine', () => {
    const r = evaluateSkipRatchet([{ path, base: BASE.replace("it('works'", "it.skip('works'"), head: BASE }]);
    expect(r.skipsAdded).toBe(false);
  });
  it('a new file with a skipIf guard is a net skip addition', () => {
    const r = evaluateSkipRatchet([{ path: 'tests/e2e/tmux.test.ts', base: null, head: `describe.skipIf(!hasTmux)('t', () => { it('x', () => {}); });` }]);
    expect(r.skipsAdded).toBe(true);
    expect(r.testsRemoved).toBe(false);
  });
  it('deleting a test call flags testsRemoved', () => {
    const r = evaluateSkipRatchet([{ path, base: BASE, head: BASE.replace("  it('also works', async () => { expect(2).toBe(2); });\n", '') }]);
    expect(r).toMatchObject({ netTestsRemoved: 1, testsRemoved: true });
  });
  it('deleting a test file flags testsRemoved and names it', () => {
    const r = evaluateSkipRatchet([{ path, base: BASE, head: null }]);
    expect(r).toMatchObject({ netFilesRemoved: 1, testsRemoved: true, deletedFiles: [path] });
  });
  it('moving a test file into tests/fixtures/** is a loss', () => {
    const r = evaluateSkipRatchet([
      { path, base: BASE, head: null },
      { path: 'tests/fixtures/thing.test.ts', base: null, head: BASE },
    ]);
    expect(r.testsRemoved).toBe(true);
    expect(r.netFilesRemoved).toBe(1);
  });
  it('renaming a test file within the inventory is net zero', () => {
    const r = evaluateSkipRatchet([
      { path, base: BASE, head: null },
      { path: 'tests/unit/renamed.test.ts', base: null, head: BASE },
    ]);
    expect(r).toMatchObject({ netFilesRemoved: 0, netTestsRemoved: 0, testsRemoved: false });
  });
  it('moving tests between files is net zero; non-inventoried paths are ignored', () => {
    const r = evaluateSkipRatchet([
      { path, base: BASE, head: `it('works', () => {});` },
      { path: 'tests/unit/other.test.ts', base: `it('o', () => {});`, head: `it('o', () => {}); it('also works', () => {});` },
      { path: 'tests/contract/live.test.ts', base: `it('x', () => {});`, head: null },
    ]);
    expect(r.testsRemoved).toBe(false);
  });
});

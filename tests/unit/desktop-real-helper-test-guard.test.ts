import { describe, expect, it } from 'vitest';
import { realHelperBlockedUnderTest } from '../../src/core/MacDesktopHost.js';

const real = '/opt/instar/dist/native/instar-desktop-host';

describe('real desktop helper under a test runner', () => {
  it('blocks the real packaged helper in a test run without the opt-in', () => {
    expect(realHelperBlockedUnderTest(real, real, { VITEST: 'true' })).toBe(true);
  });
  it('lets a fake helper with another name run', () => {
    expect(realHelperBlockedUnderTest('/opt/instar/dist/native/instar-desktop-capture-test-1-0', real, { VITEST: 'true' })).toBe(false);
  });
  it('lets the real helper run when a Mac opts in', () => {
    expect(realHelperBlockedUnderTest(real, real, { VITEST: 'true', INSTAR_REAL_DESKTOP_HELPER_TESTS: '1' })).toBe(false);
  });
  it('never blocks outside a test runner', () => {
    expect(realHelperBlockedUnderTest(real, real, {})).toBe(false);
  });
});

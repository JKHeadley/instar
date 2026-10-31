import { describe, expect, it } from 'vitest';
import { dashboardUnlockRefused } from '../../src/core/desktopTransport.js';

describe('dashboardUnlockRefused — the rule the console checks before showing a PIN box', () => {
  it('never refuses when remote desktop is off, whatever the connection', () => {
    expect(dashboardUnlockRefused(false, false, '100.101.95.10')).toBe(false);
    expect(dashboardUnlockRefused(false, false, undefined)).toBe(false);
  });
  it('with remote desktop on, accepts a secure or a local connection', () => {
    expect(dashboardUnlockRefused(true, true, '100.101.95.10')).toBe(false);
    expect(dashboardUnlockRefused(true, false, '127.0.0.1')).toBe(false);
    expect(dashboardUnlockRefused(true, false, '::ffff:127.0.0.1')).toBe(false);
    expect(dashboardUnlockRefused(true, false, '::1')).toBe(false);
  });
  it('with remote desktop on, refuses a plain connection from another address', () => {
    expect(dashboardUnlockRefused(true, false, '100.101.95.10')).toBe(true);
    expect(dashboardUnlockRefused(true, false, '172.24.80.1')).toBe(true);
    expect(dashboardUnlockRefused(true, false, undefined)).toBe(true);
  });
});

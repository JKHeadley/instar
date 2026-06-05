/**
 * Unit tests for the update-notification policy (src/core/updateNotifyPolicy.ts).
 *
 * Pure-logic coverage of BOTH sides of every decision branch (Testing Integrity
 * Standard — semantic correctness on both sides of each boundary):
 *   - mechanics → silent by default
 *   - mechanics + heartbeat flag + confirmation → reaches user
 *   - mechanics + heartbeat flag but NOT the confirmation → still silent
 *   - mechanics + confirmation but flag OFF → silent
 *   - interruption / actionable / failure-escalated → always reach the user
 */

import { describe, it, expect } from 'vitest';
import {
  decideUpdateNotify,
  type UpdateNotifyKind,
} from '../../src/core/updateNotifyPolicy.js';

describe('decideUpdateNotify', () => {
  it('silences plain update mechanics by default (option A)', () => {
    const d = decideUpdateNotify('mechanics');
    expect(d.reachUser).toBe(false);
    expect(d.reason).toMatch(/housekeeping|logs only/i);
  });

  it('always surfaces an interruption (a restart hitting the user now)', () => {
    const d = decideUpdateNotify('interruption');
    expect(d.reachUser).toBe(true);
    expect(d.reason).toMatch(/interrupt/i);
  });

  it('always surfaces an actionable notice (user must apply a manual update)', () => {
    const d = decideUpdateNotify('actionable');
    expect(d.reachUser).toBe(true);
    expect(d.reason).toMatch(/action/i);
  });

  it('always surfaces a genuinely stuck (escalated) update failure', () => {
    const d = decideUpdateNotify('failure-escalated');
    expect(d.reachUser).toBe(true);
    expect(d.reason).toMatch(/stuck/i);
  });

  describe('option B — background-refresh heartbeat', () => {
    it('surfaces the background-refresh confirmation when the flag is ON', () => {
      const d = decideUpdateNotify('mechanics', {
        backgroundRefreshHeartbeat: true,
        isBackgroundRefreshConfirmation: true,
      });
      expect(d.reachUser).toBe(true);
      expect(d.reason).toMatch(/heartbeat/i);
    });

    it('stays silent for the confirmation when the flag is OFF (default A)', () => {
      const d = decideUpdateNotify('mechanics', {
        backgroundRefreshHeartbeat: false,
        isBackgroundRefreshConfirmation: true,
      });
      expect(d.reachUser).toBe(false);
    });

    it('stays silent for NON-confirmation mechanics even when the flag is ON', () => {
      // The flag must never re-introduce the version-churn flood — only the
      // single dedicated confirmation event can surface.
      const d = decideUpdateNotify('mechanics', {
        backgroundRefreshHeartbeat: true,
        isBackgroundRefreshConfirmation: false,
      });
      expect(d.reachUser).toBe(false);
    });
  });

  it('defaults an unknown kind to silent (fail-safe against accidental spam)', () => {
    const d = decideUpdateNotify('totally-new-kind' as unknown as UpdateNotifyKind);
    expect(d.reachUser).toBe(false);
  });
});

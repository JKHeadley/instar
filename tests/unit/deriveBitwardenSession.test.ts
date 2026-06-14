import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  deriveBitwardenSession,
  type BitwardenUnlockSurface,
} from '../../src/monitoring/SelfUnblockProbeProviders.js';

/**
 * Guards the production wiring of DurableVaultSession.deriveSession for the
 * org-Bitwarden probe (the MOTIVATING source: "the cred is in the vault but I
 * can't reach it"). The original AgentServer closure read `process.env.BW_SESSION`
 * after unlock — wrong, because BitwardenProvider.unlock() stores the session in a
 * PRIVATE field and never exports it to the env. The injected-fake provider tests
 * could not catch it; this helper extraction makes the wiring testable.
 */
describe('deriveBitwardenSession (org-Bitwarden session wiring)', () => {
  const origEnv = process.env.BW_SESSION;
  afterEach(() => {
    if (origEnv === undefined) delete process.env.BW_SESSION;
    else process.env.BW_SESSION = origEnv;
  });

  it('returns the session from getSessionKey() after a successful unlock', () => {
    const bw: BitwardenUnlockSurface = {
      unlock: vi.fn(() => true),
      getSessionKey: vi.fn(() => 'live-session-xyz'),
    };
    const out = deriveBitwardenSession({ getMasterPassword: () => 'master-pw', bw });
    expect(out).toBe('live-session-xyz');
    expect(bw.unlock).toHaveBeenCalledWith('master-pw');
  });

  it('uses getSessionKey(), NOT process.env.BW_SESSION (the bug this guards)', () => {
    process.env.BW_SESSION = 'STALE-ENV-SESSION-should-not-be-used';
    const bw: BitwardenUnlockSurface = {
      unlock: () => true,
      getSessionKey: () => 'fresh-from-unlock',
    };
    const out = deriveBitwardenSession({ getMasterPassword: () => 'master-pw', bw });
    expect(out).toBe('fresh-from-unlock');
    expect(out).not.toBe('STALE-ENV-SESSION-should-not-be-used');
  });

  it('returns null and does NOT unlock when no master password is available', () => {
    const unlock = vi.fn(() => true);
    const out = deriveBitwardenSession({
      getMasterPassword: () => null,
      bw: { unlock, getSessionKey: () => 'x' },
    });
    expect(out).toBeNull();
    expect(unlock).not.toHaveBeenCalled();
  });

  it('returns null when the master-password getter throws (locked/decrypt-failed vault)', () => {
    const out = deriveBitwardenSession({
      getMasterPassword: () => {
        throw new Error('vault locked');
      },
      bw: { unlock: () => true, getSessionKey: () => 'x' },
    });
    expect(out).toBeNull();
  });

  it('returns null when unlock fails', () => {
    const out = deriveBitwardenSession({
      getMasterPassword: () => 'master-pw',
      bw: { unlock: () => false, getSessionKey: () => 'should-not-be-read' },
    });
    expect(out).toBeNull();
  });

  it('returns null when getSessionKey yields an empty/absent session', () => {
    for (const empty of [null, '']) {
      const out = deriveBitwardenSession({
        getMasterPassword: () => 'master-pw',
        bw: { unlock: () => true, getSessionKey: () => empty as string | null },
      });
      expect(out).toBeNull();
    }
  });
});

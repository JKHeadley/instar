import { describe, expect, it } from 'vitest';
import { evaluateSubscriptionReloginAdmission } from '../../src/core/SubscriptionReloginPolicy.js';
import type { SubscriptionReloginAdmissionInput } from '../../src/core/SubscriptionReloginPolicy.js';

function valid(overrides: Partial<SubscriptionReloginAdmissionInput> = {}): SubscriptionReloginAdmissionInput {
  return {
    configuredMode: 'approval',
    poolAuthority: 'ready',
    account: {
      id: 'acct-1', machineId: 'machine-1', status: 'needs-reauth', framework: 'claude-code',
      provider: 'anthropic', identityHash: 'identity-sha256',
    },
    sourceEpisode: {
      id: 11, accountId: 'acct-1', machineId: 'machine-1', openedAt: '2026-08-28T00:00:00Z',
      closedAt: null, causeClass: 'exchange-failed', corroboration: 'exchange-corroborated',
      outcome: null, provenance: 'observed',
    },
    hasLiveRepair: false,
    hasLivePendingLogin: false,
    profile: {
      id: 'justin-google', ambiguous: false, dirExists: true, dedicated: true, identityHash: 'identity-sha256',
      loginMethod: 'session-cookie', danglingRefs: [],
    },
    breakerOpen: false,
    ...overrides,
  };
}

describe('evaluateSubscriptionReloginAdmission', () => {
  it('admits only a directly observed exchange-corroborated open incident', () => {
    const result = evaluateSubscriptionReloginAdmission(valid());
    expect(result).toMatchObject({ admitted: true, mode: 'approval', profileId: 'justin-google' });
    if (result.admitted) expect(result.inputDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    expect(evaluateSubscriptionReloginAdmission(valid({
      sourceEpisode: { ...valid().sourceEpisode, corroboration: 'status-preexisting' },
    }))).toEqual({ admitted: false, reason: 'source-not-exchange-corroborated' });
    expect(evaluateSubscriptionReloginAdmission(valid({
      sourceEpisode: { ...valid().sourceEpisode, provenance: 'inferred-from-level' },
    }))).toEqual({ admitted: false, reason: 'source-not-directly-observed' });
    expect(evaluateSubscriptionReloginAdmission(valid({
      sourceEpisode: { ...valid().sourceEpisode, closedAt: '2026-08-28T01:00:00Z' },
    }))).toEqual({ admitted: false, reason: 'source-episode-closed' });
  });

  it.each([
    ['credential-absent-or-unreadable'], ['credential-missing-oauth-block'],
    ['credential-token-shape-invalid'], ['unparseable-credential-blob'],
    ['refresh-read-failed'], ['write-failed'], ['unrecognized-reason'],
  ] as const)('refuses non-corroborated cause %s even if incorrectly presented as exchange evidence', (causeClass) => {
    expect(evaluateSubscriptionReloginAdmission(valid({
      sourceEpisode: { ...valid().sourceEpisode, causeClass },
    }))).toEqual({ admitted: false, reason: 'cause-not-actionable' });
  });

  it('fails closed on authority, cell, duplicate work, profile, vault, framework, and breaker boundaries', () => {
    const cases: Array<[Partial<SubscriptionReloginAdmissionInput>, string]> = [
      [{ poolAuthority: 'unavailable' }, 'pool-authority-not-ready'],
      [{ account: { ...valid().account, status: 'active' } }, 'account-not-needs-reauth'],
      [{ hasLiveRepair: true }, 'repair-already-live'],
      [{ hasLivePendingLogin: true }, 'pending-login-already-live'],
      [{ profile: null }, 'profile-unresolved'],
      [{ profile: { ...valid().profile!, ambiguous: true } }, 'profile-ambiguous'],
      [{ profile: { ...valid().profile!, dirExists: false } }, 'profile-directory-missing'],
      [{ profile: { ...valid().profile!, dedicated: false } }, 'profile-not-dedicated'],
      [{ profile: { ...valid().profile!, identityHash: 'wrong' } }, 'profile-identity-mismatch'],
      [{ profile: { ...valid().profile!, danglingRefs: ['missing'] } }, 'vault-reference-missing'],
      [{ profile: { ...valid().profile!, loginMethod: 'password+phone-2fa' } }, 'login-method-not-autonomous'],
      [{ account: { ...valid().account, framework: 'gemini-cli' } }, 'framework-not-supported'],
      [{ account: { ...valid().account, framework: 'codex-cli' } }, 'framework-not-supported'],
      [{ breakerOpen: true }, 'breaker-open'],
    ];
    for (const [override, reason] of cases) {
      expect(evaluateSubscriptionReloginAdmission(valid(override))).toEqual({ admitted: false, reason });
    }
  });

  it('never lets metrics turn unattended mode on without explicit opt-in and all evidence floors', () => {
    const near = evaluateSubscriptionReloginAdmission(valid({
      configuredMode: 'unattended',
      unattended: { explicitlyEnabled: false, successfulRepairs: 100, evidenceDays: 365, identityMismatches: 0, unexpectedOrigins: 0 },
    }));
    expect(near).toMatchObject({ admitted: true, mode: 'approval', unattendedHeld: true });
    const graduated = evaluateSubscriptionReloginAdmission(valid({
      configuredMode: 'unattended',
      unattended: { explicitlyEnabled: true, successfulRepairs: 10, evidenceDays: 30, identityMismatches: 0, unexpectedOrigins: 0 },
    }));
    expect(graduated).toMatchObject({ admitted: true, mode: 'unattended', unattendedHeld: false });
  });

  it('binds the approval digest to every action-authority coordinate', () => {
    const base = evaluateSubscriptionReloginAdmission(valid());
    const changed = evaluateSubscriptionReloginAdmission(valid({
      account: { ...valid().account, machineId: 'machine-2' },
      sourceEpisode: { ...valid().sourceEpisode, machineId: 'machine-2' },
    }));
    expect(base.admitted && changed.admitted && base.inputDigest).not.toBe(changed.admitted && changed.inputDigest);
  });
});

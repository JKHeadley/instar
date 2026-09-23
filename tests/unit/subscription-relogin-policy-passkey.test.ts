import { describe, expect, it } from 'vitest';
import { evaluateSubscriptionReloginAdmission } from '../../src/core/SubscriptionReloginPolicy.js';
import type { PasskeyCellAdmissionState, SubscriptionReloginAdmissionInput } from '../../src/core/SubscriptionReloginPolicy.js';

// Spec docs/specs/agent-held-google-passkey.md §3.4 — the `google-passkey` method in the pure
// admission policy: named refusals per cell state, `ready` admits, the input digest carries the
// method + entry key ONLY for the passkey path (legacy digests stay byte-stable).

function valid(overrides: Partial<SubscriptionReloginAdmissionInput> = {}): SubscriptionReloginAdmissionInput {
  return {
    configuredMode: 'approval',
    poolAuthority: 'ready',
    account: { id: 'acct-1', machineId: 'machine-1', status: 'needs-reauth', framework: 'claude-code', provider: 'anthropic', identityHash: 'identity-sha256' },
    sourceEpisode: { id: 11, accountId: 'acct-1', machineId: 'machine-1', openedAt: '2026-08-28T00:00:00Z', closedAt: null,
      causeClass: 'exchange-failed', corroboration: 'exchange-corroborated', outcome: null, provenance: 'observed' },
    hasLiveRepair: false,
    hasLivePendingLogin: false,
    profile: { id: 'justin-google', ambiguous: false, dirExists: true, dedicated: true, identityHash: 'identity-sha256', loginMethod: 'session-cookie', danglingRefs: [] },
    breakerOpen: false,
    ...overrides,
  };
}
const passkey = (cell: PasskeyCellAdmissionState | null | undefined, key: string | null = 'pk-entry-1') => valid({
  profile: { ...valid().profile!, loginMethod: 'google-passkey', passkeyEntryKey: key, passkeyCell: cell },
});

describe('evaluateSubscriptionReloginAdmission — google-passkey', () => {
  it('admits a google-passkey account ONLY when its cell is ready', () => {
    const result = evaluateSubscriptionReloginAdmission(passkey('ready'));
    expect(result).toMatchObject({ admitted: true, mode: 'approval', profileId: 'justin-google' });
  });

  it('refuses every non-ready cell state by NAME, and an uncomputed state as unknown', () => {
    const cases: Array<[PasskeyCellAdmissionState | null | undefined, string]> = [
      ['security', 'passkey-cell-security'],
      ['breaker-open', 'passkey-cell-breaker-open'],
      ['unverified-stopped', 'passkey-cell-unverified-stopped'],
      ['quarantined', 'passkey-cell-quarantined'],
      ['rejected', 'passkey-cell-rejected'],
      ['suspended', 'passkey-suspended'],
      ['chrome-unverified', 'passkey-chrome-unverified'],
      ['unknown', 'passkey-cell-state-unknown'],
      [null, 'passkey-cell-state-unknown'],
      [undefined, 'passkey-cell-state-unknown'],
    ];
    for (const [cell, reason] of cases) {
      expect(evaluateSubscriptionReloginAdmission(passkey(cell))).toEqual({ admitted: false, reason });
    }
  });

  it('refuses a passkey account with no entry key before looking at the cell', () => {
    expect(evaluateSubscriptionReloginAdmission(passkey('ready', null))).toEqual({ admitted: false, reason: 'passkey-binding-missing' });
    expect(evaluateSubscriptionReloginAdmission(passkey('ready', ''))).toEqual({ admitted: false, reason: 'passkey-binding-missing' });
  });

  it('cell state is ignored for a non-passkey method (it cannot block the password path)', () => {
    const result = evaluateSubscriptionReloginAdmission(valid({
      profile: { ...valid().profile!, loginMethod: 'password', passkeyEntryKey: 'stale', passkeyCell: 'security' },
    }));
    expect(result).toMatchObject({ admitted: true });
  });

  it('the input digest separates the passkey path from the password path and from another entry key, and leaves legacy digests unchanged', () => {
    const legacy = evaluateSubscriptionReloginAdmission(valid());
    const legacyWithNoise = evaluateSubscriptionReloginAdmission(valid({
      profile: { ...valid().profile!, passkeyEntryKey: null, passkeyCell: null },
    }));
    const pk1 = evaluateSubscriptionReloginAdmission(passkey('ready', 'pk-entry-1'));
    const pk2 = evaluateSubscriptionReloginAdmission(passkey('ready', 'pk-entry-2'));
    if (!legacy.admitted || !legacyWithNoise.admitted || !pk1.admitted || !pk2.admitted) throw new Error('expected admission');
    expect(legacyWithNoise.inputDigest).toBe(legacy.inputDigest);
    expect(pk1.inputDigest).not.toBe(legacy.inputDigest);
    expect(pk1.inputDigest).not.toBe(pk2.inputDigest);
    // Deterministic.
    const again = evaluateSubscriptionReloginAdmission(passkey('ready', 'pk-entry-1'));
    expect(again.admitted && again.inputDigest).toBe(pk1.inputDigest);
  });

  it('a passkey cell refusal comes AFTER the profile checks and BEFORE the breaker', () => {
    expect(evaluateSubscriptionReloginAdmission({ ...passkey('security'), breakerOpen: true }))
      .toEqual({ admitted: false, reason: 'passkey-cell-security' });
    expect(evaluateSubscriptionReloginAdmission(valid({
      profile: { ...passkey('security').profile!, danglingRefs: ['missing'] },
    }))).toEqual({ admitted: false, reason: 'vault-reference-missing' });
  });
});

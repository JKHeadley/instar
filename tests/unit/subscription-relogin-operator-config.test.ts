import { describe, expect, it } from 'vitest';
import { validateSubscriptionReloginOperatorInput } from '../../src/core/SubscriptionReloginOperatorConfig.js';

describe('subscription re-login operator config validation', () => {
  it('normalizes and deduplicates exact identities while allowing an explicit zero-evidence rollout', () => {
    const result = validateSubscriptionReloginOperatorInput({
      enabled: true,
      mode: 'unattended',
      dryRun: false,
      unattendedPolicy: {
        identities: [' Echo@SageMindAI.io ', 'echo@sagemindai.io'],
        minimumSuccessfulRepairs: 0,
        minimumEvidenceDays: 0,
      },
    });
    expect(result).toEqual({
      ok: true,
      value: {
        enabled: true,
        mode: 'unattended',
        dryRun: false,
        unattendedPolicy: {
          identities: ['echo@sagemindai.io'],
          minimumSuccessfulRepairs: 0,
          minimumEvidenceDays: 0,
        },
      },
    });
  });

  it('refuses live unattended authority without an exact identity', () => {
    expect(validateSubscriptionReloginOperatorInput({
      enabled: true,
      mode: 'unattended',
      dryRun: false,
      unattendedPolicy: { identities: [], minimumSuccessfulRepairs: 0, minimumEvidenceDays: 0 },
    })).toEqual({ ok: false, error: 'live unattended mode requires at least one exact identity' });
    expect(validateSubscriptionReloginOperatorInput({
      enabled: true,
      mode: 'unattended',
      dryRun: false,
      unattendedPolicy: { identities: ['not-an-email'], minimumSuccessfulRepairs: 0, minimumEvidenceDays: 0 },
    })).toEqual({ ok: false, error: 'every unattended identity must be an exact email address' });
  });
});

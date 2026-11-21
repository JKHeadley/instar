/**
 * SEC-162: switching a guard off through the API key alone was not a raise. `configPatchRaises`
 * looked only at `externalOperations` and `evolution`, so `{monitoring:{<guard>:{enabled:false}}}`,
 * `inputGuard.enabled:false` and `responseReview.enabled:false` were written with the token alone.
 * Switching a guard off now needs the same owner approval as any other loosening; switching one on
 * stays free.
 */
import { describe, it, expect } from 'vitest';
import { configPatchRaises } from '../../src/core/TrustRaiseGuard.js';
import { bearerConfigWriteRefusal } from '../../src/config/bearerConfigWrite.js';
import { BUILTIN_FEATURES as FEATURE_DEFINITIONS } from '../../src/core/FeatureDefinitions.js';
import { PATCHABLE_CONFIG_KEYS, OPERATOR_ONLY_SESSION_KEYS } from '../../src/server/routes.js';

const live = {
  monitoring: { watchdog: { enabled: true, intervalMs: 30000 }, sessionReaper: { enabled: true }, telemetry: { enabled: true } },
  inputGuard: { enabled: true },
  responseReview: { enabled: true },
};

describe('SEC-162: switching a guard off is a raise', () => {
  it('a monitoring guard switched off', () => {
    expect(configPatchRaises(live, { monitoring: { watchdog: { enabled: false, intervalMs: 30000 } } })).not.toEqual([]);
  });

  it("a guard's own block replaced without its switch (one-level merge), so it falls back to its off default", () => {
    // The session reaper's manifest default is off; a body naming only its dryRun replaces the block.
    expect(configPatchRaises(live, { monitoring: { sessionReaper: { dryRun: true } } })).not.toEqual([]);
  });

  it('the whole monitoring block replaced by a non-object', () => {
    expect(configPatchRaises(live, { monitoring: 'off' })).not.toEqual([]);
  });

  it('a guard left on by default (absent from the file) and now written off', () => {
    expect(configPatchRaises({ monitoring: {} }, { monitoring: { watchdog: { enabled: false } } })).not.toEqual([]);
  });

  it('the input guard and response review switched off', () => {
    expect(configPatchRaises(live, { inputGuard: { enabled: false } })).not.toEqual([]);
    expect(configPatchRaises({}, { inputGuard: { enabled: false } })).not.toEqual([]); // on unless false
    expect(configPatchRaises(live, { responseReview: { enabled: false } })).not.toEqual([]);
  });

  it('a guard weakened while left on: dry run, an input-guard check off, a weaker action, observe-only review', () => {
    expect(configPatchRaises(live, { monitoring: { sessionReaper: { enabled: true, dryRun: true } } })).not.toEqual([]);
    expect(configPatchRaises(live, { inputGuard: { enabled: true, injectionPatterns: false } })).not.toEqual([]);
    expect(configPatchRaises(live, { inputGuard: { enabled: true, action: 'log' } })).not.toEqual([]);
    expect(configPatchRaises(live, { inputGuard: { enabled: true, action: 'none' } })).not.toEqual([]); // unknown = weakest
    expect(configPatchRaises(live, { responseReview: { enabled: true, observeOnly: true } })).not.toEqual([]);
    // and the reverse is free
    expect(configPatchRaises({ inputGuard: { enabled: true, action: 'log' } }, { inputGuard: { enabled: true, action: 'block' } })).toEqual([]);
    expect(configPatchRaises({ monitoring: { sessionReaper: { enabled: true, dryRun: true } } }, { monitoring: { sessionReaper: { enabled: true, dryRun: false } } })).toEqual([]);
  });

  it('the permission-prompt floor disarmed', () => {
    expect(configPatchRaises(live, { monitoring: { permissionPromptAutoResolver: { emergencyDisable: true } } })).not.toEqual([]);
  });

  it('the bearer single-path writer (commitment auto-correction) refuses the same', () => {
    const opts = { fileConfig: live, patchableKeys: PATCHABLE_CONFIG_KEYS, operatorOnlySessionKeys: OPERATOR_ONLY_SESSION_KEYS };
    expect(bearerConfigWriteRefusal('monitoring.watchdog.enabled', false, opts)).toMatch(/raise trust or autonomy/);
    expect(bearerConfigWriteRefusal('inputGuard.enabled', false, opts)).toMatch(/raise trust or autonomy/);
    expect(bearerConfigWriteRefusal('monitoring.watchdog.intervalMs', 60000, opts)).toBeNull();
  });
});

describe('SEC-162: what stays free', () => {
  it('switching a guard on, and tuning a guard that stays on', () => {
    expect(configPatchRaises({ monitoring: { watchdog: { enabled: false } } }, { monitoring: { watchdog: { enabled: true } } })).toEqual([]);
    expect(configPatchRaises(live, { monitoring: { watchdog: { enabled: true, intervalMs: 60000 } } })).toEqual([]);
    expect(configPatchRaises({}, { inputGuard: { enabled: true } })).toEqual([]);
    expect(configPatchRaises({}, { responseReview: { enabled: true } })).toEqual([]);
  });

  it('a guard already off stays off', () => {
    expect(configPatchRaises({ monitoring: { watchdog: { enabled: false } } }, { monitoring: { watchdog: { enabled: false, intervalMs: 1 } } })).toEqual([]);
    expect(configPatchRaises({ responseReview: { enabled: false } }, { responseReview: { enabled: false } })).toEqual([]);
    expect(configPatchRaises({}, { responseReview: { enabled: false } })).toEqual([]); // off unless true
  });

  it('settings that are not guards', () => {
    expect(configPatchRaises(live, { updates: { autoApply: false } })).toEqual([]);
    expect(configPatchRaises(live, { sessions: { maxSessions: 2 } })).toEqual([]);
  });
});

describe('SEC-162: which everyday feature toggles are affected', () => {
  // Every shipped feature switch, replayed against a config where the feature is on (enable) or off
  // (disable). This is the exact list the Chief of Staff asked for: a toggle that now needs approval.
  const needsApproval: string[] = [];
  for (const f of FEATURE_DEFINITIONS) {
    for (const [dir, action] of [['enable', f.enableAction], ['disable', f.disableAction]] as const) {
      if (!action || action.method !== 'PATCH' || action.path !== '/config') continue;
      if (configPatchRaises(live, action.body as Record<string, unknown>).length > 0) needsApproval.push(`${f.id}:${dir}`);
    }
  }

  // (autonomous-evolution:enable is judged against the autonomy profile, which this check has none
  // of, so it does not show here; it is unchanged by SEC-162.)
  it('only disabling a protection asks; every enable and every other disable is unchanged', () => {
    expect(needsApproval.sort()).toEqual([
      'external-operation-gate:disable', // unchanged: already a raise before SEC-162
      'input-guard:disable',
      'response-review:disable',
    ].sort());
  });
});

describe('SEC-162: every switch path gets the same card', () => {
  it('no path lifts the loosening check: the owner phone, the dashboard and the key all go through configPatchRaises', () => {
    // docs/specs/trust-journey.md decision 4, Phones: a phone presence signature is evidence, never
    // authority for a raise; a dashboard PIN constructs nothing. So no switch path may skip the check.
    const src = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../../src/server/routes.ts'), 'utf-8') as string;
    expect(src).toContain('const configRaises = configPatchRaises(fileConfig, patch as Record<string, unknown>');
    expect(src).not.toMatch(/X-Instar-Owner-Switch|ownerSwitchGrant/);
  });
});

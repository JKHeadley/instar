import { describe, expect, it } from 'vitest';
import { applyDefaults, getInitDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';

import { ownerNeedsAdmissionEnabled } from '../../src/server/ownerNeedsSources.js';

const installDefaults = (config: Record<string, unknown>) =>
  applyDefaults(config, getMigrationDefaults('managed-project'));

describe('Needs You owner admission migration', () => {
  it.each(['managed-project', 'standalone'] as const)('enables admission in new %s configurations', type => {
    expect(getInitDefaults(type)).toMatchObject({ needsYou: { ownerAdmission: { enabled: true } } });
  });
  it('installs the fleet default once without removing other settings', () => {
    const config = { needsYou: { otherSetting: true } };
    expect(installDefaults(config).patched).toBe(true);
    expect(config.needsYou).toEqual({ otherSetting: true, ownerAdmission: { enabled: true } });
    expect(installDefaults(config).patched).toBe(false);
  });

  it('creates the setting for an agent with no Needs You configuration', () => {
    const config = {};
    expect(installDefaults(config).patched).toBe(true);
    expect(config).toMatchObject({ needsYou: { ownerAdmission: { enabled: true } } });
  });

  it.each([true, false])('preserves the existing enabled setting %s', enabled => {
    const config = { needsYou: { ownerAdmission: { enabled } } };
    installDefaults(config);
    expect(config.needsYou.ownerAdmission.enabled).toBe(enabled);
  });

  it.each([{ needsYou: [] }, { needsYou: null }, { needsYou: { ownerAdmission: 'invalid' } }])('leaves malformed configuration available for diagnosis', config => {
    const original = structuredClone(config);
    installDefaults(config);
    expect(config.needsYou).toEqual(original.needsYou);
  });

  it.each([undefined, {}, { ownerAdmission: {} }, { ownerAdmission: { enabled: true } }])('defaults startup to on for %j', settings => {
    expect(ownerNeedsAdmissionEnabled(settings)).toBe(true);
  });

  it.each([null, [], { ownerAdmission: null }, { ownerAdmission: { enabled: false } }, { ownerAdmission: { enabled: 'true' } }])('keeps startup inactive for %j', settings => {
    expect(ownerNeedsAdmissionEnabled(settings)).toBe(false);
  });
});

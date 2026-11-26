import { describe, expect, it } from 'vitest';
import { takeFirstBackupCode } from '../../src/core/SubscriptionReloginRuntime.js';

function vault(initial: Record<string, unknown>) {
  const data = { ...initial };
  return { data, get: (k: string) => data[k], set: (k: string, v: unknown) => { data[k] = v; } };
}

describe('takeFirstBackupCode — single-use Google backup codes', () => {
  it('returns the first code and removes it from the vault before anyone types it', () => {
    const v = vault({ codes: '1111 2222 33334444 5555 6666' });
    expect(takeFirstBackupCode(v, 'codes')).toBe('11112222');
    expect(v.data.codes).toBe('33334444 55556666');
    expect(takeFirstBackupCode(v, 'codes')).toBe('33334444');
    expect(takeFirstBackupCode(v, 'codes')).toBe('55556666');
    expect(v.data.codes).toBe('');
  });
  it('an empty, missing, or non-string entry yields no code and changes nothing', () => {
    const v = vault({ empty: '', other: 42 });
    expect(takeFirstBackupCode(v, 'empty')).toBeNull();
    expect(takeFirstBackupCode(v, 'missing')).toBeNull();
    expect(takeFirstBackupCode(v, 'other')).toBeNull();
    expect(v.data.other).toBe(42);
  });
});

import { resolveAllowedScopes } from '../../src/core/SubscriptionReloginRuntime.js';

describe('resolveAllowedScopes — what a repair may approve', () => {
  const link = 'https://claude.com/cai/oauth/authorize?code=true&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&state=x';
  it('an operator-configured list wins', () => {
    expect(resolveAllowedScopes(['user:profile'], link)).toEqual(['user:profile']);
  });
  it('without a list, allows exactly the scopes our own CLI put in its sign-in link', () => {
    expect(resolveAllowedScopes(undefined, link)).toEqual(['org:create_api_key', 'user:profile', 'user:inference']);
    expect(resolveAllowedScopes([], link)).toEqual(['org:create_api_key', 'user:profile', 'user:inference']);
  });
  it('keeps dotted scope names (Codex style) and drops wildcards or junk', () => {
    expect(resolveAllowedScopes(undefined, 'https://auth.openai.com/oauth/authorize?scope=openid+api.connectors.read+*+%3Cx%3E'))
      .toEqual(['openid', 'api.connectors.read']);
  });
  it('a link without scopes, or an unparseable link, allows nothing', () => {
    expect(resolveAllowedScopes(undefined, 'https://auth.openai.com/codex/device')).toEqual([]);
    expect(resolveAllowedScopes(undefined, 'not a url')).toEqual([]);
  });
});

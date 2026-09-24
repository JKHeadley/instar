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

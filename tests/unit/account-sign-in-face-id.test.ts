/**
 * The signed action for starting an account sign-in from the owner's phone with Face ID
 * (docs/specs/account-sign-in-face-id.md): its target is `<accountId>@<machineId>`, each part checked
 * strictly, and the signed line names both, so one Face ID proof covers exactly one account on one machine.
 */
import { describe, it, expect } from 'vitest';
import { accountSignInTarget, buildAction, actionLine, ACCOUNT_ID_PATTERN, SIGN_IN_MACHINE_PATTERN } from '../../src/server/mobilePermissionsRoutes.js';

const M = 'm_03b30f5b32c6ef3eb0afd3ca7054e252';

describe('account-sign-in action', () => {
  it('builds the target and the exact signed line', () => {
    expect(accountSignInTarget('gearfinity3d', M)).toBe(`gearfinity3d@${M}`);
    const built = buildAction('account-sign-in', `gearfinity3d@${M}`, {});
    expect(built).toEqual({ ok: true, action: { kind: 'account-sign-in', target: `gearfinity3d@${M}`, accountId: 'gearfinity3d', machineId: M } });
    if (!built.ok) throw new Error('unreachable');
    expect(actionLine(built.action)).toBe(`account-sign-in gearfinity3d@${M}`);
  });

  it('accepts the pool\'s account id shape and a no-mesh machine name', () => {
    expect(accountSignInTarget('codex-dawn-sagemind', 'local')).toBe('codex-dawn-sagemind@local');
    expect(buildAction('account-sign-in', 'sagemind-justin@local', {}).ok).toBe(true);
  });

  it('refuses every malformed part', () => {
    const bad: Array<[unknown, unknown]> = [
      ['Gearfinity3D', M], ['gear finity', M], ['', M], ['a'.repeat(65), M], ['gear@x', M], ['gear.x', M],
      ['gearfinity3d', ''], ['gearfinity3d', 'm 1'], ['gearfinity3d', 'm@1'], ['gearfinity3d', 'm.1'], ['gearfinity3d', 'x'.repeat(65)],
      [7, M], ['gearfinity3d', null], [undefined, undefined], ['gearfinity3d\n', M],
    ];
    for (const [a, m] of bad) expect(accountSignInTarget(a, m), `${String(a)} ${String(m)}`).toBeNull();
    for (const t of ['gearfinity3d', `gearfinity3d@${M}@x`, `@${M}`, 'gearfinity3d@', `Gear@${M}`, `gearfinity3d@${M} extra`, 42, null]) {
      expect(buildAction('account-sign-in', t, {}), String(t)).toEqual({ ok: false, error: 'bad-target' });
    }
  });

  it('the patterns admit nothing that could split a signed line', () => {
    for (const ch of [' ', '\n', '\t', '@']) {
      expect(ACCOUNT_ID_PATTERN.test(`a${ch}b`)).toBe(false);
      expect(SIGN_IN_MACHINE_PATTERN.test(`a${ch}b`)).toBe(false);
    }
  });

  it('other actions keep their own target rule (the @ is allowed only for account-sign-in)', () => {
    expect(buildAction('cancel-secret', `gearfinity3d@${M}`, {})).toEqual({ ok: false, error: 'bad-target' });
    expect(buildAction('team-off', `gearfinity3d@${M}`, {})).toEqual({ ok: false, error: 'bad-target' });
  });
});

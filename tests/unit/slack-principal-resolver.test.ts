import { describe, it, expect } from 'vitest';
import {
  SlackPrincipalResolver,
  deriveRole,
  type UserLookup,
  type ResolvedUserRecord,
} from '../../src/permissions/SlackPrincipalResolver.js';

function lookup(records: Record<string, ResolvedUserRecord>): UserLookup {
  return {
    resolveFromSlackUserId: (id: string) => records[id] ?? null,
  };
}

describe('deriveRole', () => {
  it('honors an explicit valid orgRole', () => {
    expect(deriveRole([], 'operator')).toBe('operator');
    expect(deriveRole(['member'], 'owner')).toBe('owner');
  });

  it('ignores an invalid orgRole and falls back to permissions', () => {
    expect(deriveRole(['admin'], 'superuser')).toBe('admin');
  });

  it('derives the highest role named in permissions', () => {
    expect(deriveRole(['member', 'owner'])).toBe('owner');
    expect(deriveRole(['contributor'])).toBe('contributor');
    expect(deriveRole(['admin'])).toBe('admin');
  });

  it('defaults a registered user with no role markers to member', () => {
    expect(deriveRole([])).toBe('member');
    expect(deriveRole(['some-custom-permission'])).toBe('member');
  });
});

describe('SlackPrincipalResolver', () => {
  it('resolves a registered user to a verified principal with derived role', () => {
    const r = new SlackPrincipalResolver(
      lookup({ U_OLIVIA: { id: 'u-olivia', name: 'Olivia', permissions: ['owner'] } }),
    );
    const principal = r.resolve('U_OLIVIA', 'olivia.display');
    expect(principal.registered).toBe(true);
    expect(principal.userId).toBe('u-olivia');
    expect(principal.role).toBe('owner');
    expect(principal.slackUserId).toBe('U_OLIVIA');
    expect(principal.name).toBe('Olivia'); // profile name wins over display name
  });

  it('resolves an unknown id to an unregistered guest (Know Your Principal — content name is not identity)', () => {
    const r = new SlackPrincipalResolver(lookup({}));
    const principal = r.resolve('U_STRANGER', 'Totally The CEO');
    expect(principal.registered).toBe(false);
    expect(principal.role).toBe('guest');
    expect(principal.userId).toBeNull();
    // display name is carried for messaging only — it confers no authority
    expect(principal.name).toBe('Totally The CEO');
  });

  it('honors an explicit orgRole on the profile', () => {
    const r = new SlackPrincipalResolver(
      lookup({ U_AMIR: { id: 'u-amir', name: 'Amir', permissions: [], orgRole: 'admin' } }),
    );
    expect(r.resolve('U_AMIR').role).toBe('admin');
  });
});

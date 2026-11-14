import { describe, it, expect } from 'vitest';
import {
  resolveMemoryAudience, countReachablePeople, resolveMemoryOwner,
  memoryScopeFolderName, memoryScopeDir, memoryScopeEnvValue, isScopedAudience, MANY_PEOPLE,
} from '../../src/users/MemoryAudience.js';

const dm = (personId: string | null) => ({ kind: 'private' as const, placeKey: 'slack:D1', personId });
const channel = { kind: 'shared' as const, placeKey: 'slack:C1' };

describe('resolveMemoryAudience', () => {
  it('is open on a one-person agent in private and with no person', () => {
    for (const place of [dm('a'), dm(null), { kind: 'system' as const }, { kind: 'unknown' as const }]) {
      expect(resolveMemoryAudience({ multiPerson: false, ownerUserId: 'a', place })).toEqual({ kind: 'open' });
    }
  });
  it('scopes a place with other readers even on a one-person agent', () => {
    expect(resolveMemoryAudience({ multiPerson: false, ownerUserId: 'a', place: channel })).toEqual({ kind: 'place', placeKey: 'slack:C1' });
  });
  it('treats a place as private only with proof of a sole reader', () => {
    const sole = { ...channel, soleReaderId: 'a' };
    expect(resolveMemoryAudience({ multiPerson: false, ownerUserId: 'a', place: sole })).toEqual({ kind: 'open' });
    expect(resolveMemoryAudience({ multiPerson: true, ownerUserId: 'a', place: sole })).toEqual({ kind: 'owner', userId: 'a' });
    expect(resolveMemoryAudience({ multiPerson: true, ownerUserId: 'a', place: { ...channel, soleReaderId: null } })).toEqual({ kind: 'place', placeKey: 'slack:C1' });
  });
  it('gives the owner the owner audience only in a private place', () => {
    expect(resolveMemoryAudience({ multiPerson: true, ownerUserId: 'a', place: dm('a') })).toEqual({ kind: 'owner', userId: 'a' });
    expect(resolveMemoryAudience({ multiPerson: true, ownerUserId: 'a', place: channel })).toEqual({ kind: 'place', placeKey: 'slack:C1' });
  });
  it('gives another person their own audience, and never owner when there is no owner', () => {
    expect(resolveMemoryAudience({ multiPerson: true, ownerUserId: 'a', place: dm('b') })).toEqual({ kind: 'person', userId: 'b' });
    expect(resolveMemoryAudience({ multiPerson: true, ownerUserId: null, place: dm('a') })).toEqual({ kind: 'person', userId: 'a' });
  });
  it('keeps an unregistered sender to that private place', () => {
    expect(resolveMemoryAudience({ multiPerson: true, ownerUserId: 'a', place: dm(null) })).toEqual({ kind: 'place', placeKey: 'slack:D1' });
  });
  it('gives jobs owner reach as system', () => {
    expect(resolveMemoryAudience({ multiPerson: true, ownerUserId: 'a', place: { kind: 'system' } })).toEqual({ kind: 'system' });
  });
  it('fails closed to none', () => {
    expect(resolveMemoryAudience({ multiPerson: true, ownerUserId: 'a', place: { kind: 'unknown' } })).toEqual({ kind: 'none' });
    expect(resolveMemoryAudience({ multiPerson: true, ownerUserId: 'a', place: { kind: 'shared', placeKey: '' } })).toEqual({ kind: 'none' });
    expect(resolveMemoryAudience({ multiPerson: false, ownerUserId: 'a', place: { kind: 'private', placeKey: '', personId: 'a' } })).toEqual({ kind: 'none' });
  });
});

describe('countReachablePeople', () => {
  const justin = { id: 'j', channels: [], telegramUserId: 1, slackUserId: 'U1' };
  it('counts one person reachable on two channels once', () => {
    expect(countReachablePeople({ users: [justin], slackAuthorizedIds: ['U1'], telegramAuthorizedIds: [1] })).toBe(1);
    expect(countReachablePeople({ users: [justin], telegramAuthorizedIds: ['1'] })).toBe(1);
  });
  it('ignores the bot', () => {
    expect(countReachablePeople({ users: [], slackAuthorizedIds: ['U1', 'UBOT'], slackBotUserId: 'UBOT' })).toBe(1);
  });
  it('counts an allowlist of anyone as many', () => {
    expect(countReachablePeople({ users: [], whatsappAuthorizedNumbers: ['*'] })).toBe(MANY_PEOPLE);
  });
  it('counts WhatsApp and iMessage people', () => {
    expect(countReachablePeople({ users: [], whatsappAuthorizedNumbers: ['+1'], imessageAuthorizedContacts: ['+2'] })).toBe(2);
    const w = { id: 'w', channels: [{ type: 'whatsapp', identifier: '+1' }] };
    expect(countReachablePeople({ users: [w], whatsappAuthorizedNumbers: ['+1'] })).toBe(1);
  });
  it('counts unlinked ids on two platforms as two', () => {
    expect(countReachablePeople({ users: [], slackAuthorizedIds: ['U1'], telegramAuthorizedIds: [1] })).toBe(2);
  });
  it('counts unregistered people as people', () => {
    expect(countReachablePeople({ users: [], slackAuthorizedIds: ['U1', 'U2'] })).toBe(2);
    expect(countReachablePeople({ users: [justin], telegramAuthorizedIds: [1, 2] })).toBe(2);
  });
  it('counts a second person on an app phone and an observed sender', () => {
    expect(countReachablePeople({ users: [justin], mspDeviceUserIds: ['m'] })).toBe(2);
    expect(countReachablePeople({ users: [justin], observedSenderKeys: ['slack:U9'] })).toBe(2);
  });
  describe('people named as sharing memory freely', () => {
    const adri = { id: 'a', channels: [], telegramUserId: 2 };
    const named = ['j', 'a'];
    it('count as one person', () => {
      expect(countReachablePeople({ users: [justin, adri], telegramAuthorizedIds: [1, 2], sharedMemoryPeople: named })).toBe(1);
    });
    it('stop applying when a third registered person can reach the agent', () => {
      const third = { id: 't', channels: [], telegramUserId: 3 };
      expect(countReachablePeople({ users: [justin, adri, third], sharedMemoryPeople: named })).toBe(2);
    });
    it('stop applying when an unregistered person is authorized or seen', () => {
      expect(countReachablePeople({ users: [justin, adri], telegramAuthorizedIds: [1, 2, 9], sharedMemoryPeople: named })).toBe(2);
      expect(countReachablePeople({ users: [justin, adri], observedSenderKeys: ['slack:U9'], sharedMemoryPeople: named })).toBe(2);
    });
    it('do nothing for someone who is not named', () => {
      expect(countReachablePeople({ users: [justin, adri], sharedMemoryPeople: ['j'] })).toBe(2);
    });
  });
  it('does not count a profile nobody can reach', () => {
    expect(countReachablePeople({ users: [{ id: 'x', channels: [] }] })).toBe(0);
  });
});

describe('resolveMemoryOwner', () => {
  const users = [
    { id: 'a', permissions: ['admin'], telegramUserId: 1 },
    { id: 'b', permissions: ['member'], telegramUserId: 2 },
  ];
  it('prefers the configured owner, and refuses one who does not exist', () => {
    expect(resolveMemoryOwner({ configuredOwnerUserId: 'b', users })).toBe('b');
    expect(resolveMemoryOwner({ configuredOwnerUserId: 'z', users })).toBeNull();
  });
  it('uses the Telegram owner, then a single admin', () => {
    expect(resolveMemoryOwner({ telegramOwnerId: 2, users })).toBe('b');
    expect(resolveMemoryOwner({ users })).toBe('a');
  });
  it('prefers the one owner role over several admins, as an organization has', () => {
    const org = [{ id: 'o', permissions: [], orgRole: 'owner' }, { id: 'x', permissions: ['admin'] }, { id: 'y', permissions: ['admin'] }];
    expect(resolveMemoryOwner({ users: org })).toBe('o');
  });
  it('is null with no admin or several', () => {
    expect(resolveMemoryOwner({ users: [users[1]] })).toBeNull();
    expect(resolveMemoryOwner({ users: [users[0], { ...users[1], permissions: ['admin'] }] })).toBeNull();
  });
});

describe('scope folders', () => {
  it('never uses an id as a path', () => {
    expect(memoryScopeFolderName({ kind: 'person', userId: '../../etc' })).toMatch(/^person-[0-9a-f]{16}$/);
    expect(memoryScopeDir('/r', '../x', { kind: 'person', userId: 'a' })).not.toContain('/../');
  });
  it('separates people and places', () => {
    expect(memoryScopeFolderName({ kind: 'person', userId: 'a' })).not.toBe(memoryScopeFolderName({ kind: 'person', userId: 'b' }));
    expect(memoryScopeFolderName({ kind: 'person', userId: 'a' })).not.toBe(memoryScopeFolderName({ kind: 'place', placeKey: 'a' }));
  });
  it('sits outside the agent home, separately for each agent', () => {
    const dir = memoryScopeDir('/u/.instar', 'luna', { kind: 'person', userId: 'a' })!;
    expect(dir.startsWith('/u/.instar/memory-scopes/luna/person-')).toBe(true);
    expect(dir).not.toBe(memoryScopeDir('/u/.instar', 'echo', { kind: 'person', userId: 'a' }));
  });
  it('leaves open, owner and system on the existing folder', () => {
    for (const a of [{ kind: 'open' }, { kind: 'owner', userId: 'a' }, { kind: 'system' }] as const) {
      expect(memoryScopeDir('/r', 'x', a)).toBeNull();
      expect(isScopedAudience(a)).toBe(false);
    }
  });
  it('marks person, place and none as inside the boundary', () => {
    for (const a of [{ kind: 'person', userId: 'a' }, { kind: 'place', placeKey: 'p' }, { kind: 'none' }] as const) {
      expect(isScopedAudience(a)).toBe(true);
    }
  });
  it('sets no environment for open', () => {
    expect(memoryScopeEnvValue({ kind: 'open' })).toBeNull();
    expect(memoryScopeEnvValue({ kind: 'owner', userId: 'a' })).toBe('owner');
    expect(memoryScopeEnvValue({ kind: 'none' })).toBe('none');
  });
});

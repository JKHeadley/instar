/**
 * Which conversations never run with owner reach. Spec: docs/specs/team-roles-and-access.md §3.5, §4.1.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { resolveMemoryAudience } from '../../src/users/MemoryAudience.js';
import { MemoryPrivacy } from '../../src/users/MemoryPrivacy.js';
import { conversationRefOf, placeForEntry, TeamConfinement, topicPlaceKey } from '../../src/users/TeamConfinement.js';
import { memorySessionAllows } from '../../src/server/memorySessionGuard.js';

const uuid = '11111111-1111-4111-8111-111111111111';

describe('TeamConfinement', () => {
  let dir: string;
  const write = (entries: unknown) => {
    fs.mkdirSync(path.join(dir, 'state', 'team-access'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'team-access', 'confined.json'), JSON.stringify({ entries }));
  };
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'confine-')); });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/team-confinement.test.ts' }));

  it('a never-team agent has an empty list and refuses nothing', () => {
    const c = new TeamConfinement(dir);
    expect(c.entries()?.size).toBe(0);
    expect(c.refuseSpawn({ telegramTopicId: 7 }, false)).toBe(false);
    expect(c.place({ telegramTopicId: 7 })).toBeNull();
  });

  it('a corrupt access file on a never-team agent restricts nothing it has no sign of', () => {
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'mobile-devices.json'), '{"devices":[{"role":"msp"}]}');
    expect(new TeamConfinement(dir).refuseSpawn({ telegramTopicId: 7 }, true)).toBe(false);
  });

  it.each([
    ['a log file', () => { fs.mkdirSync(path.join(dir, 'state', 'team-access'), { recursive: true }); fs.writeFileSync(path.join(dir, 'state', 'team-access', 'log.jsonl'), ''); }],
    ['a team phone', () => { fs.mkdirSync(path.join(dir, 'state'), { recursive: true }); fs.writeFileSync(path.join(dir, 'state', 'mobile-devices.json'), '{"devices":[{"role":"team"}]}'); }],
  ])('a missing list with %s refuses every conversation, and no job', (_name, setup) => {
    setup();
    const c = new TeamConfinement(dir);
    expect(c.entries()).toBeNull();
    expect(c.refuseSpawn({ telegramTopicId: 7 }, true)).toBe(true);
    expect(c.refuseSpawn({ memoryPlace: { kind: 'system' } }, true)).toBe(false);
  });

  it('an unreadable list refuses conversations', () => {
    write([]);
    fs.writeFileSync(path.join(dir, 'state', 'team-access', 'confined.json'), '{bad');
    expect(new TeamConfinement(dir).refuseSpawn({ telegramTopicId: 7 }, true)).toBe(true);
  });

  it('resolves a confined topic to its own shared place, and leaves others alone', () => {
    write([{ ref: 'telegram:7' }]);
    const c = new TeamConfinement(dir);
    expect(c.place({ telegramTopicId: 7 })).toEqual({ kind: 'shared', placeKey: 'telegram:topic:7' });
    expect(c.place({ telegramTopicId: 8 })).toBeNull();
    expect(c.isConfined('telegram:7')).toBe(true);
  });

  it('refuses a confined conversation with privacy off, and allows it with privacy on', () => {
    write([{ ref: 'telegram:7' }]);
    const c = new TeamConfinement(dir);
    expect(c.refuseSpawn({ telegramTopicId: 7 }, false)).toBe(true);
    expect(c.refuseSpawn({ telegramTopicId: 7 }, true)).toBe(false);
    expect(c.refuseSpawn({ telegramTopicId: 8 }, false)).toBe(false);
  });

  it('a person-owned conversation keeps that person, whoever sends', () => {
    expect(placeForEntry({ ref: uuid, personKey: 'sam' })).toEqual({ kind: 'private', placeKey: `app:${uuid}`, personId: 'sam', alwaysPerson: true });
  });

  it('names the conversation of a place input', () => {
    expect(conversationRefOf({ telegramTopicId: 7 })).toBe('telegram:7');
    expect(conversationRefOf({ memoryPlaceKey: `app:${uuid}` })).toBe(uuid);
    expect(conversationRefOf({ memoryPlace: { kind: 'system' }, telegramTopicId: 7 })).toBeNull();
    expect(conversationRefOf({ memoryPlaceKey: 'slack:C1' })).toBeNull();
    expect(topicPlaceKey('telegram:7')).toBe('telegram:topic:7');
  });
});

describe('audience', () => {
  it('a team person is `person` even on an agent that reads as one person', () => {
    expect(resolveMemoryAudience({ multiPerson: false, ownerUserId: 'o', place: { kind: 'private', placeKey: 'app:x', personId: 'sam', alwaysPerson: true } }))
      .toEqual({ kind: 'person', userId: 'sam' });
    expect(resolveMemoryAudience({ multiPerson: false, ownerUserId: 'o', place: { kind: 'private', placeKey: 'app:x', personId: 'sam' } })).toEqual({ kind: 'open' });
  });

  it('a shared topic with no sole reader is a place, even on a one-person agent', () => {
    expect(resolveMemoryAudience({ multiPerson: false, ownerUserId: 'o', place: { kind: 'shared', placeKey: 'telegram:topic:7' } }))
      .toEqual({ kind: 'place', placeKey: 'telegram:topic:7' });
  });

  it('placeFor takes the confined place first, and otherwise the ordinary key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'place-'));
    fs.mkdirSync(path.join(dir, 'state', 'team-access'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'team-access', 'confined.json'), JSON.stringify({ entries: [{ ref: 'telegram:7' }] }));
    const privacy = new MemoryPrivacy({ stateDir: dir, instarRoot: dir, agentId: 'a', config: () => ({ enabled: true }), users: () => [], reachable: () => ({}) });
    privacy.confinement = new TeamConfinement(dir);
    expect(privacy.placeFor({ telegramTopicId: 7, memoryPlaceKey: 'telegram:-100' }, null)).toEqual({ kind: 'shared', placeKey: 'telegram:topic:7' });
    expect(privacy.placeFor({ telegramTopicId: 8, memoryPlaceKey: 'telegram:-100' }, null)).toMatchObject({ kind: 'shared', placeKey: 'telegram:-100' });
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/team-confinement.test.ts' });
  });
});

describe('reply guard', () => {
  const session = (placeKey: string) => ({ sessionId: 's', audience: { kind: 'place' as const, placeKey }, placeKey });

  it('a group session may reply into any topic of the group, as today', () => {
    expect(memorySessionAllows('POST', '/telegram/reply/7', session('telegram:-100'))).toBe(true);
    expect(memorySessionAllows('POST', '/telegram/reply/8', session('telegram:-100'))).toBe(true);
  });

  it('a shared topic session is held to its own topic', () => {
    expect(memorySessionAllows('POST', '/telegram/reply/7', session('telegram:topic:7'))).toBe(true);
    expect(memorySessionAllows('POST', '/telegram/reply/8', session('telegram:topic:7'))).toBe(false);
  });
});

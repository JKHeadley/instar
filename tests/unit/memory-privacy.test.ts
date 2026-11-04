import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryPrivacy, OPERATOR_PERSON_ID, READER_PROOF_MS, type MemoryPrivacyConfig, type ReachableLists } from '../../src/users/MemoryPrivacy.js';
import type { UserProfile } from '../../src/core/types.js';
import { whatsappPersonKey } from '../../src/users/MemoryAudience.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const user = (id: string, extra: Partial<UserProfile> = {}): UserProfile =>
  ({ id, name: id, channels: [], permissions: [], preferences: {}, ...extra }) as UserProfile;

describe('MemoryPrivacy', () => {
  let root: string;
  let config: MemoryPrivacyConfig;
  let lists: ReachableLists;
  let users: UserProfile[];
  let time: number;
  const make = () => new MemoryPrivacy({
    stateDir: path.join(root, 'agent'), instarRoot: root, agentId: 'luna',
    config: () => config, users: () => users, reachable: () => lists, now: () => time,
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-privacy-'));
    config = {}; lists = {}; users = []; time = 1_000_000;
  });
  afterEach(() => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/memory-privacy.test.ts' }));

  it('is single-person with one reachable human', () => {
    lists = { slackAuthorizedIds: ['U1'], slackBotUserId: 'B' };
    expect(make().isMultiPerson()).toBe(false);
  });

  it('flips with two people, and the flip survives a restart and a removed person', () => {
    lists = { slackAuthorizedIds: ['U1', 'U2'], slackBotUserId: 'B' };
    expect(make().isMultiPerson()).toBe(true);
    lists = { slackAuthorizedIds: ['U1'], slackBotUserId: 'B' };
    expect(make().isMultiPerson()).toBe(true);
  });

  it('flips on an observed second sender and says so once', () => {
    lists = { telegramAuthorizedIds: [] };
    const p = make();
    expect(p.observeSender('telegram:1')).toBe(false);
    expect(p.observeSender('telegram:2')).toBe(true);
    expect(p.observeSender('telegram:2')).toBe(false);
    expect(p.isMultiPerson()).toBe(true);
  });

  it('treats a detection error as multi-person', () => {
    lists = { slackAuthorizedIds: ['U1'], slackBotUserId: 'B' };
    const p = new MemoryPrivacy({
      stateDir: path.join(root, 'agent'), instarRoot: root, agentId: 'luna',
      config: () => config, users: () => { throw new Error('boom'); }, reachable: () => lists,
    });
    expect(p.isMultiPerson()).toBe(true);
  });

  it('does nothing when switched off', () => {
    config = { enabled: false };
    lists = { slackAuthorizedIds: ['U1', 'U2'], slackBotUserId: 'B' };
    const p = make();
    expect(p.isMultiPerson()).toBe(false);
    expect(p.audienceFor({ kind: 'shared', placeKey: 'slack:C1' })).toEqual({ kind: 'open' });
  });

  describe('baseline at first boot', () => {
    it('reads the common existing agent as one operator: no profiles, unlinked ids, two iMessage handles', () => {
      lists = { slackAuthorizedIds: ['U1'], slackBotUserId: 'B', telegramAuthorizedIds: [], imessageAuthorizedContacts: ['+1', 'me@example.test'] };
      const p = make();
      p.establishBaseline();
      expect(p.isMultiPerson()).toBe(false);
    });
    it('still sees two people on one platform', () => {
      lists = { slackAuthorizedIds: ['U1', 'U2'], slackBotUserId: 'B' };
      const p = make();
      p.establishBaseline();
      expect(p.isMultiPerson()).toBe(true);
    });
    it('adopts the first sender on a platform with no list, then counts the next', () => {
      lists = { slackAuthorizedIds: ['U1'], slackBotUserId: 'B', telegramAuthorizedIds: [] };
      const p = make();
      p.establishBaseline();
      expect(p.observeSender('telegram:7')).toBe(false);
      expect(p.isMultiPerson()).toBe(false);
      expect(p.observeSender('telegram:8')).toBe(true);
    });
    it('treats a new id added after baseline as a new person', () => {
      lists = { slackAuthorizedIds: ['U1'], slackBotUserId: 'B' };
      make().establishBaseline();
      lists = { slackAuthorizedIds: ['U1', 'U2'], slackBotUserId: 'B' };
      expect(make().isMultiPerson()).toBe(true);
    });
    it('does not run twice', () => {
      lists = { slackAuthorizedIds: ['U1'], slackBotUserId: 'B' };
      make().establishBaseline();
      lists = { slackAuthorizedIds: ['U1', 'U2'], slackBotUserId: 'B' };
      const p = make();
      p.establishBaseline();
      expect(p.isMultiPerson()).toBe(true);
    });
    it('matches a WhatsApp number at baseline to the JID at inbound', () => {
      lists = { whatsappAuthorizedNumbers: ['+1 555 0100'] };
      const p = make();
      p.establishBaseline();
      expect(p.observeSender(whatsappPersonKey('15550100@s.whatsapp.net'))).toBe(false);
      expect(p.isMultiPerson()).toBe(false);
    });
    it('keeps the operator one person after they register', () => {
      lists = { slackAuthorizedIds: ['U1'], slackBotUserId: 'B', imessageAuthorizedContacts: ['+1'] };
      make().establishBaseline();
      users = [user('me', { slackUserId: 'U1' })];
      const p = make();
      expect(p.isMultiPerson()).toBe(false);
      expect(p.isOperator('user:me')).toBe(true);
    });
    it('does not adopt a newly registered stranger as the operator', () => {
      lists = { slackAuthorizedIds: ['U1'], slackBotUserId: 'B' };
      make().establishBaseline();
      users = [user('stranger', { slackUserId: 'U9' })];
      const p = make();
      p.observeSender('user:stranger');
      expect(p.isOperator('user:stranger')).toBe(false);
      expect(p.isMultiPerson()).toBe(true);
    });
    it('reports a flip once, whatever caused it', () => {
      lists = { slackAuthorizedIds: ['U1'], slackBotUserId: 'B' };
      make().establishBaseline();
      users = [user('new', { slackUserId: 'U9' })];
      const p = make();
      expect(p.takeFlip()).toBe(true);
      expect(p.takeFlip()).toBe(false);
    });
    it('waits for the bot id, because an allowlist can hold the bot', () => {
      lists = { slackAuthorizedIds: ['U1', 'UBOT'] };
      const p = make();
      p.establishBaseline();
      expect(p.isMultiPerson()).toBe(false);
      lists = { slackAuthorizedIds: ['U1', 'UBOT'], slackBotUserId: 'UBOT' };
      p.establishBaseline();
      expect(p.isMultiPerson()).toBe(false);
      expect(p.isOperator('slack:U1')).toBe(true);
    });
    it('does not count the operator twice when they spoke before the baseline ran', () => {
      lists = { slackAuthorizedIds: ['U1'], telegramAuthorizedIds: [] };
      const p = make();
      p.observeSender('telegram:7');
      lists = { slackAuthorizedIds: ['U1'], slackBotUserId: 'B', telegramAuthorizedIds: [] };
      p.establishBaseline();
      expect(p.isOperator('telegram:7')).toBe(true);
      expect(p.isMultiPerson()).toBe(false);
    });
    it('does not wait forever for a bot id that never comes', () => {
      lists = { slackAuthorizedIds: ['U1'] };
      const p = make();
      p.establishBaseline({ force: true });
      expect(p.isOperator('slack:U1')).toBe(true);
    });
    it('never merges two Slack people when the baseline is forced', () => {
      lists = { slackAuthorizedIds: ['U1', 'U2'] };
      const p = make();
      p.establishBaseline({ force: true });
      expect(p.isOperator('slack:U2')).toBe(false);
      expect(p.isMultiPerson()).toBe(true);
    });
    it('still sees three Slack ids as several while the bot id is unknown', () => {
      lists = { slackAuthorizedIds: ['U1', 'U2', 'U3'] };
      expect(make().isMultiPerson()).toBe(true);
    });
    it('keeps the baseline operator as the owner after a flip', () => {
      lists = { slackAuthorizedIds: ['U1'], slackBotUserId: 'B' };
      const p = make();
      p.establishBaseline();
      p.observeSender('slack:U2');
      expect(p.isOperator('slack:U1')).toBe(true);
      p.recordPlace('slack:D1', 'private', OPERATOR_PERSON_ID);
      expect(p.audienceFor(p.placeFor({ slackChannelId: 'D1' }, null)).kind).toBe('owner');
    });
  });

  describe('named people', () => {
    beforeEach(() => {
      users = [user('j', { telegramUserId: 1 }), user('a', { telegramUserId: 2 })];
      lists = { telegramAuthorizedIds: [1, 2] };
    });
    it('keeps the agent single-person', () => {
      config = { sharedMemoryPeople: ['j', 'a'] };
      expect(make().isMultiPerson()).toBe(false);
    });
    it('turns protection on when someone else can reach it', () => {
      config = { sharedMemoryPeople: ['j', 'a'] };
      const p = make();
      expect(p.observeSender('telegram:9')).toBe(true);
      expect(p.isMultiPerson()).toBe(true);
    });
    it('can bring an agent back after an earlier flip', () => {
      expect(make().isMultiPerson()).toBe(true);
      config = { sharedMemoryPeople: ['j', 'a'] };
      expect(make().isMultiPerson()).toBe(false);
    });
  });

  describe('places', () => {
    it('fails closed for a session with no place', () => {
      lists = { slackAuthorizedIds: ['U1', 'U2'], slackBotUserId: 'B' };
      const p = make();
      expect(p.audienceFor(p.placeFor({}, null))).toEqual({ kind: 'none' });
    });
    it('reads a recorded private place', () => {
      lists = { slackAuthorizedIds: ['U1', 'U2'], slackBotUserId: 'B' };
      users = [user('b', { slackUserId: 'U2' })];
      const p = make();
      p.recordPlace('slack:D2', 'private', 'b');
      expect(p.audienceFor(p.placeFor({ slackChannelId: 'D2' }, null))).toEqual({ kind: 'person', userId: 'b' });
    });
    it('treats an unrecorded channel as shared, on a one-person agent too', () => {
      lists = { slackAuthorizedIds: ['U1'], slackBotUserId: 'B' };
      const p = make();
      expect(p.audienceFor(p.placeFor({ slackChannelId: 'C1' }, null))).toEqual({ kind: 'place', placeKey: 'slack:C1' });
    });
    it('uses a whole Telegram group as the place for every topic', () => {
      lists = { telegramAuthorizedIds: [1, 2] };
      const p = make();
      expect(p.placeFor({ telegramTopicId: 5 }, 'telegram:-100')).toEqual(p.placeFor({ telegramTopicId: 6 }, 'telegram:-100'));
    });
    it('honours sole-reader proof only while fresh', () => {
      lists = { telegramAuthorizedIds: [1] };
      users = [user('j', { telegramUserId: 1 })];
      const p = make();
      p.recordSoleReader('telegram:-100', 'j');
      expect(p.audienceFor(p.placeFor({ telegramTopicId: 5 }, 'telegram:-100'))).toEqual({ kind: 'open' });
      time += READER_PROOF_MS + 1;
      expect(p.audienceFor(p.placeFor({ telegramTopicId: 5 }, 'telegram:-100')).kind).toBe('place');
    });
    it('does not keep sole-reader proof across a restart', () => {
      lists = { telegramAuthorizedIds: [1] };
      make().recordSoleReader('telegram:-100', 'j');
      expect(make().audienceFor(make().placeFor({ telegramTopicId: 5 }, 'telegram:-100')).kind).toBe('place');
    });
    it('keeps a one-person agent\'s existing group as it is, until its count grows', () => {
      lists = { telegramAuthorizedIds: [1] };
      users = [user('j', { telegramUserId: 1 })];
      const p = make();
      p.confirmExistingGroup('telegram:-100');
      expect(make().audienceFor(make().placeFor({ telegramTopicId: 5 }, 'telegram:-100'))).toEqual({ kind: 'open' });
      expect(p.groupGainedReaders('telegram:-100', 3)).toBe(false);
      expect(p.groupGainedReaders('telegram:-100', 3)).toBe(false);
      expect(p.groupGainedReaders('telegram:-100', 4)).toBe(true);
      expect(make().audienceFor(make().placeFor({ telegramTopicId: 5 }, 'telegram:-100')).kind).toBe('place');
    });
    it('does not restore a lost confirmation at the next boot', () => {
      lists = { telegramAuthorizedIds: [1] };
      users = [user('j', { telegramUserId: 1 })];
      const p = make();
      p.confirmExistingGroup('telegram:-100');
      p.groupGainedReaders('telegram:-100', 3);
      p.groupGainedReaders('telegram:-100', 4);
      const next = make();
      next.confirmExistingGroup('telegram:-100');
      expect(next.audienceFor(next.placeFor({ telegramTopicId: 5 }, 'telegram:-100')).kind).toBe('place');
    });
    it('does not confirm a group on a multi-person agent', () => {
      lists = { telegramAuthorizedIds: [1, 2] };
      const p = make();
      p.confirmExistingGroup('telegram:-100');
      expect(p.audienceFor(p.placeFor({ telegramTopicId: 5 }, 'telegram:-100')).kind).toBe('place');
    });
    it('lets the operator confirm a group holds only them', () => {
      lists = { telegramAuthorizedIds: [1] };
      users = [user('j', { telegramUserId: 1 })];
      config = { privateGroups: ['telegram:-100'], ownerUserId: 'j' };
      const p = make();
      expect(p.audienceFor(p.placeFor({ telegramTopicId: 5 }, 'telegram:-100'))).toEqual({ kind: 'open' });
    });
  });

  describe('resume', () => {
    it('drops a resume when the audience changed or the entry predates this', () => {
      const p = make();
      expect(p.audienceChanged('slack:C1', { kind: 'place', placeKey: 'slack:C1' })).toBe(true);
      expect(p.audienceChanged('slack:C1', { kind: 'place', placeKey: 'slack:C1' })).toBe(false);
      expect(p.audienceChanged('slack:C1', { kind: 'open' })).toBe(true);
    });
    it('never drops a resume on an open session with no history', () => {
      expect(make().audienceChanged('slack:D1', { kind: 'open' })).toBe(false);
    });
  });

  describe('session tokens', () => {
    it('resolves, survives a restart, and revokes', () => {
      const token = make().issueSessionToken('s1', { kind: 'person', userId: 'b' }, 'slack:D2');
      expect(token).toMatch(/^mps_/);
      expect(make().sessionForToken(token)?.audience).toEqual({ kind: 'person', userId: 'b' });
      const p = make();
      p.revokeSessionTokens('s1');
      expect(p.sessionForToken(token)).toBeNull();
    });
    it('never stores the token itself', () => {
      const token = make().issueSessionToken('s1', { kind: 'none' }, null);
      expect(fs.readFileSync(path.join(root, 'agent/state/memory-privacy.json'), 'utf8')).not.toContain(token);
    });
    it('refuses an unknown token and the agent token', () => {
      expect(make().sessionForToken('mps_nope')).toBeNull();
      expect(make().sessionForToken('plain-agent-token')).toBeNull();
    });
  });

  describe('scope folders', () => {
    it('creates private folders outside the agent home', () => {
      const dir = make().ensureScopeDir({ kind: 'person', userId: 'b' }, 's')!;
      expect(dir.startsWith(path.join(root, 'memory-scopes', 'luna'))).toBe(true);
      expect(fs.statSync(path.join(dir, 'inbox')).isDirectory()).toBe(true);
      expect(fs.statSync(dir).mode & 0o077).toBe(0);
    });
    it('gives each none session its own folder, so it cannot pass facts on', () => {
      const p = make();
      expect(p.ensureScopeDir({ kind: 'none' }, 'a')).not.toBe(p.ensureScopeDir({ kind: 'none' }, 'b'));
    });
    it('keeps the existing folder for open, owner and system', () => {
      expect(make().ensureScopeDir({ kind: 'owner', userId: 'a' }, 's')).toBeNull();
    });
  });
});

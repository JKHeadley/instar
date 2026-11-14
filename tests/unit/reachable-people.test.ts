/**
 * ReachablePeople: who can reach the agent, whatever the privacy setting.
 * Spec: docs/specs/team-roles-and-access.md §3.10.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { UserProfile } from '../../src/core/types.js';
import { MemoryInboundTracker } from '../../src/users/MemoryInboundTracker.js';
import { ReachablePeople, tierOfRole, type PhoneFact, type ReachablePeopleDeps } from '../../src/users/ReachablePeople.js';

const person = (id: string, over: Partial<UserProfile> = {}): UserProfile => ({
  id, name: id, channels: [], permissions: [], preferences: {} as UserProfile['preferences'], ...over,
});

describe('ReachablePeople', () => {
  let dir: string;
  let lists: ReturnType<ReachablePeopleDeps['reachable']>;
  let users: UserProfile[];
  let phones: PhoneFact[];
  let privacyOn: boolean;
  let shared: string[];

  const make = () => new ReachablePeople({
    stateDir: dir, users: () => users, reachable: () => lists, sharedMemoryPeople: () => shared,
    privacyOn: () => privacyOn, ownerUserId: () => null, ownerName: () => 'Ann', phones: () => phones,
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reachable-'));
    lists = {}; users = []; phones = []; privacyOn = false; shared = [];
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/reachable-people.test.ts' }));

  it('maps every org role to one tier', () => {
    expect(['owner', 'admin', 'operator', 'contributor', 'member', 'guest'].map(tierOfRole))
      .toEqual(['owner', 'admin', 'member', 'member', 'member', 'guest']);
  });

  it('calls one person with several handles one person', () => {
    lists = { imessageAuthorizedContacts: ['a@x', '+1555'], slackAuthorizedIds: ['U1'] };
    const r = make();
    expect(r.count()).toBe(1);
    expect(r.warning()).toBeNull();
  });

  it('warns with privacy off when two Slack people can reach the agent, and not with it on', () => {
    lists = { slackAuthorizedIds: ['U1', 'U2'] };
    const r = make();
    expect(r.warning()?.count).toBe(2);
    expect(r.warning()?.text).toContain('2 people can reach this agent');
    privacyOn = true;
    expect(r.warning()).toBeNull();
  });

  it('counts a new sender seen with privacy off', () => {
    lists = { slackAuthorizedIds: ['U1'] };
    const r = make();
    expect(r.warning()).toBeNull();
    r.observeSender('slack:U9');
    expect(r.warning()?.count).toBe(2);
  });

  it('treats the first sender on an unlisted platform as the owner arriving there', () => {
    lists = { slackAuthorizedIds: ['U1'] };
    const r = make();
    r.observeSender('telegram:42');
    expect(r.count()).toBe(1);
    r.observeSender('telegram:43');
    expect(r.count()).toBe(2);
  });

  it('holds the warning at the count raised, until someone new appears', () => {
    lists = { slackAuthorizedIds: ['U1', 'U2'] };
    const r = make();
    r.noteRaised(r.warning()!.count);
    expect(r.warning()).toBeNull();
    r.observeSender('slack:U3');
    expect(r.warning()?.count).toBe(3);
  });

  it('counts a sender another machine saw', () => {
    lists = { slackAuthorizedIds: ['U1'] };
    expect(make().warning(['slack:U7'])?.count).toBe(2);
  });

  it('never counts the Telegram owner as a second person', () => {
    lists = { telegramOwnerId: 42 };
    const r = make();
    r.observeSender('telegram:42');
    expect(r.count()).toBe(1);
    expect(r.telegramOpenToGroup()).toBe(true);
    r.observeSender('telegram:43');
    expect(r.count()).toBe(2);
  });

  it('asks once whether a folded Slack and Telegram id are both the owner', () => {
    lists = { slackAuthorizedIds: ['U1'], telegramAuthorizedIds: [42] };
    const r = make();
    expect(r.warning()).toBeNull();
    expect(r.bothYouQuestion()?.text).toContain('a Slack account and a Telegram account');
    expect(r.bothYouQuestion()?.text).not.toContain('U1');
    r.noteAskedBothYou();
    expect(r.bothYouQuestion()).toBeNull();
  });

  it('does not ask about iMessage handles', () => {
    lists = { slackAuthorizedIds: ['U1'], imessageAuthorizedContacts: ['a@x'] };
    expect(make().bothYouQuestion()).toBeNull();
  });

  it('asks when the Telegram owner id, not the baseline, supplies the Telegram side', () => {
    lists = { slackAuthorizedIds: ['U1'], telegramOwnerId: 42 };
    expect(make().bothYouQuestion()).not.toBeNull();
  });

  it('holds an open-allowlist warning across a restart', () => {
    lists = { slackAuthorizedIds: ['*'] };
    make().noteRaised(Number.POSITIVE_INFINITY);
    expect(make().warning()).toBeNull();
  });

  it('takes on a peer hold, so a lease move does not reopen a dismissed item', () => {
    lists = { slackAuthorizedIds: ['U1', 'U2'] };
    const r = make();
    r.adoptHold({ lastRaisedCount: 2, askedBothYou: true });
    expect(r.warning()).toBeNull();
    expect(r.hold()).toEqual({ lastRaisedCount: 2, askedBothYou: true });
    r.adoptHold({ lastRaisedCount: 'x' });
    expect(r.hold().lastRaisedCount).toBe(2);
  });

  it('matches handles however they are written', () => {
    lists = { imessageAuthorizedContacts: ['(256) 283-3341'], whatsappAuthorizedNumbers: ['+1 555 010 0000'] };
    const r = make();
    r.observeSender('imessage:+12562833341');
    r.observeSender('whatsapp:15550100000@s.whatsapp.net');
    expect(r.count()).toBe(1);
    expect(r.rows().map((x) => x.name)).toEqual(['Ann']);
  });

  it('never lists a registered person twice', () => {
    users = [person('j', { name: 'Jo', slackUserId: 'U1' }), person('k', { name: 'Kit', slackUserId: 'U2' })];
    lists = { slackAuthorizedIds: ['U1', 'U2'] };
    const r = make();
    r.observeSender('user:j');
    expect(r.rows().filter((x) => x.key === 'user:j')).toHaveLength(1);
  });

  it('says anyone for an open allowlist', () => {
    lists = { slackAuthorizedIds: ['*'] };
    expect(make().warning()?.text).toContain('Anyone can reach this agent');
  });

  it('does not count people named as sharing memory', () => {
    users = [person('a', { slackUserId: 'U1' }), person('b', { slackUserId: 'U2' })];
    lists = { slackAuthorizedIds: ['U1', 'U2'] };
    shared = ['a', 'b'];
    expect(make().warning()).toBeNull();
  });

  it('counts an MSP phone as a second person', () => {
    lists = { slackAuthorizedIds: ['U1'], mspDeviceUserIds: ['m1'] };
    expect(make().warning()?.count).toBe(2);
  });

  it('counts an app-only owner, so one MSP phone is a second person', () => {
    lists = { mspDeviceUserIds: ['m1'] };
    phones = [{ userId: null, role: 'owner', name: 'Ann', deviceName: 'iPhone' }];
    expect(make().warning()?.count).toBe(2);
  });

  it('an app-only owner alone is one person', () => {
    phones = [{ userId: null, role: 'owner', name: 'Ann', deviceName: 'iPhone' }];
    expect(make().count()).toBe(1);
  });

  it('is never below one, on an agent with nothing configured yet', () => {
    expect(make().count()).toBe(1);
  });

  it('survives a restart with what it saw', () => {
    lists = { slackAuthorizedIds: ['U1'] };
    make().observeSender('slack:U9');
    expect(make().count()).toBe(2);
  });

  it('a damaged state file starts over rather than throwing', () => {
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'reachable-people.json'), '{not json');
    lists = { slackAuthorizedIds: ['U1'] };
    expect(make().count()).toBe(1);
  });

  it('lists people with what they can see, and states the MSP fact plainly', () => {
    users = [person('sam', { name: 'Sam', slackUserId: 'U2' }), person('dana', { name: 'Dana' })];
    lists = { slackAuthorizedIds: ['U1', 'U2', 'U3'] };
    phones = [
      { userId: null, role: 'owner', name: 'Ann', deviceName: 'iPhone' },
      { userId: 'dana', role: 'msp', name: 'Dana', deviceName: 'Pixel' },
    ];
    const rows = make().rows();
    const by = (n: string) => rows.find((r) => r.name === n);
    expect(rows[0].tier).toBe('owner');
    expect(by('Ann')?.sees).toBe('Everything.');
    expect(by('Ann')?.reach.map((x) => x.detail)).toContain('Phone: iPhone');
    expect(by('Dana')).toMatchObject({ tier: 'admin', relationship: 'msp' });
    expect(by('Dana')?.warnings[0]).toContain("Dana's chats run with the agent's full reach");
    expect(by('Sam')?.sees).toBe('Slack channels they are in.');
    expect(by('Someone on Slack (U3)')?.tier).toBe('unknown');
  });

  it('adds no privacy warning to a row once privacy is on', () => {
    lists = { slackAuthorizedIds: ['U1', 'U2'] };
    privacyOn = true;
    expect(make().rows().flatMap((r) => r.warnings)).toEqual([]);
  });
});

describe('MemoryInboundTracker reach seam', () => {
  it('reports the sender even with memory privacy off, and still delivers', async () => {
    const seen: string[] = [];
    const tracker = new MemoryInboundTracker({
      privacy: { enabled: false } as never,
      retireSessions: async () => [], retireSessionUnlessAudience: async () => true,
      sandboxReady: () => true, framework: () => 'claude-code', onSender: (k) => seen.push(k),
    });
    const verdict = await tracker.onInbound({ senderKey: 'slack:U9', placeKey: 'slack:C1', placeKind: 'shared' } as never);
    expect(verdict).toBe('deliver');
    expect(seen).toEqual(['slack:U9']);
  });
});

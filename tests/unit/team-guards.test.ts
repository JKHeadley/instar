/** The pure team guards, both sides (docs/specs/team-roles-and-access.md §3.7, §4.1). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { attentionForNonOwner } from '../../src/permissions/TeamAccess.js';
import { filterAttentionForPhone, filterTopicsForTeam, maskSessionsForPhone } from '../../src/server/mobilePairingRoutes.js';
import { eventsFitPath } from '../../src/core/TeamAccessLog.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { createTempProject, createMockSessionManager, createSampleJobsFile } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';

const person = (role: string, userId = 'p') => ({ ok: true, role, userId, tier: 'member' });
const reqOf = (p: unknown) => ({ instarDevicePerson: p }) as never;
const svcOf = (on: boolean, may: (ref: string) => boolean) => ({ teamOn: () => on, mayUse: (_p: unknown, ref: string) => may(ref) }) as never;

describe('attentionForNonOwner', () => {
  const yes = () => true; const no = () => false;
  it('never shows a category outside maintenance', () => {
    expect(attentionForNonOwner({ category: 'personal', contextTopicIds: [1] }, yes)).toBeNull();
    expect(attentionForNonOwner({}, yes)).toBeNull();
  });
  it('a maintenance item with no conversation shows only a fixed label', () => {
    const shown = attentionForNonOwner({ id: 'a', category: 'system', title: 'secret words', summary: 'more words' } as never, yes) as { title: string; summary: string };
    expect(shown.title).toBe('A system item needs attention');
    expect(shown.summary).toBe('');
  });
  it('a maintenance item about a conversation shows in full only to someone who may read all of it', () => {
    const item = { category: 'monitoring', contextTopicIds: [1, 2], title: 't' };
    expect(attentionForNonOwner(item, yes)).toBe(item);
    expect(attentionForNonOwner(item, no)).toBeNull();
    expect(attentionForNonOwner(item, (id) => id === 1)).toBeNull();
  });
  it('where an item was delivered gives no access', () => {
    expect(attentionForNonOwner({ category: 'system', topicId: 9, title: 'secret' } as never, yes)).toMatchObject({ title: 'A system item needs attention' });
  });
});

describe('filterAttentionForPhone', () => {
  const items = [{ category: 'personal', title: 'x' }];
  it('the owner and the bearer see everything', () => {
    expect(filterAttentionForPhone(svcOf(true, () => false), reqOf(person('owner')), items)).toBe(items);
    expect(filterAttentionForPhone(svcOf(true, () => false), reqOf(undefined), items)).toBe(items);
  });
  it('an MSP phone is unchanged until team access is on, then filtered', () => {
    expect(filterAttentionForPhone(svcOf(false, () => false), reqOf(person('msp')), items)).toBe(items);
    expect(filterAttentionForPhone(svcOf(true, () => false), reqOf(person('msp')), items)).toEqual([]);
  });
});

describe('filterTopicsForTeam', () => {
  const rows = [{ id: 1 }, { id: 2 }];
  it('keeps only what a team phone may read', () => {
    expect(filterTopicsForTeam(svcOf(true, (r) => r === 'telegram:1'), reqOf(person('team')), rows, (r) => r.id)).toEqual([{ id: 1 }]);
  });
  it('leaves the owner and an MSP phone alone', () => {
    expect(filterTopicsForTeam(svcOf(true, () => false), reqOf(person('owner')), rows, (r) => r.id)).toBe(rows);
    expect(filterTopicsForTeam(svcOf(true, () => false), reqOf(person('msp')), rows, (r) => r.id)).toBe(rows);
  });
});

describe('maskSessionsForPhone', () => {
  const rows = [
    { id: 'a', status: 'running', name: 'Topic secret', telegramTopicId: 1, prompt: 'words' },
    { id: 'b', status: 'running', name: 'App secret', memoryPlaceInput: { memoryPlaceKey: 'app:key-1' }, prompt: 'words' },
    { id: 'c', status: 'running', name: 'No place', prompt: 'words' },
  ];
  it('the owner sees every row, and an MSP phone does until team access is on', () => {
    expect(maskSessionsForPhone(svcOf(true, () => false), reqOf(person('owner')), rows)).toBe(rows);
    expect(maskSessionsForPhone(svcOf(false, () => false), reqOf(person('msp')), rows)).toBe(rows);
  });
  it('shows a row someone may read, matching an app place by its conversation key', () => {
    const seen = maskSessionsForPhone(svcOf(true, (r) => r === 'telegram:1' || r === 'key-1'), reqOf(person('team')), rows);
    expect(seen[0]).toBe(rows[0]);
    expect(seen[1]).toBe(rows[1]);
  });
  it('masks the rest down to a label, with no prompt', () => {
    const seen = maskSessionsForPhone(svcOf(true, () => false), reqOf(person('team')), rows);
    for (const row of seen) expect(row).toEqual({ id: row.id, status: 'running', name: 'Private session' });
  });
});

describe('eventsFitPath', () => {
  it('each route carries only its own events', () => {
    expect(eventsFitPath('/mobile/team/invites', [{ type: 'team-on' }, { type: 'person-add' }, { type: 'grant' }])).toBe(true);
    expect(eventsFitPath('/mobile/team/invites', [{ type: 'team-off' }])).toBe(false);
    expect(eventsFitPath('/mobile/team/invites', [{ type: 'person-remove', personKey: 'a' }])).toBe(false);
    expect(eventsFitPath('/mobile/team/grants', [{ type: 'grant' }, { type: 'grant-remove' }])).toBe(true);
    expect(eventsFitPath('/mobile/team/grants', [{ type: 'team-off' }])).toBe(false);
    expect(eventsFitPath('/mobile/team/off', [{ type: 'team-off' }])).toBe(true);
    expect(eventsFitPath('/mobile/team/off', [{ type: 'grant' }])).toBe(false);
  });
  it('a people route carries changes to that person only', () => {
    expect(eventsFitPath('/mobile/team/people/a', [{ type: 'person-set', personKey: 'a' }])).toBe(true);
    expect(eventsFitPath('/mobile/team/people/a', [{ type: 'person-remove', personKey: 'b' }])).toBe(false);
    expect(eventsFitPath('/mobile/team/people/%E0%A4%A', [{ type: 'person-remove', personKey: 'a' }])).toBe(false);
  });
  it('an unknown path carries nothing', () => {
    expect(eventsFitPath('/mobile/team/other', [{ type: 'grant' }])).toBe(false);
  });
});

describe('the conversation lock', () => {
  const lock = (self: unknown, ref: string, fn: () => Promise<unknown>) => SessionManager.prototype.withConversationLock.call(self as never, ref, fn as never);
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it('runs one change at a time on a conversation, in order', async () => {
    const self = { conversationLocks: new Map() };
    const order: string[] = [];
    const a = lock(self, 'r', async () => { order.push('a-start'); await tick(); order.push('a-end'); });
    const b = lock(self, 'r', async () => { order.push('b'); });
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
  });
  it('different conversations do not wait for each other', async () => {
    const self = { conversationLocks: new Map() };
    const order: string[] = [];
    const a = lock(self, 'r1', async () => { await tick(); order.push('slow'); });
    const b = lock(self, 'r2', async () => { order.push('fast'); });
    await Promise.all([a, b]);
    expect(order).toEqual(['fast', 'slow']);
  });
  it('a failure lets the next one through and leaves nothing behind', async () => {
    const self = { conversationLocks: new Map() };
    await expect(lock(self, 'r', async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(lock(self, 'r', async () => 'ok')).resolves.toBe('ok');
    expect(self.conversationLocks.size).toBe(0);
  });
  it('ends only that conversation\'s sessions, before the change', async () => {
    const retired: string[] = [];
    const sessions = [
      { id: 'a', telegramTopicId: 5 }, { id: 'b', memoryPlaceInput: { telegramTopicId: 5 } }, { id: 'c', telegramTopicId: 6 },
      { id: 'd', memoryPlaceInput: { memoryPlaceKey: 'app:k' } },
    ];
    const self = {
      conversationLocks: new Map(), listRunningSessions: () => sessions,
      retireMemorySession: async (s: { id: string }) => { retired.push(s.id); },
      withConversationLock: SessionManager.prototype.withConversationLock,
    };
    let seen: string[] = [];
    await SessionManager.prototype.applyConversationChange.call(self as never, 'telegram:5', () => { seen = [...retired]; });
    expect(seen).toEqual(['a', 'b']);
    retired.length = 0;
    await SessionManager.prototype.applyConversationChange.call(self as never, 'k', () => undefined);
    expect(retired).toEqual(['d']);
  });
});

describe('a job bound to a confined topic', () => {
  let project: TempProject;
  let scheduler: JobScheduler;
  const drop = (job: unknown) => (scheduler as unknown as { dropConfinedTopic(j: unknown): void }).dropConfinedTopic(job);
  beforeEach(() => {
    project = createTempProject();
    scheduler = new JobScheduler({ jobsFile: createSampleJobsFile(project.stateDir), enabled: true, maxParallelJobs: 2, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } } as never, createMockSessionManager() as never, project.state, project.stateDir);
  });
  afterEach(() => project.cleanup());

  it('keeps its topic when the topic is not confined', () => {
    const job = { slug: 'j', topicId: 5 };
    scheduler.confinedTopicCheck = () => false;
    drop(job);
    expect(job.topicId).toBe(5);
  });
  it('loses it when confined, and when the list cannot be read', () => {
    for (const verdict of [true, null]) {
      const job: { slug: string; topicId?: number } = { slug: 'j', topicId: 5 };
      scheduler.confinedTopicCheck = () => verdict;
      drop(job);
      expect(job.topicId).toBeUndefined();
    }
  });
  it('does nothing with no check wired', () => {
    const job = { slug: 'j', topicId: 5 };
    drop(job);
    expect(job.topicId).toBe(5);
  });
});

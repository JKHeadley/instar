/** The pure team guards, both sides (docs/specs/team-roles-and-access.md §3.7, §4.1). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { attentionForNonOwner } from '../../src/permissions/TeamAccess.js';
import { filterAttentionForPhone, filterTopicsForTeam, maskSessionsForPhone } from '../../src/server/mobilePairingRoutes.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TeamAccessLog, eventsFitPath, foldRowInto, foldRows, emptyState } from '../../src/core/TeamAccessLog.js';
import { prepareSessionCurlHome, safeInboxTarget } from '../../src/core/memorySessionPolicy.js';
import { setAsideUnlessRealFolder } from '../../src/users/MemoryPrivacy.js';
import { isSafeSessionRef } from '../../src/core/claudeResumeTranscript.js';
import { TopicResumeMap } from '../../src/core/TopicResumeMap.js';
import { AppConversationService } from '../../src/core/AppConversationService.js';
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
      retireMemorySession: async (s: { id: string }) => { retired.push(s.id); return true; },
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

describe('a session that will not end', () => {
  it('stops the change', async () => {
    const self = {
      conversationLocks: new Map(), listRunningSessions: () => [{ id: 'a', telegramTopicId: 5 }],
      retireMemorySession: async () => false, withConversationLock: SessionManager.prototype.withConversationLock,
    };
    let changed = false;
    await expect(SessionManager.prototype.applyConversationChange.call(self as never, 'telegram:5', () => { changed = true; })).rejects.toThrow('still-running');
    expect(changed).toBe(false);
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
  it('is re-checked before posting, because a run holds its own copy of the job', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/scheduler/JobScheduler.ts'), 'utf8');
    const notify = src.slice(src.indexOf('async notifyJobComplete'));
    const check = notify.indexOf('this.dropConfinedTopic(job);');
    expect(check).toBeGreaterThan(-1);
    // Before the first thing that reads the topic: the gate and the reflection take it too.
    expect(check).toBeLessThan(notify.indexOf('topicId: job.topicId'));
    expect(check).toBeLessThan(notify.indexOf('sendToTopic(job.topicId'));
  });
  it('does nothing with no check wired', () => {
    const job = { slug: 'j', topicId: 5 };
    drop(job);
    expect(job.topicId).toBe(5);
  });
});

describe('a file the server puts in a session inbox', () => {
  const scope = () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'team-inbox-')));
    return { dir, inbox: path.join(dir, 'inbox'), outside: path.join(dir, '..', `outside-${path.basename(dir)}.txt`) };
  };
  const copyIn = (inbox: string, source: string) => AppConversationService.prototype.intoConfinedInbox.call({ deps: { confinedInbox: () => inbox } } as never, 'k', source);

  it('lands in the inbox, under a name nobody can guess, and repeats do not collide', () => {
    const { dir, inbox } = scope();
    const source = path.join(dir, 'a.txt');
    fs.writeFileSync(source, 'member bytes', { mode: 0o400 });
    const one = copyIn(inbox, source);
    const two = copyIn(inbox, source);
    expect(one).not.toBe(two);
    expect(path.dirname(one)).toBe(inbox);
    expect(fs.readFileSync(one, 'utf8')).toBe('member bytes');
    expect(path.basename(one)).toMatch(/^[0-9a-f-]{36}-a\.txt$/);
  });

  it('refuses an inbox the session swapped for a link, and writes nothing through it', () => {
    const { dir, inbox } = scope();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'team-elsewhere-'));
    fs.symlinkSync(elsewhere, inbox);
    const source = path.join(dir, 'a.txt');
    fs.writeFileSync(source, 'member bytes');
    expect(() => copyIn(inbox, source)).toThrow();
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('a link planted at the old predictable name is never followed', () => {
    const { dir, inbox, outside } = scope();
    fs.mkdirSync(inbox);
    fs.writeFileSync(outside, 'owner settings');
    fs.symlinkSync(outside, path.join(inbox, 'a.txt'));
    const source = path.join(dir, 'a.txt');
    fs.writeFileSync(source, 'member bytes');
    copyIn(inbox, source);
    expect(fs.readFileSync(outside, 'utf8')).toBe('owner settings');
  });

  it('with no confinement the file stays where it is', () => {
    expect(AppConversationService.prototype.intoConfinedInbox.call({ deps: {} } as never, 'k', '/some/file')).toBe('/some/file');
  });

  it('safeInboxTarget refuses a plain file at the inbox path', () => {
    const { inbox } = scope();
    fs.writeFileSync(inbox, 'x');
    expect(() => safeInboxTarget(inbox, 'a')).toThrow();
  });
});

describe('folding one row at a time', () => {
  it('reaches the same state as folding from the start', () => {
    const rows = [
      { seq: 1, kind: 'machine', at: 't', events: [{ type: 'conversation-own', ref: 'r', personKey: 'p' }], machineSig: {} },
      { seq: 2, kind: 'machine', at: 't', events: [{ type: 'phone-bind', keyHash: 'k', deviceId: 'd', boundTo: 'owner' }], machineSig: {} },
    ] as never[];
    const verify = () => 'verified' as const;
    const step = emptyState();
    for (const r of rows) foldRowInto(step, r, verify);
    expect(step).toEqual(foldRows(rows, verify));
  });
});

describe('ending a conversation\'s session', () => {
  it('forgets its resume binding before the change', async () => {
    const dropped: string[] = [];
    const self = {
      conversationLocks: new Map(), listRunningSessions: () => [], retireMemorySession: async () => undefined,
      withConversationLock: SessionManager.prototype.withConversationLock, conversationResumeDropper: (ref: string) => { dropped.push(ref); },
    };
    let seen: string[] = [];
    await SessionManager.prototype.applyConversationChange.call(self as never, 'telegram:5', () => { seen = [...dropped]; });
    expect(seen).toEqual(['telegram:5']);
  });
});

describe('a session id reported by a hook', () => {
  it('passes only as a plain id', () => {
    for (const ok of ['7f1c2d3e-1111-4111-8111-111111111111', 'latest', '3', 'thread_abc-1']) expect(isSafeSessionRef(ok)).toBe(true);
    for (const bad of ['--plugin-dir=/x', '-x', '../../x', '/etc/passwd', 'a/b', 'a b', '', '.', '..', 'a.b', 'x'.repeat(129), 5, null, undefined]) {
      expect(isSafeSessionRef(bad)).toBe(false);
    }
  });

  it('is refused before it can be stored', () => {
    const saved: string[] = [];
    const running = [{ id: 's1', tmuxSession: 't', claudeSessionId: 'old' }];
    const self = { state: { listSessions: () => running, saveSession: (x: { claudeSessionId: string }) => saved.push(x.claudeSessionId) } };
    SessionManager.prototype.setClaudeSessionId.call(self as never, 's1', '--plugin-dir=/x');
    expect(running[0].claudeSessionId).toBe('old');
    expect(saved).toEqual([]);
  });

  it('is refused by the resume store', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-resume-'));
    const map = new TopicResumeMap(dir, dir);
    const stored = () => fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.json'))
      .map((f) => fs.readFileSync(path.join(dir, String(f)), 'utf8')).join('');
    map.save(5, '--plugin-dir=/../x', 'sess');
    expect(stored()).not.toContain('plugin-dir');
    map.save(6, '7f1c2d3e-1111-4111-8111-111111111111', 'sess'); // the control: a real id is kept
    expect(stored()).toContain('7f1c2d3e-1111-4111-8111-111111111111');
  });

  it('never reaches a claude launch, even from an older stored value', async () => {
    const launch = await import('../../src/core/frameworkSessionLaunch.js');
    const src = fs.readFileSync(path.join(process.cwd(), 'src/core/frameworkSessionLaunch.ts'), 'utf8');
    expect(launch).toBeTruthy();
    const resumes = src.match(/argv\.push\('--resume', options\.resumeSessionId\)/g) ?? [];
    expect(resumes.length).toBeGreaterThan(0);
    expect((src.match(/isSafeSessionRef\(options\.resumeSessionId\)/g) ?? []).length).toBeGreaterThanOrEqual(resumes.length + 1);
    const manager = fs.readFileSync(path.join(process.cwd(), 'src/core/SessionManager.ts'), 'utf8');
    expect(manager.match(/isSafeSessionRef\(options\.resumeSessionId\)/g) ?? []).toHaveLength(2);
  });
});

describe('what the server writes into a folder a session controls', () => {
  const dirOf = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'team-scope-')));

  it('.curlrc replaces a planted link and leaves its target alone', () => {
    const scope = dirOf();
    const victim = path.join(dirOf(), 'config.json');
    fs.writeFileSync(victim, 'owner config');
    fs.mkdirSync(path.join(scope, '.curl'));
    fs.symlinkSync(victim, path.join(scope, '.curl', '.curlrc'));
    const home = prepareSessionCurlHome(scope, 'linux')!;
    expect(fs.readFileSync(victim, 'utf8')).toBe('owner config');
    expect(fs.lstatSync(path.join(home, '.curlrc')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(home, '.curlrc'), 'utf8')).toContain('noproxy');
  });

  it('a linked .curl folder is set aside, and nothing is written through it', () => {
    const scope = dirOf();
    const elsewhere = dirOf();
    fs.symlinkSync(elsewhere, path.join(scope, '.curl'));
    const home = prepareSessionCurlHome(scope, 'linux')!;
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(fs.lstatSync(home).isDirectory()).toBe(true);
  });

  it('nothing is written on a Mac', () => {
    expect(prepareSessionCurlHome(dirOf(), 'darwin')).toBeNull();
  });

  it('a file or a link where a folder belongs is moved aside; a real folder stays', () => {
    const scope = dirOf();
    const asFile = path.join(scope, 'inbox');
    fs.writeFileSync(asFile, 'x');
    setAsideUnlessRealFolder(asFile);
    expect(fs.existsSync(asFile)).toBe(false);
    const real = path.join(scope, 'tmp');
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, 'keep'), 'y');
    setAsideUnlessRealFolder(real);
    expect(fs.readFileSync(path.join(real, 'keep'), 'utf8')).toBe('y');
    setAsideUnlessRealFolder(path.join(scope, 'absent'));
  });
});

describe('what a confined session feeds agent-wide', () => {
  it('a confined session never feeds digests; another does', () => {
    const self = {};
    expect(SessionManager.prototype.feedsAgentDigests.call(self as never, { memoryScopeDir: '/scope' })).toBe(false);
    expect(SessionManager.prototype.feedsAgentDigests.call(self as never, { memoryScopeDir: undefined })).toBe(true);
  });
  it('the completion path applies the same rule as the periodic scan', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf8');
    const at = src.indexOf('activitySentinel!.synthesizeSession(session)');
    expect(at).toBeGreaterThan(-1);
    expect(src.lastIndexOf('feedsAgentDigests(session)', at)).toBeGreaterThan(at - 200);
  });
  it('production gives a session\'s history the held check, not only the fallback dispatch', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf8');
    expect(src).toContain('heldFromAReader: (key, message) => _teamHeldFromAReader');
    expect(src).toContain('_teamHeldFromAReader = (key, message) =>');
    expect(src).toContain('convs.useHeldCheck(');
  });
  it('a team member\'s words are kept out of the owner\'s learned corrections', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf8');
    expect(src).toContain('entry.fromUser && entry.text && !entry.teamPhone');
    const routes = fs.readFileSync(path.join(process.cwd(), 'src/server/routes.ts'), 'utf8');
    expect(routes).toContain("trust?.sender?.role === 'team' ? { teamPhone: true,");
  });
});

describe('wiring that production actually uses', () => {
  const server = () => fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf8');
  const agent = () => fs.readFileSync(path.join(process.cwd(), 'src/server/AgentServer.ts'), 'utf8');

  it('the service production builds cannot skip confinement before pairing is ready', () => {
    const s = server();
    const built = s.indexOf('const appSvc = new AppConversationService({');
    expect(built).toBeGreaterThan(-1);
    expect(s.slice(built, built + 500)).toContain('confineStranded: () => { throw new Error(\'pairing-not-ready\'); }');
  });
  it('the real hook is set where every path passes, after the ledger', () => {
    const a = agent();
    const ledger = a.indexOf('this.mobilePairing.keyLedger = keyLedger;');
    const hook = a.indexOf('svc.deps.confineStranded = (key, personKey, deviceId)');
    expect(ledger).toBeGreaterThan(-1);
    expect(hook).toBeGreaterThan(ledger);
  });
  it('the resume dropper does not depend on the scheduler', () => {
    const s = server();
    const wired = s.indexOf('sessionManager.conversationResumeDropper =');
    expect(wired).toBeGreaterThan(-1);
    expect(wired).toBeLessThan(s.indexOf('if (config.scheduler.enabled && coordinator.isAwake) {'));
  });
});

describe('a log row that cannot be placed yet', () => {
  it('counts as soon as it can, without waiting for a restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-refold-'));
    let known = false;
    const log = new TeamAccessLog({
      stateDir: dir, verify: () => (known ? 'verified' : 'unknown'),
      signer: { machineId: () => 'm', signerKeyHash: () => 'k', sign: () => ({ machineId: 'm', signerKeyHash: 'k', sig: 's' }) } as never,
    });
    log.appendMachineEvents([{ type: 'conversation-own', ref: 'r', personKey: 'p' }]);
    expect(log.state().owned.get('r')).toBeUndefined();
    known = true;
    expect(log.state().owned.get('r')).toBe('p');
  });
});

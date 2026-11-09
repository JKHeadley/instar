// docs/specs/telegram-test-groups.md — grant, title, marker, audit log, result parsers,
// the orchestrator's gates and caps, and the broker's dedicated operation path.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  TelegramTestGroups, TestGroupAuditLog, TestGroupMarkerKey, grantedBot, issueTestGroupMarker, markerOfTitle,
  parseTestGroupCreate, parseTestGroupDelete, parseTestGroupList, readTestGroupGrant, validTestGroupTitle,
  verifyTestGroupMarker, floodWaitSeconds, TEST_GROUP_GRANT_MAX_MS, type TestGroupGrant,
} from '../../../src/messaging/telegram-origin/TelegramTestGroups.js';
import { TelegramBrowserBroker } from '../../../src/messaging/telegram-origin/TelegramBrowserBroker.js';
import type { TelegramBrowserDriver } from '../../../src/messaging/telegram-origin/BrowserTypes.js';

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const DECISION = '[source: telegram 134088/123456 2026-11-08]';
const ACCOUNT = '7812716706';
const BOT = { username: 'instar_pr2760_livetest_bot', userId: '8000000001' };
const producer = { originMachineId: 'm-studio', harnessId: 'claude-code', sessionId: 'session-1' };
const dirs: string[] = [];
function stateDir(): string { const dir = mkdtempSync(path.join(tmpdir(), 'tg-test-groups-')); dirs.push(dir); return dir; }
function rawGrant(overrides: Record<string, unknown> = {}) {
  return { testGroups: { profileId: 'justin-telegram', accountId: ACCOUNT, bots: [BOT], decisionRef: DECISION,
    expiresAt: new Date(NOW + 7 * 24 * 60 * 60_000).toISOString(), ...overrides } };
}
afterEach(() => { vi.useRealTimers(); });

describe('grant', () => {
  it('reads an exact, unexpired grant whose decisionRef is one attribution source marker', () => {
    const grant = readTestGroupGrant(rawGrant(), NOW)!;
    expect(grant).toMatchObject({ profileId: 'justin-telegram', accountId: ACCOUNT, decisionRef: DECISION });
    expect(grantedBot(grant, '@INSTAR_PR2760_LIVETEST_BOT')).toEqual(BOT);
    expect(grantedBot(grant, 'some_other_bot')).toBeNull();
  });
  it.each([
    ['extra key', { extra: 1 }],
    ['bad profile', { profileId: 'has space' }],
    ['non-digit account', { accountId: '12a' }],
    ['feedback id as decision', { decisionRef: 'fb-87d2e9e4-e87' }],
    ['two markers', { decisionRef: `${DECISION} ${DECISION}` }],
    ['malformed marker', { decisionRef: '[source: fax 1/2 2026-11-08]' }],
    ['expired', { expiresAt: new Date(NOW - 1).toISOString() }],
    ['over 30 days', { expiresAt: new Date(NOW + TEST_GROUP_GRANT_MAX_MS + 60_000).toISOString() }],
    ['unparseable expiry', { expiresAt: 'soon' }],
    ['no bots', { bots: [] }],
    ['nine bots', { bots: Array.from({ length: 9 }, (_, i) => ({ username: `b${i}xx_bot`, userId: String(i + 1) })) }],
    ['not a bot username', { bots: [{ username: 'justin_human', userId: '5' }] }],
    ['duplicate bot id', { bots: [BOT, { username: 'other_test_bot', userId: BOT.userId }] }],
    ['bot extra key', { bots: [{ ...BOT, accessHash: 'x' }] }],
  ])('refuses %s', (_name, overrides) => {
    expect(readTestGroupGrant(rawGrant(overrides), NOW)).toBeNull();
  });
  it('refuses a missing or non-object grant', () => {
    expect(readTestGroupGrant(undefined, NOW)).toBeNull();
    expect(readTestGroupGrant({ testGroups: [] }, NOW)).toBeNull();
  });
});

describe('caller title', () => {
  it('accepts the exact prefix and a closed alphabet', () => {
    expect(validTestGroupTitle('Instar test - unread messages proof')).toBe(true);
    expect(validTestGroupTitle('Instar test - PR 2966 (rows) #2')).toBe(true);
  });
  it.each([
    ['en dash look-alike', 'Instar test – proof'],
    ['missing prefix', 'test - proof'],
    ['lowercase prefix', 'instar test - proof'],
    ['empty name', 'Instar test - '],
    ['double space', 'Instar test - a  b'],
    ['trailing space', 'Instar test - proof '],
    ['line separator', 'Instar test - a b'],
    ['combining mark', 'Instar test - é'],
    ['marker injection', 'Instar test - x [itg-aaaaaaaaaa]'],
    ['over length', 'Instar test - ' + 'a'.repeat(97)],
    ['not a string', 42],
  ])('refuses %s', (_name, title) => { expect(validTestGroupTitle(title)).toBe(false); });
});

describe('marker', () => {
  const key = Buffer.alloc(32, 7), other = Buffer.alloc(32, 8);
  it('verifies only under the issuing key and profile', () => {
    const marker = issueTestGroupMarker(key, 'justin-telegram');
    expect(marker).toMatch(/^itg-[a-z2-7]{10}$/);
    expect(verifyTestGroupMarker(key, 'justin-telegram', marker)).toBe(true);
    expect(verifyTestGroupMarker(other, 'justin-telegram', marker)).toBe(false);
    expect(verifyTestGroupMarker(key, 'another-profile', marker)).toBe(false);
    const flipped = marker.slice(0, -1) + (marker.endsWith('a') ? 'b' : 'a');
    expect(verifyTestGroupMarker(key, 'justin-telegram', flipped)).toBe(false);
  });
  it('reads the marker from a full title only', () => {
    expect(markerOfTitle('Instar test - x [itg-abcdeabcde]')).toBe('itg-abcdeabcde');
    expect(markerOfTitle('Family [itg-abcdeabcde]')).toBeNull();
  });
  it('creates the key file once with owner-only permissions and holds when it is unreadable', async () => {
    const dir = stateDir();
    const key = new TestGroupMarkerKey(dir);
    const first = await key.load();
    expect(first).toHaveLength(32);
    expect(statSync(key.file).mode & 0o777).toBe(0o600);
    expect(await new TestGroupMarkerKey(dir).load()).toEqual(first);
    writeFileSync(key.file, 'not hex');
    expect(await new TestGroupMarkerKey(dir).load()).toBeNull();
  });
});

describe('audit log', () => {
  it('counts create intents in 24 h, honours holds, and stores no secrets', async () => {
    let now = NOW;
    const dir = stateDir(), log = new TestGroupAuditLog(dir, () => now);
    await log.append({ at: now - 25 * 60 * 60_000, op: 'create', phase: 'intent', profileId: 'p' });
    await log.append({ at: now - 60_000, op: 'create', phase: 'intent', profileId: 'p' });
    await log.append({ at: now - 60_000, op: 'create', phase: 'intent', profileId: 'other' });
    await log.append({ at: now, op: 'hold', phase: 'hold', profileId: 'p', reason: 'flood-wait', until: now + 30_000 });
    expect(await log.summary('p')).toEqual({ attempts24h: 1, holdUntil: now + 30_000, holdReason: 'flood-wait', floodUntil: now + 30_000 });
    now += 31_000;
    expect((await log.summary('p')).holdUntil).toBe(0);
    expect(readFileSync(log.file, 'utf8')).not.toMatch(/hash|token/i);
  });
  it('drops a torn final line and keeps counting', async () => {
    const dir = stateDir(), log = new TestGroupAuditLog(dir, () => NOW);
    await log.append({ at: NOW, op: 'create', phase: 'intent', profileId: 'p' });
    writeFileSync(log.file, readFileSync(log.file, 'utf8') + '{"at":1,"op":"cre', { flag: 'w' });
    expect((await log.summary('p')).attempts24h).toBe(1);
    expect(readFileSync(log.file, 'utf8').endsWith('\n')).toBe(true);
  });
  it('moves a damaged log aside and holds creates for 24 h instead of resetting the count', async () => {
    const dir = stateDir(), log = new TestGroupAuditLog(dir, () => NOW);
    mkdirSync(path.join(dir, 'state'), { recursive: true });
    writeFileSync(log.file, 'garbage\n{"at":1,"op":"create","phase":"intent","profileId":"p"}\n');
    const summary = await log.summary('p');
    expect(summary).toMatchObject({ holdReason: 'audit-damaged', holdUntil: NOW + 24 * 60 * 60_000 });
    expect(readdirSync(path.join(dir, 'state')).some(name => name.startsWith('telegram-test-groups.damaged-'))).toBe(true);
    expect((await log.summary('p')).holdReason).toBe('audit-damaged');
  });
  it('a missing log is first use', async () => {
    expect(await new TestGroupAuditLog(stateDir(), () => NOW).summary('p')).toEqual({ attempts24h: 0, holdUntil: 0, holdReason: null, floodUntil: 0 });
  });
});

describe('page result parsers accept exact keys only', () => {
  it('list', () => {
    const group = { channelId: '1001', title: 'Instar test - a [itg-abcdeabcde]', date: 1 };
    expect(parseTestGroupList({ ok: true, complete: true, groups: [group] })).toEqual({ ok: true, complete: true, groups: [group] });
    expect(parseTestGroupList({ ok: true, complete: true, groups: [{ ...group, access_hash: '9' }] })).toBeNull();
    expect(parseTestGroupList({ ok: true, complete: true, groups: [{ ...group, title: 'Family chat' }] })).toBeNull();
    expect(parseTestGroupList({ ok: true, complete: true, groups: [], hash: 'x' })).toBeNull();
    expect(parseTestGroupList({ ok: true, complete: true, groups: [], requested: { present: true } })).toMatchObject({ requested: { present: true } });
  });
  it('create and delete', () => {
    expect(parseTestGroupCreate({ ok: true, channelId: '1001' })).toEqual({ ok: true, channelId: '1001' });
    expect(parseTestGroupCreate({ ok: true, channelId: '1001', access_hash: '1' })).toBeNull();
    expect(parseTestGroupCreate({ ok: false, step: 'invite', channelId: '1001', rolledBack: true })).toMatchObject({ rolledBack: true });
    expect(parseTestGroupCreate({ ok: false, step: 'made-up-step' })).toBeNull();
    expect(parseTestGroupCreate({ ok: false, step: 'create', type: 'lower case' })).toBeNull();
    expect(parseTestGroupDelete({ ok: true, outcome: 'gone' })).toEqual({ ok: true, outcome: 'gone' });
    expect(parseTestGroupDelete({ ok: true, outcome: 'maybe' })).toBeNull();
  });
  it('reads flood waits', () => {
    expect(floodWaitSeconds({ ok: false, step: 'create', code: 420, type: 'FLOOD_WAIT_37' })).toBe(37);
    expect(floodWaitSeconds({ ok: false, step: 'create', code: 400, type: 'CHANNELS_TOO_MUCH' })).toBeNull();
  });
});

// ── Orchestrator over the real broker with a fake driver backed by a simulated account ──

interface Chat { id: string; title: string; date: number; creator: boolean; forum: boolean; megagroup: boolean; members: string[] }
function fakeAccount() {
  const chats = new Map<string, Chat>();
  let next = 5000;
  const calls: string[] = [];
  const isCandidate = (c: Chat) => c.creator && c.forum && c.megagroup && /^Instar test - .{1,112} \[itg-[a-z2-7]{10}\]$/.test(c.title);
  const behaviour = { createFailure: null as null | Record<string, unknown>, listFailure: null as null | Record<string, unknown>,
    incomplete: false, slowMs: 0, throwAfterCreate: false };
  const driver: TelegramBrowserDriver = {
    canary: async () => ({ transport: 'web-k', buildId: 'fixture', accountId: ACCOUNT, supported: true }),
    readSnapshot: async () => ({ text: '', accountId: ACCOUNT }),
    invoke: async () => { throw new Error('no sends in this test'); },
    close: async () => { calls.push('close'); },
    listTestGroups: async input => {
      calls.push('list');
      if (behaviour.slowMs) await new Promise(resolve => setTimeout(resolve, behaviour.slowMs));
      if (behaviour.listFailure) return behaviour.listFailure;
      const candidates = [...chats.values()].filter(isCandidate);
      return { ok: true, complete: !behaviour.incomplete, groups: candidates.map(c => ({ channelId: c.id, title: c.title, date: c.date })),
        ...(input.channelId ? { requested: { present: chats.has(input.channelId) } } : {}) };
    },
    createTestGroup: async input => {
      calls.push('create');
      if (behaviour.createFailure) return behaviour.createFailure;
      const id = String(next++);
      chats.set(id, { id, title: input.title, date: Math.floor(NOW / 1000), creator: true, forum: true, megagroup: true, members: [ACCOUNT, input.bot.userId] });
      if (behaviour.throwAfterCreate) throw new Error('page-crashed');
      return { ok: true, channelId: id };
    },
    deleteTestGroup: async input => {
      calls.push('delete');
      const chat = chats.get(input.channelId);
      if (!chat) return { ok: true, outcome: 'gone' };
      if (chat.title !== input.title || !isCandidate(chat)) return { ok: false, step: 'identity-mismatch' };
      chats.delete(input.channelId);
      return { ok: true, outcome: 'deleted' };
    },
  };
  return { chats, calls, driver, behaviour };
}
function harness(overrides: { grant?: TestGroupGrant | null; holdsLease?: boolean; healthy?: boolean; executorBusy?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const account = fakeAccount();
  const dir = stateDir();
  const broker = new TelegramBrowserBroker({ driverFactory: async () => account.driver, authorizePreparedChild: async () => false,
    resolveAgentPublicKey: () => null, isProfileExclusivelyOwned: () => true, clockSkewMs: () => 0 });
  const authority = { healthy: overrides.healthy ?? true, enabled: true, holdsLease: overrides.holdsLease ?? true,
    grant: overrides.grant === undefined ? readTestGroupGrant(rawGrant(), NOW) : overrides.grant };
  const busy = { executor: overrides.executorBusy ?? false };
  const groups = new TelegramTestGroups({ profileId: 'justin-telegram', stateDir: dir, accountId: ACCOUNT, broker,
    executorBusy: () => busy.executor, authority: () => authority });
  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
  return { ...account, broker, groups, authority, busy, dir, advance };
}

describe('create, list, delete through the real broker', () => {
  it('creates a marked group, lists it as verified, and deletes it', async () => {
    const h = harness();
    const created = await h.groups.create({ title: 'Instar test - proof', bot: '@instar_pr2760_livetest_bot' }, producer);
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ chatId: `-100${created.body.channelId}`, bot: BOT.username });
    expect(String(created.body.title)).toMatch(/^Instar test - proof \[itg-[a-z2-7]{10}\]$/);
    expect(JSON.stringify(created.body)).not.toMatch(/hash/i);
    h.advance(6000);
    const listed = await h.groups.list();
    expect(listed.body).toMatchObject({ complete: true, groups: [{ channelId: created.body.channelId, verification: 'verified' }] });
    h.advance(6000);
    expect(await h.groups.delete(String(created.body.channelId), producer)).toEqual({ status: 200, body: { channelId: created.body.channelId, state: 'deleted' } });
    expect(h.chats.size).toBe(0);
    const audit = readFileSync(path.join(h.dir, 'state', 'telegram-test-groups.jsonl'), 'utf8');
    expect(audit).toContain(DECISION);
    expect(audit).toContain('"originMachineId":"m-studio"');
  });
  it('refuses create without a grant, without the lease, or for a bot outside the grant; list and delete still work', async () => {
    const h = harness({ grant: null });
    expect((await h.groups.create({ title: 'Instar test - a', bot: BOT.username }, producer)).status).toBe(403);
    expect((await h.groups.list()).status).toBe(200);
    h.authority.grant = readTestGroupGrant(rawGrant(), NOW);
    expect((await h.groups.create({ title: 'Instar test - a', bot: 'someone_else_bot' }, producer)).status).toBe(403);
    h.authority.holdsLease = false;
    expect((await h.groups.create({ title: 'Instar test - a', bot: BOT.username }, producer)).body).toEqual({ error: 'test-groups-not-lease-holder' });
    expect(h.calls).not.toContain('create');
  });
  it('never deletes a group without this agent\'s marker, or an operator chat', async () => {
    const h = harness();
    h.chats.set('900', { id: '900', title: 'Family', date: 1, creator: true, forum: true, megagroup: true, members: [] });
    h.chats.set('901', { id: '901', title: 'Instar test - copied [itg-abcdeabcde]', date: 1, creator: true, forum: true, megagroup: true, members: [] });
    expect((await h.groups.delete('900', producer)).body).toEqual({ error: 'test-group-failed', step: 'not-a-test-group' });
    h.advance(6000);
    expect((await h.groups.delete('901', producer)).body).toEqual({ error: 'test-group-failed', step: 'not-a-test-group' });
    h.advance(6000);
    expect((await h.groups.delete('902', producer)).body).toEqual({ channelId: '902', state: 'gone' });
    expect(h.calls).not.toContain('delete');
    expect(h.chats.size).toBe(2);
  });
  it('shows another issuer\'s look-alike groups as unverified without using up the live cap', async () => {
    const h = harness();
    for (let i = 0; i < 6; i++) h.chats.set(String(800 + i), { id: String(800 + i), title: `Instar test - x${i} [itg-abcdeabcd${'a'}]`, date: 1, creator: true, forum: true, megagroup: true, members: [] });
    const created = await h.groups.create({ title: 'Instar test - mine', bot: BOT.username }, producer);
    expect(created.status).toBe(200);
    h.advance(6000);
    const listed = await h.groups.list();
    const rows = listed.body.groups as { verification: string }[];
    expect(rows.filter(r => r.verification === 'unverified')).toHaveLength(6);
    expect(rows.filter(r => r.verification === 'verified')).toHaveLength(1);
  });
  it('enforces the live cap from the account and the daily cap from attempts', async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) {
      const r = await h.groups.create({ title: `Instar test - g${i}`, bot: BOT.username }, producer);
      expect(r.status).toBe(200);
      h.advance(6000);
    }
    expect((await h.groups.create({ title: 'Instar test - g5', bot: BOT.username }, producer)).body).toEqual({ error: 'test-groups-limit', limit: 'live-groups' });
    // Deleting frees the live cap but not the daily attempts.
    for (const id of [...h.chats.keys()]) { h.advance(6000); await h.groups.delete(id, producer); }
    for (let i = 0; i < 5; i++) { h.advance(6000); expect((await h.groups.create({ title: `Instar test - h${i}`, bot: BOT.username }, producer)).status).toBe(200); }
    for (const id of [...h.chats.keys()]) { h.advance(6000); await h.groups.delete(id, producer); }
    h.advance(6000);
    expect((await h.groups.create({ title: 'Instar test - eleven', bot: BOT.username }, producer)).body).toEqual({ error: 'test-groups-limit', limit: 'daily-creates' });
  });
  it('a damaged audit log holds create for 24 h but never blocks list or delete', async () => {
    const h = harness();
    h.chats.set('900', { id: '900', title: 'Family', date: 1, creator: true, forum: true, megagroup: true, members: [] });
    mkdirSync(path.join(h.dir, 'state'), { recursive: true });
    writeFileSync(path.join(h.dir, 'state', 'telegram-test-groups.jsonl'), 'garbage\n');
    expect((await h.groups.create({ title: 'Instar test - a', bot: BOT.username }, producer)).body).toMatchObject({ error: 'test-groups-limit', limit: 'audit-damaged' });
    h.advance(6000);
    expect((await h.groups.list()).status).toBe(200);
    h.advance(6000);
    expect((await h.groups.delete('901', producer)).body).toEqual({ channelId: '901', state: 'gone' });
  });
  it('refuses create on an incomplete read', async () => {
    const h = harness();
    h.behaviour.incomplete = true;
    expect((await h.groups.create({ title: 'Instar test - a', bot: BOT.username }, producer)).body).toEqual({ error: 'test-groups-read-incomplete' });
    expect(h.calls).not.toContain('create');
  });
  it('records a flood wait and holds every operation until it passes', async () => {
    const h = harness();
    h.behaviour.createFailure = { ok: false, step: 'create', code: 420, type: 'FLOOD_WAIT_120' };
    expect((await h.groups.create({ title: 'Instar test - a', bot: BOT.username }, producer)).body).toMatchObject({ error: 'test-group-failed', step: 'flood-wait' });
    h.advance(6000);
    expect((await h.groups.list()).body).toMatchObject({ error: 'test-groups-limit', limit: 'flood-wait' });
    h.advance(120_000);
    expect((await h.groups.list()).status).toBe(200);
  });
  it('reports a page crash after createChannel as outcome-unknown, and the group is then listed and deletable', async () => {
    const h = harness();
    h.behaviour.throwAfterCreate = true;
    const r = await h.groups.create({ title: 'Instar test - crash', bot: BOT.username }, producer);
    expect(r.body).toMatchObject({ error: 'test-group-outcome-unknown', retryable: false });
    expect(h.calls).toContain('close');
    h.behaviour.throwAfterCreate = false;
    h.advance(6000);
    const listed = await h.groups.list();
    const [row] = listed.body.groups as { channelId: string; verification: string }[];
    expect(row.verification).toBe('verified');
    h.advance(6000);
    expect((await h.groups.delete(row.channelId, producer)).body).toMatchObject({ state: 'deleted' });
  });
  it('a typed rollback is a known failure and leaves the driver open', async () => {
    const h = harness();
    h.behaviour.createFailure = { ok: false, step: 'verify', channelId: '777', rolledBack: true };
    expect((await h.groups.create({ title: 'Instar test - a', bot: BOT.username }, producer)).body).toEqual({ error: 'test-group-failed', step: 'verify', rolledBack: true });
    expect(h.calls).not.toContain('close');
  });
  it('an unconfirmed rollback is outcome-unknown', async () => {
    const h = harness();
    h.behaviour.createFailure = { ok: false, step: 'invite', channelId: '777', rolledBack: false };
    expect((await h.groups.create({ title: 'Instar test - a', bot: BOT.username }, producer)).body).toMatchObject({ error: 'test-group-outcome-unknown' });
  });
  it('re-authorizes before each page step: a grant revoked during the list never reaches createChannel', async () => {
    const h = harness();
    const original = h.driver.listTestGroups!;
    h.driver.listTestGroups = async input => { const r = await original(input); h.authority.grant = null; return r; };
    expect((await h.groups.create({ title: 'Instar test - a', bot: BOT.username }, producer)).status).toBe(403);
    expect(h.calls).not.toContain('create');
  });
  it('busy rule: refuses while a reply is in flight or the broker queue has work, and spaces live reads', async () => {
    const h = harness({ executorBusy: true });
    expect((await h.groups.list()).body).toMatchObject({ error: 'test-groups-busy' });
    h.busy.executor = false;
    expect((await h.groups.list()).status).toBe(200);
    // Within 15 s the cached read answers without touching the browser.
    const calls = h.calls.length;
    expect((await h.groups.list()).status).toBe(200);
    expect(h.calls.length).toBe(calls);
    // A delete inside the 5 s spacing is refused with the time left.
    expect((await h.groups.delete('5000', producer)).body).toMatchObject({ error: 'test-groups-busy' });
  });
  it('a missing key is created; an unreadable key holds create and delete while list reports key-unavailable', async () => {
    const h = harness();
    expect((await h.groups.create({ title: 'Instar test - a', bot: BOT.username }, producer)).status).toBe(200);
    const keyFile = path.join(h.dir, 'state', 'telegram-test-groups.key');
    expect(existsSync(keyFile)).toBe(true);
    writeFileSync(keyFile, 'corrupt');
    const fresh = new TelegramTestGroups({ profileId: 'justin-telegram', stateDir: h.dir, accountId: ACCOUNT, broker: h.broker,
      executorBusy: () => false, authority: () => h.authority });
    h.advance(6000);
    expect((await fresh.create({ title: 'Instar test - b', bot: BOT.username }, producer)).body).toEqual({ error: 'test-groups-key-unavailable' });
    h.advance(6000);
    const listed = await fresh.list();
    expect((listed.body.groups as { verification: string }[])[0].verification).toBe('key-unavailable');
  });
});

describe('broker test-group operation path', () => {
  function broker(driver: TelegramBrowserDriver, owned = { value: true }) {
    return new TelegramBrowserBroker({ driverFactory: async () => driver, authorizePreparedChild: async () => false,
      resolveAgentPublicKey: () => null, isProfileExclusivelyOwned: () => owned.value, clockSkewMs: () => 0 });
  }
  const base: TelegramBrowserDriver = { canary: async () => ({ transport: 'web-k', buildId: 'b', accountId: ACCOUNT, supported: true }),
    readSnapshot: async () => ({ text: '', accountId: ACCOUNT }), invoke: async () => null, close: async () => undefined };
  const opts = { expectedAccountId: ACCOUNT, authorize: () => null, operationMs: 45_000, evaluationMs: 20_000 };
  it('an error before a mutating step is known; after one it is unknown', async () => {
    const b = broker(base);
    expect(await b.runTestGroupOperation(opts, async step => step({ mutating: false }, async () => { throw new Error('x'); })))
      .toEqual({ state: 'known-failed', reason: 'browser-transport-failed' });
    expect(await b.runTestGroupOperation(opts, async step => step({ mutating: true }, async () => { throw new Error('x'); })))
      .toEqual({ state: 'unknown', reason: 'browser-transport-failed' });
  });
  it('refuses a different account, a lost exclusive ownership, and a step without enough budget', async () => {
    const other = broker({ ...base, canary: async () => ({ transport: 'web-k', buildId: 'b', accountId: '1', supported: true }) });
    expect(await other.runTestGroupOperation(opts, async () => 1)).toEqual({ state: 'known-failed', reason: 'browser-account-mismatch' });
    const owned = { value: false };
    expect(await broker(base, owned).runTestGroupOperation(opts, async () => 1)).toEqual({ state: 'known-failed', reason: 'browser-profile-unavailable' });
    expect(await broker(base).runTestGroupOperation({ ...opts, operationMs: 10_000 }, async step => step({ mutating: true, minRemainingMs: 22_000 }, async () => 1)))
      .toEqual({ state: 'known-failed', reason: 'budget' });
  });
  it('passes the operation deadline to the canary', async () => {
    const canary = vi.fn(async (_deadline?: number) => ({ transport: 'web-k' as const, buildId: 'b', accountId: ACCOUNT, supported: true }));
    await broker({ ...base, canary }).runTestGroupOperation(opts, async () => 1);
    expect(typeof canary.mock.calls[0][0]).toBe('number');
  });
  it('a closed broker answers known-failed instead of rejecting (the route never hangs)', async () => {
    const b = broker(base);
    await b.close();
    expect(await b.runTestGroupOperation(opts, async () => 1)).toEqual({ state: 'known-failed', reason: 'browser-closed' });
  });
  it('is busy while an operation is queued', async () => {
    const b = broker(base);
    let release!: () => void;
    const pending = b.runTestGroupOperation(opts, () => new Promise<number>(resolve => { release = () => resolve(1); }));
    expect(b.isBusy()).toBe(true);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await pending;
    expect(b.isBusy()).toBe(false);
  });
});

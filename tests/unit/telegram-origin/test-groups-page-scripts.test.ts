// docs/specs/telegram-test-groups.md section 5 — the real Web K page scripts, run in a
// vm against a simulated Telegram account (the same seam the send canary tests use).
import { describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';

const fixture = vi.hoisted(() => ({ evaluate: (_expression: string): Promise<unknown> => Promise.resolve(null), expressions: [] as string[] }));
vi.mock('../../../src/messaging/telegram-origin/PrivateCdpPipe.js', async importOriginal => ({ ...await importOriginal<object>(), PrivateCdpPipe: class {
  async request(method: string, params: { expression?: string }) {
    if (method === 'Target.createTarget') return { targetId: 'target' };
    if (method === 'Target.attachToTarget') return { sessionId: 'session' };
    if (params.expression) fixture.expressions.push(params.expression);
    try { return { result: { value: await fixture.evaluate(params.expression!) } }; }
    catch { return { exceptionDetails: {} }; }
  }
  async close() { /* nothing */ }
} }));
import { TelegramWebKDriver, TEST_GROUP_ADMIN_RIGHTS } from '../../../src/messaging/telegram-origin/TelegramWebKDriver.js';
import { parseTestGroupCreate, parseTestGroupDelete, parseTestGroupList } from '../../../src/messaging/telegram-origin/TelegramTestGroups.js';

const SELF = '123', BOT = { username: 'instar_pr2760_livetest_bot', userId: '900' };
type Chat = { _: string; id: number; title: string; date: number; access_hash: string; pFlags: Record<string, boolean>; participants: { _: string; user_id: number; admin_rights?: unknown }[] };
function harness(options: { addRights?: string[]; missingInvitee?: boolean; createShape?: 'none' | 'two'; failInvite?: boolean; slice?: boolean; botFlag?: boolean; createError?: { type: string; code: number }; listThrow?: unknown } = {}) {
  const assets = ['app-fixture.js', 'apiManagerProxy-fixture.js', 'index-fixture.js'].sort();
  const bytes = new Map(assets.map(asset => [asset, `public bundle ${asset}`]));
  const assetDigests = Object.fromEntries([...bytes].map(([asset, content]) => [asset, createHash('sha256').update(content).digest('hex')]));
  const chats = new Map<number, Chat>();
  let nextId = 7000;
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const rpcError = (type: string, code = 400) => Object.assign(new Error(type), { type, code });
  const api = async (method: string, params: Record<string, any>) => {
    calls.push({ method, params: JSON.parse(JSON.stringify(params)) });
    switch (method) {
      case 'users.getUsers': return [{ _: 'user', id: Number(SELF) }];
      case 'messages.getAllChats': if (options.listThrow !== undefined) throw options.listThrow; return { _: options.slice ? 'messages.chatsSlice' : 'messages.chats', chats: [...chats.values()].map(c => ({ ...c })) };
      case 'contacts.resolveUsername':
        return { peer: { _: 'peerUser', user_id: Number(BOT.userId) },
          users: [{ _: 'user', id: Number(BOT.userId), access_hash: 'bot-hash', pFlags: options.botFlag === false ? {} : { bot: true } }] };
      case 'channels.createChannel': {
        if (options.createError) throw rpcError(options.createError.type, options.createError.code);
        if (options.createShape === 'none') return { _: 'updates', chats: [] };
        const make = () => { const id = nextId++; const chat: Chat = { _: 'channel', id, title: params.title, date: 1_700_000_000, access_hash: `hash-${id}`,
          pFlags: { creator: true, megagroup: !!params.megagroup, forum: !!params.forum }, participants: [{ _: 'channelParticipantCreator', user_id: Number(SELF) }] };
          chats.set(id, chat); return chat; };
        const made = options.createShape === 'two' ? [make(), make()] : [make()];
        return { _: 'updates', chats: made };
      }
      case 'channels.inviteToChannel': {
        if (options.failInvite) throw rpcError('USER_PRIVACY_RESTRICTED');
        const chat = chats.get(params.channel.channel_id);
        if (!chat || params.channel.access_hash !== chat.access_hash) throw rpcError('CHANNEL_INVALID');
        if (!options.missingInvitee) chat.participants.push({ _: 'channelParticipant', user_id: Number(BOT.userId) });
        return { _: 'messages.invitedUsers', updates: {}, missing_invitees: options.missingInvitee ? [{ user_id: Number(BOT.userId) }] : [] };
      }
      case 'channels.editAdmin': {
        const chat = chats.get(params.channel.channel_id)!;
        const flags = { ...params.admin_rights.pFlags };
        for (const extra of options.addRights ?? []) flags[extra] = true;
        chat.participants = chat.participants.map(p => p.user_id === Number(BOT.userId)
          ? { _: 'channelParticipantAdmin', user_id: p.user_id, admin_rights: { _: 'chatAdminRights', pFlags: flags } } : p);
        return { _: 'updates' };
      }
      case 'channels.getParticipants': {
        const chat = chats.get(params.channel.channel_id)!;
        return { _: 'channels.channelParticipants', count: chat.participants.length, participants: chat.participants };
      }
      case 'channels.getChannels': {
        const chat = chats.get(params.id[0].channel_id);
        if (!chat || params.id[0].access_hash !== chat.access_hash) throw rpcError('CHANNEL_INVALID');
        return { _: 'messages.chats', chats: [{ ...chat }] };
      }
      case 'channels.deleteChannel': {
        const chat = chats.get(params.channel.channel_id);
        if (!chat || params.channel.access_hash !== chat.access_hash) throw rpcError('CHANNEL_INVALID');
        chats.delete(chat.id); return { _: 'updates' };
      }
      default: throw rpcError('METHOD_NOT_ALLOWED_IN_FIXTURE');
    }
  };
  const window: Record<string, unknown> = { createProxiedManagersForAccount: () => ({ apiManager: { getAccountNumber: async () => 1,
    invokeApi: (method: string, params: Record<string, unknown>) => api(method, params) } }) };
  const context = { location: { origin: 'https://web.telegram.org', pathname: '/k/' },
    document: { scripts: assets.map(asset => ({ src: `https://web.telegram.org/k/${asset}` })) },
    performance: { getEntriesByType: () => [] }, crypto: webcrypto, AbortSignal, TextEncoder, Uint8Array,
    window, fetch: async (url: string) => new Response(bytes.get(url.split('/').pop()!) ?? '', { status: 200 }), setTimeout, Date, Object, JSON, Number, String, Array };
  fixture.expressions = [];
  fixture.evaluate = async expression => vm.runInNewContext(expression, context, { timeout: 1000 });
  const driver = new TelegramWebKDriver({ executablePath: '/fixture/chrome', userDataDir: '/fixture/profile',
    accountNumber: 1, expectedAccountId: SELF, supportedBuilds: [{ buildId: 'fixture-build', criticalAssets: assets, assetDigests }] });
  const operator = (id: number, title: string, flags: Record<string, boolean> = { creator: true, megagroup: true, forum: true }) =>
    chats.set(id, { _: 'channel', id, title, date: 1_600_000_000, access_hash: `hash-${id}`, pFlags: flags, participants: [] });
  return { driver, chats, calls, operator, window };
}
const deadline = () => Date.now() + 20_000;
const TITLE = 'Instar test - proof [itg-abcdeabcde]';

describe('createTestGroup page script', () => {
  it('creates a forum supergroup, invites and promotes exactly the bot, verifies, and returns ids only', async () => {
    const h = harness();
    const raw = await h.driver.createTestGroup({ title: TITLE, bot: BOT, deadline: deadline() });
    expect(parseTestGroupCreate(raw)).toEqual({ ok: true, channelId: '7000' });
    expect(JSON.stringify(raw)).not.toMatch(/hash/);
    const methods = h.calls.map(c => c.method).filter(m => m !== 'users.getUsers');
    expect(methods).toEqual(['contacts.resolveUsername', 'channels.createChannel', 'channels.inviteToChannel', 'channels.editAdmin', 'channels.getParticipants']);
    const create = h.calls.find(c => c.method === 'channels.createChannel')!.params;
    expect(create).toEqual({ megagroup: true, forum: true, title: TITLE, about: '' });
    const promote = h.calls.find(c => c.method === 'channels.editAdmin')!.params;
    expect(JSON.stringify(promote.admin_rights)).toBe(TEST_GROUP_ADMIN_RIGHTS);
    expect(JSON.parse(TEST_GROUP_ADMIN_RIGHTS)).toEqual({ _: 'chatAdminRights', pFlags: { delete_messages: true, manage_topics: true, pin_messages: true } });
    expect(h.chats.get(7000)!.pFlags).toEqual({ creator: true, megagroup: true, forum: true });
  });
  it('accepts the implied manage-chat right but rolls back any other extra right', async () => {
    const ok = harness({ addRights: ['other'] });
    expect(parseTestGroupCreate(await ok.driver.createTestGroup({ title: TITLE, bot: BOT, deadline: deadline() }))).toMatchObject({ ok: true });
    const bad = harness({ addRights: ['change_info'] });
    expect(parseTestGroupCreate(await bad.driver.createTestGroup({ title: TITLE, bot: BOT, deadline: deadline() })))
      .toEqual({ ok: false, step: 'verify', channelId: '7000', rolledBack: true });
    expect(bad.chats.size).toBe(0);
  });
  it('rolls back when the invite fails or the bot is missing from the invite', async () => {
    for (const option of [{ failInvite: true }, { missingInvitee: true }]) {
      const h = harness(option);
      expect(parseTestGroupCreate(await h.driver.createTestGroup({ title: TITLE, bot: BOT, deadline: deadline() })))
        .toEqual({ ok: false, step: 'invite', channelId: '7000', rolledBack: true });
      expect(h.chats.size).toBe(0);
    }
  });
  it('refuses a user that is not a bot before making anything', async () => {
    const h = harness({ botFlag: false });
    expect(parseTestGroupCreate(await h.driver.createTestGroup({ title: TITLE, bot: BOT, deadline: deadline() }))).toEqual({ ok: false, step: 'bot-identity' });
    expect(h.calls.some(c => c.method === 'channels.createChannel')).toBe(false);
  });
  it('touches nothing when the create result has an unexpected shape', async () => {
    for (const shape of ['none', 'two'] as const) {
      const h = harness({ createShape: shape });
      expect(parseTestGroupCreate(await h.driver.createTestGroup({ title: TITLE, bot: BOT, deadline: deadline() })))
        .toEqual({ ok: false, step: 'create-shape', uncertain: true });
      expect(h.calls.some(c => c.method === 'channels.deleteChannel' || c.method === 'channels.inviteToChannel')).toBe(false);
    }
  });
  it('a client-side NETWORK_ 406 from createChannel is uncertain; a server refusal is known', async () => {
    const network = harness({ createError: { type: 'NETWORK_BAD_RESPONSE', code: 406 } });
    expect(parseTestGroupCreate(await network.driver.createTestGroup({ title: TITLE, bot: BOT, deadline: deadline() })))
      .toMatchObject({ ok: false, step: 'create', uncertain: true });
    const refused = harness({ createError: { type: 'CHANNELS_TOO_MUCH', code: 400 } });
    expect(parseTestGroupCreate(await refused.driver.createTestGroup({ title: TITLE, bot: BOT, deadline: deadline() })))
      .toMatchObject({ ok: false, step: 'create', uncertain: false });
  });
  it('will not start createChannel without 15 s left', async () => {
    const h = harness();
    expect(parseTestGroupCreate(await h.driver.createTestGroup({ title: TITLE, bot: BOT, deadline: Date.now() + 14_000 }))).toMatchObject({ ok: false });
    expect(h.calls.some(c => c.method === 'channels.createChannel')).toBe(false);
  });
  it('interpolates caller data only as canonical JSON', async () => {
    const h = harness();
    await h.driver.createTestGroup({ title: 'Instar test - x [itg-abcdeabcde]', bot: { username: 'a_bot"});alert(1);//', userId: '900' }, deadline: deadline() });
    const script = fixture.expressions.at(-1)!;
    expect(script).toContain(JSON.stringify({ title: 'Instar test - x [itg-abcdeabcde]', userId: '900', username: 'a_bot"});alert(1);//' }));
  });
});

describe('listTestGroups and deleteTestGroup page scripts', () => {
  it('a plain script error reports its kind and a filtered message; unsafe text is dropped (2026-11-09 live: step list, no code)', async () => {
    const h = harness({ listThrow: new TypeError('m.apiManager.invokeApi is not a function') });
    const raw = await h.driver.listTestGroups({ deadline: deadline() });
    expect(parseTestGroupList(raw)).toEqual({ ok: false, step: 'list', kind: 'TypeError', message: 'm.apiManager.invokeApi is not a function' });
    const h2 = harness({ listThrow: new Error('chat "Family" <secret> failed') });
    expect(parseTestGroupList(await h2.driver.listTestGroups({ deadline: deadline() }))).toEqual({ ok: false, step: 'list', kind: 'Error' });
    const h3 = harness({ listThrow: Object.assign(new Error('x'), { type: 'CHAT_LIST_FAILED', code: 400 }) });
    expect(parseTestGroupList(await h3.driver.listTestGroups({ deadline: deadline() }))).toEqual({ ok: false, step: 'list', code: 400, type: 'CHAT_LIST_FAILED' });
  });

  it('lists only creator-owned forum supergroups with a marker title, and never other chats', async () => {
    const h = harness();
    h.operator(1, 'Family');
    h.operator(2, 'Instar test - not mine [itg-abcdeabcde]', { creator: false, megagroup: true, forum: true });
    h.operator(3, 'Instar test - no forum [itg-abcdeabcde]', { creator: true, megagroup: true, forum: false });
    h.operator(4, TITLE);
    const raw = await h.driver.listTestGroups({ deadline: deadline(), channelId: '1' });
    expect(parseTestGroupList(raw)).toEqual({ ok: true, complete: true, groups: [{ channelId: '4', title: TITLE, date: 1_600_000_000 }], requested: { present: true } });
    expect(JSON.stringify(raw)).not.toMatch(/Family|hash/);
  });
  it('marks a slice as incomplete', async () => {
    const h = harness({ slice: true });
    expect(parseTestGroupList(await h.driver.listTestGroups({ deadline: deadline() }))).toMatchObject({ ok: true, complete: false });
  });
  it('deletes the listed group after a fresh identity re-check', async () => {
    const h = harness();
    h.operator(4, TITLE);
    await h.driver.listTestGroups({ deadline: deadline(), channelId: '4' });
    expect(parseTestGroupDelete(await h.driver.deleteTestGroup({ channelId: '4', title: TITLE, deadline: deadline() }))).toEqual({ ok: true, outcome: 'deleted' });
    expect(h.chats.has(4)).toBe(false);
    expect(h.window.__instarTestGroups).toBeUndefined();
  });
  it('refuses when the live title changed after the list, and when there was no list in this operation', async () => {
    const h = harness();
    h.operator(4, TITLE);
    await h.driver.listTestGroups({ deadline: deadline(), channelId: '4' });
    h.chats.get(4)!.title = 'Family renamed';
    expect(parseTestGroupDelete(await h.driver.deleteTestGroup({ channelId: '4', title: TITLE, deadline: deadline() }))).toEqual({ ok: false, step: 'identity-mismatch' });
    expect(h.chats.has(4)).toBe(true);
    expect(parseTestGroupDelete(await h.driver.deleteTestGroup({ channelId: '4', title: TITLE, deadline: deadline() }))).toEqual({ ok: false, step: 'stale-read' });
  });
  it('a group deleted between list and delete is gone', async () => {
    const h = harness();
    h.operator(4, TITLE);
    await h.driver.listTestGroups({ deadline: deadline(), channelId: '4' });
    h.chats.delete(4);
    expect(parseTestGroupDelete(await h.driver.deleteTestGroup({ channelId: '4', title: TITLE, deadline: deadline() }))).toEqual({ ok: true, outcome: 'gone' });
  });
  it('sends no request from the account when the build canary fails', async () => {
    const h = harness();
    const driver = new TelegramWebKDriver({ executablePath: '/x', userDataDir: '/y', accountNumber: 1, expectedAccountId: SELF,
      supportedBuilds: [{ buildId: 'other', criticalAssets: ['a-1.js', 'b-1.js', 'c-1.js'], assetDigests: { 'a-1.js': '0'.repeat(64), 'b-1.js': '0'.repeat(64), 'c-1.js': '0'.repeat(64) } }] });
    expect(parseTestGroupCreate(await driver.createTestGroup({ title: TITLE, bot: BOT, deadline: deadline() }))).toEqual({ ok: false, step: 'canary' });
    expect(h.calls.filter(c => c.method !== 'users.getUsers')).toEqual([]);
  });
});

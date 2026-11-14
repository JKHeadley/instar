/**
 * People and roles for paired phones (docs/specs/mobile-app-people-and-roles.md): the pure
 * resolver, the mint/reassign validation, the shared conversation check, and the persistence
 * shapes (device record, pairing code, replicated app events).
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  choosePerson, devicePerson, mayUseConversation, conversationOwnerFor, validConversationOwner, isOwnerProfile,
  type PeopleLookup, type PersonProfile, type ResolvedPerson,
} from '../../src/core/MobilePeople.js';
import { DeviceRegistry } from '../../src/core/MobileDeviceKeys.js';
import { PairingCodeStore } from '../../src/core/MobilePairing.js';
import { validateAppEvent } from '../../src/core/AppConversationStore.js';
import { registryPeople, DEVICE_ALLOWLIST, teamConversationTarget } from '../../src/server/mobilePairingRoutes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/mobile-app-people-roles.test.ts' }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mpr-')); dirs.push(d); return d; };

const OWNER_TG = 7812716706;
const owner = { ownerName: 'Ann', telegramOwnerId: OWNER_TG };
const profiles: Record<string, PersonProfile> = {
  justin: { id: 'justin', name: 'Justin', permissions: ['user'], telegramUserId: 555 },
  ann: { id: 'ann', name: 'Ann Client', permissions: ['user'], telegramUserId: OWNER_TG },
  boss: { id: 'boss', name: 'Boss', permissions: [], orgRole: 'owner' },
  admin: { id: 'admin', name: 'Admin Pat', permissions: ['admin'] },
};
const people: PeopleLookup = { getUser: (id) => profiles[id] ?? null };

describe('devicePerson', () => {
  it('a record with neither field is the owner, named from config, with the Telegram owner id', () => {
    expect(devicePerson({}, people, owner)).toEqual({ ok: true, role: 'owner', userId: null, name: 'Ann', telegramUserId: OWNER_TG });
    expect(devicePerson({}, null, { ownerName: '', telegramOwnerId: null })).toMatchObject({ ok: true, role: 'owner', name: 'Operator' });
  });
  it('an MSP phone resolves to its registry person and its own Telegram id', () => {
    expect(devicePerson({ userId: 'justin', role: 'msp' }, people, owner)).toEqual({ ok: true, role: 'msp', userId: 'justin', name: 'Justin', telegramUserId: 555, slackUserId: null, grants: { ownerConversations: false, slack: false } });
  });
  it('an MSP phone whose person was removed is person-unknown — never the owner', () => {
    const r = devicePerson({ userId: 'gone', role: 'msp' }, people, owner);
    expect(r.ok).toBe(false);
    expect(devicePerson({ role: 'msp' }, people, owner).ok).toBe(false);
    expect(devicePerson({ userId: 'justin', role: 'msp' }, null, owner).ok).toBe(false);
  });
  it('a role this build does not know fails closed', () => {
    expect(devicePerson({ role: 'admin' as never }, people, owner).ok).toBe(false);
  });
});

describe('choosePerson (mint and reassign validation)', () => {
  it('neither field ⇒ the owner, as before', () => {
    expect(choosePerson(undefined, undefined, people, owner)).toMatchObject({ ok: true, userId: null, role: 'owner', name: 'Ann' });
  });
  it('msp needs a registered non-owner person', () => {
    expect(choosePerson('justin', 'msp', people, owner)).toMatchObject({ ok: true, userId: 'justin', role: 'msp', name: 'Justin' });
    expect(choosePerson(undefined, 'msp', people, owner)).toMatchObject({ ok: false, error: 'bad-person' });
    expect(choosePerson('nobody', 'msp', people, owner)).toMatchObject({ ok: false, error: 'bad-person' });
    expect(choosePerson('ann', 'msp', people, owner)).toMatchObject({ ok: false, error: 'bad-person' }); // owner by Telegram id
    expect(choosePerson('boss', 'msp', people, owner)).toMatchObject({ ok: false, error: 'bad-person' }); // owner by orgRole
    expect(choosePerson('admin', 'msp', people, owner)).toMatchObject({ ok: true, role: 'msp' }); // an admin may be an MSP
  });
  it('owner with a userId needs that person to be the owner', () => {
    expect(choosePerson('ann', 'owner', people, owner)).toMatchObject({ ok: true, role: 'owner', userId: 'ann' });
    expect(choosePerson('justin', 'owner', people, owner)).toMatchObject({ ok: false, error: 'bad-person' });
  });
  it('a userId alone takes the person\'s standing', () => {
    expect(choosePerson('justin', undefined, people, owner)).toMatchObject({ ok: true, role: 'msp' });
    expect(choosePerson('ann', undefined, people, owner)).toMatchObject({ ok: true, role: 'owner' });
  });
  it('rejects bad shapes', () => {
    expect(choosePerson(undefined, 'admin', people, owner)).toMatchObject({ ok: false, error: 'bad-role' });
    expect(choosePerson(42, 'msp', people, owner)).toMatchObject({ ok: false, error: 'bad-person' });
    expect(choosePerson('', 'msp', people, owner)).toMatchObject({ ok: false, error: 'bad-person' });
  });
  it('a profile carrying the owner\'s Slack id is the owner and can never be paired as an MSP', () => {
    const withSlack = { ...owner, slackOwnerUserId: 'U0OWNER' };
    const look: PeopleLookup = { getUser: (id) => (id === 'sneaky' ? { id, name: 'Sneaky', permissions: [], slackUserId: 'U0OWNER' } : null) };
    expect(choosePerson('sneaky', 'msp', look, withSlack)).toMatchObject({ ok: false, error: 'bad-person' });
    expect(choosePerson('sneaky', 'msp', look, owner)).toMatchObject({ ok: true }); // no Slack owner configured
  });
  it('isOwnerProfile: Telegram owner id or derived owner role', () => {
    expect(isOwnerProfile(profiles.ann!, owner)).toBe(true);
    expect(isOwnerProfile(profiles.boss!, owner)).toBe(true);
    expect(isOwnerProfile(profiles.admin!, owner)).toBe(false);
  });
});

describe('mayUseConversation (the one shared check)', () => {
  const ownerP: ResolvedPerson = { ok: true, role: 'owner', userId: null, name: 'Ann', telegramUserId: OWNER_TG };
  const msp: ResolvedPerson = { ok: true, role: 'msp', userId: 'justin', name: 'Justin', telegramUserId: 555 };
  const KEY_OWNER = '11111111-1111-4111-8111-111111111111';
  const KEY_MSP = '22222222-2222-4222-8222-222222222222';
  const KEY_PEER = '33333333-3333-4333-8333-333333333333';
  const lookup = (k: string) => (k === KEY_OWNER ? null : k === KEY_MSP ? { machineId: 'm1', userId: 'justin' } : k === KEY_PEER ? { machineId: 'm2', userId: 'justin' } : undefined);
  it('the owner may use everything', () => {
    for (const ref of [KEY_OWNER, `app:${KEY_MSP}`, 'slack:T1:C1', 'telegram:5', 'anything']) expect(mayUseConversation(ownerP, ref, 'm1', lookup)).toBe(true);
  });
  it('an MSP: Telegram yes, Slack no, own app conversation yes, the owner\'s no', () => {
    expect(mayUseConversation(msp, 'telegram:4242', 'm1', lookup)).toBe(true);
    expect(mayUseConversation(msp, 'slack:T1:C1', 'm1', lookup)).toBe(false);
    expect(mayUseConversation(msp, KEY_MSP, 'm1', lookup)).toBe(true);
    expect(mayUseConversation(msp, `app:${KEY_MSP}`, 'm1', lookup)).toBe(true);
    expect(mayUseConversation(msp, KEY_OWNER, 'm1', lookup)).toBe(false);
  });
  it('an MSP: another machine\'s namespace, an unknown conversation, an odd ref, or no lookup ⇒ no', () => {
    expect(mayUseConversation(msp, KEY_PEER, 'm1', lookup)).toBe(false);
    expect(mayUseConversation(msp, '44444444-4444-4444-8444-444444444444', 'm1', lookup)).toBe(false);
    expect(mayUseConversation(msp, 'whatever', 'm1', lookup)).toBe(false);
    expect(mayUseConversation(msp, KEY_MSP, 'm1', null)).toBe(false);
  });
  it('conversationOwnerFor stamps only MSP creators', () => {
    expect(conversationOwnerFor(ownerP, 'm1')).toBeNull();
    expect(conversationOwnerFor(msp, 'm1')).toEqual({ machineId: 'm1', userId: 'justin' });
    expect(validConversationOwner({ machineId: 'm1', userId: 'x' })).toEqual({ machineId: 'm1', userId: 'x' });
    expect(validConversationOwner({ machineId: 'm1' })).toBeNull();
    expect(validConversationOwner('m1:x')).toBeNull();
  });
});

describe('persistence shapes', () => {
  it('a device record keeps the absent-means-owner shape; setPerson assigns an MSP and never a revoked phone', () => {
    const reg = new DeviceRegistry(tmp());
    const owned = reg.createPending({ deviceName: 'a', label: null, publicKey: 'pk-a', host: 'h' });
    const msp = reg.createPending({ deviceName: 'b', label: null, publicKey: 'pk-b', host: 'h', userId: 'justin', role: 'msp' });
    if (!owned.ok || !msp.ok) throw new Error('setup');
    expect(owned.device.userId).toBeUndefined();
    expect(owned.device.role).toBeUndefined();
    expect(reg.get(msp.device.id)).toMatchObject({ userId: 'justin', role: 'msp' });
    expect(reg.setPerson(owned.device.id, { userId: 'justin', role: 'msp' })).toMatchObject({ userId: 'justin', role: 'msp' });
    expect(reg.setPerson(owned.device.id, { userId: null, role: 'owner' })).not.toHaveProperty('role');
    reg.revoke(msp.device.id);
    expect(reg.setPerson(msp.device.id, { userId: 'admin', role: 'msp' })).toBeNull();
    expect(reg.setPerson('missing', { userId: 'admin', role: 'msp' })).toBeNull();
  });
  it('a pairing code carries its person through redeem; an older-style mint carries none', () => {
    const store = new PairingCodeStore();
    const a = store.mint(60_000, null, 'tok', null, { userId: 'justin', role: 'msp' });
    const b = store.mint(60_000, null, 'tok');
    if (!a.ok || !b.ok) throw new Error('setup');
    expect(store.redeem(a.code, 'tok')).toMatchObject({ ok: true, person: { userId: 'justin', role: 'msp' } });
    expect(store.redeem(b.code, 'tok')).toMatchObject({ ok: true, person: null });
  });
  it('replicated events keep the person fields; malformed ones are dropped, never the event', () => {
    const base = { eventId: 'e1', conversationKey: '22222222-2222-4222-8222-222222222222', at: new Date().toISOString(), machineId: 'm1' };
    expect(validateAppEvent({ ...base, kind: 'created', title: 'T', ownerPerson: { machineId: 'm1', userId: 'justin' } })).toMatchObject({ ownerPerson: { machineId: 'm1', userId: 'justin' } });
    expect(validateAppEvent({ ...base, kind: 'created', title: 'T', ownerPerson: 'bogus' })).not.toHaveProperty('ownerPerson');
    const msg = validateAppEvent({ ...base, kind: 'message', messageId: 'x', role: 'operator', text: 'hi', senderName: 'Justin', senderRole: 'msp', senderPerson: { machineId: 'm1', userId: 'justin' } });
    expect(msg).toMatchObject({ senderName: 'Justin', senderRole: 'msp', senderPerson: { machineId: 'm1', userId: 'justin' } });
    const bad = validateAppEvent({ ...base, kind: 'message', messageId: 'x', role: 'operator', text: 'hi', senderRole: 'admin', senderName: 'x'.repeat(500) });
    expect(bad).not.toBeNull();
    expect(bad).not.toHaveProperty('senderRole');
    expect(bad).not.toHaveProperty('senderName');
  });
  it('registryPeople reads users.json read-only, with config.users underneath', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'justin', name: 'Justin H', channels: [], permissions: ['user'] }]));
    const before = fs.readdirSync(dir).sort();
    const p = registryPeople(dir, [{ id: 'justin', name: 'Old' }, { id: 'cfg', name: 'From config' }]);
    expect(p.getUser('justin')?.name).toBe('Justin H');
    expect(p.getUser('cfg')?.name).toBe('From config');
    expect(p.getUser('none')).toBeNull();
    expect(fs.readdirSync(dir).sort()).toEqual(before); // nothing written
  });
});

describe('DEVICE_ALLOWLIST coverage', () => {
  // Every device route whose path or body names a conversation must call the shared check. This
  // list is the routes that take a conversation reference; a new one must be flagged and checked.
  const TAKES_CONVERSATION = [
    'GET /mobile/conversations', 'PATCH /mobile/conversations/<uuid>', 'DELETE /mobile/conversations/<uuid>',
    'POST /mobile/chat/app/<uuid>', 'GET /mobile/chat/app/<uuid>/messages', 'GET /mobile/chat/app/<uuid>/events',
    'GET /mobile/chat/app/<uuid>/preview/x', 'POST /mobile/chat/slack/-1', 'GET /mobile/chat/slack/-1/messages',
    'POST /mobile/media/uploads', 'GET /mobile/media/<sha>', 'POST /mobile/media/purge',
    'GET /mobile/conversations/session', 'GET /mobile/conversations/<uuid>/placement',
    // mobile-unread-messages §3.5: a read report names conversations in its body.
    'POST /mobile/conversations/read',
    // conversation-pinned-messages: list and pin/unpin in each kind of conversation.
    'GET /mobile/chat/app/<uuid>/pins', 'POST /mobile/chat/app/<uuid>/pins', 'GET /mobile/chat/7/pins', 'POST /mobile/chat/7/pins',
    'GET /mobile/chat/slack/-1/pins', 'POST /mobile/chat/slack/-1/pins',
  ];
  const UUID = '22222222-2222-4222-8222-222222222222';
  const sample = (s: string) => s.replace('<uuid>', UUID).replace('<sha>', 'a'.repeat(64));
  it('every route that takes a conversation is flagged conversationRef, and nothing else is', () => {
    for (const r of TAKES_CONVERSATION) {
      const [method, p] = sample(r).split(' ') as [string, string];
      const rule = DEVICE_ALLOWLIST.find((x) => x.method === method && x.re.test(p));
      expect(rule, r).toBeDefined();
      expect(rule!.conversationRef, r).toBe(true);
    }
    const flagged = DEVICE_ALLOWLIST.filter((x) => x.conversationRef).length;
    expect(flagged).toBe(TAKES_CONVERSATION.length);
  });
  it('only status, confirm and self-revoke answer an unassigned phone', () => {
    const open = DEVICE_ALLOWLIST.filter((x) => x.unassignedOk).map((x) => `${x.method} ${x.re.source}`);
    expect(open).toHaveLength(3);
  });
});

describe('Agent Awareness + Migration Parity', async () => {
  const { PostUpdateMigrator, MOBILE_PEOPLE_CLAUDEMD_SECTION, MOBILE_CHAT_STALE_SENDER_SENTENCE, MOBILE_CHAT_SENDER_SENTENCE } = await import('../../src/core/PostUpdateMigrator.js');
  const { generateClaudeMd } = await import('../../src/scaffold/templates.js');
  type R = { upgraded: string[]; skipped: string[]; errors: string[] };
  const MARK = 'Phones belong to people';
  const count = (s: string, m = MARK) => s.split(m).length - 1;

  it('new agents get the section once, and the chat sentence in its current form', () => {
    const md = generateClaudeMd('test', 'Test', 4042, false);
    expect(count(md)).toBe(1);
    expect(md).not.toContain(MOBILE_CHAT_STALE_SENDER_SENTENCE);
  });

  it('existing agents get the section once and the stale sender sentence replaced; idempotent', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, `# CLAUDE.md\n\n${MOBILE_CHAT_STALE_SENDER_SENTENCE}\n`);
    const m = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
    const run = () => { const r: R = { upgraded: [], skipped: [], errors: [] }; (m as unknown as { migrateClaudeMd(r: R): void }).migrateClaudeMd(r); return r; };
    const first = run();
    expect(first.upgraded).toContain('CLAUDE.md: added Phones belong to people section');
    expect(first.upgraded).toContain('CLAUDE.md: updated the Mobile operator chat sender sentence');
    run();
    const after = fs.readFileSync(file, 'utf8');
    expect(count(after)).toBe(1);
    expect(after).not.toContain(MOBILE_CHAT_STALE_SENDER_SENTENCE);
    // The seeded stale line was replaced in place (the migrator may also append the full chat section).
    expect(after).toContain(`# CLAUDE.md\n\n${MOBILE_CHAT_SENDER_SENTENCE}\n`);
  });

  it('names the mint body, the reassign route and the owner-only limits', () => {
    const s = MOBILE_PEOPLE_CLAUDEMD_SECTION(4042);
    expect(s).toContain('"userId":"justin","role":"msp"');
    expect(s).toContain('/mobile/devices/DEVICE_ID/person');
    expect(s).toContain('owner-needs-pairing');
    expect(s).toContain('owner-only');
  });
});

describe('owner grants for an MSP (§3.5)', async () => {
  const { MspGrantStore } = await import('../../src/core/MobileMspGrants.js');
  const KEY_OWNER = '11111111-1111-4111-8111-111111111111';
  const KEY_OTHER_MSP = '55555555-5555-4555-8555-555555555555';
  const lookup = (k: string) => (k === KEY_OWNER ? null : k === KEY_OTHER_MSP ? { machineId: 'm1', userId: 'pat' } : undefined);
  const mspWith = (g: { ownerConversations: boolean; slack: boolean }): ResolvedPerson => ({ ok: true, role: 'msp', userId: 'justin', name: 'Justin', telegramUserId: null, grants: g });

  it('off by default; each switch opens only its own area; another MSP\'s conversation stays closed', () => {
    const none = mspWith({ ownerConversations: false, slack: false });
    expect(mayUseConversation(none, KEY_OWNER, 'm1', lookup)).toBe(false);
    expect(mayUseConversation(none, 'slack:T1:C1', 'm1', lookup)).toBe(false);
    const chats = mspWith({ ownerConversations: true, slack: false });
    expect(mayUseConversation(chats, KEY_OWNER, 'm1', lookup)).toBe(true);
    expect(mayUseConversation(chats, 'slack:T1:C1', 'm1', lookup)).toBe(false);
    expect(mayUseConversation(chats, KEY_OTHER_MSP, 'm1', lookup)).toBe(false);
    const slack = mspWith({ ownerConversations: false, slack: true });
    expect(mayUseConversation(slack, 'slack:T1:C1', 'm1', lookup)).toBe(true);
    expect(mayUseConversation(slack, KEY_OWNER, 'm1', lookup)).toBe(false);
  });

  it('the store: no row ⇒ nothing; set merges fields; all-off removes the row; a corrupt file grants nothing', () => {
    const dir = tmp();
    const g = new MspGrantStore(dir);
    expect(g.get('justin')).toEqual({ ownerConversations: false, slack: false });
    g.set('justin', { slack: true }, 'dev-owner');
    expect(g.get('justin')).toEqual({ ownerConversations: false, slack: true });
    g.set('justin', { ownerConversations: true }, 'dev-owner');
    expect(g.get('justin')).toEqual({ ownerConversations: true, slack: true });
    expect(g.all().justin!.setByDevice).toBe('dev-owner');
    g.set('justin', { ownerConversations: false, slack: false }, 'dev-owner');
    expect(g.all()).toEqual({});
    fs.writeFileSync(g.file, '{not json');
    expect(g.get('justin')).toEqual({ ownerConversations: false, slack: false });
  });

  it('devicePerson attaches the person\'s grants to an MSP phone', () => {
    const p = devicePerson({ userId: 'justin', role: 'msp' }, people, owner, () => ({ ownerConversations: true, slack: false }));
    expect(p).toMatchObject({ ok: true, grants: { ownerConversations: true, slack: false } });
  });
});

describe('team phones (team-roles-and-access §3.1, §3.5)', () => {
  const owner = { ownerName: 'Ann', telegramOwnerId: 1 };
  const standing = (key: string) => (key === 'sam' ? { name: 'Sam', tier: 'member' as const } : key === 'gus' ? { name: 'Gus', tier: 'guest' as const } : null);
  const resolved = (key: string) => {
    const p = devicePerson({ userId: key, role: 'team' }, null, owner, undefined, standing);
    if (!p.ok) throw new Error('unresolved');
    return p;
  };
  const uuid = '11111111-1111-4111-8111-111111111111';
  const facts = (_k: string, ref: string) => ({ own: ref === 'telegram:9', grant: ref === 'telegram:7' ? 'use' as const : ref === 'telegram:8' ? 'read' as const : null });

  it('resolves standing from the log and nothing else', () => {
    expect(devicePerson({ userId: 'sam', role: 'team' }, null, owner, undefined, standing)).toMatchObject({ ok: true, role: 'team', name: 'Sam', tier: 'member', telegramUserId: null });
  });

  it('a person the log does not hold is unknown, never the owner', () => {
    expect(devicePerson({ userId: 'nobody', role: 'team' }, null, owner, undefined, standing)).toMatchObject({ ok: false, reason: 'person-unknown' });
    expect(devicePerson({ role: 'team' }, null, owner, undefined, standing)).toMatchObject({ ok: false });
    expect(devicePerson({ userId: 'sam', role: 'team' }, null, owner)).toMatchObject({ ok: false });
  });

  it('a bearer link can never name a team phone', () => {
    expect(choosePerson(undefined, 'team', null, owner)).toMatchObject({ ok: false, error: 'bad-role' });
  });

  it('a team person owns what they create, unlike the owner', () => {
    expect(conversationOwnerFor(resolved('sam'), 'm1')).toEqual({ machineId: 'm1', userId: 'sam' });
  });

  it.each([
    ['sam', 'telegram:7', 'send', true],
    ['sam', 'telegram:7', 'delete', false],
    ['sam', 'telegram:8', 'read', true],
    ['sam', 'telegram:8', 'send', false],
    ['sam', 'telegram:6', 'read', false],
    ['sam', 'telegram:9', 'delete', true],
    ['gus', 'telegram:7', 'read', true],
    ['gus', 'telegram:7', 'send', false],
    ['sam', 'slack:T1:C1', 'read', false],
    ['sam', uuid, 'read', false],
  ] as const)('%s on %s may %s: %s', (who, ref, op, want) => {
    expect(mayUseConversation(resolved(who), ref, 'm1', () => null, op, facts)).toBe(want);
  });

  it('a team person with no facts source gets nothing', () => {
    expect(mayUseConversation(resolved('sam'), 'telegram:7', 'm1', () => null, 'read', null)).toBe(false);
  });

  it('a team person reaches their own app conversation by its stored owner', () => {
    expect(mayUseConversation(resolved('sam'), uuid, 'm1', () => ({ machineId: 'm1', userId: 'sam' }), 'delete', () => ({ own: false, grant: null }))).toBe(true);
    expect(mayUseConversation(resolved('sam'), uuid, 'm1', () => ({ machineId: 'm1', userId: 'other' }), 'read', () => ({ own: false, grant: null }))).toBe(false);
  });

  it('msp and owner answers do not depend on the operation', () => {
    const msp = { ok: true as const, role: 'msp' as const, userId: 'd', name: 'Dana', telegramUserId: null, grants: { ownerConversations: false, slack: false } };
    expect(mayUseConversation(msp, 'telegram:6', 'm1', () => null, 'delete', facts)).toBe(true);
  });
});

describe('role literals', () => {
  it('no code outside MobilePeople compares a phone role to msp to decide owner behaviour', () => {
    const root = path.resolve(__dirname, '../../src');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.ts') || e.name === 'MobilePeople.ts') continue;
        for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
          if (/\b(?:sender|person|sendPerson|forWhom)\??\.role\s*===\s*'msp'/.test(line)) hits.push(`${e.name}: ${line.trim().slice(0, 80)}`);
        }
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});

describe('route tiers (team-roles-and-access §3.7)', () => {
  it('a send names a topic the way its handler reads it', () => {
    expect(teamConversationTarget('POST', '/mobile/chat/01')).toEqual({ ref: 'telegram:1', op: 'send' });
    expect(teamConversationTarget('POST', '/mobile/chat/50')).toEqual({ ref: 'telegram:50', op: 'send' });
  });

  it('every allowlist entry has a tier, and owner-only entries read owner', () => {
    for (const rule of DEVICE_ALLOWLIST) {
      expect(rule.tier, rule.re.source).toBeTruthy();
      if (rule.ownerOnly) expect(rule.tier).toBe('owner');
    }
  });

  const tierFor = (method: string, p: string) => DEVICE_ALLOWLIST.find((r) => r.method === method && r.re.test(p))?.tier;

  it.each([
    ['GET', '/mobile/conversations', 'guest'],
    ['GET', '/telegram/topics/7/messages', 'guest'],
    ['POST', '/mobile/chat/7', 'member'],
    ['POST', '/mobile/conversations', 'member'],
    ['POST', '/mobile/media/purge', 'member'],
    ['GET', '/attention', 'admin'],
    ['GET', '/sessions', 'admin'],
    ['GET', '/mobile/people', 'owner'],
    ['POST', '/mobile/console-ticket', 'owner'],
    ['GET', '/mobile/files', 'owner'],
    ['GET', '/mobile/machines', 'owner'],
  ])('%s %s needs %s', (method, p, tier) => {
    expect(tierFor(method, p)).toBe(tier);
  });

  it('a route added without a decision stays closed to members', () => {
    const open = DEVICE_ALLOWLIST.filter((r) => r.tier === 'guest' || r.tier === 'member').length;
    // 27: mobile-unread-messages §3.5 opened POST /mobile/conversations/read to guests (reading is guest).
    // 31: conversation-pinned-messages opened the app and Telegram pin list (guest) and pin/unpin (member).
    // 35: instar-document-viewer §4.2 opened the document list, a document's summary and text, and the
    //     single-use page code to guests (each document is still checked against its conversation's audience).
    // 38: instar-document-viewer §3.6a opened linking a computer, listing and forgetting linked computers (each is the person's own).
    // 39: §3.6a item 6 opened the link-code lookup (who asked for this code), so the phone shows it before Face ID.
    expect(open).toBe(39);
  });

  it.each([
    ['POST', '/mobile/chat/7', 'telegram:7', 'send'],
    ['GET', '/telegram/topics/7/messages', 'telegram:7', 'read'],
  ] as const)('%s %s targets %s for %s', (method, p, ref, op) => {
    expect(teamConversationTarget(method, p)).toEqual({ ref, op });
  });

  it('reads the operation from an app conversation route', () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    expect(teamConversationTarget('POST', `/mobile/chat/app/${uuid}`)).toEqual({ ref: uuid, op: 'send' });
    expect(teamConversationTarget('GET', `/mobile/chat/app/${uuid}/messages`)).toEqual({ ref: uuid, op: 'read' });
    expect(teamConversationTarget('GET', `/mobile/chat/app/${uuid}/preview/m1`)).toEqual({ ref: uuid, op: 'read' });
    expect(teamConversationTarget('DELETE', `/mobile/conversations/${uuid}`)).toEqual({ ref: uuid, op: 'delete' });
    expect(teamConversationTarget('PATCH', `/mobile/conversations/${uuid}`)).toEqual({ ref: uuid, op: 'rename' });
    expect(teamConversationTarget('GET', '/mobile/conversations')).toBeNull();
  });
});

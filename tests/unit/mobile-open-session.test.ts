/** Unit: "Open session" resolution (src/server/mobileSessionRoutes.ts). */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator, APP_CONVERSATIONS_CLAUDEMD_SECTION, APP_CONVERSATIONS_OPEN_SESSION_LINE, APP_CONVERSATIONS_POOL_LINE } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { findRemoteSession,
  parseSessionConversationRef, mayUseRefOf, dashboardSessionUrl, resolveOpenSession, selfMachineNickname, dashboardOriginFor, NO_SESSION_REASON,
} from '../../src/server/mobileSessionRoutes.js';

const UUID = '22222222-2222-4222-8222-222222222222';

describe('parseSessionConversationRef', () => {
  it('accepts the media routes\' three ref shapes', () => {
    expect(parseSessionConversationRef(`app:${UUID}`)).toEqual({ kind: 'app', ref: `app:${UUID}`, key: UUID });
    expect(parseSessionConversationRef('telegram:42')).toEqual({ kind: 'telegram', ref: 'telegram:42', topicId: 42 });
    expect(parseSessionConversationRef('slack:T1:C2:1700000000.1')).toEqual({ kind: 'slack', ref: 'slack:T1:C2:1700000000.1' });
  });
  it('refuses everything else', () => {
    for (const bad of [undefined, 42, '', 'app:nope', 'app:ABCDEF12-2222-4222-8222-222222222222', 'telegram:0', 'telegram:-3', 'telegram:01',
      'telegram:12345678901234567', 'slack:', 'slack:a b', 'whatsapp:1', `app:${UUID}x`, 'x'.repeat(129)]) {
      expect(parseSessionConversationRef(bad), String(bad)).toBeNull();
    }
  });
  it('the people-and-roles check gets the bare uuid for an app conversation, the full key otherwise', () => {
    expect(mayUseRefOf(parseSessionConversationRef(`app:${UUID}`)!)).toBe(UUID);
    expect(mayUseRefOf(parseSessionConversationRef('telegram:5')!)).toBe('telegram:5');
  });
});

describe('dashboardSessionUrl', () => {
  it('builds origin/dashboard?session=<name>, encoding the name and dropping any path or query on the origin', () => {
    expect(dashboardSessionUrl('https://a.example.dev', 'echo-topic-7')).toBe('https://a.example.dev/dashboard?session=echo-topic-7');
    expect(dashboardSessionUrl('https://a.example.dev/x?token=1', 'a b&c')).toBe('https://a.example.dev/dashboard?session=a%20b%26c');
  });
  it('no usable origin → null', () => {
    expect(dashboardSessionUrl(null, 's')).toBeNull();
    expect(dashboardSessionUrl('not a url', 's')).toBeNull();
    expect(dashboardSessionUrl('javascript:alert(1)', 's')).toBeNull();
  });
});

describe('resolveOpenSession', () => {
  const base = { ownerMachineId: null, selfMachineId: 'm_self', ownerNickname: null, selfNickname: 'Studio', origin: 'https://a.example.dev' };
  it('a running local session → active with the link', () => {
    expect(resolveOpenSession({ ...base, localSession: { name: 's1', startedAt: '2026-11-03T00:00:00.000Z', framework: 'codex-cli' } })).toEqual({
      active: true, sessionName: 's1', startedAt: '2026-11-03T00:00:00.000Z', framework: 'codex-cli', machineNickname: 'Studio',
      dashboardUrl: 'https://a.example.dev/dashboard?session=s1',
    });
  });
  it('a local session wins even when the records name another owner (the session is here)', () => {
    expect(resolveOpenSession({ ...base, ownerMachineId: 'm_peer', localSession: { name: 's1' } }).active).toBe(true);
  });
  it('active with no origin says why there is no link', () => {
    const r = resolveOpenSession({ ...base, origin: null, localSession: { name: 's1' } });
    expect(r.active).toBe(true);
    expect(r.dashboardUrl).toBeUndefined();
    expect(r.reason).toMatch(/no dashboard address/);
  });
  it('no session, owned here or unknown → the plain reason', () => {
    expect(resolveOpenSession({ ...base, localSession: null })).toEqual({ active: false, machineNickname: 'Studio', reason: NO_SESSION_REASON });
    expect(resolveOpenSession({ ...base, ownerMachineId: 'm_self', localSession: null }).reason).toBe(NO_SESSION_REASON);
  });
  it('no session, another owner → names it (or says the name is unconfirmed)', () => {
    const named = resolveOpenSession({ ...base, ownerMachineId: 'm_peer', ownerNickname: 'Mac Mini', localSession: null });
    expect(named).toMatchObject({ active: false, ownerMachine: { machineId: 'm_peer', nickname: 'Mac Mini' } });
    expect(named.reason).toContain('Mac Mini');
    const unnamed = resolveOpenSession({ ...base, ownerMachineId: 'm_peer', localSession: null });
    expect(unnamed.reason).toContain('could not confirm');
    expect(unnamed.reason).not.toContain('m_peer');
    expect(unnamed.ownerMachine).toEqual({ machineId: 'm_peer', nickname: null });
  });
  it('another machine runs it: the session opens natively there, never a link to that machine\'s dashboard', () => {
    const found = resolveOpenSession({ ...base, ownerMachineId: 'm_peer', ownerNickname: 'Mac Mini', localSession: null, remote: { state: 'found', name: 'echo-plans', startedAt: '2026-11-07T05:00:00Z', framework: 'claude-code' } });
    expect(found).toMatchObject({ active: true, remote: true, sessionName: 'echo-plans', machineId: 'm_peer', machineNickname: 'Mac Mini', ownerMachine: { machineId: 'm_peer', nickname: 'Mac Mini' } });
    expect(found.dashboardUrl).toBeUndefined();
    expect(JSON.stringify(found)).not.toMatch(/dashboard/i);
    // Not answering: said plainly, with a retry, and never "open the dashboard".
    const down = resolveOpenSession({ ...base, ownerMachineId: 'm_peer', ownerNickname: 'Mac Mini', localSession: null, remote: { state: 'unreachable' } });
    expect(down).toMatchObject({ active: false, retry: true });
    expect(down.reason).toBe("This chat's session runs on Mac Mini, which isn't answering right now, so it can't open here. Try again in a moment.");
    // No session there yet: the next message starts one.
    expect(resolveOpenSession({ ...base, ownerMachineId: 'm_peer', ownerNickname: 'Mac Mini', localSession: null, remote: { state: 'none' } }).reason).toBe(NO_SESSION_REASON);
    // An older Instar there: named, with what to do.
    expect(resolveOpenSession({ ...base, ownerMachineId: 'm_peer', ownerNickname: 'Mac Mini', localSession: null, remote: { state: 'too-old' } }).reason).toBe('Mac Mini needs the latest Instar update before its session can open here.');
    for (const st of ['found', 'none', 'unreachable', 'too-old'] as const) {
      const r = resolveOpenSession({ ...base, ownerMachineId: 'm_peer', ownerNickname: 'Mac Mini', localSession: null, remote: st === 'found' ? { state: st, name: 'x' } : { state: st } });
      expect(r.reason ?? '').not.toMatch(/dashboard/i);
    }
  });
  it('without a known self id an owner cannot be judged remote', () => {
    expect(resolveOpenSession({ ...base, selfMachineId: null, ownerMachineId: 'm_peer', localSession: null }).reason).toBe(NO_SESSION_REASON);
  });
});

describe('selfMachineNickname', () => {
  it('prefers the pool nickname; an id-shaped nickname is not a name', () => {
    expect(selfMachineNickname({ selfMachineId: () => 'm_self', nicknameOf: () => 'Studio' })).toBe('Studio');
    const fallback = selfMachineNickname({ selfMachineId: () => 'm_self', nicknameOf: () => 'm_self' });
    expect(fallback === null || (typeof fallback === 'string' && fallback !== 'm_self')).toBe(true);
  });
});

describe('dashboardOriginFor', () => {
  const pairing = (o: { ownNames?: boolean; accepts?: string[]; chosen?: { origin: string; host: string } | null; sibling?: string | null }) => ({
    ownNames: o.ownNames ? ({ accepts: (h: string) => (o.accepts ?? []).includes(h) } as never) : null,
    pairingOrigin: () => (o.chosen ? { ...o.chosen, kind: 'cloudflare' as const } : null),
    siblingClaiming: () => o.sibling ?? null,
  });
  const cf = { origin: 'https://shared.example.dev', host: 'shared.example.dev' };
  it('multi-route: the verified own name the phone reached wins over the pairing origin', () => {
    expect(dashboardOriginFor(pairing({ ownNames: true, accepts: ['studio.tail.ts.net'], chosen: cf }), 'studio.tail.ts.net')).toBe('https://studio.tail.ts.net');
  });
  it('multi-route but the host is not an own name: falls back to the pairing origin', () => {
    expect(dashboardOriginFor(pairing({ ownNames: true, accepts: [], chosen: cf }), 'other.example.dev')).toBe('https://shared.example.dev');
  });
  it('the pairing origin is skipped when an active sibling claims its host', () => {
    expect(dashboardOriginFor(pairing({ chosen: cf, sibling: 'Mac Mini' }), 'paired.example.dev')).toBe('https://paired.example.dev');
    expect(dashboardOriginFor(pairing({ chosen: cf, sibling: 'Mac Mini' }), null)).toBeNull();
  });
  it('single-route: the pairing origin, else the paired host', () => {
    expect(dashboardOriginFor(pairing({ chosen: cf }), 'paired.example.dev')).toBe('https://shared.example.dev');
    expect(dashboardOriginFor(pairing({ chosen: null }), 'paired.example.dev')).toBe('https://paired.example.dev');
  });
});

describe('Agent Awareness + Migration Parity', () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/mobile-open-session.test.ts' }); });
  type R = { upgraded: string[]; skipped: string[]; errors: string[] };
  const run = (projectDir: string) => {
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
    const result: R = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: R): void }).migrateClaudeMd(result);
    return result;
  };
  it('new agents get the Open session line once, right after the pool-read line', () => {
    const md = generateClaudeMd('test', 'Test', 4040, false);
    expect(md.split(APP_CONVERSATIONS_OPEN_SESSION_LINE).length - 1).toBe(1);
    const lines = md.split('\n');
    expect(lines[lines.indexOf(APP_CONVERSATIONS_POOL_LINE) + 1]).toBe(APP_CONVERSATIONS_OPEN_SESSION_LINE);
  });
  it('existing agents get it in place, once (idempotent)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-session-mig-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    const md = path.join(dir, 'CLAUDE.md');
    const old = APP_CONVERSATIONS_CLAUDEMD_SECTION(4321).replace(`${APP_CONVERSATIONS_OPEN_SESSION_LINE}\n`, '');
    expect(old).not.toContain(APP_CONVERSATIONS_OPEN_SESSION_LINE);
    fs.writeFileSync(md, `# CLAUDE.md\n${old}`);
    expect(run(dir).upgraded).toContain('CLAUDE.md: added the Native app conversations Open session line');
    const lines = fs.readFileSync(md, 'utf-8').split('\n');
    expect(lines[lines.indexOf(APP_CONVERSATIONS_POOL_LINE) + 1]).toBe(APP_CONVERSATIONS_OPEN_SESSION_LINE);
    expect(run(dir).upgraded).not.toContain('CLAUDE.md: added the Native app conversations Open session line');
    expect(fs.readFileSync(md, 'utf-8').split(APP_CONVERSATIONS_OPEN_SESSION_LINE).length - 1).toBe(1);
  });
});

describe('findRemoteSession (the pool listing read)', () => {
  const APP = { kind: 'app' as const, ref: 'app:0f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f', key: '0f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f' };
  const row = (over: Record<string, unknown>) => ({ tmuxSession: 'echo-plans', machineId: 'm_peer', remote: true, status: 'running', conversationRef: APP.ref, ...over });
  it('finds the owner machine\'s session by conversation reference', () => {
    expect(findRemoteSession({ sessions: [row({ startedAt: 'T', framework: 'codex-cli' })], pool: { failed: [] } }, APP, 'm_peer'))
      .toEqual({ state: 'found', name: 'echo-plans', startedAt: 'T', framework: 'codex-cli' });
    const tg = { kind: 'telegram' as const, ref: 'telegram:134088', topicId: 134088 };
    expect(findRemoteSession({ sessions: [row({ conversationRef: 'telegram:134088', tmuxSession: 't' })] }, tg, 'm_peer')).toMatchObject({ state: 'found', name: 't' });
  });
  it('a failed machine is unreachable; a session on another machine or another conversation is not it', () => {
    expect(findRemoteSession({ sessions: [row({})], pool: { failed: [{ machineId: 'm_peer', error: 'timeout' }] } }, APP, 'm_peer')).toEqual({ state: 'unreachable' });
    expect(findRemoteSession({ sessions: [row({ machineId: 'm_other' })] }, APP, 'm_peer')).toEqual({ state: 'none' });
    expect(findRemoteSession({ sessions: [row({ conversationRef: 'app:11111111-2222-4333-8444-555555555555' })] }, APP, 'm_peer')).toEqual({ state: 'none' });
    expect(findRemoteSession(null, APP, 'm_peer')).toEqual({ state: 'unreachable' });
  });
  it('a machine whose rows carry no conversation references runs an older Instar', () => {
    expect(findRemoteSession({ sessions: [row({ conversationRef: undefined })] }, APP, 'm_peer')).toEqual({ state: 'too-old' });
  });
});

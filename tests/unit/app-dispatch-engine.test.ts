// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * App conversations start on their own engine and model, and restart on a new one with no new
 * message (docs/specs/session-swap-any-conversation.md §3.1, §3.3).
 */
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAppInboundDispatch, createAppSessionStarter, type AppInboundDispatchDeps, type AppProfile } from '../../src/core/appInboundDispatch.js';
import { SessionChannelRegistry } from '../../src/messaging/shared/SessionChannelRegistry.js';

const KEY = '0f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f';
let dir: string;
let spawns: Array<{ msg: string; opts: Record<string, unknown>; name?: string }>;
let running: Array<{ id: string; tmuxSession: string }>;
let recorded: Array<{ key: string; applied: AppProfile }>;
let admits: string[];

function deps(over: Partial<AppInboundDispatchDeps> = {}): AppInboundDispatchDeps {
  const channels = new SessionChannelRegistry({ registryPath: path.join(dir, 'reg.json') });
  return {
    sessions: {
      listRunningSessions: () => running,
      injectMessage: () => true,
      spawnInteractiveSession: async (msg, n, opts) => { spawns.push({ msg: msg ?? '', opts: (opts ?? {}) as Record<string, unknown>, name: n }); const name = `s${spawns.length}`; running.push({ id: name, tmuxSession: name }); return name; },
    },
    channels,
    store: { browseMessages: () => ({ messages: [] }) } as unknown as AppInboundDispatchDeps['store'],
    stateDir: dir,
    spawnAdmission: () => ({ admit: (i) => { admits.push(i.callsite); return { allow: true, reason: 'ok' }; } }),
    spawned: (key, applied) => recorded.push({ key, applied }),
    ...over,
  };
}
const input = { conversationKey: KEY, alias: -5, title: 'Plans', text: 'hi', messageId: 'm1', ownerName: 'Justin', originVerdict: 'unknown' as const };

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-engine-')); spawns = []; running = []; recorded = []; admits = []; });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/app-dispatch-engine.test.ts' }); });

describe('an app message spawns on the conversation\'s engine', () => {
  it('passes the profile\'s framework and model, and tells the orchestrator what landed', async () => {
    const d = deps({ profile: () => ({ framework: 'codex', model: 'gpt-5.5' }) });
    expect(await createAppInboundDispatch(d)(input)).toBe('delivered');
    expect(spawns[0].opts).toMatchObject({ framework: 'codex', defaultModel: 'gpt-5.5', bootstrapConversationIds: [-5] });
    expect(recorded).toEqual([{ key: `app:${KEY}`, applied: { framework: 'codex', model: 'gpt-5.5' } }]);
  });
  it('carries the thinking-mode and effort pins, as the Telegram and Slack spawns do', async () => {
    await createAppInboundDispatch(deps({ profile: () => ({ framework: 'claude-code', model: null, thinkingMode: 'off', effort: 'high' }) }))(input);
    expect(spawns[0].opts).toMatchObject({ framework: 'claude-code', thinkingMode: 'off', effort: 'high' });
    expect(spawns[0].opts.defaultModel).toBeUndefined();
    await createAppSessionStarter(deps(), startDeps({ aliasFor: () => -9 }))(KEY, { framework: 'claude-code', model: 'claude-opus-5-5', thinkingMode: 'adaptive', effort: 'low' });
    expect(spawns[1].opts).toMatchObject({ defaultModel: 'claude-opus-5-5', thinkingMode: 'adaptive', effort: 'low' });
  });
  it('no profile, or an unreadable one: the agent default, as before', async () => {
    await createAppInboundDispatch(deps())(input);
    await createAppInboundDispatch(deps({ profile: () => { throw new Error('bad'); } }))({ ...input, alias: -6 });
    for (const s of spawns) { expect(s.opts.framework).toBeUndefined(); expect(s.opts.defaultModel).toBeUndefined(); }
  });
  it('waits for a switch under way instead of starting a second session, and never records that one', async () => {
    let inFlight = true;
    setTimeout(() => { inFlight = false; }, 400);
    const d = deps({ startInFlight: () => inFlight, startWaitMs: 5_000 });
    const t0 = Date.now();
    await createAppInboundDispatch(d)(input);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
    expect(spawns).toHaveLength(1);
    expect(recorded).toHaveLength(1);
  });
});

const startDeps = (over: Partial<Parameters<typeof createAppSessionStarter>[1]> = {}) => ({ serves: () => true, aliasFor: () => -5, titleFor: () => 'Plans', ownerName: () => 'Justin', ...over });

describe('restarting an app conversation on a new engine (startApp)', () => {
  const start = (over: Partial<Parameters<typeof createAppSessionStarter>[1]> = {}) => ({ serves: () => true, aliasFor: () => -5, titleFor: () => 'Plans', ownerName: () => 'Justin', ...over });
  it('starts with history and no new message, on the requested engine, admitted as app-respawn', async () => {
    const d = deps();
    const landed = await createAppSessionStarter(d, start())(KEY, { framework: 'codex', model: null });
    expect(landed).toEqual({ framework: 'codex', model: null });
    expect(spawns).toHaveLength(1);
    expect(spawns[0].opts).toMatchObject({ framework: 'codex', bootstrapConversationIds: [-5] });
    expect(spawns[0].msg).toContain('There is no new message to answer');
    expect(admits).toEqual(['app-respawn']);
    expect(d.channels.getSessionForChannel('-5')).toBe('s1');
  });
  it('starts nothing on a machine that does not serve it, or for a gone conversation', async () => {
    expect(await createAppSessionStarter(deps(), start({ serves: () => false }))(KEY, { framework: 'codex', model: null })).toBeNull();
    expect(await createAppSessionStarter(deps(), start({ titleFor: () => null }))(KEY, { framework: 'codex', model: null })).toBeNull();
    expect(spawns).toHaveLength(0);
  });
  it('refused by admission or the relay: nothing started, answered as null', async () => {
    expect(await createAppSessionStarter(deps({ spawnAdmission: () => ({ admit: () => ({ allow: false, reason: 'cap' }) }) }), start())(KEY, { framework: 'codex', model: null })).toBeNull();
    expect(await createAppSessionStarter(deps({ relayReady: () => ({ ready: false, reason: 'old' }) }), start())(KEY, { framework: 'codex', model: null })).toBeNull();
    expect(spawns).toHaveLength(0);
  });
  it('a message spawning while the switch starts: one session, and the message goes into it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const injected: string[] = [];
    const d = deps({ launchedOn: () => ({ framework: 'codex', model: null }) });
    const realSpawn = d.sessions.spawnInteractiveSession;
    d.sessions.spawnInteractiveSession = async (m, n, o) => { await gate; return realSpawn(m, n, o); };
    d.sessions.injectMessage = (name) => { injected.push(name); return true; };
    const message = createAppInboundDispatch(d)(input);
    await new Promise((r) => setTimeout(r, 20));
    const start = createAppSessionStarter(d, startDeps())(KEY, { framework: 'codex', model: null });
    release();
    expect(await message).toBe('delivered');
    expect(await start).toEqual({ framework: 'codex', model: null });
    expect(spawns).toHaveLength(1);
    expect(injected).toEqual([]);
  });
  it('two context files in the same millisecond do not collide', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_794_000_000_000);
    try {
      const d = deps();
      d.sessions.injectMessage = () => true;
      await createAppInboundDispatch(d)(input);
      await expect(createAppInboundDispatch(d)(input)).resolves.toBe('delivered');
    } finally { clock.mockRestore(); }
  });

  it('a start in progress, then a message: the message is injected into the started session', async () => {
    const injected: string[] = [];
    const d = deps();
    d.sessions.injectMessage = (name) => { injected.push(name); return true; };
    const start = createAppSessionStarter(d, startDeps())(KEY, { framework: 'codex', model: null });
    const message = createAppInboundDispatch(d)(input);
    await start;
    expect(await message).toBe('delivered');
    expect(spawns).toHaveLength(1);
    expect(injected).toEqual(['s1']);
  });
  it('a session already running: answers what it is on, and starts no second one', async () => {
    const d = deps({ launchedOn: () => ({ framework: 'codex', model: null }) });
    d.channels.register('-5', 'live1', 'Plans');
    running.push({ id: 'live1', tmuxSession: 'live1' });
    expect(await createAppSessionStarter(d, start())(KEY, { framework: 'codex', model: null })).toEqual({ framework: 'codex', model: null });
    expect(await createAppSessionStarter(d, start())(KEY, { framework: 'claude-code', model: null })).toBeNull();
    expect(spawns).toHaveLength(0);
  });
});

describe('a new session with its own app conversation (session-conversation-for-every-session §2.1)', () => {
  it('starts as the operator\'s, never under the person\'s name, admitted as app-new-session, with the new-conversation opening', async () => {
    const d = deps();
    const landed = await createAppSessionStarter(d, startDeps())(KEY, { framework: 'codex', model: null }, { reason: 'new' });
    // A taken name would make SessionManager reuse that running session.
    expect(spawns[0].name).toBeUndefined();
    expect(landed).toEqual({ framework: 'codex', model: null });
    expect(admits).toEqual(['app-new-session']);
    expect(spawns[0].opts).toMatchObject({ triggeredBy: 'dashboard-operator', framework: 'codex' });
    expect(spawns[0].msg).toContain('just started for a new app conversation, "Plans"');
    expect(spawns[0].msg).not.toContain('restarted on a new engine');
    // No orchestrator start records this one, so the starter tells it what launched.
    expect(recorded).toEqual([{ key: `app:${KEY}`, applied: { framework: 'codex', model: null } }]);
  });
  it('an engine-switch restart keeps its own opening and callsite, and is never marked the operator\'s', async () => {
    const d = deps();
    await createAppSessionStarter(d, startDeps())(KEY, { framework: 'codex', model: null });
    expect(admits).toEqual(['app-respawn']);
    expect(recorded).toEqual([]);
    expect(spawns[0].opts.triggeredBy).toBeUndefined();
    expect(spawns[0].msg).toContain('restarted on a new engine');
  });
  it('records the memory place before spawning; when private memory isn\'t available it starts nothing and says why', async () => {
    const order: string[] = [];
    const refusals: string[] = [];
    const d = deps();
    const real = d.sessions.spawnInteractiveSession;
    d.sessions.spawnInteractiveSession = async (m, n, o) => { order.push('spawn'); return real(m, n, o); };
    await createAppSessionStarter(d, startDeps({ memoryPlace: async () => { order.push('memory'); return true; } }))(KEY, { framework: 'claude-code', model: null }, { reason: 'new' });
    expect(order).toEqual(['memory', 'spawn']);
    const no = await createAppSessionStarter(deps(), startDeps({ aliasFor: () => -9, memoryPlace: async () => false, onRefused: (_k, why) => refusals.push(why) }))(KEY, { framework: 'codex', model: null }, { reason: 'new' });
    expect(no).toBeNull();
    expect(refusals).toEqual(['memory']);
    expect(spawns).toHaveLength(1);
  });
  it('every refusal is reported', async () => {
    const seen: string[] = [];
    const on = { onRefused: (_k: string, why: string) => seen.push(why) };
    await createAppSessionStarter(deps(), startDeps({ ...on, serves: () => false }))(KEY, { framework: null, model: null }, { reason: 'new' });
    await createAppSessionStarter(deps(), startDeps({ ...on, titleFor: () => null }))(KEY, { framework: null, model: null }, { reason: 'new' });
    await createAppSessionStarter(deps({ relayReady: () => ({ ready: false, reason: 'old' }) }), startDeps(on))(KEY, { framework: null, model: null }, { reason: 'new' });
    await createAppSessionStarter(deps({ spawnAdmission: () => ({ admit: () => ({ allow: false, reason: 'cap' }) }) }), startDeps(on))(KEY, { framework: null, model: null }, { reason: 'new' });
    expect(seen).toEqual(['not-served', 'gone', 'relay', 'admission']);
  });
});

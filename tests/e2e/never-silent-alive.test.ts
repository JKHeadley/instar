/**
 * Production-path proof (docs/specs/never-silent-conversation.md §6): the agent server mounts
 * GET /never-silent/incidents (503 while off), server boot builds the feature through
 * buildNeverSilent (the same function exercised here with real store, real judge, real
 * policy and real templates), and a logged message that gets no reply ends in a delivered
 * notice — with an expired Claude login it moves the conversation to Codex and re-drives
 * the message with the "why it is late" line; a pinned conversation gets the one-tap ask.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { buildNeverSilent, type NeverSilentWiringInput } from '../../src/monitoring/neverSilent/neverSilentWiring.js';
import { setNeverSilentInstance } from '../../src/server/neverSilentRoutes.js';
import type { IntelligenceProvider, InstarConfig } from '../../src/core/types.js';

const servers: AgentServer[] = [];
const dirs: string[] = [];

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'ns-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs', 'server-data']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ developmentAgent: true }));
  const config = {
    projectName: 'ns-e2e', projectDir: dir, stateDir, port: 0, developmentAgent: true,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {}, monitoring: {},
  } as unknown as InstarConfig;
  const sm = createMockSessionManager() as never as { on?: unknown };
  sm.on = () => undefined;
  const server = new AgentServer({ config, sessionManager: sm as never, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), commitmentTracker: new CommitmentTracker({ stateDir }) } as never);
  servers.push(server);
  return { server, stateDir, dir };
}

afterAll(async () => {
  setNeverSilentInstance(null);
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/never-silent-alive.test.ts' });
});

function wiring(stateDir: string, over: Partial<NeverSilentWiringInput> = {}) {
  let t = 10_000_000;
  const sent: Array<{ topicId: number; text: string; button?: { text: string; data: string } }> = [];
  const respawns: Array<{ topicId: number; text: string }> = [];
  const profiles = new Map<number, { framework?: string | null; updatedBy?: string }>();
  const referee = { evaluate: async () => '{"class":"engine-login","confidence":0.95,"actions":"none","reason":"sign-in ran out"}' } as unknown as IntelligenceProvider;
  const ns = buildNeverSilent({
    stateDir, logsDir: path.join(stateDir, '..', 'logs'),
    config: () => ({ enabled: true, judge: true, actions: true, frameworkFallback: true, confidenceFloor: 0.8, noticeAfterMs: 120_000 }),
    sessionForTelegramTopic: () => 'agent-topic',
    sessionForSlackChannel: () => null,
    sessionFacts: () => ({ framework: 'claude-code', accountId: 'claude-monroe', configHome: null, alive: true, startedAt: 1 }),
    isProtected: () => false,
    capturePane: () => '⏺ Login reached its time limit · Please run /login\n✻ Baked for 4s · done\n> ',
    poolAccounts: () => [
      { id: 'claude-monroe', framework: 'claude-code', configHome: '/h/monroe', status: 'needs-reauth' },
      { id: 'codex-1', framework: 'codex-cli', configHome: '/h/codex1', status: 'active' },
    ],
    loginCheck: (id) => (id === 'claude-monroe' ? 'signed-out' : 'ok'),
    observeLoginExpired: async () => {},
    repairStarted: () => true,
    swap: async () => ({ swapped: false }),
    profileFor: (topicId) => profiles.get(topicId) ?? null,
    writeFramework: async (topicId, framework, updatedBy) => { profiles.set(topicId, { framework, updatedBy }); return true; },
    respawnTopic: async (topicId, _tmux, text) => { respawns.push({ topicId, text }); return true; },
    readJevKey: () => null,
    refereeFor: (fw) => (fw === 'codex-cli' ? referee : null),
    sendTelegramNotice: async (topicId, text, _id, button) => { sent.push({ topicId, text, button }); return String(sent.length); },
    sendSlackNotice: async () => null,
    now: () => t,
    ...over,
  });
  return { ns, sent, respawns, profiles, advance: (ms: number) => { t += ms; } };
}

describe('never-silent conversations — production wiring', () => {
  it('the route is mounted and answers 503 while the feature is off', async () => {
    const { server } = await boot();
    setNeverSilentInstance(null);
    const res = await request(server.getApp()).get('/never-silent/incidents');
    expect(res.status).toBe(503);
  });

  it('server boot builds the feature and registers the instance, the tap handler and both message feeds', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/commands/server.ts'), 'utf8');
    expect(src).toContain('buildNeverSilent({');
    expect(src).toContain('setNeverSilentInstance({ store: neverSilent.store');
    expect(src).toContain('setNeverSilentAskHandler((tap) => neverSilent.handleTelegramTap(tap))');
    expect(src).toContain("neverSilent.observeLogged('telegram'");
    expect(src).toContain("neverSilent.observeLogged('slack'");
    expect(src).toContain('neverSilent.start()');
  });

  it('expired Claude login: the waiting message is answered on Codex with the why-late line, and the person is told', async () => {
    const { server, stateDir } = await boot();
    const w = wiring(stateDir);
    setNeverSilentInstance({ store: w.ns.store, enabled: () => true });
    w.ns.observeLogged('telegram', '7165', { messageId: '901', text: 'Can you send me the summary?', fromUser: true, senderName: 'Justin' });
    w.ns.observeLogged('telegram', '7165', { messageId: '902', text: '🔭 standby: still waiting', fromUser: false, provenance: 'automation' });
    w.advance(121_000);
    await w.ns.watcher.tick();
    expect(w.profiles.get(7165)).toMatchObject({ framework: 'codex-cli', updatedBy: 'system:never-silent' });
    expect(w.respawns).toHaveLength(1);
    expect(w.respawns[0]!.text).toContain('Begin your reply with one short line saying why it is late');
    expect(w.respawns[0]!.text).toContain('Can you send me the summary?');
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.text).toContain('moved this conversation to Codex');
    // The reply on Codex closes it.
    w.ns.observeLogged('telegram', '7165', { messageId: '903', text: 'Sorry for the delay — my Claude sign-in ran out. Here is the summary…', fromUser: false, provenance: 'agent' });
    const res = await request(server.getApp()).get('/never-silent/incidents');
    expect(res.status).toBe(200);
    expect(res.body.counts.openObligations).toBe(0);
    expect(res.body.incidents[0]).toMatchObject({ silenceClass: 'engine-login', action: 'fallback', closedReason: 'answered' });
    expect(JSON.stringify(res.body)).not.toContain('Can you send me the summary?');
  });

  it('a conversation the operator set to Claude gets one notice with a one-tap ask, and the tap moves it', async () => {
    const { stateDir } = await boot();
    const w = wiring(stateDir);
    w.profiles.set(6648, { framework: 'claude-code', updatedBy: 'telegram:justin' });
    w.ns.observeLogged('telegram', '6648', { messageId: '1', text: 'hello?', fromUser: true });
    w.advance(121_000);
    await w.ns.watcher.tick();
    expect(w.respawns).toHaveLength(0);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.button).toMatchObject({ text: 'Move to Codex' });
    expect(await w.ns.handleTelegramTap({ data: w.sent[0]!.button!.data, fromIsOwner: true })).toMatch(/Moving this conversation to Codex/);
    await w.ns.watcher.settle();
    expect(w.profiles.get(6648)).toMatchObject({ framework: 'codex-cli', updatedBy: 'system:never-silent:tap' });
    expect(w.respawns).toHaveLength(1);
    expect(await w.ns.handleTelegramTap({ data: w.sent[0]!.button!.data, fromIsOwner: true })).toMatch(/Already moving/);
    expect(w.respawns).toHaveLength(1);
  });

  it('a failed restart undoes the move and keeps the operator\'s choice', async () => {
    const { stateDir } = await boot();
    const w = wiring(stateDir, { respawnTopic: async () => { throw new Error('spawn failed'); } });
    w.profiles.set(6649, { framework: 'claude-code', updatedBy: 'telegram:justin' });
    w.ns.observeLogged('telegram', '6649', { messageId: '1', text: 'hello?', fromUser: true });
    w.advance(121_000);
    await w.ns.watcher.tick();
    const nonce = w.sent[0]!.button!.data;
    expect(await w.ns.handleTelegramTap({ data: nonce, fromIsOwner: true })).toMatch(/Moving this conversation/);
    await w.ns.watcher.settle();
    expect(w.profiles.get(6649)).toEqual({ framework: 'claude-code', updatedBy: 'telegram:justin' });
    expect(w.sent.at(-1)!.text).toMatch(/couldn't move this conversation to Codex/);
  });

  it('the move back restores an operator pin under the restored-pin label, and it still counts as a pin', async () => {
    const { stateDir } = await boot();
    let healthy = false;
    const w = wiring(stateDir, { loginCheck: (id) => (id === 'claude-monroe' ? (healthy ? 'ok' : 'signed-out') : 'ok'),
      poolAccounts: () => [
        { id: 'claude-monroe', framework: 'claude-code', configHome: '/h/monroe', status: healthy ? 'active' : 'needs-reauth' },
        { id: 'codex-1', framework: 'codex-cli', configHome: '/h/codex1', status: 'active' },
      ] });
    w.profiles.set(6650, { framework: 'claude-code', updatedBy: 'telegram:justin' });
    w.ns.observeLogged('telegram', '6650', { messageId: '1', text: 'hello?', fromUser: true });
    w.advance(121_000);
    await w.ns.watcher.tick();
    await w.ns.handleTelegramTap({ data: w.sent[0]!.button!.data, fromIsOwner: true });
    await w.ns.watcher.settle();
    w.ns.observeLogged('telegram', '6650', { messageId: '2', text: 'Sorry for the wait — here it is.', fromUser: false, provenance: 'agent' });
    healthy = true;
    await w.ns.watcher.tick();
    expect(w.profiles.get(6650)).toEqual({ framework: 'claude-code', updatedBy: 'system:never-silent:restored-pin:telegram:justin' });
    // Still a pin: the next silence asks again instead of moving on its own.
    healthy = false;
    w.advance(7 * 60 * 60_000);
    w.ns.observeLogged('telegram', '6650', { messageId: '3', text: 'again?', fromUser: true });
    w.advance(121_000);
    await w.ns.watcher.tick();
    expect(w.sent.at(-1)!.button?.text).toBe('Move to Codex');
  });

  it('a referee that is down still ends in a delivered notice (never "nothing")', async () => {
    const { stateDir } = await boot();
    const down = { evaluate: async () => { throw new Error('signed out'); } } as unknown as IntelligenceProvider;
    const w = wiring(stateDir, { refereeFor: (fw) => (fw === 'codex-cli' ? down : null) });
    w.ns.observeLogged('telegram', '10375', { messageId: '1', text: 'are you there?', fromUser: true });
    w.advance(121_000);
    await w.ns.watcher.tick();
    expect(w.respawns).toHaveLength(0);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.text).toMatch(/wasn't answered yet/);
  });
});

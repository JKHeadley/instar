/**
 * Integration (docs/specs/never-silent-conversation.md §6): GET /never-silent/incidents over the
 * real HTTP pipeline, and "exactly one notice" when the judge throws, never returns, or cannot
 * tell — the action never blocks the notice.
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
import { buildNeverSilent } from '../../src/monitoring/neverSilent/neverSilentWiring.js';
import { setNeverSilentInstance } from '../../src/server/neverSilentRoutes.js';
import type { IntelligenceProvider, InstarConfig } from '../../src/core/types.js';

const dirs: string[] = [];
const servers: AgentServer[] = [];
afterAll(async () => {
  setNeverSilentInstance(null);
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/never-silent-routes.test.ts' });
});

function setup(referee: IntelligenceProvider | null) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'ns-int-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs', 'server-data']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  const config = {
    projectName: 'ns-int', projectDir: dir, stateDir, port: 0, developmentAgent: true,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {}, monitoring: {},
  } as unknown as InstarConfig;
  const sm = createMockSessionManager() as never as { on?: unknown };
  sm.on = () => undefined;
  const server = new AgentServer({ config, sessionManager: sm as never, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), commitmentTracker: new CommitmentTracker({ stateDir }) } as never);
  servers.push(server);
  let t = 5_000_000;
  const sent: string[] = [];
  const ns = buildNeverSilent({
    stateDir, logsDir: path.join(dir, 'logs'),
    config: () => ({ enabled: true, judge: true, actions: true, frameworkFallback: true, confidenceFloor: 0.8, noticeAfterMs: 60_000 }),
    sessionForTelegramTopic: () => 'agent-topic', sessionForSlackChannel: () => null,
    sessionFacts: () => ({ framework: 'claude-code', accountId: 'a', configHome: null, alive: true, startedAt: 1 }),
    isProtected: () => false,
    capturePane: () => '> ',
    poolAccounts: () => [{ id: 'c', framework: 'codex-cli', configHome: '/h/c', status: 'active' }],
    loginCheck: () => 'ok',
    observeLoginExpired: async () => {}, repairStarted: () => false, swap: async () => ({ swapped: false }),
    profileFor: () => null, writeFramework: async () => true, respawnTopic: async () => true,
    readJevKey: () => null, refereeFor: () => referee,
    sendTelegramNotice: async (_topic, text) => { sent.push(text); return String(sent.length); },
    sendSlackNotice: async () => null,
    now: () => t,
  });
  setNeverSilentInstance({ store: ns.store, enabled: () => true });
  return { server, ns, sent, advance: (ms: number) => { t += ms; } };
}

const cases: Array<[string, IntelligenceProvider | null]> = [
  ['throws', { evaluate: async () => { throw new Error('down'); } } as unknown as IntelligenceProvider],
  ['returns undetermined (unparseable)', { evaluate: async () => 'no idea' } as unknown as IntelligenceProvider],
  ['has no route at all', null],
];

describe('never-silent HTTP pipeline', () => {
  for (const [name, referee] of cases) {
    it(`an unanswered message yields exactly one notice when the judge ${name}`, async () => {
      const h = setup(referee);
      h.ns.observeLogged('telegram', '42', { messageId: '1', text: 'hi', fromUser: true });
      h.advance(61_000);
      await h.ns.watcher.tick();
      await h.ns.watcher.tick();
      expect(h.sent).toHaveLength(1);
      const res = await request(h.server.getApp()).get('/never-silent/incidents?open=1');
      expect(res.status).toBe(200);
      expect(res.body.counts.openObligations).toBe(1);
      expect(res.body.obligations[0]).toMatchObject({ state: 'told-pending', text: null });
      expect(res.body.incidents[0].notices).toHaveLength(1);
    });
  }

  it('a judge that never returns does not hold back the notice past its own bounded call', async () => {
    const hang = { evaluate: () => new Promise<string>(() => {}) } as unknown as IntelligenceProvider;
    const h = setup(hang);
    // The judge's own deadline is the bound; this proves the sweep finishes and tells.
    (h.ns.watcher as unknown as { d: { judge: { deps: { refereeTimeoutMs: number } } } }).d.judge.deps.refereeTimeoutMs = 20;
    h.ns.observeLogged('telegram', '43', { messageId: '1', text: 'hi', fromUser: true });
    h.advance(61_000);
    await h.ns.watcher.tick();
    expect(h.sent).toHaveLength(1);
  });

  it('the read surface never carries the waiting text and honours ?open=1', async () => {
    const h = setup(null);
    h.ns.observeLogged('telegram', '44', { messageId: '1', text: 'private words', fromUser: true });
    h.ns.observeLogged('telegram', '44', { messageId: '2', text: 'Here you go.', fromUser: false, provenance: 'agent' });
    const all = await request(h.server.getApp()).get('/never-silent/incidents');
    const open = await request(h.server.getApp()).get('/never-silent/incidents?open=1');
    expect(JSON.stringify(all.body)).not.toContain('private words');
    expect(all.body.obligations[0]).toMatchObject({ state: 'answered' });
    expect(open.body.obligations).toHaveLength(0);
  });
});

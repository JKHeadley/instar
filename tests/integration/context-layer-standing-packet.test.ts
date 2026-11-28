// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Integration — the standing packet through the REAL AgentServer and routes,
 * with a real TopicMemory (context-budget-layered-summaries §9.5, §9.7; Phase
 * 1 S10): `GET /topic/:id/standing-packet` reports sizes, sections and the
 * verifier's verdict and never the words; a protected reference whose hash no
 * longer matches its TopicMemory row fails verification, is never staged, and
 * is counted on `GET /context-budget/layers`; the capability index lists the
 * route; with the layers off the route is 503.
 */
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createConversationBindAuth } from '../../src/core/conversationBindToken.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { readKeepInstructionsPointer } from '../../src/monitoring/keepInstructions.js';
import { buildContextLayers } from '../../src/monitoring/contextLayers/contextLayersBoot.js';
import { wireStandingPacket } from '../../src/monitoring/contextLayers/standingPacketBoot.js';
import { readProjectAnchorFixture } from '../fixtures/project-standing-anchor.js';
import { readStandingPacketPointer, type ReadProjectAnchor } from '../../src/monitoring/contextLayers/standingPacket.js';
import { rowRefFor } from '../../src/monitoring/contextLayers/LayerStore.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import type { InstarConfig } from '../../src/core/types.js';

const OP = 'tests/integration/context-layer-standing-packet.test.ts';
const TOKEN = 'sp-it-token-0123456789abcdef01234';
const T = 141133;
const WORDS = 'OPERATOR-WORDS: the packet must never paraphrase me.';

describe('standing packet — real AgentServer', () => {
  const dirs: string[] = [];
  const servers: AgentServer[] = [];
  const mems: TopicMemory[] = [];
  const stops: Array<() => void> = [];
  afterEach(async () => {
    for (const s of stops.splice(0)) s();
    for (const s of servers.splice(0)) await s.stop();
    for (const m of mems.splice(0)) m.close();
    for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
  });

  async function boot(o: { layers: boolean; readProjectAnchor?: ReadProjectAnchor; operatorBindingFingerprint?: () => string; currentSession?: () => boolean; currentOwner?: () => boolean }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-it-')); dirs.push(root);
    const stateDir = path.join(root, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'sp-it' }));
    const config = {
      projectName: 'sp-it', projectDir: root, stateDir, port: 0, authToken: TOKEN, requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: { deliveryFailureSentinel: { enabled: false } }, updates: {}, secrets: { forceFileKey: true },
    } as unknown as InstarConfig;
    const sessions = [{ id: 'inst-1', telegramTopicId: T, framework: 'claude-code', tmuxSession: 'fixture-session' }];
    const sessionManager = Object.assign(new EventEmitter(), {
      listRunningSessions: () => sessions,
      getCachedRunningSessions: () => ({ count: 0, sessions: [] }),
      getSession: () => null,
      getSessionById: () => undefined,
      setClaudeSessionId: () => undefined,
      matchesCurrentConversationBindToken: async () => o.currentSession?.() === true,
    });
    const topicMemory = new TopicMemory(stateDir); await topicMemory.open(); mems.push(topicMemory);
    topicMemory.insertMessage({ messageId: 1, topicId: T, text: WORDS, fromUser: true, timestamp: new Date(Date.UTC(2026, 10, 10, 10)).toISOString(), sessionName: null });
    topicMemory.insertMessage({ messageId: 2, topicId: T, text: 'second operator turn', fromUser: true, timestamp: new Date(Date.UTC(2026, 10, 10, 10, 2)).toISOString(), sessionName: null });
    const layers = o.layers ? buildContextLayers({ stateDir, authToken: TOKEN }) : undefined;
    if (layers) { const s = wireStandingPacket({ layers, stateDir, topicMemory, readProjectAnchor: o.readProjectAnchor, isOperator: o.currentOwner ? () => o.currentOwner!() : undefined, operatorBindingFingerprint: o.operatorBindingFingerprint, sessions: () => sessions, debounceMs: 60_000 }); stops.push(() => s.stop()); }
    const bindAuth = createConversationBindAuth(stateDir);
    const server = new AgentServer({ config, conversationBindAuth: bindAuth, sessionManager: sessionManager as never, state: new StateManager(stateDir), topicMemory, contextLayers: layers });
    await server.start();
    servers.push(server);
    return { server, layers, stateDir, bindAuth };
  }

  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${TOKEN}`);
  const meta = { author: { sessionId: null, machine: 'm_it', model: null, kind: 'derived' as const }, asOf: { at: Date.now(), lastMessageId: 2 } };

  it('layers on: sizes, sections and a passing verdict, never the words; the route is in the capability index', async () => {
    const b = await boot({ layers: true });
    const store = b.layers!.store;
    store.writeProtected(String(T), 'u', 'm-1', [rowRefFor(1, WORDS)], meta, { label: 'operator', authority: 'operator', rowId: 1, at: Date.now() });
    store.writeProtected(String(T), 'anchor', 'current', [rowRefFor(1, WORDS)], { ...meta, status: 'anchored' }, { at: [Date.now()] });
    const app = b.server.getApp();
    const res = await auth(request(app).get(`/topic/${T}/standing-packet`));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ topicId: T, protectedRows: 1, reduced: false, verification: { ok: true, problems: [] }, budget: { deliveredMaxChars: 6000, hookLimitChars: 10_000 } });
    expect(res.body.sections.map((s: { key: string }) => s.key)).toEqual(['anchor', 'ledger', 'recent', 'h1', 'h2', 'h3', 'chunks', 'omitted']);
    expect(res.body.sections.find((s: { key: string }) => s.key === 'h1')).toMatchObject({ present: false, absent: true });
    expect(JSON.stringify(res.body)).not.toContain('OPERATOR-WORDS');
    expect(res.body.staged).toBeNull();                      // the view never stages; the debounced commit path does
    expect((await request(app).get(`/topic/${T}/standing-packet`)).status).toBe(401);
    const caps = await auth(request(app).get('/capabilities'));
    expect(JSON.stringify(caps.body)).toContain('GET /topic/:id/standing-packet');
  });

  it('a protected reference that no longer matches its TopicMemory row fails verification, is never staged, and is counted', async () => {
    const b = await boot({ layers: true });
    const store = b.layers!.store;
    // The stored reference was taken from different text: the row in TopicMemory no longer matches it.
    store.writeProtected(String(T), 'u', 'm-2', [rowRefFor(2, 'what the operator wrote before an edit')], meta, { label: 'operator', authority: 'operator', rowId: 2, at: Date.now() });
    const r = b.layers!.standingPacket()!.stageNow(String(T));
    expect(r).toMatchObject({ ok: false, reason: 'verify-failed' });
    expect(readStandingPacketPointer(b.stateDir, String(T))).toBeNull();
    const app = b.server.getApp();
    const view = await auth(request(app).get(`/topic/${T}/standing-packet`));
    expect(view.body.verification.ok).toBe(false);
    expect(view.body.verification.problems).toContain('protected-hash-mismatch');
    const layers = await auth(request(app).get('/context-budget/layers'));
    expect(layers.body.standingPacket).toMatchObject({ verifyFailed: 1, staged: 0 });
  });

  it('confirms only the current staged project anchor to the authenticated recovery hook', async () => {
    let bound = true;
    const b = await boot({
      layers: true,
      readProjectAnchor: (key) => bound ? readProjectAnchorFixture(key) : { status: 'ambiguous' },
    });
    const staged = b.layers!.standingPacket()!.stageNow(String(T));
    if (!staged.ok) throw new Error(staged.reason);
    const url = `/topic/${T}/standing-packet/anchor-current?packetHash=${staged.pointer.sha256}`;
    const app = b.server.getApp();
    expect((await request(app).get(url)).status).toBe(401);
    expect((await auth(request(app).get(url))).body).toEqual({ current: true });
    const view = () => auth(request(app).get(`/topic/${T}/standing-packet`));
    expect((await view()).body.projectAnchor).toEqual({ verified: true, stagedCurrent: true });
    bound = false;
    expect((await auth(request(app).get(url))).body).toEqual({ current: false });
    expect((await view()).body.projectAnchor).toEqual({ verified: false, stagedCurrent: false });
  });

  it('authenticates recovered and keep hash checks and rejects both after owner rotation', async () => {
    let owner = 'first-owner';
    const b = await boot({ layers: true, operatorBindingFingerprint: () => owner });
    const staged = b.layers!.standingPacket()!.stageNow(String(T));
    if (!staged.ok) throw new Error(staged.reason);
    const keep = readKeepInstructionsPointer(b.stateDir, 'inst-1')!;
    const urls = [
      `/topic/${T}/standing-packet/recovery-current?packetHash=${staged.pointer.sha256}`,
      `/standing-packet/keep-current/inst-1?packetHash=${keep.sha256}`,
    ];
    const app = b.server.getApp();
    for (const url of urls) {
      expect((await request(app).get(url)).status).toBe(401);
      expect((await auth(request(app).get(url))).body).toEqual({ current: true });
    }
    owner = 'second-owner';
    for (const url of urls) expect((await auth(request(app).get(url))).body).toEqual({ current: false });
  });

  it('rebuilds the full continuation only for the current bound session', async () => {
    let currentSession = true;
    let currentOwner = true;
    const b = await boot({
      layers: true, operatorBindingFingerprint: () => currentOwner ? 'first' : 'second',
      currentOwner: () => currentOwner, currentSession: () => currentSession,
    });
    const store = b.layers!.store;
    store.writeProtected(String(T), 'anchor', 'current', [rowRefFor(1, WORDS)],
      { ...meta, status: 'anchored' }, { at: [Date.now()] });
    const app = b.server.getApp();
    const url = `/topic/${T}/standing-packet/full`;
    const read = (token: string) => auth(request(app).get(url)).set('X-Instar-Bind-Token', token);
    const token = b.bindAuth.mint('fixture-session', [T]);
    expect((await auth(request(app).get(url))).status).toBe(403);
    expect((await read(b.bindAuth.mint('fixture-session', [T + 1]))).status).toBe(403);
    expect((await read(token)).text).toContain(WORDS);

    currentOwner = false;
    const renewed = await read(token);
    expect(renewed.status).toBe(200);
    expect(renewed.text).not.toContain(WORDS);
    expect(renewed.headers['cache-control']).toBe('no-store');
    currentSession = false;
    expect((await read(token)).status).toBe(403);
  });

  it('layers off: 503', async () => {
    const b = await boot({ layers: false });
    const res = await auth(request(b.server.getApp()).get(`/topic/${T}/standing-packet`));
    expect(res.status).toBe(503);
    expect(res.body.enableWith).toBe('contextBudget.enabled');
  });
});

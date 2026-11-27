// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * e2e — the standing packet is ALIVE on the production init path
 * (context-budget-layered-summaries §9.5, Phase 1 S10): with server.ts's own
 * gate the layers are built and `wireStandingPacket` attaches the stager the
 * way server.ts does (TopicMemory rows, the topic-intent reader, the session
 * list); a committed layer write for a topic with a live session re-renders,
 * verifies and stages its packet and writes the session's keep-instructions;
 * `GET /topic/:id/standing-packet` returns 200 with sizes and verdicts and
 * never the words; the spawn path's `formatContextForSession` carries the
 * packet. A fleet agent (layers off) gets 503, and any packet a previous run
 * staged is cleared, so recovery is exactly today's. Plus WIRED source checks.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildContextLayers, contextLayersEnabled, type ContextLayers } from '../../src/monitoring/contextLayers/contextLayersBoot.js';
import { PROJECT_ANCHOR_FIXTURE_LINE, persistedProjectAnchorFixture } from '../fixtures/project-standing-anchor.js';
import { wireProjectAnchorRegistry, wireStandingPacket } from '../../src/monitoring/contextLayers/standingPacketBoot.js';
import { clearStagedStandingPackets, readStandingPacketPointer, standingPacketDir, SECTION } from '../../src/monitoring/contextLayers/standingPacket.js';
import { rowRefFor } from '../../src/monitoring/contextLayers/LayerStore.js';
import { readKeepInstructionsPointer } from '../../src/monitoring/keepInstructions.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { TopicIntentStore } from '../../src/core/TopicIntent.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { ProjectAnchorHistoryReader } from '../../src/core/ProjectAnchorRegistry.js';
import { projectPurposeDesignationDigest } from '../../src/core/ProjectPurposePilot.js';

const OP = 'tests/e2e/context-layer-standing-packet-alive.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const T = 141133;
const FRAME = 'SECRET-SHAPED-WORDS frame: keep long topics coherent across compactions.';

describe('standing packet — alive on the production init path', () => {
  const dirs: string[] = [];
  const mems: TopicMemory[] = [];
  const stops: Array<() => void> = [];
  afterEach(() => {
    for (const s of stops.splice(0)) s();
    for (const m of mems.splice(0)) m.close();
    for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
  });

  async function boot(config: { developmentAgent?: boolean; contextBudget?: { enabled?: boolean } }, o: { preStaged?: boolean; history?: ProjectAnchorHistoryReader; allowedDesignationDigest?: string; designation?: object } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clsp-e2e-')); dirs.push(root);
    const sd = path.join(root, '.instar');
    fs.mkdirSync(sd);
    if (o.preStaged) {
      fs.mkdirSync(standingPacketDir(sd), { recursive: true });
      fs.writeFileSync(path.join(standingPacketDir(sd), `${T}.json`), JSON.stringify({ schema: 'standing-packet/1', topicKey: String(T) }));
      fs.writeFileSync(path.join(standingPacketDir(sd), `${T}.md`), 'stale');
    }
    const topicMemory = new TopicMemory(sd); await topicMemory.open(); mems.push(topicMemory);
    topicMemory.insertMessage({ messageId: 1, topicId: T, text: FRAME, fromUser: true, timestamp: new Date(Date.UTC(2026, 10, 10, 10)).toISOString(), sessionName: null });
    topicMemory.insertMessage({ messageId: 2, topicId: T, text: 'agent reply', fromUser: false, timestamp: new Date(Date.UTC(2026, 10, 10, 10, 1)).toISOString(), sessionName: null });
    const topicIntentStore = new TopicIntentStore(sd);
    const sessions = [{ id: 'inst-live', telegramTopicId: T, framework: 'claude-code' }];
    // server.ts: the layers, gated; then the standing packet, or the off-path cleanup.
    const _contextLayers: ContextLayers | null = contextLayersEnabled(config, config.contextBudget?.enabled) ? buildContextLayers({ stateDir: sd, authToken: 'e2e-auth-token-0123456789' }) : null;
    const registry = _contextLayers ? await persistedProjectAnchorFixture(sd, !o.history) : null;
    if (o.designation) {
      fs.mkdirSync(path.join(sd, 'state'), { recursive: true });
      fs.writeFileSync(path.join(sd, 'state', 'project-purpose-pilot.json'), JSON.stringify(o.designation), { mode: 0o600 });
    }
    if (_contextLayers && registry) {
      const stager = wireStandingPacket({ layers: _contextLayers, stateDir: sd, topicMemory, intent: (t) => topicIntentStore.read(t), sessions: () => sessions, debounceMs: 5 });
      stops.push(wireProjectAnchorRegistry(stager, registry, {
        stateDir: sd, history: o.history, machineId: 'fixture-studio', allowedDesignationDigest: o.allowedDesignationDigest,
      }), () => stager.stop());
    } else {
      clearStagedStandingPackets(sd);
    }
    const ctx = {
      config: { projectName: 'e2e', projectDir: root, stateDir: sd, port: 0, authToken: 'e2e-auth-token-0123456789' } as never,
      sessionManager: { listRunningSessions: () => sessions } as never,
      state: { getJobState: () => null, getSession: () => null } as never,
      scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
      updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
      publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
      triageNurse: null, topicMemory, topicIntentStore, feedbackAnomalyDetector: null, discoveryEvaluator: null,
      startTime: new Date(), contextLayers: _contextLayers,
    } as unknown as RouteContext;
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctx));
    return { app, layers: _contextLayers, topicMemory, registry, sd };
  }

  it('dev agent: a layer commit stages a verified packet and keep-instructions; the route is 200 with sizes only; the spawn context carries it', async () => {
    const b = await boot({ developmentAgent: true });
    const store = b.layers!.store;
    const meta = { author: { sessionId: null, machine: 'm_e2e', model: null, kind: 'derived' as const }, asOf: { at: Date.now(), lastMessageId: 2 } };
    store.writeProtected(String(T), 'u', 'm-1', [rowRefFor(1, FRAME)], meta, { label: 'operator', authority: 'operator', rowId: 1, at: Date.now() });
    store.writeProtected(String(T), 'anchor', 'current', [rowRefFor(1, FRAME)], { ...meta, status: 'anchored' }, { at: [Date.now()] });
    store.writeDerived(String(T), 'h1', 'current', { goal: 'keep topics coherent', trend: 'building', themes: [] }, { ...meta, status: 'live' });
    await new Promise((r) => setTimeout(r, 60));
    const ptr = readStandingPacketPointer(b.sd, String(T));
    expect(ptr).toMatchObject({ verified: true, reduced: false, protectedRows: 1 });
    const staged = fs.readFileSync(path.join(standingPacketDir(b.sd), `${T}.md`), 'utf-8');
    expect(staged).toContain(FRAME);
    expect(staged.indexOf(PROJECT_ANCHOR_FIXTURE_LINE)).toBeGreaterThan(0);
    expect(staged.indexOf(PROJECT_ANCHOR_FIXTURE_LINE)).toBeLessThan(staged.indexOf(FRAME));
    expect(readKeepInstructionsPointer(b.sd, 'inst-live')?.source).toBe('standing-packet');

    const res = await request(b.app).get(`/topic/${T}/standing-packet`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ topicId: T, reduced: false, protectedRows: 1, verification: { ok: true, problems: [] }, staged: { protectedRows: 1 } });
    expect(res.body.deliveredChars).toBeLessThanOrEqual(res.body.budget.deliveredMaxChars);
    expect(JSON.stringify(res.body)).not.toContain('SECRET-SHAPED-WORDS');
    expect(JSON.stringify(res.body)).not.toContain('Fixture purpose');
    expect(res.body.deliveredChars).toBe(staged.length);
    const check = `/topic/${T}/standing-packet/anchor-current`;
    expect((await request(b.app).get(check).query({ packetHash: ptr!.sha256 })).body).toEqual({ current: true });
    expect((await request(b.app).get(check).query({ packetHash: '0'.repeat(64) })).body).toEqual({ current: false });
    expect((await request(b.app).get('/context-budget/layers')).body.standingPacket).toMatchObject({ verifyFailed: 0 });
    expect((await request(b.app).get('/topic/abc/standing-packet')).status).toBe(400);

    // The spawn path (server.ts): formatContextForSession with the verified packet in the summary's place.
    const packet = b.layers!.standingPacket()!.packetForSession(T);
    const spawnCtx = b.topicMemory.formatContextForSession(T, 50, { standingPacket: packet });
    expect(spawnCtx).toContain('=== STANDING PACKET (topic 141133');
    expect(spawnCtx).toContain(FRAME);
    expect(spawnCtx).toContain(PROJECT_ANCHOR_FIXTURE_LINE);
    expect(spawnCtx).toContain('agent reply');
    expect(spawnCtx).not.toContain('CONVERSATION SUMMARY:');
    const project = b.registry!.get('context-budget')!;
    const current = project.approvedProjectAnchor!.anchor;
    await b.registry!.approveProjectAnchor(project.id, project.version ?? 1, `telegram:${T}`, {
      ...current, revision: 2, purpose: 'Updated fixture purpose',
    });
    await expect.poll(() => fs.readFileSync(path.join(standingPacketDir(b.sd), `${T}.md`), 'utf-8'))
      .toContain('\nUpdated fixture purpose\n[end project purpose quote ');

  });

  it('recovers only the exact original Studio proposal and withdraws it when the designation changes', async () => {
    const purpose = 'Verbatim owner purpose.\nKeep the project aligned after compression — café.\n';
    const source = { conversationKey: 'telegram:141385', messageId: '101', at: '2026-11-26T23:09:34.000Z' };
    const row = { fromUser: true, forwarded: false, telegramUserId: 123, timestamp: source.at, text: purpose };
    const grant = {
      projectId: 'context-budget', conversationKey: `telegram:${T}`, source,
      purposeSha256: createHash('sha256').update(purpose).digest('hex'),
    };
    const allowedDesignationDigest = projectPurposeDesignationDigest('fixture-studio', 123, grant);
    const b = await boot({ developmentAgent: true }, { history: {
      getVerifiedOwner: () => 123,
      findTopicMessage: (topic, id, after) => ({
        entry: topic === 141385 && [101, 102].includes(id) && after === Date.parse(source.at) ? row : null,
      }),
    }, allowedDesignationDigest, designation: grant });
    const designation = path.join(b.sd, 'state', 'project-purpose-pilot.json');
    const stager = b.layers!.standingPacket()!;
    expect(stager.packetForSession(T)).toContain(`${SECTION.anchor}\nProject purpose for context-budget (proposed, not yet confirmed)`);
    expect(stager.packetForSession(T)).toContain(`\n${purpose}\n[end project purpose quote `);
    expect(stager.packetForSession(141385)).not.toContain(purpose);
    expect((await request(b.app).get(`/topic/${T}/standing-packet`)).text).not.toContain('Verbatim owner purpose.');
    const hash = readStandingPacketPointer(b.sd, String(T))!.sha256;
    const current = `/topic/${T}/standing-packet/anchor-current`;
    expect((await request(b.app).get(current).query({ packetHash: hash })).body).toEqual({ current: true });
    fs.writeFileSync(designation, JSON.stringify({ ...grant, source: { ...source, messageId: '102' } }));
    expect((await request(b.app).get(current).query({ packetHash: hash })).body).toEqual({ current: false });
    fs.writeFileSync(designation, JSON.stringify(grant));
    expect((await request(b.app).get(current).query({ packetHash: hash })).body).toEqual({ current: true });
    fs.writeFileSync(designation, '{}');
    expect((await request(b.app).get(current).query({ packetHash: hash })).body).toEqual({ current: false });
    expect(stager.packetForSession(T)).not.toContain(purpose);
    expect(b.registry!.get('context-budget')?.approvedProjectAnchor).toBeUndefined();
  });

  it('fleet agent: 503, no stager, and a packet a previous run staged is cleared (recovery is exactly today\'s)', async () => {
    const b = await boot({}, { preStaged: true });
    expect(b.layers).toBeNull();
    expect((await request(b.app).get(`/topic/${T}/standing-packet`)).status).toBe(503);
    expect(fs.existsSync(path.join(standingPacketDir(b.sd), `${T}.json`))).toBe(false);
    expect(b.topicMemory.formatContextForSession(T, 50)).not.toContain('STANDING PACKET');
  });

  it('WIRED: server.ts attaches the stager under the layers gate, clears it off, and both spawn and resume read the packet', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    expect(src).toContain("const { wireStandingPacket } = await import('../monitoring/contextLayers/standingPacketBoot.js');");
    expect(src).toContain('try { clearStagedStandingPackets(config.stateDir); }');
    expect(src).toContain('const standingPacket = _contextLayers?.standingPacket()?.packetForSession(topicId) ?? null;');
    expect(src).toMatch(/const standingPacket = liveConfig\.get<boolean>\('contextBudget\.compactionRecovery\.enabled', true\) !== false\n\s+\? \(_contextLayers\?\.standingPacket\(\)\?\.packetForSession\(topicId\) \?\? null\)/);
    expect(src).toContain('contextContent = topicMemory.formatContextForSession(topicId, 50, { standingPacket });');
    expect(src).toContain('contextBlock = topicMemory.formatContextForSession(topicId, 20, { standingPacket });');
    const boot = fs.readFileSync(path.join(ROOT, 'src/monitoring/contextLayers/contextLayersBoot.ts'), 'utf-8');
    expect(boot).toContain('if (standingPacket && PACKET_INPUT_TYPES.has(recordType)) standingPacket.request(topicKey);');
    const routes = fs.readFileSync(path.join(ROOT, 'src/server/routes.ts'), 'utf-8');
    expect(routes).toContain("router.get('/topic/:id/standing-packet'");
  });
});

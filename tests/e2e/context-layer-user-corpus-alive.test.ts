// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * e2e — U and its referent stubs are ALIVE on the production init path
 * (context-budget-layered-summaries Phase 1, §6 row U, §6.4, §8): with the
 * layers on, the boot path builds the layer store, wires the capture loop
 * through `wireLayerCapture` with TopicMemory and the memory-privacy operator
 * binding exactly as server.ts does, and a captured operator message yields a
 * protected U record plus a validated stub from the SAME extractor call; the
 * real route serves the U size. With the layers off nothing is wired, the
 * extractor prompt asks for no stub and the route is 503. Plus WIRED source
 * checks on server.ts, routes.ts and the capture seam.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { TopicIntentStore } from '../../src/core/TopicIntent.js';
import { TopicIntentExtractor, createLlmExtractFn } from '../../src/core/TopicIntentExtractor.js';
import { createCaptureLoop } from '../../src/core/TopicIntentCapture.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { buildContextLayers, contextLayersEnabled } from '../../src/monitoring/contextLayers/contextLayersBoot.js';
import { rowRefMatches } from '../../src/monitoring/contextLayers/LayerStore.js';
import { MemoryPrivacy } from '../../src/users/MemoryPrivacy.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const OP = 'tests/e2e/context-layer-user-corpus-alive.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const T = 141133;
const OWNER = 111;

describe('U with referent stubs — alive on the production init path', () => {
  const dirs: string[] = [];
  const mems: TopicMemory[] = [];
  afterEach(() => {
    for (const m of mems.splice(0)) { try { m.close(); } catch { /* best-effort */ } }
    for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
  });

  async function boot(config: { developmentAgent?: boolean; contextBudget?: { enabled?: boolean } }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-u-e2e-')); dirs.push(root);
    const sd = path.join(root, 'agent'); fs.mkdirSync(sd, { recursive: true });
    const topicMemory = new TopicMemory(sd); await topicMemory.open(); mems.push(topicMemory);
    const topicIntentStore = new TopicIntentStore(sd);
    // server.ts: memory privacy is wired before any adapter; its binding names the operator.
    const _memoryPrivacyWired = new MemoryPrivacy({ stateDir: sd, instarRoot: root, agentId: 'e2e', config: () => ({}), users: () => [], reachable: () => ({ telegramOwnerId: OWNER }) });
    _memoryPrivacyWired.establishBaseline();
    // server.ts: the store, gated.
    const _contextLayers = contextLayersEnabled(config, config.contextBudget?.enabled) ? buildContextLayers({ stateDir: sd }) : null;
    const prompts: string[] = [];
    const provider: IntelligenceProvider = {
      async evaluate(prompt: string) {
        prompts.push(prompt);
        const l = (g: string) => ({ goal: g, trend: 'converging on a choice', themes: ['gate'] });
        return JSON.stringify({
          signals: [],
          awareness: { topic: l('design the gate'), recentArc: l('block or warn'), currentWork: l('settle block vs warn'), arcTransition: { kind: 'continue' } },
          ...(prompt.includes('"referentStub"') ? { referentStub: { stub: '[answering: should the gate block or warn?]', kind: 'answer', refersTo: '500' } } : {}),
        });
      },
    };
    const captureExtractor = new TopicIntentExtractor(topicIntentStore, createLlmExtractFn(provider));
    // server.ts: the capture block's layer wiring (dynamic import, same call shape).
    const layerWiring = _contextLayers
      ? (await import('../../src/monitoring/contextLayers/layerCaptureWiring.js')).wireLayerCapture({
          layers: _contextLayers, store: topicIntentStore, sessions: { listRunningSessions: () => [], checkSessionWorkState: async () => 'idle' as const },
          machine: 'm_e2e', projectDir: sd,
          topicMemory: topicMemory ?? null,
          isOperator: ({ senderKey, userId }) => _memoryPrivacyWired.isOperator(senderKey) || _memoryPrivacyWired.isOwnerSender(senderKey, userId),
          bindingFingerprint: () => _memoryPrivacyWired.operatorBindingFingerprint(),
        })
      : null;
    const captureLoop = createCaptureLoop({ ...(layerWiring ? layerWiring.captureDeps : {}), extractor: captureExtractor, store: topicIntentStore, topicMemory });
    // AgentServer → createRoutes with the layers in the route context.
    const ctx = {
      config: { projectName: 'echo', projectDir: sd, stateDir: sd, port: 0 } as never,
      sessionManager: { listRunningSessions: () => [] } as never,
      state: { getJobState: () => null, getSession: () => null } as never,
      scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
      updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
      publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
      triageNurse: null, topicMemory, feedbackAnomalyDetector: null, discoveryEvaluator: null,
      startTime: new Date(),
      contextLayers: _contextLayers,
    } as unknown as RouteContext;
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctx));
    // The Telegram dual-write lands the row first, then capture runs (server.ts order).
    const say = async (messageId: number, text: string, fromUser: boolean) => {
      topicMemory.insertMessage({ messageId, topicId: T, text, fromUser, timestamp: new Date(Date.UTC(2026, 10, 10, 10, 0, messageId % 60)).toISOString(), sessionName: null, forwarded: false, ...(fromUser ? { telegramUserId: OWNER } : {}) });
      return captureLoop({ messageId, topicId: T, text, fromUser, timestamp: Date.now() });
    };
    return { sd, app, layers: _contextLayers, layerWiring, say, prompts };
  }

  it('dev agent: a captured operator message yields a U record and a stub from the same call; the route serves the U size', async () => {
    const b = await boot({ developmentAgent: true });
    expect(b.layerWiring?.userCorpus).not.toBeNull();
    expect((await b.say(500, 'Should the gate block or warn?', false)).status).toBe('captured');
    const words = 'Block. Warnings get ignored in practice.';
    expect((await b.say(501, words, true)).status).toBe('captured');
    expect(b.prompts).toHaveLength(2);
    expect(b.prompts[1]).toContain('"referentStub"');
    const u = b.layers!.store.read(String(T), 'u', 'm-501')!;
    expect(u.data).toMatchObject({ label: 'operator', authority: 'operator' });
    expect(rowRefMatches(u.rows![0], words)).toBe(true);
    expect(b.layers!.store.read(String(T), 'u-stub', 'm-501')).toMatchObject({ author: { kind: 'derived' }, data: { kind: 'answer', refersTo: 500 } });
    const r = await request(b.app).get(`/topic/${T}/user-corpus`);
    expect(r.status).toBe(200);
    expect(r.body.protected).toMatchObject({ messages: 1, tokens: Math.ceil(words.length / 4) });
    expect(r.body.stubs.coverage).toBe(1);
    expect(r.text).not.toContain('Warnings get ignored');
    expect(b.layers!.status().userCorpus).toMatchObject({ operatorBinding: 'wired' });
  });

  it('fleet agent: nothing wired, no U records, no stub asked for, the route is 503', async () => {
    const b = await boot({});
    expect(b.layers).toBeNull();
    await b.say(500, 'Should the gate block or warn?', false);
    expect((await b.say(501, 'Block. Warnings get ignored in practice.', true)).status).toBe('captured');
    expect(b.prompts.some((p) => p.includes('referentStub'))).toBe(false);
    expect(fs.existsSync(path.join(b.sd, 'state', 'context-layers'))).toBe(false);
    expect((await request(b.app).get(`/topic/${T}/user-corpus`)).status).toBe(503);
  });

  it('WIRED: server.ts passes TopicMemory and the operator binding; the route and the capture seam exist', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    expect(src).toContain('topicMemory: topicMemory ?? null,');
    expect(src).toContain('isOperator: ({ senderKey, userId }) => _memoryPrivacyWired.isOperator(senderKey) || _memoryPrivacyWired.isOwnerSender(senderKey, userId),');
    expect(src).toContain('bindingFingerprint: () => _memoryPrivacyWired.operatorBindingFingerprint(),');
    expect(src).toContain('...(layerWiring ? layerWiring.captureDeps : {}),');
    const wiring = fs.readFileSync(path.join(ROOT, 'src/monitoring/contextLayers/layerCaptureWiring.ts'), 'utf-8');
    // The capture deps carry U (and S6's Anchor ledger) alongside whatever other slices add (S13's onLayerOutcome, …).
    expect(wiring).toMatch(/captureDeps: \{ layerBudget: o\.layers\.budget, onCaptured, [^\n]*\.\.\.\(userCorpus \? \{ userCorpus \} : \{\}\)[^\n]*\},/);
    expect(wiring).toMatch(/captureDeps: \{[^\n]*\.\.\.\(anchorLedger \? \{ anchorLedger \} : \{\}\)[^\n]*\},/);
    const routes = fs.readFileSync(path.join(ROOT, 'src/server/routes.ts'), 'utf-8');
    expect(routes).toContain("router.get('/topic/:id/user-corpus',");
    const capture = fs.readFileSync(path.join(ROOT, 'src/core/TopicIntentCapture.ts'), 'utf-8');
    expect(capture).toContain('deps.userCorpus.refresh(topicId, ');
    expect(capture).toContain('deps.userCorpus.stubCandidates(topicId, mid)');
    expect(capture).toContain('deps.userCorpus.acceptStub(');
    const cap = fs.readFileSync(path.join(ROOT, 'src/server/CapabilityIndex.ts'), 'utf-8');
    expect(cap).toContain("'GET /topic/:id/user-corpus'");
  });
});

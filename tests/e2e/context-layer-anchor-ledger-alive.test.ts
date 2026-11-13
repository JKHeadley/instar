// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * e2e — A and G are ALIVE on the production init path
 * (context-budget-layered-summaries Phase 1, §6.1, §6.2): with the layers on
 * (a development agent), the boot path builds the layer store and wires the
 * capture loop through `wireLayerCapture` with TopicMemory and the
 * memory-privacy operator binding exactly as server.ts does; a captured
 * operator framing message becomes the Anchor, and an operator answer whose
 * stub the SAME extractor call wrote settles a decision as derived-settled;
 * the real route serves them with no message text. On the fleet (switch
 * omitted) nothing is wired, no record is written and the route is 503.
 * Plus WIRED source checks on server.ts, routes.ts, the wiring and the
 * capture seam.
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
import { MemoryPrivacy } from '../../src/users/MemoryPrivacy.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const OP = 'tests/e2e/context-layer-anchor-ledger-alive.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const T = 161616;
const OWNER = 111;

describe('A and G — alive on the production init path', () => {
  const dirs: string[] = [];
  const mems: TopicMemory[] = [];
  afterEach(() => {
    for (const m of mems.splice(0)) { try { m.close(); } catch { /* best-effort */ } }
    for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
  });

  async function boot(config: { developmentAgent?: boolean; contextBudget?: { enabled?: boolean } }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-al-e2e-')); dirs.push(root);
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
        const msg = prompt.split('New message (')[1]?.split('Currently tracked refs')[0] ?? '';
        return JSON.stringify({
          signals: msg.includes('Block. Warnings') ? [{ kind: 'new-ref', propositionText: 'the gate blocks', refKind: 'decision' }] : [],
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
      topicIntentStore,
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

  it('dev agent: the framing row becomes the Anchor, an answered decision settles as derived-settled, the route serves both without words', async () => {
    const b = await boot({ developmentAgent: true });
    expect(b.layerWiring?.anchorLedger).not.toBeNull();
    const frame = 'We are designing the fold gate for the pilot; it must keep my decisions.';
    expect((await b.say(499, frame, true)).status).toBe('captured');
    expect((await b.say(500, 'Should the gate block or warn?', false)).status).toBe('captured');
    expect((await b.say(501, 'Block. Warnings get ignored in practice.', true)).status).toBe('captured');
    expect(b.layers!.store.read(String(T), 'anchor', 'current')).toMatchObject({ status: 'anchored', data: { messageIds: [499] } });
    const [dec] = b.layers!.store.list(String(T), 'ledger-entry');
    expect(dec).toMatchObject({ status: 'derived-settled', data: { type: 'decision', boundMessageId: 501, stubKind: 'answer' } });
    const r = await request(b.app).get(`/topic/${T}/anchor`);
    expect(r.status).toBe(200);
    expect(r.body.anchor).toMatchObject({ status: 'anchored', rows: [{ messageId: 499, length: frame.length }] });
    expect(r.body.counts.byStatus['derived-settled']).toBe(1);
    expect(r.text).not.toContain('fold gate for the pilot');
    expect(r.text).not.toContain('Warnings get ignored');
    expect(b.layers!.status().anchorLedger).toMatchObject({ counters: { errors: 0 } });
  });

  it('fleet agent: nothing wired, no Anchor or ledger records, the route is 503', async () => {
    const b = await boot({});
    expect(b.layers).toBeNull();
    expect(b.layerWiring).toBeNull();
    await b.say(499, 'We are designing the fold gate for the pilot; it must keep my decisions.', true);
    await b.say(500, 'Should the gate block or warn?', false);
    expect((await b.say(501, 'Block. Warnings get ignored in practice.', true)).status).toBe('captured');
    expect(fs.existsSync(path.join(b.sd, 'state', 'context-layers'))).toBe(false);
    expect((await request(b.app).get(`/topic/${T}/anchor`)).status).toBe(503);
  });

  it('WIRED: the capture seam calls the ledger after every turn; the wiring builds it on U; the route and capability exist', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    expect(src).toContain('...(layerWiring ? layerWiring.captureDeps : {}),');
    expect(src).toContain('topicMemory: topicMemory ?? null,');
    const wiring = fs.readFileSync(path.join(ROOT, 'src/monitoring/contextLayers/layerCaptureWiring.ts'), 'utf-8');
    expect(wiring).toContain('new AnchorLedger({ store: o.layers.store, intent: o.store, pending: new PendingConfirmationManager(o.store), rows: o.topicMemory,');
    expect(wiring).toContain('...(anchorLedger ? { anchorLedger } : {}) },');
    const capture = fs.readFileSync(path.join(ROOT, 'src/core/TopicIntentCapture.ts'), 'utf-8');
    expect(capture).toContain('deps.anchorLedger.afterTurn(entry.topicId, ');
    const routes = fs.readFileSync(path.join(ROOT, 'src/server/routes.ts'), 'utf-8');
    expect(routes).toContain("router.get('/topic/:id/anchor',");
    const cap = fs.readFileSync(path.join(ROOT, 'src/server/CapabilityIndex.ts'), 'utf-8');
    expect(cap).toContain("'GET /topic/:id/anchor'");
  });
});

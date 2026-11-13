// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Integration — A and G on their real paths (context-budget-layered-summaries
 * §6.1, §6.2, §14):
 *  - real TopicMemory rows → the REAL capture loop with the REAL extractor and
 *    the REAL production `createLlmExtractFn` (a provider stands in for the
 *    model) → the Anchor from the operator's framing row, a decision that
 *    settles as `derived-settled` only because the SAME call's referent stub
 *    is an answer, an evolution with a confirmation of kind `evolution`, and
 *    one surfaced by the next agent reply;
 *  - anchor and ledger entries ride the store's replication seam per entry;
 *  - GET /topic/:id/anchor through the real routes behind the real bearer
 *    middleware: 401 without the token, 503 off, 400 on a bad id, 200 on with
 *    row references and statuses and no message text.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { TopicIntentStore } from '../../src/core/TopicIntent.js';
import { TopicIntentExtractor, createLlmExtractFn } from '../../src/core/TopicIntentExtractor.js';
import { createCaptureLoop } from '../../src/core/TopicIntentCapture.js';
import { buildContextLayers, type LayerEmitter } from '../../src/monitoring/contextLayers/contextLayersBoot.js';
import { wireLayerCapture } from '../../src/monitoring/contextLayers/layerCaptureWiring.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const OP = 'tests/integration/context-layer-anchor-ledger.test.ts';
const AUTH = 'integration-auth-token-0123456789';
const T = 151515;
const OWNER = 111;
const dirs: string[] = [];
const mems: TopicMemory[] = [];
afterEach(() => {
  for (const m of mems.splice(0)) { try { m.close(); } catch { /* best-effort */ } }
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
});
function tmp(p: string): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; }

/** Answers like the model: keyed by a fragment of the new message's text, the signals and (when asked) the stub. */
function scriptedProvider(script: Record<string, { signals?: unknown[]; stub?: unknown }>) {
  const prompts: string[] = [];
  const provider: IntelligenceProvider = {
    async evaluate(prompt: string) {
      prompts.push(prompt);
      const msg = prompt.split('New message (')[1]?.split('Currently tracked refs')[0] ?? '';
      const id = Object.keys(script).find((k) => msg.includes(k));
      const s = id ? script[id] : {};
      const l = (g: string) => ({ goal: g, trend: 'moving toward a decision', themes: ['gate'] });
      return JSON.stringify({
        signals: s.signals ?? [],
        awareness: { topic: l('design the gate'), recentArc: l('choose block or warn'), currentWork: l('settle block vs warn'), arcTransition: { kind: 'continue' } },
        ...(prompt.includes('"referentStub"') && s.stub ? { referentStub: s.stub } : {}),
      });
    },
  };
  return { provider, prompts };
}

function appFor(sd: string, layers: ReturnType<typeof buildContextLayers> | null, store: TopicIntentStore | null): express.Express {
  const ctx = {
    config: { projectName: 'echo', projectDir: sd, stateDir: sd, port: 0 } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    startTime: new Date(),
    contextLayers: layers,
    topicIntentStore: store,
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(() => AUTH, 'test'));
  app.use('/', createRoutes(ctx));
  return app;
}

async function rig() {
  const sd = tmp('cl-al-int-');
  const tm = new TopicMemory(sd); await tm.open(); mems.push(tm);
  const replicated: string[] = [];
  const emitter: LayerEmitter = { emit: (_s, key) => { replicated.push(key); return { outcome: 'emitted' }; } };
  const layers = buildContextLayers({ stateDir: sd, emitter });
  const store = new TopicIntentStore(sd);
  const wiring = wireLayerCapture({
    layers, store, sessions: { listRunningSessions: () => [], checkSessionWorkState: async () => 'idle' as const },
    machine: 'm_int', projectDir: sd, topicMemory: tm,
    isOperator: ({ senderKey }) => senderKey === `telegram:${OWNER}`,
  });
  return { sd, tm, layers, store, wiring, replicated };
}

const FRAME = 'We are designing the fold gate for the pilot topic; it must keep my decisions.';
const ANSWER = 'Block. Warnings get ignored every time.';
const ALSO = 'Also make the dashboard card part of this topic.';

async function drive() {
  const r = await rig();
  const { provider, prompts } = scriptedProvider({
    'Block. Warnings': { signals: [{ kind: 'new-ref', propositionText: 'the gate blocks', refKind: 'decision' }], stub: { stub: '[answering: should the gate block or warn?]', kind: 'answer', refersTo: '12' } },
    'Also make the dashboard': { signals: [{ kind: 'new-ref', propositionText: 'the topic also covers the dashboard card', refKind: 'goal' }], stub: { stub: '[directing: next step after the gate]', kind: 'directive', refersTo: '14' } },
  });
  const extractor = new TopicIntentExtractor(r.store, createLlmExtractFn(provider));
  const loop = createCaptureLoop({ ...r.wiring.captureDeps, extractor, store: r.store, topicMemory: r.tm });
  const msgs = [
    { messageId: 10, text: 'hey', fromUser: true },
    { messageId: 11, text: FRAME, fromUser: true },
    { messageId: 12, text: 'Should the gate block or warn? I lean towards warn.', fromUser: false },
    { messageId: 13, text: ANSWER, fromUser: true },
    { messageId: 14, text: 'Blocking it is. What next after the gate?', fromUser: false },
    { messageId: 15, text: ALSO, fromUser: true },
    { messageId: 16, text: 'Understood, adding the card.', fromUser: false },
    { messageId: 17, text: 'Thanks, carry on with the gate.', fromUser: true },
    { messageId: 18, text: 'Will do. The card is now part of this topic; confirm that is the new scope?', fromUser: false },
  ];
  for (const [i, m] of msgs.entries()) {
    r.tm.insertMessage({ topicId: T, timestamp: new Date(Date.UTC(2026, 10, 10, 10, 0, i)).toISOString(), sessionName: null, forwarded: false, ...(m.fromUser ? { telegramUserId: OWNER } : {}), ...m });
    await loop({ messageId: m.messageId, topicId: T, text: m.text, fromUser: m.fromUser, timestamp: Date.now() });
  }
  return { ...r, prompts };
}

describe('A and G through the real capture loop', () => {
  it('the Anchor, a decision settled only by the same call\'s answer stub, an evolution surfaced by the first reply after a later user turn', async () => {
    const r = await drive();
    // One extractor call per captured message; the ledger adds none.
    expect(r.prompts.length).toBe(9);
    const a = r.layers.store.read(String(T), 'anchor', 'current')!;
    expect(a).toMatchObject({ status: 'anchored', data: { messageIds: [11], skippedGreetings: 1 } });
    const entries = r.layers.store.list(String(T), 'ledger-entry');
    const dec = entries.find((e) => e.data.type === 'decision')!;
    expect(dec).toMatchObject({ status: 'derived-settled', data: { boundMessageId: 13, stubKind: 'answer' } });
    const evo = entries.find((e) => e.data.type === 'evolution')!;
    expect(evo).toMatchObject({ status: 'tentative', data: { cause: 'user-directed', effect: 'additive', boundMessageId: 15, surfacedAfterMessageId: 18 } });
    expect(r.store.read(T).pending.outstanding).toMatchObject({ kind: 'evolution', surfacedAfterMessageId: '18' });
    // Replicated per entry (anchor and each ledger entry under its own key).
    expect(r.replicated.some((k) => k.includes(':anchor:current'))).toBe(true);
    expect(r.replicated.some((k) => k.includes(`:ledger-entry:${dec.entryKey}`))).toBe(true);
    expect(r.replicated.some((k) => k.includes(`:ledger-entry:${evo.entryKey}`))).toBe(true);
    expect(r.layers.status().anchorLedger?.counters).toMatchObject({ surfaced: 1, errors: 0 });
  });
});

describe('GET /topic/:id/anchor', () => {
  it('401 without the bearer token', async () => {
    const r = await rig();
    expect((await request(appFor(r.sd, r.layers, r.store)).get(`/topic/${T}/anchor`)).status).toBe(401);
  });

  it('503 when the layers are off, naming the switch', async () => {
    const sd = tmp('cl-al-off-');
    const res = await request(appFor(sd, null, null)).get(`/topic/${T}/anchor`).set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(503);
    expect(res.body.enableWith).toBe('contextBudget.enabled');
  });

  it('200 with row references, statuses, the live set and the queue — never the words; 400 on a bad id', async () => {
    const r = await drive();
    const app = appFor(r.sd, r.layers, r.store);
    const res = await request(app).get(`/topic/${T}/anchor`).set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body.anchor).toMatchObject({ status: 'anchored', rows: [{ messageId: 11, length: FRAME.length }] });
    expect(res.body.counts).toMatchObject({ total: 2, byType: { decision: 1, evolution: 1 } });
    expect(res.body.liveSet).toMatchObject({ live: 2, archived: 0 });
    expect(res.body.pending).toMatchObject({ outstanding: { kind: 'evolution', surfaced: true } });
    expect(res.body.builder).toMatchObject({ wired: true });
    for (const w of ['fold gate for the pilot', 'Warnings get ignored', 'dashboard card part', 'the gate blocks']) expect(res.text).not.toContain(w);
    expect((await request(app).get('/topic/abc/anchor').set('Authorization', `Bearer ${AUTH}`)).status).toBe(400);
  });
});

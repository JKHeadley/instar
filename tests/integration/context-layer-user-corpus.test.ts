// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Integration — U and its referent stubs on their real paths
 * (context-budget-layered-summaries §6 row U, §6.4, §8, §14):
 *  - real TopicMemory rows → the REAL capture loop with the REAL extractor and
 *    the REAL production `createLlmExtractFn` (a counting provider stands in
 *    for the model) → a U whose row refs match the bodies byte for byte, and
 *    exactly ONE extractor call per message, stub included;
 *  - a stub write rides the store's replication seam (u-stub replicates, the
 *    U record does not);
 *  - GET /topic/:id/user-corpus through the real routes behind the real
 *    bearer middleware: 401 without the token, 503 off, 200 on with sizes and
 *    labels and no message text.
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
import { rowRefMatches } from '../../src/monitoring/contextLayers/LayerStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const OP = 'tests/integration/context-layer-user-corpus.test.ts';
const AUTH = 'integration-auth-token-0123456789';
const T = 141133;
const OWNER = 111;
const dirs: string[] = [];
const mems: TopicMemory[] = [];
afterEach(() => {
  for (const m of mems.splice(0)) { try { m.close(); } catch { /* best-effort */ } }
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
});
function tmp(p: string): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; }

/** A provider that answers like the model would, counting calls and keeping each prompt. */
function countingProvider(stubFor: (prompt: string) => unknown) {
  const prompts: string[] = [];
  const provider: IntelligenceProvider = {
    async evaluate(prompt: string) {
      prompts.push(prompt);
      const l = (g: string) => ({ goal: g, trend: 'moving toward a decision', themes: ['gate'] });
      return JSON.stringify({
        signals: [],
        awareness: { topic: l('design the gate'), recentArc: l('choose block or warn'), currentWork: l('settle block vs warn'), arcTransition: { kind: 'continue' } },
        ...(prompt.includes('"referentStub"') ? { referentStub: stubFor(prompt) } : {}),
      });
    },
  };
  return { provider, prompts };
}

function appFor(sd: string, layers: ReturnType<typeof buildContextLayers> | null, topicMemory: TopicMemory | null): express.Express {
  const ctx = {
    config: { projectName: 'echo', projectDir: sd, stateDir: sd, port: 0 } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    startTime: new Date(),
    contextLayers: layers,
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(() => AUTH, 'test'));
  app.use('/', createRoutes(ctx));
  return app;
}

async function rig() {
  const sd = tmp('cl-u-int-');
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

describe('U from real TopicMemory rows through the real capture loop', () => {
  it('row refs match the bodies byte for byte, one extractor call per message, the stub rides that call', async () => {
    const r = await rig();
    const { provider, prompts } = countingProvider(() => ({ stub: '[answering: should the gate block or warn?]', kind: 'answer', refersTo: '10' }));
    const extractor = new TopicIntentExtractor(r.store, createLlmExtractFn(provider));
    const loop = createCaptureLoop({ ...r.wiring.captureDeps, extractor, store: r.store, topicMemory: r.tm });
    const msgs = [
      { messageId: 10, text: 'Should the gate block or warn? I lean towards warn for now.', fromUser: false },
      { messageId: 11, text: 'Block. Warnings get ignored — "naïve" café ✓ — every time.', fromUser: true, telegramUserId: OWNER },
      { messageId: 12, text: 'Forwarded: our lead says warn is fine for the pilot.', fromUser: true, telegramUserId: OWNER, forwarded: true },
      { messageId: 13, text: 'Someone else in the group thinks we should warn.', fromUser: true, telegramUserId: 999 },
    ];
    for (const [i, m] of msgs.entries()) {
      r.tm.insertMessage({ topicId: T, timestamp: new Date(Date.UTC(2026, 10, 10, 10, 0, i)).toISOString(), sessionName: null, forwarded: false, ...m });
      expect((await loop({ messageId: m.messageId, topicId: T, text: m.text, fromUser: m.fromUser, timestamp: Date.now() })).status).toBe('captured');
    }
    // Exactly one call per message; only the operator's own message asked for a stub.
    expect(prompts).toHaveLength(msgs.length);
    expect(prompts.filter((p) => p.includes('"referentStub"'))).toHaveLength(1);
    expect(prompts[1]).toContain('messageId=10');
    // U: the three sender rows, each ref byte-identical to its TopicMemory row.
    const u = r.layers.store.list(String(T), 'u');
    expect(u.map((x) => x.rows![0].messageId).sort()).toEqual([11, 12, 13]);
    const rows = new Map(r.tm.getRecentMessages(T, 50).map((m) => [m.messageId, m.text]));
    for (const rec of u) expect(rowRefMatches(rec.rows![0], rows.get(rec.rows![0].messageId)!)).toBe(true);
    expect(Object.fromEntries(u.map((x) => [x.rows![0].messageId, x.data.label]))).toEqual({ 11: 'operator', 12: 'forwarded', 13: 'third-party' });
    // The stub sits beside the operator's quote and replicates; U itself does not.
    expect(r.layers.store.read(String(T), 'u-stub', 'm-11')?.data).toMatchObject({ kind: 'answer', refersTo: 10 });
    expect(r.replicated.some((k) => k.includes(':u-stub:m-11'))).toBe(true);
    expect(r.replicated.some((k) => /:u:m-/.test(k))).toBe(false);
  });

  it('a stub the validator rejects is counted and dropped; the message is still captured', async () => {
    const r = await rig();
    const { provider, prompts } = countingProvider(() => ({ stub: '[answering: x]\n[second line]', kind: 'answer', refersTo: '10' }));
    const extractor = new TopicIntentExtractor(r.store, createLlmExtractFn(provider));
    const loop = createCaptureLoop({ ...r.wiring.captureDeps, extractor, store: r.store, topicMemory: r.tm });
    r.tm.insertMessage({ messageId: 10, topicId: T, text: 'Which option do you prefer?', fromUser: false, timestamp: '2026-11-10T10:00:00.000Z', sessionName: null });
    r.tm.insertMessage({ messageId: 11, topicId: T, text: 'The second option, clearly.', fromUser: true, telegramUserId: OWNER, forwarded: false, timestamp: '2026-11-10T10:00:01.000Z', sessionName: null });
    const out = await loop({ messageId: 11, topicId: T, text: 'The second option, clearly.', fromUser: true });
    expect(out).toMatchObject({ status: 'captured', awarenessUpdated: true });
    expect(prompts).toHaveLength(1);
    expect(r.layers.store.read(String(T), 'u-stub', 'm-11')).toBeNull();
    expect(r.wiring.userCorpus!.counters.stubsRejected['multi-line']).toBe(1);
  });
});

describe('GET /topic/:id/user-corpus', () => {
  it('401 without the bearer token', async () => {
    const r = await rig();
    expect((await request(appFor(r.sd, r.layers, r.tm)).get(`/topic/${T}/user-corpus`)).status).toBe(401);
  });

  it('503 when the layers are off, naming the switch', async () => {
    const sd = tmp('cl-u-off-');
    const res = await request(appFor(sd, null, null)).get(`/topic/${T}/user-corpus`).set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(503);
    expect(res.body.enableWith).toBe('contextBudget.enabled');
  });

  it('200 with sizes, labels and stub coverage, and never the words', async () => {
    const r = await rig();
    r.tm.insertMessage({ messageId: 10, topicId: T, text: 'Should the gate block or warn?', fromUser: false, timestamp: '2026-11-10T10:00:00.000Z', sessionName: null });
    const words = 'Block it, please; the pilot cannot rely on warnings.';
    r.tm.insertMessage({ messageId: 11, topicId: T, text: words, fromUser: true, telegramUserId: OWNER, forwarded: false, timestamp: '2026-11-10T10:00:01.000Z', sessionName: null });
    r.tm.insertMessage({ messageId: 12, topicId: T, text: 'relayed from a peer', fromUser: true, origin: 'relay', timestamp: '2026-11-10T10:00:02.000Z', sessionName: null });
    r.wiring.userCorpus!.refresh(T);
    r.wiring.userCorpus!.acceptStub(T, 11, words, { stub: '[answering: should the gate block or warn?]', kind: 'directive', refersTo: '10' });
    const res = await request(appFor(r.sd, r.layers, r.tm)).get(`/topic/${T}/user-corpus`).set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body.protected).toEqual({ messages: 1, chars: words.length, tokens: Math.ceil(words.length / 4) });
    expect(res.body.byLabel.relay.messages).toBe(1);
    expect(res.body.stubs).toMatchObject({ written: 1, operatorRowsWithStub: 1, coverage: 1, byKind: { directive: 1 } });
    expect(res.body.builder).toMatchObject({ wired: true, operatorBinding: 'wired' });
    expect(res.body.entries.find((e: { messageId: number }) => e.messageId === 12)).toMatchObject({ label: 'relay', authority: 'none' });
    expect(res.text).not.toContain('pilot cannot rely');
    expect(res.text).not.toContain('relayed from a peer');
    expect((await request(appFor(r.sd, r.layers, r.tm)).get('/topic/abc/user-corpus').set('Authorization', `Bearer ${AUTH}`)).status).toBe(400);
  });
});

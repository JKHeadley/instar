/**
 * E2E lifecycle (Tier 3) for the topic-intent CAPTURE LOOP (rung 0).
 *
 * The single most important guard here is WIRING-INTEGRITY: the original bug was
 * that the store/routes/briefing all shipped but nothing ever invoked ingest()
 * on a real turn ("shipped but asleep"). This test reconstructs the EXACT
 * production composition (createQueuedIntelligence → createLlmExtractFn →
 * TopicIntentExtractor → createCaptureLoop, chained onto an onMessageLogged
 * callback the way server.ts does it), fires a real inbound turn through that
 * live callback, and proves end-to-end that:
 *   - the cabinet fills (a ref lands in the store),
 *   - the session-start briefing for the topic is now NON-EMPTY (closes the
 *     original "no record for the topic" gap),
 *   - the capture-metrics endpoint is alive (200, not 503) and reflects it,
 *   - the prior callback in the chain is preserved,
 *   - the LLM call went through the queue's BACKGROUND lane and delegated to the
 *     injected (subscription) provider — never a raw API client (transport).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import express from 'express';
import type { Server } from 'node:http';
import request from 'supertest';
import { TopicIntentStore } from '../../src/core/TopicIntent.js';
import { TopicIntentExtractor, createLlmExtractFn } from '../../src/core/TopicIntentExtractor.js';
import {
  createCaptureLoop,
  createQueuedIntelligence,
  type CaptureTurnEntry,
} from '../../src/core/TopicIntentCapture.js';
import { createTopicIntentRoutes } from '../../src/server/topicIntentRoutes.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const TOPIC = 9100;

describe('E2E: topic-intent capture loop lifecycle', () => {
  let stateDir: string;
  let server: Server;
  let store: TopicIntentStore;

  // Live-callback chain bookkeeping (mirrors server.ts onMessageLogged chaining).
  let onMessageLogged: ((entry: { messageId: string; topicId: number; text: string; fromUser: boolean }) => void) | undefined;
  let priorCallbackFired = 0;
  const enqueueLanes: string[] = [];
  let providerCalls = 0;

  beforeAll(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-intent-capture-e2e-'));
    store = new TopicIntentStore(stateDir);

    // HTTP surface — exactly how server.ts mounts it.
    const app = express();
    app.use(express.json());
    app.use(createTopicIntentRoutes({ topicIntentStore: store }));
    await new Promise<void>(resolve => { server = app.listen(0, () => resolve()); });

    // ── Reconstruct the production capture wiring ──────────────────────────
    // Deterministic stub provider standing in for sharedIntelligence (the
    // subscription/REPL-pool provider). Returns a fixed extraction proposal.
    const provider: IntelligenceProvider = {
      async evaluate() {
        providerCalls++;
        return '[{"kind":"new-ref","propositionText":"ship rung 0 (the capture loop) first","refKind":"decision"}]';
      },
    };
    // Stub enqueue standing in for sharedLlmQueue.enqueue — records the lane.
    const enqueue = async (lane: 'interactive' | 'background', fn: (s: AbortSignal) => Promise<string>, _cost?: number) => {
      enqueueLanes.push(lane);
      return fn(new AbortController().signal);
    };
    const queuedIntelligence = createQueuedIntelligence(provider, enqueue);
    const extractFn = createLlmExtractFn(queuedIntelligence);
    const extractor = new TopicIntentExtractor(store, extractFn);
    const captureLoop = createCaptureLoop({ extractor, store, topicMemory: null });

    // The prior callback (e.g. PresenceProxy / human-as-detector) in the chain.
    const priorCallback = () => { priorCallbackFired++; };
    // Chain capture on, preserving the prior callback — EXACTLY server.ts's pattern.
    const before = priorCallback;
    onMessageLogged = (entry) => {
      before(entry as never);
      void captureLoop({
        messageId: entry.messageId,
        topicId: entry.topicId,
        text: entry.text,
        fromUser: entry.fromUser,
      } as CaptureTurnEntry);
    };
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    try { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/e2e/topic-intent-capture-lifecycle.test.ts' }); } catch { /* best */ }
  });

  it('the feature is alive: capture-metrics returns 200, not 503', async () => {
    const res = await request(server).get(`/topic-intent/${TOPIC}/capture-metrics`);
    expect(res.status).toBe(200);
    expect(res.body.funnel).toBeDefined();
  });

  it('WIRING-INTEGRITY: a real inbound turn on the live callback fills the store', async () => {
    // Before: the cabinet is empty and the briefing has nothing to say.
    const briefBefore = await request(server).get(`/topic-intent/${TOPIC}/briefing`);
    expect(briefBefore.text.trim()).toBe('');

    // Fire a substantive inbound turn through the LIVE onMessageLogged callback.
    onMessageLogged!({ messageId: 'srv-msg-1', topicId: TOPIC, text: 'Let us ship rung 0 — the capture loop — before the upper rungs.', fromUser: true });
    // Capture is fire-and-forget; let the microtask chain settle.
    await new Promise(r => setTimeout(r, 50));

    // The prior callback was preserved (chain not clobbered).
    expect(priorCallbackFired).toBeGreaterThanOrEqual(1);

    // ingest() actually ran on the live callback → a ref is in the store.
    const refs = await request(server).get(`/topic-intent/${TOPIC}/refs?tier=observation`);
    expect(refs.body.refs.length).toBeGreaterThanOrEqual(1);

    // The funnel reflects the captured turn.
    const m = await request(server).get(`/topic-intent/${TOPIC}/capture-metrics`);
    expect(m.body.funnel.turns_seen).toBeGreaterThanOrEqual(1);
    expect(m.body.funnel.extractions_attempted).toBeGreaterThanOrEqual(1);
    expect(m.body.funnel.refs_created).toBeGreaterThanOrEqual(1);
  });

  it('TRANSPORT: the extraction went through the queue background lane + the injected provider (never raw API)', () => {
    expect(providerCalls).toBeGreaterThanOrEqual(1);          // delegated to the subscription provider
    expect(enqueueLanes).toContain('background');             // admitted through the shared queue, background lane
    expect(enqueueLanes.every(l => l === 'background')).toBe(true);
  });

  it('server.ts actually contains the capture wiring (anti-"shipped-but-asleep" source guard)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const serverSrc = fs.readFileSync(path.join(here, '../../src/commands/server.ts'), 'utf-8');
    expect(serverSrc).toContain('createCaptureLoop(');
    expect(serverSrc).toContain('__instarTopicIntentCaptureWired');
    // The chain must be attached to the inbound message callback.
    expect(serverSrc).toMatch(/telegram\.onMessageLogged\s*=\s*\(entry\)\s*=>\s*\{[\s\S]*captureLoop\(/);
  });
});

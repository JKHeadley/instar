/**
 * E2E (Tier 3) — the founding methodology-drift incident, reproduced and caught.
 *
 * Scenario: a turn SETS the task frame ("we're testing over Telegram"); the
 * capture loop files it as a `method` ref; the session-start briefing then
 * carries an "ACTIVE TASK FRAME" block (so a fresh session knows the frame
 * without anyone re-stating it); and ArcCheck SIGNALS when a later draft drifts
 * from that frame. This is the exact failure the North Star was named to kill,
 * driven end-to-end through the live capture wiring + real HTTP surfaces.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import express from 'express';
import type { Server } from 'node:http';
import request from 'supertest';
import { TopicIntentStore } from '../../src/core/TopicIntent.js';
import { TopicIntentExtractor, createLlmExtractFn } from '../../src/core/TopicIntentExtractor.js';
import { createCaptureLoop, createQueuedIntelligence, type CaptureTurnEntry } from '../../src/core/TopicIntentCapture.js';
import { createTopicIntentRoutes } from '../../src/server/topicIntentRoutes.js';
import type { ArcCheckClassifyFn } from '../../src/core/TopicIntentArcCheck.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const TOPIC = 9200;

describe('E2E: task-frame capture catches the founding drift', () => {
  let stateDir: string;
  let server: Server;
  let store: TopicIntentStore;
  let onMessageLogged: ((e: { messageId: string; topicId: number; text: string; fromUser: boolean }) => void) | undefined;

  // A classifier that flags any draft mentioning "code"/"read" as contradicting the frame.
  const classify: ArcCheckClassifyFn = async (draft, refs) => {
    const drift = /read|code|dashboard|locally/i.test(draft);
    return { actsOn: [], contradicts: drift ? refs.filter(r => r.kind === 'method').map(r => r.refId) : [] };
  };

  beforeAll(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-intent-taskctx-e2e-'));
    store = new TopicIntentStore(stateDir);

    const app = express();
    app.use(express.json());
    app.use(createTopicIntentRoutes({ topicIntentStore: store, arcCheckClassify: classify }));
    await new Promise<void>(resolve => { server = app.listen(0, () => resolve()); });

    // Reconstruct the production capture wiring with a deterministic provider
    // that recognizes a frame-setting turn and proposes a `method` ref.
    const provider: IntelligenceProvider = {
      async evaluate(prompt) {
        if (/telegram/i.test(prompt)) {
          return '[{"kind":"new-ref","propositionText":"we are testing this over Telegram","refKind":"method"}]';
        }
        return '[]';
      },
    };
    const enqueue = async (_lane: 'interactive' | 'background', fn: (s: AbortSignal) => Promise<string>) => fn(new AbortController().signal);
    const queued = createQueuedIntelligence(provider, enqueue);
    const extractor = new TopicIntentExtractor(store, createLlmExtractFn(queued));
    const captureLoop = createCaptureLoop({ extractor, store, topicMemory: null });
    onMessageLogged = (entry) => { void captureLoop(entry as CaptureTurnEntry); };
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    try { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/e2e/topic-intent-task-context-lifecycle.test.ts' }); } catch { /* best */ }
  });

  it('the feature is alive: capture-metrics returns 200, not 503', async () => {
    const res = await request(server).get(`/topic-intent/${TOPIC}/capture-metrics`);
    expect(res.status).toBe(200);
  });

  it('a frame-setting turn fills the store with a method ref (drive the frame to settled)', async () => {
    // Repeat the frame statement a few times so it climbs to a tier the briefing shows.
    for (const id of ['t1', 't2', 't3']) {
      onMessageLogged!({ messageId: id, topicId: TOPIC, text: 'just to be clear, we are testing this over Telegram, like before', fromUser: true });
      await new Promise(r => setTimeout(r, 30));
    }
    const refs = await request(server).get(`/topic-intent/${TOPIC}/refs?tier=observation`);
    const methodRef = refs.body.refs.find((r: { kind: string }) => r.kind === 'method');
    expect(methodRef).toBeTruthy();
    expect(methodRef.text).toMatch(/telegram/i);
  });

  it('the briefing carries the frame so a fresh session knows it without re-stating', async () => {
    const res = await request(server).get(`/topic-intent/${TOPIC}/briefing`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('ACTIVE TASK FRAME');
    expect(res.text).toMatch(/\[method\].*telegram/i);
  });

  it('ArcCheck SIGNALS when a later draft drifts from the frame (the catch)', async () => {
    const res = await request(server)
      .post(`/topic-intent/${TOPIC}/arccheck`)
      .send({ draftText: "I'll verify this by reading the code locally" });
    expect(res.status).toBe(200);
    expect(res.body.fire).toBe(true);
    expect(res.body.refText).toMatch(/telegram/i);
  });
});

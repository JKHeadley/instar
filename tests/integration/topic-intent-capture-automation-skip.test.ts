/**
 * Integration (Tier 2): automated sends are not fed to the topic-intent extractor.
 *
 * Full pipeline: POST /telegram/reply classifies provenance at the send seam →
 * the logged row's provenance reaches the capture loop (as server.ts forwards
 * it) → GET /topic-intent/:id/capture-metrics shows the automated turn skipped
 * before any LLM call, while a conversational reply is still extracted.
 * Evidence: docs/research/jev/field-notes/2026-09-30-idea1-intent-skip.md.
 */

import { afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import { createTopicIntentRoutes } from '../../src/server/topicIntentRoutes.js';
import { TopicIntentStore } from '../../src/core/TopicIntent.js';
import { TopicIntentExtractor } from '../../src/core/TopicIntentExtractor.js';
import { createCaptureLoop, type CaptureOutcome } from '../../src/core/TopicIntentCapture.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { MessageProvenance } from '../../src/messaging/shared/MessageProvenance.js';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-intent-automation-skip-'));

afterAll(() => {
  SafeFsExecutor.safeRmSync(stateDir, {
    recursive: true,
    force: true,
    operation: 'tests/integration/topic-intent-capture-automation-skip.test.ts',
  });
});

describe('topic-intent capture skips automation-provenance sends', () => {
  const store = new TopicIntentStore(stateDir);
  let extractorCalls = 0;
  const extractor = new TopicIntentExtractor(store, async () => {
    extractorCalls++;
    return [];
  });
  const captureLoop = createCaptureLoop({ extractor, store, topicMemory: null });
  const outcomes: Promise<CaptureOutcome>[] = [];
  let nextMessageId = 1;

  const app = express();
  app.use(express.json());
  app.use(createRoutes({
    config: { authToken: 'test', stateDir, port: 0, projectName: 'automation-skip-test' },
    telegram: {
      // Stands in for TelegramAdapter.sendToTopic → appendToLog → onMessageLogged.
      sendToTopic: async (topicId: number, text: string, options?: { provenance?: MessageProvenance }) => {
        const messageId = nextMessageId++;
        const timestamp = new Date().toISOString();
        outcomes.push(captureLoop({
          messageId,
          topicId,
          text,
          fromUser: false,
          timestamp,
          provenance: options?.provenance ?? 'automation',
        }));
        return { messageId, timestamp };
      },
    },
    sessionManager: { clearInjectionTracker: () => {} },
  } as never));
  app.use(createTopicIntentRoutes({ topicIntentStore: store }));

  it('an automated job send is counted but never reaches the extractor', async () => {
    const res = await request(app)
      .post('/telegram/reply/81')
      .send({
        text: 'Worktree scan found unmerged branches on fix/codex-session-reliability; merge or delete them.',
        metadata: { messageKind: 'automated' },
      });
    expect(res.status).toBe(200);
    const outcome = await outcomes.at(-1)!;
    expect(outcome.status).toBe('skipped-automation');
    expect(extractorCalls).toBe(0);

    const m = await request(app).get('/topic-intent/81/capture-metrics');
    expect(m.status).toBe(200);
    expect(m.body.funnel.turns_seen).toBe(1);
    expect(m.body.funnel.prefilter_skipped).toBe(1);
    expect(m.body.funnel.extractions_attempted).toBe(0);
  });

  it('a conversational reply in the same pipeline is still extracted', async () => {
    const res = await request(app)
      .post('/telegram/reply/82')
      .send({ text: 'Decision: we will merge the reliability branch after the gate passes tonight.' });
    expect(res.status).toBe(200);
    const outcome = await outcomes.at(-1)!;
    expect(outcome.status).toBe('captured');
    expect(extractorCalls).toBe(1);

    const m = await request(app).get('/topic-intent/82/capture-metrics');
    expect(m.body.funnel.extractions_attempted).toBe(1);
    expect(m.body.funnel.prefilter_skipped).toBe(0);
  });
});

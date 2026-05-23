/**
 * E2E lifecycle test — Topic Intent Layer 1 is "alive" through the real boot path.
 *
 * Per the Testing Integrity Spec (CLAUDE.md):
 *   "Tier 3: E2E Lifecycle Tests — Production initialization path mirroring
 *    server.ts. Is the feature actually alive? Returns 200, not 503?"
 *
 * This test:
 *   1. Boots a real Express app with the topic-intent routes mounted exactly
 *      as server.ts wires them (via createTopicIntentRoutes + a real
 *      TopicIntentStore on a real file-backed state dir).
 *   2. Ingests synthetic conversation turns through the extractor pipeline.
 *   3. Observes tier transitions through the diagnostics HTTP endpoint
 *      (observation → tentative → authoritative as evidence accumulates).
 *   4. Verifies telemetry counters survive store re-instantiation
 *      (file-based persistence is real, not in-memory).
 *   5. Verifies framework-agnostic boot: the route surface is reachable with
 *      ZERO Claude-Code-specific dependencies in the boot path.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import express from 'express';
import http from 'node:http';
import type { Server } from 'node:http';
import request from 'supertest';
import {
  TopicIntentStore,
  buildEvent,
} from '../../src/core/TopicIntent.js';
import {
  TopicIntentExtractor,
  type SignalProposal,
} from '../../src/core/TopicIntentExtractor.js';
import { PendingConfirmationManager } from '../../src/core/TopicIntentPendingConfirm.js';
import { createTopicIntentRoutes } from '../../src/server/topicIntentRoutes.js';

describe('E2E: Topic Intent Layer 1 lifecycle', () => {
  let stateDir: string;
  let server: Server;
  let port: number;
  let store: TopicIntentStore;

  beforeAll(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-intent-e2e-'));
    // Production-path construction: same code path server.ts uses.
    store = new TopicIntentStore(stateDir);

    const app = express();
    app.use(express.json());
    app.use(createTopicIntentRoutes({ topicIntentStore: store }));

    await new Promise<void>(resolve => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    try { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/e2e/topic-intent-lifecycle.test.ts' }); } catch { /* best */ }
  });

  it('the feature is alive: diagnostics returns 200, not 503', async () => {
    const res = await request(server).get('/topic-intent/1000/diagnostics');
    expect(res.status).toBe(200);
    expect(res.body.topicId).toBe(1000);
    expect(res.body).toHaveProperty('refs');
    expect(res.body).toHaveProperty('tierDistribution');
    expect(res.body).toHaveProperty('telemetry');
  });

  it('ingestion → projection → HTTP tier visibility flow', async () => {
    const topicId = 2000;

    // Stub extractor that classifies our synthetic turns deterministically
    let turn = 0;
    const turns = [
      { from: 'user' as const, text: 'we should use Path A OAuth for fetchDocument', expectProposal: 'new-ref' },
      { from: 'user' as const, text: 'continuing with Path A — and the timeout should be 30s', expectProposal: 'reref' },
      { from: 'user' as const, text: 'yes, Path A is the call', expectProposal: 'affirm' },
    ];
    let createdRefId: string | null = null;

    const ext = new TopicIntentExtractor(store, async (input): Promise<SignalProposal[]> => {
      const t = turns[turn++];
      if (!t) return [];
      if (t.expectProposal === 'new-ref') {
        return [{ kind: 'new-ref', refId: null, propositionText: 'use Path A OAuth for fetchDocument', refKind: 'decision' }];
      }
      // reref / affirm need the previously-created refId
      if (!createdRefId) return [];
      return [{ kind: t.expectProposal as 'reref' | 'affirm', refId: createdRefId }];
    });

    // Turn 1: new-ref → tentative (0.40)
    let r = await ext.ingest({
      topicId, arcId: 'arc-1',
      message: { id: 'msg-1', text: turns[0].text, fromUser: true, turn: 1, at: new Date().toISOString() },
      existingRefs: Object.values(store.read(topicId).refs),
    });
    expect(r.createdRefs).toHaveLength(1);
    createdRefId = r.createdRefs[0].refId;

    let res = await request(server).get(`/topic-intent/${topicId}/diagnostics`);
    expect(res.status).toBe(200);
    expect(res.body.tierDistribution.tentative).toBe(1);
    expect(res.body.tierDistribution.authoritative).toBe(0);

    // Turn 2: user-reref → 0.40 + 0.10 = 0.50 (still tentative)
    await ext.ingest({
      topicId, arcId: 'arc-1',
      message: { id: 'msg-2', text: turns[1].text, fromUser: true, turn: 2, at: new Date().toISOString() },
      existingRefs: Object.values(store.read(topicId).refs),
    });
    res = await request(server).get(`/topic-intent/${topicId}/diagnostics`);
    expect(res.body.tierDistribution.tentative).toBe(1);
    expect(res.body.refs[0].confidence).toBeCloseTo(0.50);

    // Turn 3: user-affirm → 0.50 + 0.30 = 0.80 (authoritative)
    await ext.ingest({
      topicId, arcId: 'arc-1',
      message: { id: 'msg-3', text: turns[2].text, fromUser: true, turn: 3, at: new Date().toISOString() },
      existingRefs: Object.values(store.read(topicId).refs),
    });
    res = await request(server).get(`/topic-intent/${topicId}/diagnostics`);
    expect(res.body.tierDistribution.authoritative).toBe(1);
    expect(res.body.tierDistribution.tentative).toBe(0);
    expect(res.body.refs[0].confidence).toBeCloseTo(0.80);
    expect(res.body.refs[0].tier).toBe('authoritative');
  });

  it('telemetry counters survive store re-instantiation (file-based persistence is real)', async () => {
    const topicId = 3000;
    // Ingest some events
    store.appendEvidence(topicId, 'ref-x', buildEvent('ref-x', 'extract-user', 'm1'));
    store.appendEvidence(topicId, 'ref-x', buildEvent('ref-x', 'user-affirm', 'm2'));
    store.appendEvidence(topicId, 'ref-x', buildEvent('ref-x', 'agent-reref', 'm3'));

    // Read telemetry via HTTP
    let res = await request(server).get(`/topic-intent/${topicId}/telemetry`);
    expect(res.status).toBe(200);
    expect(res.body.telemetry.evidence_event_total['extract-user']).toBe(1);
    expect(res.body.telemetry.evidence_event_total['user-affirm']).toBe(1);
    expect(res.body.telemetry.evidence_event_total['agent-reref']).toBe(1);

    // Construct a SECOND store pointing at the same stateDir — verify persistence
    const store2 = new TopicIntentStore(stateDir);
    const file = store2.read(topicId);
    expect(file.telemetry.evidence_event_total['extract-user']).toBe(1);
    expect(file.telemetry.evidence_event_total['user-affirm']).toBe(1);
    expect(file.telemetry.evidence_event_total['agent-reref']).toBe(1);
  });

  it('pending confirmation lifecycle visible through HTTP', async () => {
    const topicId = 4000;
    store.appendEvidence(topicId, 'ref-A', buildEvent('ref-A', 'extract-user', 'm-A'), { text: 'A', kind: 'decision' });
    store.appendEvidence(topicId, 'ref-B', buildEvent('ref-B', 'extract-user', 'm-B'), { text: 'B', kind: 'decision' });

    const mgr = new PendingConfirmationManager(store);
    mgr.create({ topicId, arcId: 'arc', refId: 'ref-A', propositionText: 'A', questionText: 'q', currentUserTurn: 5 });
    mgr.create({ topicId, arcId: 'arc', refId: 'ref-B', propositionText: 'B', questionText: 'q', currentUserTurn: 5 });

    const res = await request(server).get(`/topic-intent/${topicId}/pending`);
    expect(res.status).toBe(200);
    expect(res.body.outstanding?.refId).toBe('ref-A');
    expect(res.body.queue).toHaveLength(1);

    // Answer the outstanding — queue promotes
    mgr.interpretAnswer(topicId, 'positive', 'm-answer');
    const res2 = await request(server).get(`/topic-intent/${topicId}/pending`);
    expect(res2.body.outstanding?.refId).toBe('ref-B');
    expect(res2.body.queue).toHaveLength(0);

    // ref-A is now authoritative
    const res3 = await request(server).get(`/topic-intent/${topicId}/refs?tier=authoritative`);
    expect(res3.body.refs.some((r: { refId: string }) => r.refId === 'ref-A')).toBe(true);
  });

  it('Layer 2 briefing endpoint is alive through the real boot path', async () => {
    const topicId = 4500;
    store.appendEvidence(topicId, 'ref-auth', buildEvent('ref-auth', 'extract-user', 'm1'), { text: 'authoritative item', kind: 'decision' });
    store.appendEvidence(topicId, 'ref-auth', buildEvent('ref-auth', 'user-affirm', 'm2'));
    store.appendEvidence(topicId, 'ref-ten', buildEvent('ref-ten', 'extract-user', 'm3'), { text: 'tentative item', kind: 'fact' });

    const res = await request(server).get(`/topic-intent/${topicId}/briefing`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('SETTLED');
    expect(res.text).toContain('TENTATIVE');
    expect(res.text).toContain('authoritative item');
    expect(res.text).toContain('tentative item');
  });

  it('framework-agnostic — boot path has zero Claude-Code-specific dependencies in Layer 1 + Layer 2 sources', () => {
    // Read all Layer 1 + Layer 2 source files; grep for forbidden tokens
    const sourceFiles = [
      'src/core/TopicIntent.ts',
      'src/core/TopicIntentExtractor.ts',
      'src/core/TopicIntentPendingConfirm.ts',
      'src/core/TopicIntentBriefing.ts',
      'src/server/topicIntentRoutes.ts',
    ];
    const forbidden = [
      'claudeSessionId',
      '.claude/projects',
      'CLAUDE_CODE_SESSION_ID',
      'claude-code',
      'codex-cli',     // also forbidden — must work regardless of CLI
    ];
    for (const file of sourceFiles) {
      const fp = path.join(process.cwd(), file);
      const src = fs.readFileSync(fp, 'utf-8');
      for (const token of forbidden) {
        expect(src, `${file} contains framework-specific token "${token}"`).not.toContain(token);
      }
    }
  });
});

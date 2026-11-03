// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Integration — POST /sessions/spawn honours the topic's pinned profile at
 * spawn time and records what it launched (Echo Bugs topic 10000001430).
 *
 * Before: the route ignored the topic profile and recorded nothing, so the
 * profile orchestrator restarted every such session at the next server boot
 * ("pinned profile wasn't applied") and the restart lost the spawn prompt.
 *
 * Full HTTP route pipeline with a REAL TopicProfileStore + resolver-shaped
 * reader, a REAL TopicProfileOrchestrator and a REAL TopicSpawnBriefStore;
 * only the session manager is the shared mock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import { TopicProfileStore } from '../../src/core/TopicProfileStore.js';
import { TopicProfileOrchestrator } from '../../src/core/TopicProfileOrchestrator.js';
import { TopicSpawnBriefStore } from '../../src/core/TopicSpawnBriefStore.js';
import type { ResolvedTopicProfile } from '../../src/core/TopicProfileResolver.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createMockSessionManager, type MockSessionManager } from '../helpers/setup.js';
import { makeOrchestratorDeps, newRecorder, type OrchestratorRecorder } from '../helpers/topicProfileOrchestratorDeps.js';

const TOPIC = 4242;

describe('POST /sessions/spawn — topic profile at spawn time', () => {
  let tmpDir: string;
  let app: express.Express;
  let sm: MockSessionManager;
  let store: TopicProfileStore;
  let briefs: TopicSpawnBriefStore;
  let orch: TopicProfileOrchestrator;
  let rec: OrchestratorRecorder;
  let orchStatePath: string;

  const resolveProfile = (topicKey: string | number): ResolvedTopicProfile => {
    const pin = store.resolve(String(topicKey));
    return {
      framework: pin?.framework ?? 'claude-code',
      model: pin?.model ?? undefined,
      modelTier: pin?.modelTier ?? null,
      thinkingMode: undefined,
      effort: undefined,
      escalationOverride: 'inherit',
      sources: { framework: 'pin', model: pin?.model ? 'pin' : 'default', thinkingMode: 'default', effort: 'default' },
      notices: [],
    } as ResolvedTopicProfile;
  };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-topic-profile-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    store = new TopicProfileStore({ stateFilePath: path.join(tmpDir, 'state', 'topic-profiles.json') });
    await store.mutate(String(TOPIC), { model: 'claude-opus-5-5', updatedBy: 'api-token' });
    briefs = new TopicSpawnBriefStore(tmpDir);
    rec = newRecorder();
    orchStatePath = path.join(tmpDir, 'state', 'topic-profile-orchestrator.json');
    orch = new TopicProfileOrchestrator(makeOrchestratorDeps({ store, resolveProfile, stateFilePath: orchStatePath, rec }));
    sm = createMockSessionManager();
    app = express();
    app.use(express.json());
    const ctx: any = {
      config: { authToken: 'test', stateDir: tmpDir, port: 0 },
      sessionManager: sm,
      startTime: new Date(),
      topicProfile: { store, resolver: { resolve: resolveProfile }, orchestrator: orch, spawnBriefs: briefs },
    };
    app.use(createRoutes(ctx));
  });

  afterEach(() => {
    orch.dispose();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/sessions-spawn-topic-profile.test.ts' });
  });

  it('launches a topic-bound spawn on the pinned model, records it, and keeps the brief', async () => {
    const res = await request(app)
      .post('/sessions/spawn')
      .set('Authorization', 'Bearer test')
      .send({ name: 'bug-fix', prompt: 'Fix the bug to completion.', topicId: TOPIC });
    expect(res.status).toBe(201);
    expect(sm._lastSpawnArgs?.model).toBe('claude-opus-5-5');
    expect(sm._lastSpawnArgs?.framework).toBe('claude-code');
    expect(briefs.getForSession(TOPIC, res.body.tmuxSession)?.prompt).toBe('Fix the bug to completion.');

    // The recorded launch matches the pin → a server restart does NOT restart it.
    rec.sessions.set(String(TOPIC), res.body.tmuxSession);
    const afterRestart = new TopicProfileOrchestrator(makeOrchestratorDeps({ store, resolveProfile, stateFilePath: orchStatePath, rec }));
    afterRestart.bootReconcileSweep();
    await new Promise((r) => setTimeout(r, 80));
    afterRestart.dispose();
    expect(rec.disclosures.join('\n')).not.toContain("wasn't applied");
    expect(rec.kills).toEqual([]);
    expect(rec.spawns).toEqual([]);
  });

  it('an explicit request model wins over the pin', async () => {
    const res = await request(app)
      .post('/sessions/spawn')
      .set('Authorization', 'Bearer test')
      .send({ name: 'bug-fix-2', prompt: 'p', topicId: TOPIC, model: 'sonnet' });
    expect(res.status).toBe(201);
    expect(sm._lastSpawnArgs?.model).toBe('sonnet');
  });

  it('a spawn with no topic is untouched by any profile and records no brief', async () => {
    const res = await request(app)
      .post('/sessions/spawn')
      .set('Authorization', 'Bearer test')
      .send({ name: 'plain-job', prompt: 'p' });
    expect(res.status).toBe(201);
    expect(sm._lastSpawnArgs?.model).toBeUndefined();
    expect(sm._lastSpawnArgs?.framework).toBeUndefined();
    expect(fs.existsSync(path.join(tmpDir, 'state', 'topic-spawn-briefs'))).toBe(false);
  });

  it('when the pin later changes, the profile respawn names the session it replaces so its brief can be carried', async () => {
    const res = await request(app)
      .post('/sessions/spawn')
      .set('Authorization', 'Bearer test')
      .send({ name: 'bug-fix-3', prompt: 'Carry me across the restart.', topicId: TOPIC });
    expect(res.status).toBe(201);
    rec.sessions.set(String(TOPIC), res.body.tmuxSession);
    await store.mutate(String(TOPIC), { model: 'claude-fable-5', updatedBy: 'api-token' });
    const afterRestart = new TopicProfileOrchestrator(makeOrchestratorDeps({ store, resolveProfile, stateFilePath: orchStatePath, rec }));
    afterRestart.bootReconcileSweep();
    const start = Date.now();
    while (rec.spawns.length === 0 && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 10));
    afterRestart.dispose();
    expect(rec.spawns).toHaveLength(1);
    expect(rec.spawns[0].replacedSessionName).toBe(res.body.tmuxSession);
    expect(briefs.getForSession(TOPIC, rec.spawns[0].replacedSessionName)?.prompt).toBe('Carry me across the restart.');
  });
});

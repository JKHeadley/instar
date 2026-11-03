/**
 * E2E lifecycle — a direct spawn (POST /sessions/spawn) into a topic with a
 * pinned profile survives a server restart without a profile restart, and a
 * genuine later profile restart still knows its original brief.
 * (Echo Bugs topic 10000001430.)
 *
 * Production composition: a real AgentServer with the topic-profile bundle
 * built like src/commands/server.ts (real TopicProfileStore +
 * TopicProfileResolver, real TopicProfileOrchestrator, real
 * TopicSpawnBriefStore on the same stateDir). Only tmux is faked.
 *
 *   Phase 1 — alive: the spawn route returns 201 (not 503/500) and the
 *             launch carries the pinned model.
 *   Phase 2 — restart: a NEW orchestrator instance on the same durable state
 *             runs the boot sweep → no "wasn't applied" notice, no kill.
 *   Phase 3 — a legacy session with NO launch record is left alone too.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TopicProfileStore } from '../../src/core/TopicProfileStore.js';
import { TopicProfileResolver } from '../../src/core/TopicProfileResolver.js';
import { TopicProfileWriteSurface } from '../../src/core/topicProfileWriteSurface.js';
import { ProfileConfirmSlots } from '../../src/core/topicProfileIngress.js';
import { TopicProfileOrchestrator } from '../../src/core/TopicProfileOrchestrator.js';
import { TopicSpawnBriefStore } from '../../src/core/TopicSpawnBriefStore.js';
import { createMockSessionManager, type MockSessionManager } from '../helpers/setup.js';
import { makeOrchestratorDeps, newRecorder } from '../helpers/topicProfileOrchestratorDeps.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH_TOKEN = 'test-direct-spawn-e2e';
const TOPIC = 10000001430;

describe('Topic profile × direct spawn E2E lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let sm: MockSessionManager;
  let store: TopicProfileStore;
  let resolver: TopicProfileResolver;
  let orch: TopicProfileOrchestrator;
  let briefs: TopicSpawnBriefStore;
  let orchStatePath: string;
  let pinnedModel: string | undefined;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-direct-spawn-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'tp-direct-spawn-e2e' }));
    const config = {
      projectName: 'tp-direct-spawn-e2e',
      agentName: 'E2E Agent',
      projectDir: tmpDir,
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
    } as InstarConfig;

    store = new TopicProfileStore({
      stateFilePath: path.join(stateDir, 'state', 'topic-profiles.json'),
      legacyFrameworksPath: path.join(stateDir, 'state', 'topic-frameworks.json'),
      isDryRun: () => false,
    });
    resolver = new TopicProfileResolver({
      store,
      defaultFramework: () => 'claude-code',
      configTopicFrameworks: () => ({}),
      configProfileDefaults: () => ({}),
      frameworkDefaultModels: () => ({}),
      tierEscalationConfig: () => undefined,
      localModelBinding: () => null,
      frameworkBinaryPath: () => null,
    });
    await store.mutate(String(TOPIC), { model: 'claude-opus-5-5', updatedBy: 'api-token' });
    pinnedModel = resolver.resolve(String(TOPIC)).model;

    orchStatePath = path.join(stateDir, 'state', 'topic-profile-orchestrator.json');
    orch = new TopicProfileOrchestrator(makeOrchestratorDeps({
      store,
      resolveProfile: (k) => resolver.resolve(k),
      stateFilePath: orchStatePath,
      rec: newRecorder(),
    }));
    briefs = new TopicSpawnBriefStore(stateDir);
    const surface = new TopicProfileWriteSurface({
      store,
      resolver,
      regime: () => ({ enabled: true, dryRun: false }),
      boundOperator: () => null,
      localModelBinding: () => null,
      legacyFrameworkRespawn: async () => ({ respawned: false }),
      orchestrator: null,
      disclose: async () => {},
      audit: () => 'seq-e2e',
    });
    sm = createMockSessionManager();
    server = new AgentServer({
      config,
      sessionManager: sm as any,
      state: new StateManager(stateDir),
      topicProfile: {
        store,
        resolver,
        surface,
        confirmSlots: new ProfileConfirmSlots({ ttlMs: () => 300_000 }),
        orchestrator: orch,
        spawnBriefs: briefs,
      },
    } as any);
  });

  afterAll(async () => {
    orch?.dispose();
    try { await (server as unknown as { stop?: () => Promise<void> }).stop?.(); } catch { /* ignore */ }
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'topic-profile-direct-spawn-lifecycle' });
  });

  let spawnedTmux = '';

  it('Phase 1 — POST /sessions/spawn into the pinned topic returns 201 on the pinned model', async () => {
    expect(pinnedModel).toBeTruthy();
    const res = await request(server.getApp())
      .post('/sessions/spawn')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .send({ name: 'echo-bug-e2e', prompt: 'Fix the bug to completion.', topicId: TOPIC });
    expect(res.status).toBe(201);
    expect(sm._lastSpawnArgs?.model).toBe(pinnedModel);
    spawnedTmux = res.body.tmuxSession;
    expect(briefs.getForSession(TOPIC, spawnedTmux)?.prompt).toBe('Fix the bug to completion.');
  });

  it('Phase 2 — after a server restart the boot sweep does NOT restart the fresh session', async () => {
    const rec = newRecorder();
    rec.sessions.set(String(TOPIC), spawnedTmux);
    const rebooted = new TopicProfileOrchestrator(makeOrchestratorDeps({
      store,
      resolveProfile: (k) => resolver.resolve(k),
      stateFilePath: orchStatePath,
      rec,
    }));
    rebooted.bootReconcileSweep();
    await new Promise((r) => setTimeout(r, 100));
    rebooted.dispose();
    expect(rec.disclosures.join('\n')).not.toContain("wasn't applied");
    expect(rec.kills).toEqual([]);
    expect(rec.spawns).toEqual([]);
  });

  it('Phase 3 — a live session with no launch record (pre-fix spawn) is left alone, audited', async () => {
    const rec = newRecorder();
    rec.sessions.set('777', 'echo-legacy');
    await store.mutate('777', { model: 'claude-opus-5-5', updatedBy: 'api-token' });
    const rebooted = new TopicProfileOrchestrator(makeOrchestratorDeps({
      store,
      resolveProfile: (k) => resolver.resolve(k),
      stateFilePath: orchStatePath,
      rec,
    }));
    rebooted.bootReconcileSweep();
    await new Promise((r) => setTimeout(r, 100));
    rebooted.dispose();
    expect(rec.kills).toEqual([]);
    expect(rec.audits.some((a) => a.type === 'boot-sweep-unknown-applied' && a.topic === '777')).toBe(true);
  });
});

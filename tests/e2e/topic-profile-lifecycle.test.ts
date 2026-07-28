/**
 * E2E lifecycle — Topic Profile (TOPIC-PROFILE-SPEC §5/§10/§12).
 *
 * Tier 3 of the Testing Integrity Standard. Tests the complete PRODUCTION path:
 *   Phase 1 — Feature is alive: the /topic-profile routes are wired into a real
 *             AgentServer composed the SAME way src/commands/server.ts composes it
 *             (real TopicProfileStore + TopicProfileResolver + TopicProfileWriteSurface
 *             + ProfileConfirmSlots; regime resolved through resolveDevAgentGate exactly
 *             like production — an empty config yields the shipped fleet regime
 *             enabled:false/dryRun:true). Proves GET returns 200 (not 503), i.e.
 *             ctx.topicProfile is a REAL bundle, not null.
 *   Phase 2 — The full write → read → durable-persistence lifecycle over the live
 *             server: a §5.2(d) framework write lands LIVE under the fleet regime,
 *             survives on disk in state/topic-profiles.json, and regenerates the
 *             legacy topic-frameworks.json mirror.
 *   Phase 3 — The dark arm: an AgentServer with NO topicProfile bundle serves 503
 *             (never a crash), and load-bearing boundary invariants hold (intent
 *             header required; key clamp; unbound-topic refusal).
 *
 * WIRING-INTEGRITY per the standard: the injected bundle delegates to the real
 * store (durable file proof), and the late-bound boundOperator closure reads the
 * SAME TopicOperatorStore instance the server's routes write — mirroring the
 * production _agentServerRef pattern.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TopicProfileStore } from '../../src/core/TopicProfileStore.js';
import { TopicProfileResolver } from '../../src/core/TopicProfileResolver.js';
import { TopicProfileWriteSurface } from '../../src/core/topicProfileWriteSurface.js';
import { ProfileConfirmSlots } from '../../src/core/topicProfileIngress.js';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH_TOKEN = 'test-topic-profile-e2e';
const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });
const TOPIC = '19437';

describe('Topic Profile E2E lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  let respawns: string[];

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-profile-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'topic-profile-e2e' }));

    const config: InstarConfig = {
      projectName: 'topic-profile-e2e',
      agentName: 'E2E Agent',
      projectDir: tmpDir,
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
    } as InstarConfig;

    // ── Mirror of the src/commands/server.ts composition block ──
    const store = new TopicProfileStore({
      stateFilePath: path.join(stateDir, 'state', 'topic-profiles.json'),
      legacyFrameworksPath: path.join(stateDir, 'state', 'topic-frameworks.json'),
      isDryRun: () => true,
    });
    const resolver = new TopicProfileResolver({
      store,
      defaultFramework: () => 'claude-code',
      configTopicFrameworks: () => ({}),
      configProfileDefaults: () => ({}),
      frameworkDefaultModels: () => ({}),
      tierEscalationConfig: () => undefined,
      localModelBinding: () => null,
      frameworkBinaryPath: () => null,
    });
    const confirmSlots = new ProfileConfirmSlots({ ttlMs: () => 300_000 });
    respawns = [];
    const surface = new TopicProfileWriteSurface({
      store,
      resolver,
      // Production regime resolution verbatim: enabled rides the dev-agent dark
      // gate (no developmentAgent in this config → the shipped FLEET regime).
      regime: () => ({
        enabled: resolveDevAgentGate(undefined, config as { developmentAgent?: boolean }),
        dryRun: true,
      }),
      // Late-bound to the server's OWN TopicOperatorStore — same instance the
      // /topic-operator routes write (the production _agentServerRef pattern).
      boundOperator: (topicKey) => {
        const op = server?.getTopicOperatorStore()?.getOperator(topicKey) ?? null;
        return op ? { platform: op.platform, uid: op.uid } : null;
      },
      localModelBinding: () => null,
      legacyFrameworkRespawn: async (k) => { respawns.push(k); return { respawned: true }; },
      orchestrator: null,
      disclose: async () => { /* no platform adapter in this harness */ },
      audit: () => 'seq-e2e',
    });

    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as any,
      state: new StateManager(stateDir),
      topicProfile: { store, resolver, surface, confirmSlots },
    });
    app = server.getApp();
  });

  afterAll(async () => {
    try { await (server as unknown as { stop?: () => Promise<void> }).stop?.(); } catch { /* ignore */ }
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'topic-profile-lifecycle' });
  });

  // ── Phase 1: feature is alive on the production AgentServer boot path ──

  it('GET /topic-profile/:topicId returns 200 (route wired, bundle not null) with the resolved default', async () => {
    const res = await request(app).get(`/topic-profile/${TOPIC}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.resolved.framework).toBe('claude-code');
    expect(res.body.pin).toBeNull();
  });

  // ── Phase 2: write → read → durable persistence over the live server ──

  it('binds an operator, then a §5.2(d) framework write lands LIVE under the shipped fleet regime', async () => {
    const bind = await request(app)
      .post('/topic-operator')
      .set(auth())
      .send({ topicId: Number(TOPIC), platform: 'telegram', uid: '7812716706', displayName: 'Justin' });
    expect(bind.status).toBe(200);

    const write = await request(app)
      .post(`/topic-profile/${TOPIC}`)
      .set(auth())
      .set('X-Instar-Request', '1')
      .send({ framework: 'codex-cli' });
    expect(write.status).toBe(200);
    expect(write.body.ok).toBe(true);
    expect(write.body.appliedLive).toContain('framework');

    const read = await request(app).get(`/topic-profile/${TOPIC}`).set(auth());
    expect(read.status).toBe(200);
    expect(read.body.pin.framework).toBe('codex-cli');
    expect(read.body.resolved.framework).toBe('codex-cli');
  });

  it('durably persisted the pin to state/topic-profiles.json and regenerated the legacy mirror', () => {
    const file = path.join(stateDir, 'state', 'topic-profiles.json');
    expect(fs.existsSync(file)).toBe(true);
    const stored = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const entry = stored.topics?.[TOPIC] ?? stored[TOPIC];
    expect(JSON.stringify(entry)).toContain('codex-cli');

    const mirror = path.join(stateDir, 'state', 'topic-frameworks.json');
    expect(fs.existsSync(mirror)).toBe(true);
    expect(fs.readFileSync(mirror, 'utf-8')).toContain('codex-cli');
  });

  it('a second store instance over the same state file reads the pin back (restart survival)', () => {
    const reloaded = new TopicProfileStore({
      stateFilePath: path.join(stateDir, 'state', 'topic-profiles.json'),
      legacyFrameworksPath: path.join(stateDir, 'state', 'topic-frameworks.json'),
      isDryRun: () => true,
    });
    expect(reloaded.get(TOPIC)?.current?.framework).toBe('codex-cli');
  });

  // ── Phase 3: boundary invariants + the dark arm ──

  it('refuses a write without the X-Instar-Request intent header (403)', async () => {
    const res = await request(app)
      .post(`/topic-profile/${TOPIC}`)
      .set(auth())
      .send({ framework: 'claude-code' });
    expect(res.status).toBe(403);
  });

  it('refuses a write for a topic with no bound operator (403 no-bound-operator)', async () => {
    const res = await request(app)
      .post('/topic-profile/555')
      .set(auth())
      .set('X-Instar-Request', '1')
      .send({ framework: 'codex-cli' });
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('no-bound-operator');
  });

  it('clamps malformed topic keys at the route boundary (400)', async () => {
    const res = await request(app).get('/topic-profile/not-a-topic').set(auth());
    expect(res.status).toBe(400);
  });

  it('an AgentServer with NO topicProfile bundle serves 503, never a crash (dark arm)', async () => {
    const darkTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-profile-e2e-dark-'));
    const darkState = path.join(darkTmp, '.instar');
    fs.mkdirSync(path.join(darkState, 'state', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(darkState, 'config.json'), JSON.stringify({ port: 0, projectName: 'dark' }));
    const dark = new AgentServer({
      config: {
        projectName: 'dark', agentName: 'Dark', projectDir: darkTmp,
        stateDir: darkState, port: 0, authToken: AUTH_TOKEN,
      } as InstarConfig,
      sessionManager: createMockSessionManager() as any,
      state: new StateManager(darkState),
    });
    try {
      const res = await request(dark.getApp()).get(`/topic-profile/${TOPIC}`).set(auth());
      expect(res.status).toBe(503);
    } finally {
      try { await (dark as unknown as { stop?: () => Promise<void> }).stop?.(); } catch { /* ignore */ }
      SafeFsExecutor.safeRmSync(darkTmp, { recursive: true, force: true, operation: 'topic-profile-lifecycle' });
    }
  });
});

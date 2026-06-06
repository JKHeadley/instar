// safe-git-allow: test file — tmpdir scratch dirs only.
// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 E2E "feature is alive" lifecycle test for GET /coherence/journal — the
 * bounded, merged READ surface over the per-machine coherence journal
 * (COHERENCE-JOURNAL-SPEC §3.5, P1.2).
 *
 * Per TESTING-INTEGRITY-SPEC the single most important test for a feature with
 * API routes: is it actually ALIVE on the production init path (200, not
 * 404/503)? This boots the REAL AgentServer (the same construction path
 * server.ts uses) with real auth middleware + a real StateManager, and mirrors
 * the production gate that server.ts applies when deciding whether to construct
 * and wire the journal:
 *
 *     const cjEnabled = cjCfg?.enabled ?? !!config.developmentAgent;
 *     if (cjEnabled) { ... state.setCoherenceJournal(journal); }
 *
 * (server.ts ~line 2569). The route itself gates on
 * `ctx.state.getCoherenceJournal()` (truthy → 200, undefined → 503), so the
 * journal-wired StateManager IS the production-equivalent "feature enabled"
 * state. We reproduce that decision here rather than booting full server.ts
 * (which spins up Telegram polling, schedulers, tunnels, dozens of monitors) —
 * AgentServer is the same factory those go through, and the codex-usage E2E
 * (tests/e2e/codex-usage-lifecycle.test.ts) is the precedent for this scope.
 *
 * Asserts:
 *   (a) ENABLED (multiMachine.coherenceJournal.enabled / developmentAgent true):
 *       GET /coherence/journal → 200 with the §3.5 shape.
 *   (b) DISABLED: the route → 503.
 *   (c) ALIVE-PATH: emit a topic-placement through the WIRED journal (via
 *       StateManager.getCoherenceJournal()), flush, and the route returns it.
 *   (d) the route requires Bearer auth.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

function baseConfig(stateDir: string, projectDir: string, auth: string): InstarConfig {
  return {
    projectName: 'e2e', projectDir, stateDir, port: 0, authToken: auth,
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;
}

/**
 * Mirror server.ts's coherence-journal construction gate: construct + open +
 * wire the journal into the StateManager IFF the config enables it. Returns the
 * (already-wired) StateManager so the test can reach the live journal handle.
 */
function buildState(config: InstarConfig, machineId: string): { state: StateManager; journal?: CoherenceJournal } {
  const state = new StateManager(config.stateDir);
  const cjCfg = config.multiMachine?.coherenceJournal;
  const cjEnabled = cjCfg?.enabled ?? !!config.developmentAgent;
  if (!cjEnabled) return { state };
  const journal = new CoherenceJournal({ stateDir: config.stateDir, machineId });
  journal.open();
  state.setCoherenceJournal(journal);
  return { state, journal };
}

function mkStateDir(tmpDir: string, name: string): string {
  const stateDir = path.join(tmpDir, name);
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
  return stateDir;
}

describe('Coherence Journal read API E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  const AUTH = 'test-e2e-coherence-journal';

  // (a)+(c) ENABLED server.
  let enabledServer: AgentServer;
  let enabledApp: express.Express;
  let enabledJournal: CoherenceJournal;

  // (b) DISABLED server.
  let disabledServer: AgentServer;
  let disabledApp: express.Express;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coherence-journal-e2e-'));

    // ENABLED via multiMachine.coherenceJournal.enabled (one of the two prod toggles).
    const enabledStateDir = mkStateDir(tmpDir, 'enabled');
    const enabledConfig = baseConfig(enabledStateDir, tmpDir, AUTH);
    (enabledConfig as InstarConfig & { multiMachine?: { coherenceJournal?: { enabled?: boolean } } }).multiMachine = {
      coherenceJournal: { enabled: true },
    };
    const enabledBuilt = buildState(enabledConfig, 'm_e2e_enabled');
    enabledJournal = enabledBuilt.journal!;
    enabledServer = new AgentServer({
      config: enabledConfig,
      sessionManager: createMockSessionManager() as never,
      state: enabledBuilt.state,
    });
    await enabledServer.start();
    enabledApp = enabledServer.getApp();

    // DISABLED: no developmentAgent, no multiMachine.coherenceJournal → journal not wired.
    const disabledStateDir = mkStateDir(tmpDir, 'disabled');
    const disabledConfig = baseConfig(disabledStateDir, tmpDir, AUTH);
    const disabledBuilt = buildState(disabledConfig, 'm_e2e_disabled');
    expect(disabledBuilt.journal).toBeUndefined(); // the gate refused construction
    disabledServer = new AgentServer({
      config: disabledConfig,
      sessionManager: createMockSessionManager() as never,
      state: disabledBuilt.state,
    });
    await disabledServer.start();
    disabledApp = disabledServer.getApp();
  });

  afterAll(async () => {
    try { enabledJournal?.close(); } catch { /* best-effort */ }
    await enabledServer?.stop();
    await disabledServer?.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/coherence-journal-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('(a) ENABLED: GET /coherence/journal is alive (200) with the §3.5 shape', async () => {
    const res = await request(enabledApp).get('/coherence/journal').set(auth());
    expect(res.status).toBe(200);
    // §3.5 shape: entries[], streams{}, skippedCorrupt, truncated.
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(typeof res.body.streams).toBe('object');
    expect(res.body.streams).not.toBeNull();
    expect(typeof res.body.skippedCorrupt).toBe('number');
    expect(typeof res.body.truncated).toBe('boolean');
  });

  it('(b) DISABLED: the route returns 503 (not 200/404)', async () => {
    const res = await request(disabledApp).get('/coherence/journal').set(auth());
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not enabled/i);
  });

  it('(c) ALIVE-PATH: an emit through the wired journal surfaces on the route', async () => {
    const topic = 13481;
    // Emit through the SAME wired journal the route reads (via StateManager).
    enabledJournal.emitPlacement(topic, { owner: 'm_e2e_enabled', epoch: 7, reason: 'placed' });
    enabledJournal.flush(); // durable on disk where the reader scans.

    const res = await request(enabledApp).get('/coherence/journal').query({ kind: 'topic-placement' }).set(auth());
    expect(res.status).toBe(200);
    const placement = res.body.entries.find(
      (e: { topic?: number; kind?: string }) => e.topic === topic && e.kind === 'topic-placement',
    );
    expect(placement).toBeDefined();
    expect(placement.data.owner).toBe('m_e2e_enabled');
    expect(placement.data.epoch).toBe(7);
    expect(placement.data.reason).toBe('placed');
    // The stream status map reports the own stream as `current` (P1.2).
    const streamKey = Object.keys(res.body.streams).find((k) => k.includes('topic-placement'));
    expect(streamKey).toBeDefined();
    expect(res.body.streams[streamKey!].source).toBe('own');
    expect(res.body.streams[streamKey!].status).toBe('current');
  });

  it('(d) requires Bearer auth', async () => {
    const res = await request(enabledApp).get('/coherence/journal');
    expect(res.status).toBe(401);
  });
});

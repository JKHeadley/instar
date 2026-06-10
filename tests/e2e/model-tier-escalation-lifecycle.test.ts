// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * E2E lifecycle — Model-Tier Escalation (FABLE-MODEL-ESCALATION-SPEC §11)
 * on the PRODUCTION initialization path.
 *
 * Phase 1 (the single most important test): the feature is ALIVE. AgentServer
 * constructs the EscalationGovernor + ModelSwapService internally on its real
 * init path; POST /sessions/:name/model-swap must answer with the engine's
 * verdict (404 unknown-session), NOT 503 "not wired". The integration tests
 * hand-inject the service into createRoutes and cannot catch a dropped
 * AgentServer wiring — this can.
 *
 * Phase 2: an escalated spawn (model: claude-fable-5) is accepted by the spawn
 * route and reported by GET /sessions (§5.2 seeding surface over the wire).
 *
 * Phase 3: a codex-cli session is a strict no-op for the mid-session swap
 * (launch-time-only capability) — the backwards-compat contract, alive.
 *
 * Phase 4: dryRun evaluates the full production gate chain and injects nothing.
 *
 * Phase 5 (real tmux, auto-skipped when tmux is unavailable): the §5.3
 * independent-oracle canary end-to-end against a REAL tmux pane running a
 * mock-claude that acknowledges /model — through the REAL SessionManager
 * hardened send-keys + capture primitives.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { ModelSwapService } from '../../src/core/ModelSwapService.js';
import { EscalationGovernor } from '../../src/core/EscalationGovernor.js';
import { StateManager } from '../../src/core/StateManager.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig, Session } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH_TOKEN = 'test-e2e-model-tier';
const IDLE_TAIL = '│ > │\n  shift+tab to cycle\n';

describe('Model-Tier Escalation E2E lifecycle (production init path)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  let mockSM: ReturnType<typeof createMockSessionManager> & {
    on: (ev: string, fn: unknown) => void;
    getProtectedSessions: () => string[];
    captureMeaningfulTail: (t: string, n: number) => string | null;
  };
  let config: InstarConfig;
  let stateRef: StateManager;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-tier-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    // The production SessionManager surface the model-tier wiring relies on:
    // EventEmitter.on (sessionReaped lease release), getProtectedSessions,
    // captureMeaningfulTail (idle check + canary read-back).
    mockSM = Object.assign(createMockSessionManager(), {
      on: () => {},
      getProtectedSessions: () => [] as string[],
      captureMeaningfulTail: () => IDLE_TAIL,
    });
    // The real SessionManager persists every spawn via state.saveSession —
    // GET /sessions serves from StateManager, so the mock must do the same
    // for the spawn→report assertion to exercise the production read path.
    const state = new StateManager(stateDir);
    const origSpawn = mockSM.spawnSession.bind(mockSM);
    mockSM.spawnSession = async (opts) => {
      const s = await origSpawn(opts);
      state.saveSession(s);
      return s;
    };
    stateRef = state;

    config = {
      projectName: 'e2e-model-tier',
      projectDir: tmpDir,
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      requestTimeoutMs: 10000,
      version: '0.0.0-test',
      sessions: {
        claudePath: '/usr/bin/echo',
        maxSessions: 3,
        defaultMaxDurationMinutes: 30,
        protectedSessions: [],
        monitorIntervalMs: 5000,
      },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [],
      monitoring: {},
      updates: {},
      // §9 config — enabled+dryRun mutated per-phase below (the production
      // wiring re-reads config.models on every call, exactly like server.ts).
      // requireQuotaHeadroom off: this server has no subscription pool, so a
      // cached snapshot can never exist and the fail-closed quota gate would
      // (correctly) refuse every escalation before the dryRun phase ran.
      models: {
        tierEscalation: { enabled: false, dryRun: true, costGuards: { requireQuotaHeadroom: false } },
      },
    } as InstarConfig;

    server = new AgentServer({
      config,
      sessionManager: mockSM as never,
      state: stateRef,
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/model-tier-escalation-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });
  const te = () => (config as { models: { tierEscalation: { enabled: boolean; dryRun: boolean } } }).models.tierEscalation;

  // ── Phase 1: FEATURE IS ALIVE ────────────────────────────────────────
  it('FEATURE IS ALIVE: model-swap answers with the engine verdict (404), never 503', async () => {
    const res = await request(app)
      .post('/sessions/no-such-session/model-swap')
      .set(auth())
      .send({ tier: 'escalated' });
    expect(res.status).toBe(404); // engine reached and refused unknown-session
    expect(res.body.reason).toBe('unknown-session');
  });

  it('model-swap requires Bearer auth (401 without)', async () => {
    const res = await request(app)
      .post('/sessions/foo/model-swap')
      .send({ tier: 'escalated' });
    expect(res.status).toBe(401);
  });

  // ── Phase 2: escalated spawn reported over the wire ──────────────────
  it('an escalated spawn (claude-fable-5) is accepted and GET /sessions reports it', async () => {
    const spawn = await request(app)
      .post('/sessions/spawn')
      .set(auth())
      .send({ name: 'fable-session', prompt: 'work', model: 'claude-fable-5' });
    expect(spawn.status).toBe(201);

    const list = await request(app).get('/sessions').set(auth());
    expect(list.status).toBe(200);
    const fable = (list.body as Session[]).find(s => s.name === 'fable-session');
    expect(fable).toBeDefined();
    expect(fable!.model).toBe('claude-fable-5');
  });

  // ── Phase 3: codex no-op (backwards-compat alive) ─────────────────────
  it('codex-cli session: the same trigger performs ZERO swaps and never changes the model', async () => {
    te().enabled = true;
    te().dryRun = false;
    const codex: Session = {
      id: 'codex-1',
      name: 'codex-session',
      status: 'running',
      tmuxSession: 'instar-codex-session',
      startedAt: new Date().toISOString(),
      framework: 'codex-cli',
    } as Session;
    mockSM._sessions.push(codex);

    const res = await request(app)
      .post('/sessions/codex-session/model-swap')
      .set(auth())
      .send({ tier: 'escalated' });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('launch-time-only-framework');
    expect(codex.model).toBeUndefined();
    te().enabled = false;
    te().dryRun = true;
  });

  // ── Phase 4: dryRun through the production gate chain ─────────────────
  it('dryRun: full gate chain runs for an escalation, status dry-run, Session.model untouched', async () => {
    te().enabled = true;
    te().dryRun = true;
    await request(app)
      .post('/sessions/spawn')
      .set(auth())
      .send({ name: 'plain-session', prompt: 'work' }); // no model — default tier
    const res = await request(app)
      .post('/sessions/plain-session/model-swap')
      .set(auth())
      .send({ tier: 'escalated' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('dry-run');
    expect(res.body.model).toBe('claude-fable-5'); // server-derived escalated id
    const plain = mockSM._sessions.find(s => s.name === 'plain-session');
    expect(plain!.model).toBeUndefined(); // untouched by dry-run
    te().enabled = false;
  });

  // ── Phase 4b: rescue de-escalation honesty through production wiring ──
  it('rescue de-escalation under dryRun performs a REAL swap attempt (202 unconfirmed on a silent pane)', async () => {
    te().enabled = true;
    te().dryRun = true;
    const res = await request(app)
      .post('/sessions/fable-session/model-swap')
      .set(auth())
      .send({ tier: 'default' }); // fable-session is ON the escalated id → rescue path
    // The mock pane never prints the CLI ack, so the honest outcome is
    // 202 unconfirmed with Session.model untouched — never a fake 'swapped'.
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('unconfirmed');
    const fable = mockSM._sessions.find(s => s.name === 'fable-session');
    expect(fable!.model).toBe('claude-fable-5');
    te().enabled = false;
  });
});

// ── Phase 5: §5.3 canary vs REAL tmux ───────────────────────────────────
const tmuxOk = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
const TMUX_SESSION = `model-tier-canary-${process.pid}`;

describe.skipIf(!tmuxOk)('§5.3 canary end-to-end vs real tmux (mock-claude pane)', () => {
  let dir: string;
  let stateDir: string;
  let manager: SessionManager;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-tier-canary-'));
    stateDir = path.join(dir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    // Mock-claude: renders an idle prompt and acknowledges `/model <id>` the
    // way the CLI does ("Set model to <id>") — the independent oracle's input.
    const mockClaude = path.join(dir, 'mock-claude.sh');
    fs.writeFileSync(mockClaude, `#!/bin/bash
echo '  shift+tab to cycle'
echo '│ > │'
while IFS= read -r line; do
  case "$line" in
    /model\\ *) echo "Set model to \${line#/model } (tier swap)" ;;
  esac
  echo '  shift+tab to cycle'
  echo '│ > │'
done
`, { mode: 0o755 });

    const tmuxPath = spawnSync('which', ['tmux']).stdout.toString().trim();
    spawnSync(tmuxPath, ['new-session', '-d', '-s', TMUX_SESSION, mockClaude], { stdio: 'ignore' });
    // Wait for the mock-claude pane to render its idle prompt — the swap's
    // idle gate fails closed on a not-yet-started pane.
    for (let i = 0; i < 40; i++) {
      const cap = spawnSync(tmuxPath, ['capture-pane', '-p', '-t', `=${TMUX_SESSION}:`]).stdout?.toString() ?? '';
      if (cap.includes('shift+tab to cycle')) break;
      spawnSync('sleep', ['0.25']);
    }

    manager = new SessionManager(
      {
        tmuxPath,
        claudePath: '/usr/bin/echo',
        projectDir: dir,
        maxSessions: 3,
        protectedSessions: [],
        completionPatterns: [],
        framework: 'claude-code',
      } as never,
      new StateManager(stateDir),
    );
  });

  afterAll(() => {
    manager?.stopMonitoring();
    spawnSync('tmux', ['kill-session', '-t', `=${TMUX_SESSION}`], { stdio: 'ignore' });
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/model-tier-escalation-lifecycle.test.ts:canary' });
  });

  it('injects via the REAL hardened send-keys and the independent oracle confirms', async () => {
    const session: Session = {
      id: 'canary-1',
      name: 'canary-session',
      status: 'running',
      tmuxSession: TMUX_SESSION,
      startedAt: new Date().toISOString(),
    } as Session;

    const governor = new EscalationGovernor({
      stateDir: dir,
      getConfig: () => cfg(),
      quotaSnapshot: () => ({ measuredAt: new Date().toISOString(), fiveHour: { utilizationPct: 5 }, sevenDay: { utilizationPct: 5 } }),
      ultraTokensTodayUtc: () => 0,
      isHolderLive: () => false,
    });
    const saved: Session[] = [];
    const cfg = () => ({
      enabled: true,
      dryRun: false,
      triggers: { skills: ['build'], projectDesign: true, llmIntentCheck: false },
      frameworks: { 'claude-code': { default: 'claude-opus-4-8', escalated: 'claude-fable-5' } },
      costGuards: {
        respectFreeWindows: {},
        requireQuotaHeadroom: true,
        maxConcurrentEscalatedPerAccount: 2,
        maxEscalationsPerHour: 8,
        dailyUltraTokenCap: null,
        maxEscalationTtlMs: 21_600_000,
        minTierDwellMs: 300_000,
        minTierDwellTurns: 1,
      },
    } as never);

    const swap = new ModelSwapService({
      stateDir: dir,
      sessions: {
        listRunningSessions: () => [session],
        // The REAL SessionManager primitives against the REAL pane.
        captureMeaningfulTail: (t, n) => manager.captureMeaningfulTail(t, n),
        sendInput: (t, input) => manager.sendInput(t, input),
      },
      saveSession: s => { saved.push({ ...s }); },
      protectedSessions: () => [],
      getConfig: cfg,
      governor,
      canaryAttempts: 10,
      canaryIntervalMs: 300,
    });

    const result = await swap.swap('canary-session', 'escalated');
    if (result.status !== 'swapped') {
      // Surface the engine's refusal reason in the test output — the audit
      // trail has the full story when this fails.
      console.error('canary swap did not confirm:', JSON.stringify(result));
    }
    expect(result.status).toBe('swapped');
    expect(result.confirmed).toBe(true);
    expect(result.model).toBe('claude-fable-5');
    expect(session.model).toBe('claude-fable-5');
    expect(saved.length).toBe(1);

    // The audit trail tells the whole story: injected → swap-confirmed.
    const audit = fs.readFileSync(path.join(dir, 'state', 'model-tier-escalation', 'audit.jsonl'), 'utf8');
    expect(audit).toContain('"injected"');
    expect(audit).toContain('"swap-confirmed"');
  }, 30_000);
});

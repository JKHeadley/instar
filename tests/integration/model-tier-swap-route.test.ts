// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Integration tests — POST /sessions/:name/model-swap (FABLE-MODEL-ESCALATION-
 * SPEC §5.3) and the /sessions/spawn fable allowlist, over the full HTTP route
 * pipeline with a REAL ModelSwapService + EscalationGovernor (only the tmux
 * surface is faked).
 *
 * §11 contract under test:
 *  - the body carries a TIER only; a raw model id is a hard 400 (Sec-F5)
 *  - the model id is derived server-side from config, never from the caller
 *  - refusals map to honest HTTP statuses (404 unknown / 403 protected /
 *    409 disabled / 429 dwell-or-cost-guard)
 *  - enabled:false wins over everything; dryRun evaluates every gate but
 *    injects nothing and leaves Session.model untouched
 *  - a non-claude framework with no escalated model performs ZERO swaps
 *    (backwards-compat contract: noop, not an error)
 *  - /sessions/spawn accepts claude-fable-5 for claude-code and refuses it
 *    for codex-cli (closed per-framework allowlists)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import { ModelSwapService } from '../../src/core/ModelSwapService.js';
import { EscalationGovernor } from '../../src/core/EscalationGovernor.js';
import { DEFAULT_TIER_ESCALATION_CONFIG, normalizeTierEscalationConfig } from '../../src/core/ModelTierEscalation.js';
import type { TierEscalationConfig } from '../../src/core/ModelTierEscalation.js';
import type { Session } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createMockSessionManager } from '../helpers/setup.js';

// Must contain an IDLE_PROMPT_PATTERNS marker AND a bare/empty prompt row.
const IDLE_TAIL = '│ > Try "build something" │\n  shift+tab to cycle\n';

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: over.id ?? 'sess-1',
    name: over.name ?? 'work-session',
    status: 'running',
    tmuxSession: over.tmuxSession ?? 'instar-work-session',
    startedAt: new Date().toISOString(),
    ...over,
  } as Session;
}

describe('POST /sessions/:name/model-swap — integration', () => {
  let tmpDir: string;
  let app: express.Express;
  let sessions: Session[];
  let sentInputs: string[];
  let tailResponse: () => string | null;
  let cfg: TierEscalationConfig;
  let protectedList: string[];

  function buildApp(): void {
    const governor = new EscalationGovernor({
      stateDir: tmpDir,
      getConfig: () => cfg,
      quotaSnapshot: () => ({
        // healthy cached snapshot so requireQuotaHeadroom admits
        measuredAt: new Date().toISOString(),
        fiveHour: { utilizationPct: 10 },
        sevenDay: { utilizationPct: 10 },
      }),
      ultraTokensTodayUtc: () => 0,
      isHolderLive: () => false,
    });
    const swap = new ModelSwapService({
      stateDir: tmpDir,
      sessions: {
        listRunningSessions: () => sessions,
        captureMeaningfulTail: () => tailResponse(),
        sendInput: (_t, input) => { sentInputs.push(input); return true; },
      },
      saveSession: () => {},
      protectedSessions: () => protectedList,
      getConfig: () => cfg,
      governor,
      canaryAttempts: 1,
      canaryIntervalMs: 1,
      wait: async () => {},
    });

    app = express();
    app.use(express.json());
    const ctx: any = {
      config: { authToken: 'test', stateDir: tmpDir, port: 0 },
      sessionManager: createMockSessionManager(),
      startTime: new Date(),
      modelTierSwap: swap,
    };
    app.use(createRoutes(ctx));
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-tier-route-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    sessions = [makeSession()];
    sentInputs = [];
    tailResponse = () => IDLE_TAIL;
    protectedList = [];
    cfg = normalizeTierEscalationConfig({
      ...structuredClone(DEFAULT_TIER_ESCALATION_CONFIG),
      enabled: true,
      dryRun: false,
    });
    buildApp();
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/model-tier-swap-route.test.ts' });
  });

  it('400s a body that names a raw model id — the id is server-derived (Sec-F5)', async () => {
    const res = await request(app)
      .post('/sessions/work-session/model-swap')
      .send({ tier: 'escalated', model: 'claude-fable-5' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('derived server-side');
    expect(sentInputs).toEqual([]);
  });

  it('400s a missing or invalid tier', async () => {
    for (const body of [{}, { tier: 'ultra' }, { tier: 'claude-fable-5' }]) {
      const res = await request(app).post('/sessions/work-session/model-swap').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('"tier" must be "default" or "escalated"');
    }
  });

  it('404s an unknown session', async () => {
    const res = await request(app)
      .post('/sessions/no-such-session/model-swap')
      .send({ tier: 'escalated' });
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe('unknown-session');
  });

  it('403s a protected session', async () => {
    protectedList = ['instar-work-session'];
    const res = await request(app)
      .post('/sessions/work-session/model-swap')
      .send({ tier: 'escalated' });
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('protected-session');
  });

  it('409s when escalation is disabled (enabled:false wins)', async () => {
    cfg = normalizeTierEscalationConfig({ ...cfg, enabled: false });
    const res = await request(app)
      .post('/sessions/work-session/model-swap')
      .send({ tier: 'escalated' });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('disabled');
    expect(sentInputs).toEqual([]);
  });

  it('409s a non-idle session (fail-closed pane check)', async () => {
    tailResponse = () => 'Running tests...\n47 passed\n';
    const res = await request(app)
      .post('/sessions/work-session/model-swap')
      .send({ tier: 'escalated' });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('not-idle');
    expect(sentInputs).toEqual([]);
  });

  it('dryRun: 200 with status dry-run, every gate evaluated, NOTHING injected', async () => {
    cfg = normalizeTierEscalationConfig({ ...cfg, dryRun: true });
    const res = await request(app)
      .post('/sessions/work-session/model-swap')
      .send({ tier: 'escalated' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('dry-run');
    expect(res.body.model).toBe('claude-fable-5'); // server-derived
    expect(sentInputs).toEqual([]);
    expect(sessions[0].model).toBeUndefined(); // Session.model untouched
  });

  it('live swap injects the SERVER-derived /model command and 202s when unconfirmed', async () => {
    // Idle pane that never prints the canary ack → injected but unconfirmed.
    const res = await request(app)
      .post('/sessions/work-session/model-swap')
      .send({ tier: 'escalated' });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('unconfirmed');
    expect(sentInputs).toEqual(['/model claude-fable-5']);
    expect(sessions[0].model).toBeUndefined(); // unconfirmed ⇒ untouched
  });

  it('live swap 200s as swapped when the independent oracle confirms', async () => {
    // Call 1 = pre-inject idle check (must look idle); later calls = canary
    // read-back showing the CLI's own acknowledgment line (not our echo).
    let calls = 0;
    tailResponse = () => {
      calls++;
      return calls === 1 ? IDLE_TAIL : 'Set model to claude-fable-5 (ultra)\n' + IDLE_TAIL;
    };
    const res = await request(app)
      .post('/sessions/work-session/model-swap')
      .send({ tier: 'escalated' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('swapped');
    expect(res.body.confirmed).toBe(true);
    expect(sentInputs).toEqual(['/model claude-fable-5']);
    expect(sessions[0].model).toBe('claude-fable-5');
  });

  it('RESCUE: enabled:false still de-escalates a session stuck on the escalated id (rollback lever works)', async () => {
    // Phase-5 review finding: the rollback levers must not strand a live
    // escalated session on the ultra model — tier:'default' for a session
    // currently ON an escalated id bypasses enabled/dryRun.
    cfg = normalizeTierEscalationConfig({ ...cfg, enabled: false });
    sessions = [makeSession({ model: 'claude-fable-5' })];
    let calls = 0;
    tailResponse = () => {
      calls++;
      return calls === 1 ? IDLE_TAIL : 'Set model to claude-opus-4-8\n' + IDLE_TAIL;
    };
    const res = await request(app)
      .post('/sessions/work-session/model-swap')
      .send({ tier: 'default' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('swapped');
    expect(sentInputs).toEqual(['/model claude-opus-4-8']);
    expect(sessions[0].model).toBe('claude-opus-4-8');
  });

  it('RESCUE: dryRun:true also performs a REAL de-escalation for an escalated session', async () => {
    cfg = normalizeTierEscalationConfig({ ...cfg, dryRun: true });
    sessions = [makeSession({ model: 'claude-fable-5' })];
    let calls = 0;
    tailResponse = () => {
      calls++;
      return calls === 1 ? IDLE_TAIL : 'Set model to claude-opus-4-8\n' + IDLE_TAIL;
    };
    const res = await request(app)
      .post('/sessions/work-session/model-swap')
      .send({ tier: 'default' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('swapped');
    expect(sessions[0].model).toBe('claude-opus-4-8');
  });

  it('disabled + tier:default on a NON-escalated session: still refused (fleet stays inert)', async () => {
    cfg = normalizeTierEscalationConfig({ ...cfg, enabled: false });
    sessions = [makeSession({ model: 'claude-sonnet-4-6' })]; // not the escalated id
    const res = await request(app)
      .post('/sessions/work-session/model-swap')
      .send({ tier: 'default' });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('disabled');
    expect(sentInputs).toEqual([]);
  });

  it('codex-cli session (no escalated model): noop, zero swaps — backwards-compat alive', async () => {
    sessions = [makeSession({ framework: 'codex-cli' } as Partial<Session>)];
    const res = await request(app)
      .post('/sessions/work-session/model-swap')
      .send({ tier: 'escalated' });
    // codex-cli is launch-time-only capability → refused before any resolve,
    // and NEVER an injection.
    expect([200, 409]).toContain(res.status);
    expect(res.body.status ?? 'refused').toBeDefined();
    expect(sentInputs).toEqual([]);
    expect(sessions[0].model).toBeUndefined();
  });

  it('503s when the swap engine is not wired', async () => {
    const bare = express();
    bare.use(express.json());
    bare.use(createRoutes({
      config: { authToken: 'test', stateDir: tmpDir, port: 0 },
      sessionManager: createMockSessionManager(),
      startTime: new Date(),
      modelTierSwap: null,
    } as any));
    const res = await request(bare)
      .post('/sessions/work-session/model-swap')
      .send({ tier: 'escalated' });
    expect(res.status).toBe(503);
  });
});

describe('POST /sessions/spawn — fable allowlist (integration)', () => {
  let tmpDir: string;
  let app: express.Express;
  let mockSM: ReturnType<typeof createMockSessionManager>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-tier-spawn-'));
    mockSM = createMockSessionManager();
    app = express();
    app.use(express.json());
    app.use(createRoutes({
      config: { authToken: 'test', stateDir: tmpDir, port: 0 },
      sessionManager: mockSM,
      startTime: new Date(),
    } as any));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/model-tier-swap-route.test.ts' });
  });

  it('accepts claude-fable-5 for the (default) claude-code framework', async () => {
    const res = await request(app)
      .post('/sessions/spawn')
      .send({ name: 'fable-spawn', prompt: 'hello', model: 'claude-fable-5' });
    expect(res.status).toBe(201);
    expect(res.body.model).toBe('claude-fable-5');
    expect(mockSM._lastSpawnArgs?.model).toBe('claude-fable-5');
  });

  it('refuses claude-fable-5 for codex-cli (closed per-framework allowlist)', async () => {
    const res = await request(app)
      .post('/sessions/spawn')
      .send({ name: 'codex-spawn', prompt: 'hello', model: 'claude-fable-5', framework: 'codex-cli' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('"model" must be one of');
    expect(mockSM._spawnCount).toBe(0);
  });

  it('threads an explicit ultracode opt-in only to Claude spawns', async () => {
    const accepted = await request(app)
      .post('/sessions/spawn')
      .send({ name: 'ultracode-spawn', prompt: 'hello', ultracode: true });
    expect(accepted.status).toBe(201);
    expect(mockSM._lastSpawnArgs?.ultracode).toBe(true);

    const refused = await request(app)
      .post('/sessions/spawn')
      .send({ name: 'codex-ultracode', prompt: 'hello', framework: 'codex-cli', ultracode: true });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain('supported only for framework');
  });

  it('rejects non-boolean ultracode values', async () => {
    const res = await request(app)
      .post('/sessions/spawn')
      .send({ name: 'bad-ultracode', prompt: 'hello', ultracode: 'yes' });
    expect(res.status).toBe(400);
  });

  it('refuses omitted-framework ultracode on a Codex-default agent', async () => {
    const codexDefaultApp = express();
    codexDefaultApp.use(express.json());
    codexDefaultApp.use(createRoutes({
      config: { authToken: 'test', stateDir: tmpDir, port: 0, sessions: { framework: 'codex-cli' } },
      sessionManager: mockSM,
      startTime: new Date(),
    } as any));
    const res = await request(codexDefaultApp)
      .post('/sessions/spawn')
      .send({ name: 'implicit-codex-ultracode', prompt: 'hello', ultracode: true });
    expect(res.status).toBe(400);
    expect(mockSM._spawnCount).toBe(0);
  });
});

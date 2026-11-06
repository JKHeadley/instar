// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 E2E "feature is alive" for the Skill Learning Sentinel's operator surface
 * (docs/specs/skill-learning-sentinel.md §3.10 / §8, slice 1): the production AgentServer init
 * path mounts `/skills/learned*` behind the real bearer gate; with the flag on and no sentinel
 * bound it answers the exact dark error (503 `skill-learning-disabled`, never a 404 and never a
 * fake 200); binding a sentinel through the server's own `setSkillLearningSentinel()` turns the
 * same route 200 without a restart; the PIN-gated taps run the real operator-PIN gate (403 without
 * a PIN); and the wiring is the real one (source guards: the mount next to queue-pace, the setter,
 * routes.ts delegating its `checkMandatePin` closure to mandatePin.ts).
 *
 * The 200 path with the REAL sentinel class (src/monitoring/SkillLearningSentinel.ts, builder 1B)
 * is the last `it`: it runs only once that module exists on disk and is reported as skipped (not
 * passed) until then.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { HandshakeManager } from '../../src/threadline/HandshakeManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import type { SkillLearningSentinelLike, SkillLearningStatus } from '../../src/monitoring/skillLearning/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const REAL_SENTINEL = path.join(process.cwd(), 'src/monitoring/SkillLearningSentinel.ts');
const realSentinelOnDisk = fs.existsSync(REAL_SENTINEL);

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

describe('skill-learning E2E lifecycle (feature is alive on the production init path)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-skill-learning';
  const PIN = '135791';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'skill-learning-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
    const config: InstarConfig = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH, dashboardPin: PIN,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: { skillLearning: { enabled: true, mode: 'shadow' } }, updates: {},
    } as InstarConfig;
    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as any,
      state: new StateManager(stateDir),
      handshakeManager: new HandshakeManager(stateDir, 'e2e'),
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/skill-learning-alive.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('the route is mounted behind the real bearer gate: 401 without a token, never a 404', async () => {
    const res = await request(app).get('/skills/learned');
    expect(res.status).toBe(401);
  });

  it('flag on, no sentinel bound yet: the exact dark answer (503 skill-learning-disabled), not a fake 200', async () => {
    const res = await request(app).get('/skills/learned').set(auth());
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('skill-learning-disabled');
    expect(typeof res.body.machine).toBe('string');
    const one = await request(app).get('/skills/learned/weekly-ci-health').set(auth());
    expect(one.status).toBe(503);
    expect(one.body.error).toBe('skill-learning-disabled');
  });

  it('the slug grammar guards the edge even while dark (400 for a bad name)', async () => {
    const res = await request(app).get('/skills/learned/Not%20A%20Slug').set(auth());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid-skill-name');
  });

  it('binding a sentinel through setSkillLearningSentinel() makes the SAME route answer 200 with no restart; the taps run the real PIN gate', async () => {
    const status: SkillLearningStatus = {
      machine: 'e2e', enabled: true, mode: 'shadow',
      counts: { requests: 0, verified: 0, keys: 0, proposals: 1, skills: 0 },
      channels: { telegram: 'measured', slack: 'support-only', app: 'unmeasurable' },
      pendingBacklog: 0, classifierFailures24h: 0, abortedUnreachable24h: 0,
      filtered: { 'not-user': 0, forwarded: 0, 'not-operator': 0, 'confirmation-reply': 0, 'slack-asserted': 0 },
      skills: [], proposals: [{ name: 'weekly-ci-health', key: 'k', arbiterOnly: false, createdAt: new Date().toISOString(), paraphrases: ['how is CI this week?'], description: 'Report the week’s CI health.' }],
      pending: [], retired: [],
    };
    const verdicts: string[] = [];
    const sentinel: SkillLearningSentinelLike = {
      status: () => status,
      skill: (name) => status.proposals.find((p) => p.name === name) ?? null,
      recordOperatorVerdict: (name, verdict) => { verdicts.push(`${name}:${verdict}`); return { ok: true }; },
    };
    server.setSkillLearningSentinel(sentinel);
    try {
      const res = await request(app).get('/skills/learned').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe('shadow');
      expect(res.body.proposals).toHaveLength(1);
      // The operator-PIN gate is the real shared one: bearer alone is refused.
      const noPin = await request(app).post('/skills/learned/proposals/weekly-ci-health/agree').set(auth()).send({});
      expect(noPin.status).toBe(403);
      expect(noPin.body.error).toContain('Operator PIN required');
      expect(verdicts).toEqual([]);
      const noReason = await request(app).post('/skills/learned/proposals/weekly-ci-health/disagree').set(auth()).send({ pin: PIN });
      expect(noReason.status).toBe(400);
      const ok = await request(app).post('/skills/learned/proposals/weekly-ci-health/agree').set(auth()).send({ pin: PIN });
      expect(ok.status).toBe(200);
      expect(ok.body.ok).toBe(true);
      expect(verdicts).toEqual(['weekly-ci-health:agree']);
    } finally {
      server.setSkillLearningSentinel(null);
    }
    const dark = await request(app).get('/skills/learned').set(auth());
    expect(dark.status).toBe(503);
  });

  it.skipIf(!realSentinelOnDisk)('200 path with the REAL SkillLearningSentinel over the REAL ledger and provenance log (runs once builder 1B\'s src/monitoring/SkillLearningSentinel.ts exists)', async () => {
    const [{ SkillLearningSentinel }, { Ledger }, { JudgmentProvenanceLog }, { SKILL_LEARNING_DEFAULTS }] = await Promise.all([
      import('../../src/monitoring/SkillLearningSentinel.js'),
      import('../../src/monitoring/skillLearning/Ledger.js'),
      import('../../src/core/JudgmentProvenanceLog.js'),
      import('../../src/config/ConfigDefaults.js'),
    ]);
    const provenanceLog = new JudgmentProvenanceLog({ dir: path.join(stateDir, 'state', 'judgment-provenance') });
    const real = new SkillLearningSentinel({
      config: { ...structuredClone(SKILL_LEARNING_DEFAULTS), enabled: true, mode: 'shadow' },
      stateDir, projectDir: tmpDir, machineId: os.hostname(),
      ledger: new Ledger({ stateDir, machineId: os.hostname() }),
      families: () => [],
      transcriptPath: () => null,
      operatorMessage: () => null,
      provenance: { recordDecision: (input) => provenanceLog.recordDecision(input), isRecordingLive: () => true },
    });
    server.setSkillLearningSentinel(real);
    try {
      const res = await request(app).get('/skills/learned').set(auth());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ enabled: true, mode: 'shadow' });
      expect(Array.isArray(res.body.proposals)).toBe(true);
      expect(Array.isArray(res.body.skills)).toBe(true);
      expect(typeof res.body.machine).toBe('string');
      // A tap on a proposal the real sentinel does not know is refused, never a silent 200.
      const unknown = await request(app).post('/skills/learned/proposals/never-drafted/agree').set(auth()).send({ pin: PIN });
      expect([404, 409]).toContain(unknown.status);
    } finally {
      server.setSkillLearningSentinel(null);
      real.stop();
    }
  });
});

describe('skill-learning routes — WIRED into the production server (dead-code guard)', () => {
  const agentServerSrc = fs.readFileSync(path.join(process.cwd(), 'src/server/AgentServer.ts'), 'utf-8');
  const routesSrc = fs.readFileSync(path.join(process.cwd(), 'src/server/routes.ts'), 'utf-8');

  it('AgentServer mounts createSkillLearningRoutes with the live getter, next to queue pace', () => {
    const mount = agentServerSrc.indexOf('this.app.use(createSkillLearningRoutes({ ...routeCtx, skillLearningSentinel: () => this.skillLearningSentinel }));');
    expect(mount).toBeGreaterThan(0);
    const pace = agentServerSrc.indexOf('this.app.use(createQueuePaceRoutes(');
    expect(pace).toBeGreaterThan(0);
    expect(mount - pace).toBeLessThan(600);
  });

  it('AgentServer exposes setSkillLearningSentinel() for server.ts to bind the real sentinel', () => {
    expect(agentServerSrc).toMatch(/setSkillLearningSentinel\(sentinel: SkillLearningSentinelLike \| null\): void/);
  });

  it('routes.ts keeps its checkMandatePin signature and delegates to the shared mandatePin.ts gate', () => {
    expect(routesSrc).toContain("import { createMandatePinCheck } from './mandatePin.js';");
    expect(routesSrc).toMatch(/function checkMandatePin\(req: import\('express'\)\.Request, res: import\('express'\)\.Response, pinOverride\?: string\): boolean \{\s*return requireMandatePin\(req, res, \{ pinOverride \}\);/);
    // The old inline implementation is gone (one gate, not two).
    expect(routesSrc).not.toContain('const mandatePinAttempts = new Map');
  });
});

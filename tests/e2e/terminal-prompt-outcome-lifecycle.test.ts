// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier 3 (CMT-1677): on the production AgentServer boot path, a PromptGate
 * prompt-detect decision followed by a simulated pane change records a
 * `progressed-without-input` outcome that the booted server's own
 * GET /decision-quality grades under terminal-prompt-detect.
 *
 * PromptGate itself is constructed in commands/server.ts (not AgentServer), so
 * the wiring there is pinned by source and the detector is built here exactly
 * as boot builds it: the shared production Jev factory, a REAL router, and
 * the production §5.4 chokepoint (annotateDecisionOutcome) that the booted
 * AgentServer installs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type express from 'express';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { IntelligenceRouter } from '../../src/core/IntelligenceRouter.js';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';
import type { InstarConfig, IntelligenceProvider } from '../../src/core/types.js';
import { annotateDecisionOutcome } from '../../src/core/DecisionQualityRecorderImpl.js';
import { buildPromptJevFirst, promptDetectState } from '../../src/core/JevFirstPrompt.js';
import { InputDetector } from '../../src/monitoring/PromptGate.js';
import { PromptDetectOutcomeObserver } from '../../src/monitoring/PromptDetectOutcomeObserver.js';
import { JudgmentProvenanceLog } from '../../src/core/JudgmentProvenanceLog.js';
import { DP_TERMINAL_PROMPT_DETECT } from '../../src/data/provenanceCoverage.js';

const AUTH = 'terminal-prompt-outcome-e2e';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

describe('terminal prompt-detect outcome on the production boot path (CMT-1677)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let scheduler: JobScheduler;
  let app: express.Express;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-prompt-outcome-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
    const jobsFile = path.join(stateDir, 'jobs.json');
    fs.writeFileSync(jobsFile, '[]');
    const config: InstarConfig = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0', developmentAgent: true,
      provenance: { uniformSeam: { enabled: true, dryRun: false } },
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile, maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as InstarConfig;
    const state = new StateManager(stateDir);
    const sessionManager = { listRunningSessions: () => [], getSession: () => null };
    scheduler = new JobScheduler({ jobsFile, enabled: false, maxParallelJobs: 1,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } }, sessionManager as any, state, stateDir);
    server = new AgentServer({ config, sessionManager: sessionManager as any, state, scheduler });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    scheduler.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/terminal-prompt-outcome-lifecycle.test.ts' });
  });

  it('boot wires the observer to the production chokepoint and every session write feeds it', () => {
    const bootSource = fs.readFileSync(path.join(__dirname, '../../src/commands/server.ts'), 'utf8');
    expect(bootSource).toMatch(/new InputDetector\(\{[\s\S]*?outcomeObserver: new PromptDetectOutcomeObserver\(\{ annotate: annotateDecisionOutcome \}\)/);
    expect(bootSource).toMatch(/promptDetector\?\.disposeOutcomeObserver\(\)/);
    const smSource = fs.readFileSync(path.join(__dirname, '../../src/core/SessionManager.ts'), 'utf8');
    expect(smSource).toMatch(/private confinedWriteRefused\([\s\S]*?this\.promptDetector\?\.noteSessionInput\(tmuxSession\)/);
  });

  it('a prompt-detect decision then a pane change records progressed-without-input, graded on /decision-quality', async () => {
    const defaultProvider: IntelligenceProvider = { evaluate: vi.fn(async () => 'NO_PROMPT') };
    const router = new IntelligenceRouter({ defaultProvider, defaultFramework: 'claude-code' as IntelligenceFramework,
      resolveConfig: () => undefined, buildProvider: () => null });
    const provenance = new JudgmentProvenanceLog({ dir: path.join(stateDir, 'terminal-prompt-jev-provenance') });
    const rows: any[] = [];
    const { gateway, getPoint } = buildPromptJevFirst({ stateDir, developmentAgent: true,
      readConfig: () => undefined,
      provenance: () => ({ recordDecisionFlushed: async (row: any) => { rows.push(row); return provenance.recordDecisionFlushed(row); } }) as any,
      readKey: () => 'test-key', askJev: async () => ({ model: 'jev-1.13.0', probability: 0.03, ms: 6 }) });
    const outcomes: any[] = [];
    const detector = new InputDetector({ detectionWindowLines: 50, enabled: true, intelligence: router,
      jevFirst: gateway, getJevPoint: getPoint, jevState: promptDetectState,
      outcomeObserver: new PromptDetectOutcomeObserver({ annotate: annotateDecisionOutcome, onOutcome: (o) => outcomes.push(o) }) });
    const pane = 'E2E_PANE_MARKER finished.\n❯ \n';
    for (let i = 0; i < 3; i++) detector.onCapture('e2e-session', pane);
    await vi.waitFor(() => expect(rows).toHaveLength(1));
    await detector.lastJevShadow;
    const correlationId = rows[0].producerCorrelationId;
    expect(correlationId).toMatch(/^d-/);
    expect(rows[0].context.sessionName).toBe('e2e-session');

    detector.onCapture('e2e-session', 'E2E_PANE_MARKER started the next step\n❯ \n');
    expect(outcomes).toEqual([expect.objectContaining({ correlationId, kind: 'progressed-without-input', grade: 'right' })]);

    const res = await request(app).get('/decision-quality?sinceHours=24').set(auth());
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('E2E_PANE_MARKER');
    const point = (res.body.points as any[]).find((p) => p.decisionPoint === DP_TERMINAL_PROMPT_DETECT);
    expect(point).toBeTruthy();
    expect(point.decisions).toBe(1);
    expect(point.byRule['terminal-prompt-progressed-v1']).toMatchObject({ right: 1, wrong: 0 });
    expect(res.body.rejections).toEqual({ enumInvalid: 0, rungMismatch: 0, ownerMismatch: 0, unknownDecisionPoint: 0 });
    await provenance.close();
  });
});

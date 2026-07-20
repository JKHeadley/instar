// safe-fs-allow: isolated tmp fixture cleanup uses SafeFsExecutor.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('feedback drain bounded self-heal — production boot wiring', () => {
  let root: string; let stateDir: string; let server: AgentServer;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-self-heal-e2e-'));
    stateDir = path.join(root, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'feedback-factory', 'store'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'self-heal-e2e', authToken: 'self-heal-auth' }));
    const config = {
      projectName: 'self-heal-e2e', projectDir: process.cwd(), stateDir, port: 0, authToken: 'self-heal-auth', developmentAgent: true,
      requestTimeoutMs: 10_000, version: 'self-heal-e2e',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 10, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
      feedbackFactory: { processing: {}, drain: {}, consumer: { dryRun: true } },
    } as InstarConfig;
    server = new AgentServer({ config, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir),
      sessionManager: { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [], on: () => undefined } as never });
    await server.start();
  });
  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'feedback-drain-self-heal-lifecycle.test.ts' });
  });

  it('repairs only generated defaults, durably rechecks, and admits exactly one recovery tick', async () => {
    const auditPath = path.join(stateDir, 'logs', 'feedback-factory-drain.jsonl');
    let audit = '';
    for (let attempt = 0; attempt < 100 && !audit.includes('heal-succeeded'); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      try { audit = fs.readFileSync(auditPath, 'utf8'); } catch { /* controller has not persisted yet */ }
    }
    const generated = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'generated-feature-defaults.json'), 'utf8'));
    expect(generated).toEqual({ schemaVersion: 1, feedbackFactory: { processing: { enabled: true }, drain: { enabled: true } } });
    const rows = audit.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { kind: string; episodeKey?: string });
    const episodeRows = rows.filter((row) => row.episodeKey === 'generated-defaults:self-heal-e2e');
    expect(episodeRows.filter((row) => row.kind === 'heal-attempt')).toHaveLength(1);
    expect(episodeRows.filter((row) => row.kind === 'heal-succeeded')).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'feedback-factory', 'recovery-state.json'), 'utf8'))
      .episodes['generated-defaults:self-heal-e2e']).toMatchObject({ status: 'healed', attempts: 1 });
  });
});

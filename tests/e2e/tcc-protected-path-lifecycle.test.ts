// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle — the TCC-protected path guard on
 * the REAL AgentServer boot path (the same AgentServer + GuardRegistry wiring
 * server.ts uses), over real disk state.
 *
 * Per TESTING-INTEGRITY-SPEC: is the feature actually alive on the production
 * init path — does `GET /guards` carry the `monitoring.tccProtectedPathGuard`
 * row as on-confirmed (200, not missing), is it Bearer-gated, and does an
 * agent that ALREADY lives under ~/Documents on macOS get exactly ONE durable
 * finding (the JSONL fallback when no Telegram adapter is configured) with
 * the runbook named — while a Linux boot of the same layout stays silent?
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { GuardRegistry } from '../../src/monitoring/GuardRegistry.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  runTccProtectedPathDetection,
  tccGuardStatus,
  TCC_GUARD_KEY,
  TCC_MOVE_RUNBOOK,
} from '../../src/core/TccProtectedPathGuard.js';

const AUTH = 'test-e2e-tcc-guard';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

interface Booted { server: AgentServer; app: express.Express; stateDir: string; projectDir: string }

let home: string;

async function boot(projectDir: string, platform: string): Promise<Booted> {
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E', monitoring: {}, scheduler: { enabled: false } }));
  const config: InstarConfig = {
    projectName: 'e2e', projectDir, stateDir, port: 0, authToken: AUTH,
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/false', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;

  // The production boot sequence (src/commands/server.ts): construct the
  // registry, run the detection once, register the getter, serve /guards.
  const guardRegistry = new GuardRegistry();
  const result = await runTccProtectedPathDetection({ projectDir, stateDir, platform, homeDir: home });
  guardRegistry.register(TCC_GUARD_KEY, () => tccGuardStatus(result));

  const sm = new SessionManager({
    tmuxPath: '/usr/bin/false', claudePath: '/usr/bin/false', projectDir,
    maxSessions: 1, protectedSessions: [], completionPatterns: [],
  }, new StateManager(stateDir));
  const server = new AgentServer({ config, sessionManager: sm, state: new StateManager(stateDir), guardRegistry });
  await server.start();
  return { server, app: server.getApp(), stateDir, projectDir };
}

const booted: Booted[] = [];

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tcc-e2e-home-'));
  fs.mkdirSync(path.join(home, 'Documents', 'Projects'), { recursive: true });
  fs.mkdirSync(path.join(home, '.instar', 'agents'), { recursive: true });
});

afterAll(async () => {
  for (const b of booted) await b.server.stop();
  SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/e2e/tcc-protected-path-lifecycle.test.ts' });
});

describe('TCC-protected path guard E2E lifecycle (feature is alive)', () => {
  it('safe agent home on macOS: GET /guards carries the row on-confirmed (alive, not missing); Bearer-gated; no finding written', async () => {
    const b = await boot(path.join(home, '.instar', 'agents', 'echo'), 'darwin');
    booted.push(b);
    expect((await request(b.app).get('/guards')).status).toBe(401);
    const res = await request(b.app).get('/guards').set(auth());
    expect(res.status).toBe(200);
    const row = res.body.guards.find((g: { key: string }) => g.key === TCC_GUARD_KEY);
    expect(row).toBeDefined();
    expect(row.effective).toBe('on-confirmed');
    expect(row.runtime.enabled).toBe(true);
    expect(fs.existsSync(path.join(b.stateDir, 'audit', 'tcc-protected-path.jsonl'))).toBe(false);
  });

  it('agent ALREADY under ~/Documents on macOS: boots, row on-confirmed, exactly ONE durable HIGH finding naming the runbook; nothing moved', async () => {
    const projectDir = path.join(home, 'Documents', 'Projects', 'instar-codey');
    const b = await boot(projectDir, 'darwin');
    booted.push(b);
    const res = await request(b.app).get('/guards').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.guards.find((g: { key: string }) => g.key === TCC_GUARD_KEY).effective).toBe('on-confirmed');
    const fallback = path.join(b.stateDir, 'audit', 'tcc-protected-path.jsonl');
    expect(fs.existsSync(fallback)).toBe(true);
    const lines = fs.readFileSync(fallback, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const item = JSON.parse(lines[0]);
    expect(item.priority).toBe('HIGH');
    expect(item.category).toBe('tcc-protected-path');
    expect(item.summary).toContain(projectDir);
    expect(item.summary).toContain(TCC_MOVE_RUNBOOK);
    expect(fs.existsSync(projectDir)).toBe(true);
    expect(fs.readdirSync(path.join(home, 'Documents', 'Projects'))).toContain('instar-codey');
  });

  it('the same ~/Documents layout booted as Linux: row on-confirmed, NO finding (platform honesty)', async () => {
    const projectDir = path.join(home, 'Documents', 'Projects', 'linux-agent');
    const b = await boot(projectDir, 'linux');
    booted.push(b);
    const res = await request(b.app).get('/guards').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.guards.find((g: { key: string }) => g.key === TCC_GUARD_KEY).effective).toBe('on-confirmed');
    expect(fs.existsSync(path.join(b.stateDir, 'audit', 'tcc-protected-path.jsonl'))).toBe(false);
  });

  it('the runbook every surface points at exists on disk', () => {
    expect(fs.existsSync(path.resolve(TCC_MOVE_RUNBOOK))).toBe(true);
  });
});

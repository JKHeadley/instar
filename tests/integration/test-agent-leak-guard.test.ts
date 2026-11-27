/**
 * Integration — test-agent leak guard (docs/specs/test-agent-leak-guard.md).
 *
 * The real `initProject` in the incident's shape (a temp folder, HOME pointed
 * at a sandbox, no terminal) → the records it writes → `loadConfig` → the
 * scheduler guard the server builds → a real JobScheduler refusing the job →
 * the installAutoStart funnel refusing to load anything.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../../src/commands/init.js';
import { loadConfig } from '../../src/core/Config.js';
import { installAutoStart } from '../../src/commands/setup.js';
import { buildThrowawayJobGuard, takeLastAutoStartRefusal } from '../../src/core/ThrowawayAgentGuard.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { StateManager } from '../../src/core/StateManager.js';
import { createMockSessionManager, createSampleJobsFile } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tlg-int-'));
const realHome = process.env.HOME;

afterEach(() => { process.env.HOME = realHome; });
afterAll(() => {
  SafeFsExecutor.safeRmSync(base, { recursive: true, force: true, operation: 'tests/integration/test-agent-leak-guard.test.ts' });
});

function readCfg(dir: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(dir, '.instar', 'config.json'), 'utf-8'));
}

describe('instar init in the incident shape', () => {
  const dir = path.join(base, 'rtcheck');

  it('records autoInstall:false and a 24h throwaway expiry', async () => {
    fs.mkdirSync(dir, { recursive: true });
    process.env.HOME = path.join(base, 'fakehome');
    fs.mkdirSync(process.env.HOME, { recursive: true });
    await initProject({ dir, port: 5591, skipPrereqs: true, interactive: false });
    const cfg = readCfg(dir);
    expect(cfg.autostart).toEqual({ autoInstall: false, reason: expect.stringContaining('throwaway location') });
    expect(cfg.throwawayAgent.reasons).toEqual(expect.arrayContaining(['home-sandboxed', 'project-under-temp']));
    const ttl = Date.parse(cfg.throwawayAgent.expiresAt) - Date.parse(cfg.throwawayAgent.createdAt);
    expect(ttl).toBe(24 * 60 * 60 * 1000);
  });

  it('a re-run over the existing agent changes nothing', async () => {
    const before = readCfg(dir).throwawayAgent;
    await initProject({ dir, port: 5591, skipPrereqs: true, interactive: true });
    expect(readCfg(dir).throwawayAgent).toEqual(before);
  });

  it('the loaded config feeds a guard that makes a real scheduler refuse', async () => {
    const config = loadConfig(dir);
    expect(config.throwawayAgent?.expiresAt).toBeDefined();
    const guard = buildThrowawayJobGuard({ projectDir: config.projectDir, allowOnThrowawayAgent: config.scheduler.allowOnThrowawayAgent });
    const state = new StateManager(config.stateDir);
    const jobsFile = createSampleJobsFile(config.stateDir);
    const sm = createMockSessionManager();
    const scheduler = new JobScheduler(
      { jobsFile, enabled: true, maxParallelJobs: 2, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
      sm as any, state, config.stateDir,
    );
    scheduler.setThrowawayJobGuard(guard);
    try {
      expect(await scheduler.triggerJob('health-check', 'cron')).toBe('skipped');
      expect(sm._sessions.length).toBe(0);
    } finally {
      scheduler.stop();
    }
  });

  it('the funnel refuses to install its autostart', () => {
    const config = loadConfig(dir);
    expect(installAutoStart(config.projectName, config.projectDir, false)).toBe(false);
    expect(takeLastAutoStartRefusal()).toMatch(/throwaway agent/);
  });
});

describe('init flags', () => {
  it('--keep writes an exemption record instead of an expiry', async () => {
    const dir = path.join(base, 'kept');
    fs.mkdirSync(dir, { recursive: true });
    await initProject({ dir, port: 5592, skipPrereqs: true, interactive: false, keep: true });
    expect(readCfg(dir).throwawayAgent).toEqual({ createdAt: expect.any(String), keep: true });
  });

  it('--autostart lifts the self-install record', async () => {
    const dir = path.join(base, 'auto');
    fs.mkdirSync(dir, { recursive: true });
    await initProject({ dir, port: 5593, skipPrereqs: true, interactive: false, autostart: true });
    expect(readCfg(dir).autostart).toBeUndefined();
  });

  it('--expires-in sets the requested lifetime', async () => {
    const dir = path.join(base, 'short');
    fs.mkdirSync(dir, { recursive: true });
    await initProject({ dir, port: 5594, skipPrereqs: true, interactive: true, expiresIn: '30m' });
    const rec = readCfg(dir).throwawayAgent;
    expect(Date.parse(rec.expiresAt) - Date.parse(rec.createdAt)).toBe(30 * 60 * 1000);
  });
});

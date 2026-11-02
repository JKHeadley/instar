/**
 * E2E lifecycle: machine self-maintenance, watch-only (Tier 3).
 *
 * Mirrors the production init in commands/server.ts: the REAL OS readers feed a REAL
 * DrainRehearsal over a REAL host store, and a REAL AgentServer answers
 * GET /machine-maintenance with 200. The feature is alive after production-shaped
 * init: not a 503, and carrying real readings of this machine. Also runs the migrator
 * on an existing home and checks the fresh template, so both kinds of agent know.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { DrainRehearsal, setActiveDrainRehearsal } from '../../src/monitoring/machineMaintenance/DrainRehearsal.js';
import { HostMaintenanceStore } from '../../src/monitoring/machineMaintenance/HostMaintenanceStore.js';
import { normalizeSettings } from '../../src/monitoring/machineMaintenance/planner.js';
import { makeReadOnlyRunner, parseHidIdleMs, readMachineSignals } from '../../src/monitoring/machineMaintenance/readings.js';
import { MACHINE_BROWSER_CARE_CLAUDEMD_SECTION, MACHINE_MAINTENANCE_CLAUDEMD_SECTION, PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { BrowserCareSweep, DOWNLOAD_FRESH_MS, normalizeBrowserCare, parseChromeProcesses, setActiveBrowserCare } from '../../src/monitoring/machineMaintenance/BrowserCare.js';
import { makeDownloadCheck } from '../../src/core/BrowserCareProbes.js';
import { MachineLockStateReader, setActiveMachineLockStateReader } from '../../src/core/MachineLockStateReader.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

const AUTH = 'e2e-token';
const auth = { Authorization: `Bearer ${AUTH}` };

describe('machine maintenance lifecycle', () => {
  let dir: string;
  let rehearsal: DrainRehearsal;
  let server: AgentServer;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-e2e-'));
    rehearsal = new DrainRehearsal({
      agentName: 'e2e', version: '1', stateDir: dir, logPath: path.join(dir, 'logs', 'machine-drain.jsonl'),
      store: new HostMaintenanceStore({ dir: path.join(dir, 'host') }),
      enabled: () => true,
      settings: () => normalizeSettings(undefined),
      readSignals: () => readMachineSignals(),
      census: async () => ({ sessions: [], autonomousRuns: [], localVerifyRunning: [], localVerifyQueued: [], testRuns: [], scriptRuns: [] }),
      resumeQueue: () => null, coResidentAgents: () => [], holdsLease: () => null, ownUser: os.userInfo().username,
    });
    setActiveDrainRehearsal(rehearsal);
    server = new AgentServer({ config: { authToken: AUTH, stateDir: dir, port: 0 } as any, stateDir: dir } as any);
  });

  afterEach(() => {
    rehearsal.stop();
    setActiveDrainRehearsal(null);
    setActiveBrowserCare(null);
    setActiveMachineLockStateReader(null);
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/machine-maintenance-lifecycle.test.ts' });
  });

  it('answers 200 with real readings of this machine, and cannot act', async () => {
    await rehearsal.tick();
    const res = await request(server.getApp()).get('/machine-maintenance').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, mode: 'watch-only', canRestart: false, canStopWork: false, lastError: null });
    expect(res.body.lastBootAt).toBeLessThanOrEqual(Date.now());
    expect(res.body.uptimeDays).toBeGreaterThanOrEqual(0);
    expect(res.body.safetyHolds.map((h: { id: string }) => h.id)).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect(res.body.delays.map((d: { id: string }) => d.id)).toEqual(['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7']);
    expect(res.body.nextWindow.restartAt).toBeGreaterThan(res.body.nextWindow.start);
  });

  it('reaches a fresh agent and an updated one through one shared section', () => {
    const section = MACHINE_MAINTENANCE_CLAUDEMD_SECTION(4042);
    expect(section).toContain('/machine-maintenance');
    expect(section).toMatch(/cannot restart a machine and it cannot stop any work/);
    expect(generateClaudeMd('p', 'a', 4042, false)).toContain('/machine-maintenance');
  });

  it('browser care and the lock reading are alive on the production wiring, and act on nothing', async () => {
    // As commands/server.ts wires it, with this temp dir as the agent home: the REAL process-table,
    // tmux and input readers run, so nothing on this machine is owned and nothing can be picked.
    const read = makeReadOnlyRunner();
    let tabChecks = 0;
    const sweep = new BrowserCareSweep({
      agentName: 'e2e', agentHome: dir, operatorChromeDir: path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
      ledgerDir: path.join(dir, 'state', 'browser-instances'), logPath: path.join(dir, 'logs', 'browser-care.jsonl'),
      settings: () => normalizeBrowserCare(undefined),
      listChrome: async () => { const out = await read('chromeProcesses'); return out === null ? null : parseChromeProcesses(out); },
      tmuxSessions: async () => { const out = await read('tmuxSessions'); return out === null ? [] : out.split('\n').filter(Boolean); },
      inputIdleMs: async () => { const out = await read('inputIdle'); return out === null ? null : parseHidIdleMs(out); },
      signInRepairOpen: () => false,
      downloadActive: makeDownloadCheck(DOWNLOAD_FRESH_MS),
      checkTabs: async () => { tabChecks++; return 'unreadable'; },
    });
    setActiveBrowserCare(sweep);
    await sweep.sweep();
    // The helper probe is not run here: a missing helper must read as unknown, never locked.
    setActiveMachineLockStateReader(new MachineLockStateReader({ runProbe: async () => null, runPolicy: async () => null }));

    const res = await request(server.getApp()).get('/machine-maintenance').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.browserCare).toMatchObject({ enabled: true, dryRun: true, canClose: false, owned: 0, wouldClose: 0, lastError: null });
    expect(res.body.browserCare.lastSweepAt).not.toBeNull();
    expect(tabChecks).toBe(0);

    const lock = await request(server.getApp()).get('/machine-maintenance/lock-state').set(auth);
    expect(lock.status).toBe(200);
    expect(['unknown', 'not-applicable']).toContain(lock.body.lockState);
    expect(lock.body.lockState).not.toBe('locked');
  });

  it('an existing agent gets the browser care section once, and a fresh one has it', () => {
    const projectDir = path.join(dir, 'proj');
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Agent\n' + MACHINE_MAINTENANCE_CLAUDEMD_SECTION(4321));
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'mig' });
    type R = { upgraded: string[]; skipped: string[]; errors: string[] };
    const r1: R = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: R): void }).migrateClaudeMd(r1);
    const r2: R = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: R): void }).migrateClaudeMd(r2);
    expect(r1.upgraded).toContain('CLAUDE.md: added browser care and lock reading section');
    expect(r2.upgraded).not.toContain('CLAUDE.md: added browser care and lock reading section');
    const md = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(md.split('/machine-maintenance/lock-state').length - 1).toBe(MACHINE_BROWSER_CARE_CLAUDEMD_SECTION(4321).split('/machine-maintenance/lock-state').length - 1);
    expect(generateClaudeMd('p', 'a', 4042, false)).toContain('chrome-close.sh');
  });
});

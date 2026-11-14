/**
 * E2E lifecycle: wedge detection, dry-run (machine-self-maintenance Part E, Tier 3).
 *
 * Mirrors the production init in commands/server.ts: the REAL probe runner reads this
 * machine's process table, a REAL WedgeMonitor claims the host maintainer role in a REAL
 * host store, the REAL judge factory and notice sender are wired, and a REAL AgentServer
 * answers GET /machine-maintenance with 200 and a live `wedge` block. Also checks that an
 * existing agent and a fresh one both learn about it.
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
import { normalizeSettings, windowFor } from '../../src/monitoring/machineMaintenance/planner.js';
import { WEDGE_CANARY_APP, makeProbeRunner, makeReadOnlyRunner, parseBootTime, readMachineSignals, wedgeCanaryAvailable } from '../../src/monitoring/machineMaintenance/readings.js';
import { WedgeMonitor, normalizeWedgeSettings, setActiveWedgeMonitor } from '../../src/monitoring/machineMaintenance/WedgeMonitor.js';
import { makeMachineWedgeJudge } from '../../src/monitoring/MachineWedgeJudge.js';
import { makeWedgeNoticeSender } from '../../src/monitoring/MachineWedgeNotice.js';
import { MACHINE_WEDGE_CLAUDEMD_SECTION, MACHINE_WEDGE_CURRENT_F1_TEXT, MACHINE_WEDGE_STALE_F1_TEXT, PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { isWslHost } from '../../src/core/wslPlatform.js';

const AUTH = 'e2e-token';
const auth = { Authorization: `Bearer ${AUTH}` };

describe('machine wedge detection lifecycle', () => {
  let dir: string;
  let rehearsal: DrainRehearsal;
  let monitor: WedgeMonitor;
  let server: AgentServer;
  let notices = 0;

  let priorCanaryOptIn: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-wedge-e2e-'));
    notices = 0;
    // This lifecycle test opts in to launching the real built canary (a no-UI app that quits at once).
    priorCanaryOptIn = process.env.INSTAR_REAL_WEDGE_CANARY_TESTS;
    process.env.INSTAR_REAL_WEDGE_CANARY_TESTS = '1';
    const store = new HostMaintenanceStore({ dir: path.join(dir, 'host') });
    const read = makeReadOnlyRunner();
    monitor = new WedgeMonitor({
      agentName: 'e2e', machineId: () => `m_host_${os.hostname()}`,
      platform: process.platform === 'darwin' ? 'darwin' : isWslHost() ? 'wsl' : process.platform === 'linux' ? 'linux' : 'other',
      logPath: path.join(dir, 'logs', 'machine-maintenance.jsonl'),
      store, enabled: () => true,
      settings: () => normalizeWedgeSettings(undefined),
      probe: makeProbeRunner(),
      readBootAt: async () => {
        if (process.platform !== 'darwin') return Math.round(Date.now() - os.uptime() * 1000);
        const out = await read('bootTime');
        return out === null ? null : parseBootTime(out);
      },
      lockState: async () => null,
      canaryAvailable: () => wedgeCanaryAvailable(),
      ownUser: os.userInfo().username,
      loadReading: () => null,
      spawnSystemFailures30m: () => null,
      sessionsCount: () => 0,
      nextWindowRestartAt: (now) => windowFor(now, normalizeSettings(undefined).window).restartAt,
      judge: makeMachineWedgeJudge({ evaluate: async () => '{"action":"leave","reason":"e2e"}' }),
      raiseNotice: makeWedgeNoticeSender({ createAttentionItem: async () => { notices += 1; }, machineLabel: () => 'e2e' }),
    });
    rehearsal = new DrainRehearsal({
      agentName: 'e2e', version: '1', stateDir: dir, logPath: path.join(dir, 'logs', 'machine-drain.jsonl'),
      store, enabled: () => true, settings: () => normalizeSettings(undefined),
      readSignals: () => readMachineSignals(),
      census: async () => ({ sessions: [], autonomousRuns: [], localVerifyRunning: [], localVerifyQueued: [], testRuns: [], scriptRuns: [] }),
      resumeQueue: () => null, coResidentAgents: () => [], holdsLease: () => null, ownUser: os.userInfo().username,
      forcedDueAt: () => monitor.forcedDueAt(),
    });
    setActiveDrainRehearsal(rehearsal);
    setActiveWedgeMonitor(monitor);
    server = new AgentServer({ config: { authToken: AUTH, stateDir: dir, port: 0 } as any, stateDir: dir } as any);
  });

  afterEach(() => {
    if (priorCanaryOptIn === undefined) delete process.env.INSTAR_REAL_WEDGE_CANARY_TESTS;
    else process.env.INSTAR_REAL_WEDGE_CANARY_TESTS = priorCanaryOptIn;
    monitor.stop();
    rehearsal.stop();
    setActiveWedgeMonitor(null);
    setActiveDrainRehearsal(null);
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/machine-wedge-lifecycle.test.ts' });
  });

  it('is alive after production-shaped init: 200, a real sample of this machine, and no way to act', async () => {
    await monitor.tick();
    const res = await request(server.getApp()).get('/machine-maintenance').set(auth);
    expect(res.status).toBe(200);
    const w = res.body.wedge;
    expect(w).toMatchObject({ enabled: true, dryRun: true, actuation: 'not-built', canRestart: false, canStopWork: false, noticeEnabled: false, role: 'maintainer', lastError: null });
    expect(w.lastSampleAt).toEqual(expect.any(Number));
    // The real process table answered (a healthy test machine); the result is a reading, not a default.
    expect(['negative', 'positive']).toContain(w.families.F2.result);
    // No load report wired here: F4 is unknown, never "healthy".
    expect(w.families.F4).toMatchObject({ result: 'unknown', reason: 'no-load-report' });
    if (process.platform === 'darwin') {
      if (fs.existsSync(path.join(WEDGE_CANARY_APP, 'Contents', 'MacOS', 'InstarWedgeCanary'))) {
        // The real canary ran through LaunchServices. A first sample can pass (negative) or, before any
        // pass this boot, fail as ineligible; it is never positive on a first sample and never unread.
        expect(w.families.F1.reason).toMatch(/^canary-/);
        expect(['negative', 'ineligible']).toContain(w.families.F1.result);
        expect(w.f1PassedThisBoot).toBe(w.families.F1.result === 'negative');
      } else {
        expect(w.families.F1).toMatchObject({ result: 'unknown', reason: 'canary-not-installed' });
      }
      // The kernel zone was read without root, or its absence is named.
      expect(typeof w.families.F2.detail?.kernelZoneReason === 'string' || w.families.F2.result === 'positive').toBe(true);
      if (w.families.F2.detail?.kernelZoneReason === 'read-unprivileged') expect(w.families.F2.detail.kallocInUseBytes).toBeGreaterThan(0);
    }
    expect(w.candidate).toBeNull();
    expect(notices).toBe(0);
    const rows = fs.readFileSync(path.join(dir, 'logs', 'machine-maintenance.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows[0]).toMatchObject({ type: 'wedge-sample', feature: 'wedge', dryRun: true });
    // The host maintainer heartbeat and published state are on disk for co-resident agents.
    expect(fs.existsSync(path.join(dir, 'host', 'wedge-maintainer.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'host', 'wedge-state.json'))).toBe(true);
  });

  it('reaches a fresh agent, and an existing agent exactly once', () => {
    expect(generateClaudeMd('p', 'a', 4042, false)).toContain('### Is this machine wedged? (dry-run)');
    const projectDir = path.join(dir, 'proj');
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Agent\n');
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'mig' });
    type R = { upgraded: string[]; skipped: string[]; errors: string[] };
    const r1: R = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: R): void }).migrateClaudeMd(r1);
    const r2: R = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: R): void }).migrateClaudeMd(r2);
    expect(r1.upgraded).toContain('CLAUDE.md: added machine wedge detection section');
    expect(r2.upgraded).not.toContain('CLAUDE.md: added machine wedge detection section');
    const md = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(md.split('### Is this machine wedged? (dry-run)').length - 1).toBe(1);
    expect(MACHINE_WEDGE_CLAUDEMD_SECTION(4321)).toContain('http://localhost:4321/machine-maintenance');
    expect(MACHINE_WEDGE_CLAUDEMD_SECTION(4321)).toContain(MACHINE_WEDGE_CURRENT_F1_TEXT);
  });

  it('an existing agent whose wedge section still says F1 is unread on macOS gets the current line, once', () => {
    const projectDir = path.join(dir, 'proj-stale');
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    const stale = MACHINE_WEDGE_CLAUDEMD_SECTION(4321).replace(MACHINE_WEDGE_CURRENT_F1_TEXT, MACHINE_WEDGE_STALE_F1_TEXT);
    expect(stale).toContain(MACHINE_WEDGE_STALE_F1_TEXT);
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), `# Agent\n${stale}`);
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'mig' });
    type R = { upgraded: string[]; skipped: string[]; errors: string[] };
    const r1: R = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: R): void }).migrateClaudeMd(r1);
    const r2: R = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: R): void }).migrateClaudeMd(r2);
    expect(r1.upgraded).toContain('CLAUDE.md: updated the machine wedge F1/F2 evidence line');
    expect(r2.upgraded).not.toContain('CLAUDE.md: updated the machine wedge F1/F2 evidence line');
    const md = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(md).not.toContain(MACHINE_WEDGE_STALE_F1_TEXT);
    expect(md.split(MACHINE_WEDGE_CURRENT_F1_TEXT).length - 1).toBe(1);
  });
});

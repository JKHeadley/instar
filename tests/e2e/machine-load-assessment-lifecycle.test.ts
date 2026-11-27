/**
 * Machine load assessment (trustworthy-machine-load B4) — E2E lifecycle tier.
 *
 * Mirrors the production path: the assessor is built with the same factory
 * server.ts calls (config read live from config.json), installed and STARTED
 * on a real timer, the routes are the real createRoutes on a real port. On a
 * development agent the feature is alive (the timer labels a disagreement and
 * the summary is 200 + enabled); on the fleet it is dark (no vendor call); an
 * explicit false in config.json darks it live. The awareness card reaches
 * existing agents (migrator) and new agents (template).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { createRoutes } from '../../src/server/routes.js';
import { HookEventReceiver } from '../../src/monitoring/HookEventReceiver.js';
import { buildMachineLoadAssessor, installMachineLoadAssessor, getMachineLoadAssessor } from '../../src/core/MachineLoadAssessor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';
import type { MachineCapacity } from '../../src/core/types.js';

const PEER = {
  machineId: 'm-peer', nickname: 'Mac Studio', online: true, clockSkewStatus: 'ok',
  liveness: { state: 'live', evidenceAgeMs: 3000, evidenceAt: null, source: 'direct' },
  lastPullRttMs: 60, loadReportAgeMs: 4000, loadVerdict: 'elevated',
  loadReport: { bootId: 'b', seq: 9, sampleAgeMs: 1000, platform: 'darwin', cores: 24, totalMemBytes: null, loadPerCore: 0.6, cpuIdlePct: 50, memAvailablePct: 41, memPressureNative: 'warn', eventLoopLagP99Ms: 50, sessionsActive: 4, sessionsMax: 10, spawnCapSaturated: false, testRunnerSaturated: false, verdict: 'elevated', uptimeS: 7200 },
} as unknown as MachineCapacity;

function setup(initial: Record<string, unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mla-e2e-'));
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  const configPath = path.join(stateDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ projectName: 'e2e', port: 4042, ...initial }, null, 2));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# CLAUDE.md — e2e\n');
  const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return { root, stateDir, configPath, readConfig };
}

async function serve(stateDir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(createRoutes({ config: { authToken: 'test', stateDir, port: 0, projectName: 'e2e' }, hookEventReceiver: new HookEventReceiver({ stateDir }) } as never));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

afterEach(() => installMachineLoadAssessor(null));

describe('machine load assessment — awareness parity', () => {
  it('existing agents get the card once (migrator); new agents get it from the template', () => {
    const e = setup({});
    const migrator = new PostUpdateMigrator({ port: 4042, stateDir: e.stateDir, projectDir: e.root, hasTelegram: false, projectName: 'e2e' } as never) as unknown as { migrateClaudeMd(r: unknown): void };
    const r = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
    migrator.migrateClaudeMd(r);
    expect(r.upgraded).toContain('CLAUDE.md: added machine load second-opinion awareness card');
    migrator.migrateClaudeMd({ upgraded: [], skipped: [], errors: [] });
    const md = fs.readFileSync(path.join(e.root, 'CLAUDE.md'), 'utf8');
    expect(md.split('### Machine Load Second Opinion').length - 1).toBe(1);
    expect(md).toContain('http://localhost:4042/load-assessment/summary');
    // The card must never satisfy the older load-assess.sh card's sniff.
    expect(md).toContain('### Machine Load Assessment (the go-to way');
    expect(generateClaudeMd('p', 'a', 4040, false)).toContain('http://localhost:4040/load-assessment/summary');
  });

  it('is registered as a dev-gated feature', () => {
    expect(DEV_GATED_FEATURES.filter((f) => f.configPath === 'intelligence.jevLoadAssessment.enabled')).toHaveLength(1);
  });
});

describe('machine load assessment — alive on a development agent, dark on the fleet', () => {
  async function run(developmentAgent: boolean, after?: (e: ReturnType<typeof setup>) => void) {
    const e = setup({ developmentAgent });
    after?.(e);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', usage: { input_tokens: 250 }, answers: { state: { choice: 'healthy_busy', probabilities: { healthy_busy: 0.91 } } } }) }) as unknown as Response);
    const config = e.readConfig();
    // Same wiring as server.ts, including start() on a real timer.
    const assessor = buildMachineLoadAssessor({
      readLiveIntelligence: () => e.readConfig().intelligence,
      bootBlock: config.intelligence?.jevLoadAssessment,
      developmentAgent: config.developmentAgent === true,
      readSecret: (n) => (n === 'typesafe_api_key' ? 'k' : null),
      capacities: () => [PEER],
      isAssessor: () => true,
      stateDir: e.stateDir,
      fetchImpl: fetchImpl as never,
    });
    installMachineLoadAssessor(assessor);
    assessor.start(20);
    const srv = await serve(e.stateDir);
    for (let i = 0; i < 50 && fetchImpl.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await getMachineLoadAssessor()!.tick();
    const summary = await (await fetch(`${srv.url}/load-assessment/summary`)).json() as Record<string, unknown>;
    assessor.stop();
    await srv.close();
    return { e, fetchImpl, summary };
  }

  it('development agent: the started timer labels the disagreement and the route is alive', async () => {
    const x = await run(true);
    expect(x.fetchImpl).toHaveBeenCalledTimes(1);
    expect(x.summary).toMatchObject({ enabled: true, checks: 1, labels: { healthy_busy: 1 }, conflicts: { 'memory-free-but-os-pressure': 1 } });
    const row = JSON.parse(fs.readFileSync(path.join(x.e.root, 'logs', 'machine-load-assessment.jsonl'), 'utf8').trim());
    expect(row).toMatchObject({ kind: 'check', machineId: 'm-peer', label: 'healthy_busy', decidedBy: 'jev' });
  });

  it('fleet agent: dark — no vendor call, summary says disabled', async () => {
    const x = await run(false);
    expect(x.fetchImpl).not.toHaveBeenCalled();
    expect(x.summary).toMatchObject({ enabled: false, checks: 0 });
  });

  it('kill switch: explicit false in config.json darks a development agent', async () => {
    const x = await run(true, (e) => {
      const c = e.readConfig();
      fs.writeFileSync(e.configPath, JSON.stringify({ ...c, intelligence: { jevLoadAssessment: { enabled: false } } }));
    });
    expect(x.fetchImpl).not.toHaveBeenCalled();
    expect(x.summary).toMatchObject({ enabled: false });
  });
});

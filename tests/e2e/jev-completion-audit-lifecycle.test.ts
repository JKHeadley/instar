// safe-fs-allow: test file — SafeFsExecutor removes only the per-test tmpdir.
/**
 * Jev job-completion audit — E2E lifecycle tier
 * (spec: docs/specs/jev-job-supervision.md Tests §3).
 *
 * Mirrors the production path: the update migrator writes the DARK default
 * into a real config.json; the PRODUCTION factory builds the audit with the
 * same config-read shape server.ts uses; POST /jev-audit/batch is exercised
 * over real HTTP (503 when not constructed — the fleet default — and 200
 * driving a real batch when alive); a config flip needs no restart.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { buildJevJobCompletionAudit, type CaptureInput } from '../../src/scheduler/JevJobCompletionAudit.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface TestServer { url: string; close: () => Promise<void> }
const servers: TestServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'jev-audit-e2e.cleanup' });
});

async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      const s = { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
      servers.push(s);
      resolve(s);
    });
  });
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-audit-e2e-'));
  dirs.push(root);
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  const configPath = path.join(stateDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ projectName: 'e2e', port: 4042 }));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# agent\n');
  const migrate = () => {
    const m = new PostUpdateMigrator({ port: 4042, stateDir, projectDir: root, hasTelegram: false, projectName: 'e2e' } as never);
    const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
    (m as unknown as { migrateConfig(r: typeof result): void }).migrateConfig(result);
    return result;
  };
  return { root, stateDir, configPath, migrate };
}

describe('Jev job-completion audit — production lifecycle', () => {
  it('the fleet default: the route answers 503 when the audit is not constructed', async () => {
    const app = express();
    app.use(express.json());
    app.use(createRoutes({ config: { authToken: 'test', stateDir: '/tmp', port: 0 }, scheduler: null } as never));
    const server = await listen(app);
    const res = await fetch(server.url + '/jev-audit/batch', { method: 'POST' });
    expect(res.status).toBe(503);
  });

  it('migrator installs the dark default; flag-off boot captures nothing and audits nothing', async () => {
    const e = setup();
    e.migrate();
    const fetchImpl = () => {
      throw new Error('must not be called');
    };
    const audit = buildJevJobCompletionAudit({
      readLiveIntelligence: () => JSON.parse(fs.readFileSync(e.configPath, 'utf8')).intelligence,
      readSecret: () => 'k',
      stateDir: e.stateDir,
      fetchImpl: fetchImpl as never,
    });
    audit.capture({ runId: 'r1', slug: 's', goal: 'g', result: 'success', output: 'out', workDir: e.root, startedAtMs: Date.now() } as CaptureInput);
    await audit.flush();
    expect(fs.existsSync(path.join(e.stateDir, 'jev-supervision-evidence'))).toBe(false);
    const res = await audit.runBatch();
    expect(res.audited).toBe(0);
    expect(res.skipped.disabled).toBe(1);
  });

  it('config flip (no restart) brings capture + batch alive through the factory AND the HTTP route', async () => {
    const e = setup();
    e.migrate();
    const answers = {
      produced_declared_effect: { noul: 0.92 },
      false_success: { noul: 0.04 },
      failure_class: { choice: 'cannot-tell' },
    };
    const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', usage: { input_tokens: 42 }, answers }) })) as never;
    const audit = buildJevJobCompletionAudit({
      readLiveIntelligence: () => JSON.parse(fs.readFileSync(e.configPath, 'utf8')).intelligence,
      readSecret: (name) => (name === 'typesafe_api_key' ? 'k' : null),
      stateDir: e.stateDir,
      fetchImpl,
    });

    // Flip the config on disk — the factory's live read must see it, no restart.
    const cfg = JSON.parse(fs.readFileSync(e.configPath, 'utf8'));
    cfg.intelligence.jevJobCompletionAudit.enabled = true;
    cfg.intelligence.jevJobCompletionAudit.soakEndsAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
    fs.writeFileSync(e.configPath, JSON.stringify(cfg));

    audit.capture({ runId: 'r-live', slug: 'live-job', goal: 'produce the report', result: 'success', output: 'report done', workDir: e.root, startedAtMs: Date.now() - 1000 } as CaptureInput);
    await audit.flush();

    // Drive the batch over REAL HTTP through the production route, reaching
    // the audit the way server.ts wires it (via the scheduler getter).
    const app = express();
    app.use(express.json());
    app.use(createRoutes({ config: { authToken: 'test', stateDir: e.stateDir, port: 0 }, scheduler: { getJevAudit: () => audit } } as never));
    const server = await listen(app);
    const res = await fetch(server.url + '/jev-audit/batch', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { audited: number };
    expect(body.audited).toBe(1);

    const logPath = path.join(e.stateDir, '..', 'logs', 'jev-job-completion-audit.jsonl');
    const rows = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.some((r) => r.kind === 'audited' && r.runId === 'r-live')).toBe(true);
  });
});

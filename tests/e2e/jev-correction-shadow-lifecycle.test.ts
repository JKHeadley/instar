/**
 * jev-correction-shadow — E2E lifecycle tier. Spec: docs/specs/jev-correction-shadow.md.
 *
 * Mirrors the production path: the update migrator runs over a real agent home
 * (config + CLAUDE.md); the shadow is built with the same factory server.ts
 * calls (reading config.json live), installed the same way and chained onto a
 * REAL TelegramAdapter's onMessageLogged; the routes are the real createRoutes
 * served on a real port. On a development agent the feature is alive (a check
 * is logged, the summary is 200 and enabled); on the fleet it is dark (no
 * vendor call); an explicit false written to config.json stops it live.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { createRoutes } from '../../src/server/routes.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { HumanAsDetectorLog } from '../../src/monitoring/HumanAsDetectorLog.js';
import { buildJevCorrectionShadow, installJevCorrectionShadow, getJevCorrectionShadow } from '../../src/core/JevCorrectionShadow.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';

function setup(initial: Record<string, unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-correction-e2e-'));
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  const configPath = path.join(stateDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ projectName: 'e2e', port: 4042, ...initial }, null, 2));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# CLAUDE.md — e2e\n');
  const migrator = new PostUpdateMigrator({ port: 4042, stateDir, projectDir: root, hasTelegram: true, projectName: 'e2e' } as never) as unknown as {
    migrateConfig(r: unknown): void; migrateClaudeMd(r: unknown): void;
  };
  const result = () => ({ upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] });
  const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return { root, stateDir, configPath, migrator, result, readConfig };
}

async function serve(stateDir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(createRoutes({ config: { authToken: 'test', stateDir, port: 0, projectName: 'e2e' } } as never));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

afterEach(() => installJevCorrectionShadow(null));

describe('jev-correction-shadow — migration parity and awareness', () => {
  it('existing agents get the awareness card once; new agents get it from the template', () => {
    const e = setup({});
    const r = e.result();
    e.migrator.migrateClaudeMd(r);
    expect(r.upgraded).toContain('CLAUDE.md: added Jev correction-shadow awareness card');
    e.migrator.migrateClaudeMd(e.result());
    const md = fs.readFileSync(path.join(e.root, 'CLAUDE.md'), 'utf8');
    expect(md.split('### Jev Correction Shadow').length - 1).toBe(1);
    expect(md).toContain('http://localhost:4042/jev-correction/summary');
    const fresh = generateClaudeMd('p', 'a', 4040, false);
    expect(fresh.split('### Jev Correction Shadow').length - 1).toBe(1);
    expect(fresh).toContain('http://localhost:4040/jev-correction/summary');
  });

  it('the update path writes no `enabled` (code defaults; the dev gate decides) and keeps an operator override', () => {
    const e = setup({});
    e.migrator.migrateConfig(e.result());
    expect(e.readConfig().intelligence?.jevCorrectionShadow?.enabled).toBeUndefined();
    const op = setup({ intelligence: { jevCorrectionShadow: { enabled: false } } });
    op.migrator.migrateConfig(op.result());
    expect(op.readConfig().intelligence.jevCorrectionShadow.enabled).toBe(false);
  });

  it('is registered as a dev-gated feature and wired in server.ts on the Telegram message seam', () => {
    expect(DEV_GATED_FEATURES.filter((f) => f.configPath === 'intelligence.jevCorrectionShadow.enabled')).toHaveLength(1);
    const src = fs.readFileSync(path.join(__dirname, '../../src/commands/server.ts'), 'utf8');
    expect(src).toMatch(/installJevCorrectionShadow\(correctionShadow\)/);
    expect(src).toMatch(/if \(beforeJevCorrectionCb\) beforeJevCorrectionCb\(entry\);\s*correctionShadow\.observe\(entry\)/);
  });
});

describe('jev-correction-shadow — alive on a development agent, dark on the fleet', () => {
  async function run(developmentAgent: boolean, mutate?: (e: ReturnType<typeof setup>) => void) {
    const e = setup({ developmentAgent });
    e.migrator.migrateConfig(e.result());
    mutate?.(e);
    const fetchImpl = vi.fn(async () => {
      const p = { correction: 0.1, preference: 0.88, neither: 0.02, cannot_tell: 0 };
      return { ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', usage: { input_tokens: 300 }, answers: { kind: { choice: 'preference', probabilities: p }, kind_rev: { choice: 'preference', probabilities: p } } }) } as unknown as Response;
    });
    const config = e.readConfig();
    // Same wiring as server.ts.
    const shadow = buildJevCorrectionShadow({
      readLiveIntelligence: () => e.readConfig().intelligence,
      bootBlock: config.intelligence?.jevCorrectionShadow,
      developmentAgent: config.developmentAgent === true,
      readSecret: (n) => (n === 'typesafe_api_key' ? 'k' : null),
      layer0: (t) => HumanAsDetectorLog.getInstance().classify(t),
      stateDir: e.stateDir,
      fetchImpl: fetchImpl as never,
    });
    installJevCorrectionShadow(shadow);
    const adapter = new TelegramAdapter({ token: 'test-token-123', chatId: '-100123456', pollIntervalMs: 100 }, e.stateDir);
    const before = adapter.onMessageLogged;
    adapter.onMessageLogged = (entry) => { if (before) before(entry); shadow.observe(entry); };
    adapter.logInboundMessage({ messageId: 77, topicId: 5, text: 'From now on always give me the direct link, never point me at an email.', timestamp: new Date().toISOString() });
    await getJevCorrectionShadow()!.lastCheck;
    const srv = await serve(e.stateDir);
    const res = await fetch(`${srv.url}/jev-correction/summary`);
    const summary = await res.json() as Record<string, unknown>;
    await srv.close();
    return { e, fetchImpl, summary, status: res.status };
  }

  it('development agent: an inbound message drives a check and the summary route is alive', async () => {
    const x = await run(true);
    expect(x.status).toBe(200);
    expect(x.fetchImpl).toHaveBeenCalledTimes(1);
    expect(x.summary).toMatchObject({ enabled: true, checks: 1, jevFlags: 1, labels: { preference: 1 } });
    const row = JSON.parse(fs.readFileSync(path.join(x.e.root, 'logs', 'jev-correction-shadow.jsonl'), 'utf8').trim());
    expect(row).toMatchObject({ kind: 'check', topic: 5, messageId: 77, label: 'preference', jevFlag: true });
  });

  it('fleet agent: dark — no vendor call, summary says disabled', async () => {
    const x = await run(false);
    expect(x.fetchImpl).not.toHaveBeenCalled();
    expect(x.summary).toMatchObject({ enabled: false, checks: 0 });
  });

  it('development agent with an explicit false in config.json: stopped', async () => {
    const x = await run(true, (e) => {
      const c = e.readConfig();
      c.intelligence = { ...(c.intelligence ?? {}), jevCorrectionShadow: { enabled: false } };
      fs.writeFileSync(e.configPath, JSON.stringify(c));
    });
    expect(x.fetchImpl).not.toHaveBeenCalled();
    expect(x.summary).toMatchObject({ enabled: false });
  });
});

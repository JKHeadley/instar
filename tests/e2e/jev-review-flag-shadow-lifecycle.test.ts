/**
 * jev-review-flag-shadow — E2E lifecycle tier. Spec: docs/specs/jev-review-flag-shadow.md.
 *
 * Mirrors the production path end to end: the update migrator writes the
 * default config block and the awareness card into a real agent home; the
 * shadow is built with the same factory server.ts calls (reading config.json
 * live), installed and STARTED the same way (a real timer); the routes are the
 * real createRoutes served over a real port. On a development agent the
 * feature is alive (the timer judges a reply from the real history file, the
 * summary is 200 and enabled); on the fleet it is dark (no vendor call); an
 * explicit false written to config.json stops it live.
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
import { buildJevReviewFlagShadow, installJevReviewFlagShadow, getJevReviewFlagShadow } from '../../src/core/JevReviewFlagShadow.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';

function setup(initial: Record<string, unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-rf-e2e-'));
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  const configPath = path.join(stateDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ projectName: 'e2e', port: 4042, ...initial }, null, 2));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# CLAUDE.md — e2e\n');
  const migrator = new PostUpdateMigrator({ port: 4042, stateDir, projectDir: root, hasTelegram: false, projectName: 'e2e' } as never) as unknown as {
    migrateConfig(r: unknown): void; migrateClaudeMd(r: unknown): void;
  };
  const result = () => ({ upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] });
  const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const now = Date.now();
  fs.writeFileSync(path.join(stateDir, 'telegram-messages.jsonl'), [
    { messageId: 9001, topicId: 42, text: 'Did the fix land?', fromUser: true, timestamp: new Date(now - 60_000).toISOString(), sessionName: 'echo-e2e', provenance: 'user' },
    { messageId: 9002, topicId: 42, text: 'Yes, it is merged.', fromUser: false, timestamp: new Date(now - 30_000).toISOString(), sessionName: 'echo-e2e', provenance: 'agent' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { root, stateDir, configPath, migrator, result, readConfig };
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

afterEach(() => installJevReviewFlagShadow(null));

describe('jev-review-flag-shadow — migration parity', () => {
  it('the update path adds the dev-gated block (no `enabled`), idempotently, never overwriting', () => {
    const e = setup({});
    const r = e.result();
    e.migrator.migrateConfig(r);
    expect(r.errors).toEqual([]);
    expect(e.readConfig().intelligence.jevReviewFlagShadow).toEqual({ timeoutMs: 1500, maxChecksPerDay: 3000 });
    e.migrator.migrateConfig(e.result());
    expect(e.readConfig().intelligence.jevReviewFlagShadow).toEqual({ timeoutMs: 1500, maxChecksPerDay: 3000 });

    const op = setup({ intelligence: { jevReviewFlagShadow: { enabled: false, maxChecksPerDay: 5 } } });
    op.migrator.migrateConfig(op.result());
    expect(op.readConfig().intelligence.jevReviewFlagShadow).toEqual({ enabled: false, maxChecksPerDay: 5, timeoutMs: 1500 });
  });

  it('existing agents get the awareness card once; new agents get it from the template', () => {
    const e = setup({});
    const r = e.result();
    e.migrator.migrateClaudeMd(r);
    expect(r.upgraded).toContain('CLAUDE.md: added Jev review-flag-shadow awareness card');
    e.migrator.migrateClaudeMd(e.result());
    const md = fs.readFileSync(path.join(e.root, 'CLAUDE.md'), 'utf8');
    expect(md.split('### Jev Review-Flag Shadow').length - 1).toBe(1);
    expect(md).toContain('http://localhost:4042/jev-review-flag/summary');
    expect(generateClaudeMd('p', 'a', 4040, false)).toContain('### Jev Review-Flag Shadow');
    expect(generateClaudeMd('p', 'a', 4040, false)).toContain('http://localhost:4040/jev-review-flag/summary');
  });

  it('is registered as a dev-gated feature', () => {
    expect(DEV_GATED_FEATURES.filter((f) => f.configPath === 'intelligence.jevReviewFlagShadow.enabled')).toHaveLength(1);
  });
});

describe('jev-review-flag-shadow — alive on a development agent, dark on the fleet', () => {
  async function run(developmentAgent: boolean, after?: (e: ReturnType<typeof setup>) => void) {
    const e = setup({ developmentAgent });
    e.migrator.migrateConfig(e.result());
    after?.(e);
    const fetchImpl = vi.fn(async () => {
      const p = { needs_review: 0.2, fine: 0.78, cannot_tell: 0.02 };
      return { ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: { review: { choice: 'fine', probabilities: p }, review_rev: { choice: 'fine', probabilities: p } }, usage: { input_tokens: 400 } }) } as unknown as Response;
    });
    const config = e.readConfig();
    // Same wiring as server.ts, including start() on a real timer.
    const shadow = buildJevReviewFlagShadow({
      readLiveIntelligence: () => e.readConfig().intelligence,
      bootBlock: config.intelligence?.jevReviewFlagShadow,
      developmentAgent: config.developmentAgent === true,
      readSecret: (n) => (n === 'typesafe_api_key' ? 'k' : null),
      stateDir: e.stateDir,
      fetchImpl: fetchImpl as never,
    });
    installJevReviewFlagShadow(shadow);
    shadow.start(20);
    const srv = await serve(e.stateDir);
    for (let i = 0; i < 50 && fetchImpl.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await getJevReviewFlagShadow()!.tick(); // settle any in-flight pass
    const summary = await (await fetch(`${srv.url}/jev-review-flag/summary`)).json() as Record<string, unknown>;
    shadow.stop();
    await srv.close();
    return { e, fetchImpl, summary };
  }

  it('development agent: the started timer judges the reply and the summary route is alive', async () => {
    const x = await run(true);
    expect(x.fetchImpl).toHaveBeenCalledTimes(1);
    expect(x.summary).toMatchObject({ enabled: true, checks: 1, wouldFlags: 0, labels: { fine: 1 } });
    const row = JSON.parse(fs.readFileSync(path.join(x.e.root, 'logs', 'jev-review-flag-shadow.jsonl'), 'utf8').trim());
    expect(row).toMatchObject({ kind: 'check', topicId: 42, replyMessageId: 9002, requestMessageId: 9001, label: 'fine', wouldFlag: false });
  });

  it('fleet agent: dark — no vendor call, summary says disabled', async () => {
    const x = await run(false);
    expect(x.fetchImpl).not.toHaveBeenCalled();
    expect(x.summary).toMatchObject({ enabled: false, checks: 0 });
  });

  it('kill switch: explicit false in config.json darks a development agent', async () => {
    const x = await run(true, (e) => {
      const c = e.readConfig();
      c.intelligence.jevReviewFlagShadow.enabled = false;
      fs.writeFileSync(e.configPath, JSON.stringify(c));
    });
    expect(x.fetchImpl).not.toHaveBeenCalled();
    expect(x.summary).toMatchObject({ enabled: false });
  });
});

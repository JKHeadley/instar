// safe-fs-allow: test file — SafeFsExecutor removes only the per-test tmpdir.
/**
 * Jev memory picker — E2E lifecycle tier (spec: docs/specs/jev-memory-picker.md).
 *
 * Mirrors production: the PRODUCTION factory (buildJevMemoryPicker, the same
 * call server.ts makes) reads a real config.json live; the update migrator
 * writes the real session-start hook and CLAUDE.md card; the MIGRATED hook is
 * executed by bash against a real HTTP server and prints the ranked block.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { buildJevMemoryPicker, INJECT_HEADER } from '../../src/core/JevMemoryPicker.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const closers: Array<() => Promise<void>> = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'jev-memory-picker-e2e.cleanup' });
});

function setup(config: Record<string, unknown>) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-mem-e2e-')));
  dirs.push(home);
  const root = path.join(home, 'agent');
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  const configPath = path.join(stateDir, 'config.json');
  const writeConfig = (c: Record<string, unknown>) => fs.writeFileSync(configPath, JSON.stringify({ projectName: 'e2e', port: 4042, ...c }, null, 2));
  writeConfig(config);
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# CLAUDE.md — e2e\n');
  const configDir = path.join(home, '.claude');
  const memDir = path.join(configDir, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'MEMORY.md'), Array.from({ length: 160 }, (_, i) => `- [Memory ${i + 1}](m.md) — ` + 'x'.repeat(180)).join('\n') + '\n');
  const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const vendorCalls: string[] = [];
  const picker = buildJevMemoryPicker({
    readLiveIntelligence: () => readConfig().intelligence,
    bootBlock: undefined,
    developmentAgent: readConfig().developmentAgent === true,
    readSecret: (name) => (name === 'typesafe_api_key' ? 'k' : undefined),
    stateDir,
    homeDir: home,
    fetchImpl: (async (_u: string, init: RequestInit) => {
      vendorCalls.push(String(init.body));
      return { ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: { b155: { noul: 0.8 }, c155: { noul: 0.6 } } }) } as unknown as Response;
    }) as never,
  });
  const migrator = () => new PostUpdateMigrator({ port: 4042, stateDir, projectDir: root, hasTelegram: false, projectName: 'e2e' } as never) as unknown as {
    migrateHooks(r: unknown): void; migrateClaudeMd(r: unknown): void;
  };
  const result = () => ({ upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] });
  return { home, root, stateDir, configDir, writeConfig, picker, vendorCalls, migrator, result };
}

async function serve(e: ReturnType<typeof setup>): Promise<{ port: number; url: string }> {
  const app = express();
  app.use(express.json());
  const topicMemory = { getTopicContext: (id: number) => ({ topicName: `Topic ${id}`, totalMessages: 1, summary: null, recentMessages: [{ fromUser: true, text: 'what did we decide about the Mama PC?', timestamp: '2026-09-30T10:00:00Z' }] }) };
  app.use(createRoutes({ config: { authToken: 'test', stateDir: e.stateDir, port: 0 }, topicMemory, jevMemoryPicker: e.picker } as never));
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      closers.push(() => new Promise<void>((r) => srv.close(() => r())));
      const port = (srv.address() as AddressInfo).port;
      resolve({ port, url: `http://127.0.0.1:${port}` });
    });
  });
}

const post = (url: string, e: ReturnType<typeof setup>) => fetch(`${url}/memory-picker/session-context`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ configDir: e.configDir, projectDir: e.root, topicId: 9 }),
});

describe('jev-memory-picker — production lifecycle', () => {
  it('is alive on a development agent (202, a ranked row), dark on the fleet (503)', async () => {
    const dev = setup({ developmentAgent: true });
    const { url } = await serve(dev);
    const res = await post(url, dev);
    expect(res.status).toBe(202);
    await dev.picker.lastRun;
    await dev.picker.flush();
    const row = JSON.parse(fs.readFileSync(path.join(dev.stateDir, '..', 'logs', 'jev-memory-picker.jsonl'), 'utf8').trim());
    expect(row).toMatchObject({ outcome: 'ranked', mode: 'shadow' });
    expect(dev.vendorCalls).toHaveLength(1);

    const fleet = setup({});
    const f = await serve(fleet);
    expect((await post(f.url, fleet)).status).toBe(503);
    expect(fleet.vendorCalls).toHaveLength(0);
  });

  it('the kill switch and the mode are read live from config.json — no restart', async () => {
    const e = setup({ developmentAgent: true });
    const { url } = await serve(e);
    expect((await post(url, e)).status).toBe(202);
    e.writeConfig({ developmentAgent: true, intelligence: { jevMemoryPicker: { enabled: false } } });
    expect((await post(url, e)).status).toBe(503);
    e.writeConfig({ developmentAgent: true, intelligence: { jevMemoryPicker: { mode: 'inject' } } });
    const body = await (await post(url, e)).json();
    expect(body).toMatchObject({ mode: 'inject', present: true });
    expect(body.block).toContain('Memory 155');
  });

  it('the MIGRATED session-start hook, run by bash, prints the ranked block in inject mode', async () => {
    const e = setup({ developmentAgent: true, intelligence: { jevMemoryPicker: { mode: 'inject' } } });
    const { port } = await serve(e);
    e.writeConfig({ developmentAgent: true, port, intelligence: { jevMemoryPicker: { mode: 'inject' } } });
    const r = e.result();
    e.migrator().migrateHooks(r);
    const hook = path.join(e.stateDir, 'hooks', 'instar', 'session-start.sh');
    expect(fs.readFileSync(hook, 'utf8')).toContain('/memory-picker/session-context');
    const out = await new Promise<string>((resolve, reject) => {
      execFile('bash', [hook], {
        env: { PATH: process.env.PATH ?? '', HOME: e.home, CLAUDE_PROJECT_DIR: e.root, CLAUDE_CONFIG_DIR: e.configDir, INSTAR_AUTH_TOKEN: 'test', INSTAR_TELEGRAM_TOPIC: '9', CLAUDE_HOOK_MATCHER: 'startup' },
        timeout: 60_000,
      }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    expect(out).toContain(INJECT_HEADER);
    expect(out).toContain('Memory 155');
    const sent = JSON.parse(e.vendorCalls[0]);
    expect(sent.state).toContain('what did we decide about the Mama PC?');
  }, 90_000);

  it('the same hook prints nothing from the picker in shadow mode', async () => {
    const e = setup({ developmentAgent: true });
    const { port } = await serve(e);
    e.writeConfig({ developmentAgent: true, port });
    e.migrator().migrateHooks(e.result());
    const hook = path.join(e.stateDir, 'hooks', 'instar', 'session-start.sh');
    const out = await new Promise<string>((resolve, reject) => {
      execFile('bash', [hook], {
        env: { PATH: process.env.PATH ?? '', HOME: e.home, CLAUDE_PROJECT_DIR: e.root, CLAUDE_CONFIG_DIR: e.configDir, INSTAR_AUTH_TOKEN: 'test', INSTAR_TELEGRAM_TOPIC: '9', CLAUDE_HOOK_MATCHER: 'startup' },
        timeout: 60_000,
      }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    expect(out).not.toContain(INJECT_HEADER);
    await e.picker.lastRun;
    expect(e.vendorCalls).toHaveLength(1); // it still ranked, and only logged
  }, 90_000);

  it('the compaction-recovery twin, run by bash, ranks again and logs source=compact', async () => {
    const e = setup({ developmentAgent: true });
    const { port } = await serve(e);
    e.writeConfig({ developmentAgent: true, port });
    e.migrator().migrateHooks(e.result());
    const hook = path.join(e.stateDir, 'hooks', 'instar', 'compaction-recovery.sh');
    await new Promise<void>((resolve, reject) => {
      execFile('bash', [hook], {
        env: { PATH: process.env.PATH ?? '', HOME: e.home, CLAUDE_PROJECT_DIR: e.root, CLAUDE_CONFIG_DIR: e.configDir, INSTAR_AUTH_TOKEN: 'test', INSTAR_TELEGRAM_TOPIC: '9' },
        timeout: 60_000,
      }, (err) => (err ? reject(err) : resolve()));
    });
    await e.picker.lastRun;
    await e.picker.flush();
    const row = JSON.parse(fs.readFileSync(path.join(e.stateDir, '..', 'logs', 'jev-memory-picker.jsonl'), 'utf8').trim().split('\n').pop()!);
    expect(row).toMatchObject({ source: 'compact', outcome: 'ranked' });
  }, 90_000);

  it('existing agents get the awareness card once; new agents get it from the template; it is dev-gated', () => {
    const e = setup({});
    const r1 = e.result();
    e.migrator().migrateClaudeMd(r1);
    expect(r1.upgraded).toContain('CLAUDE.md: added Jev memory picker awareness card');
    e.migrator().migrateClaudeMd(e.result());
    expect(fs.readFileSync(path.join(e.root, 'CLAUDE.md'), 'utf8').split('### Jev Memory Picker').length - 1).toBe(1);
    expect(generateClaudeMd('p', 'a', 4040, false)).toContain('### Jev Memory Picker');
    expect(DEV_GATED_FEATURES.filter((f) => f.configPath === 'intelligence.jevMemoryPicker.enabled')).toHaveLength(1);
  });
});

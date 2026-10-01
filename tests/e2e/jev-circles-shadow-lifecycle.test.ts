/**
 * jev-circles-shadow — E2E lifecycle tier. Spec: docs/specs/jev-circles-shadow.md.
 *
 * Mirrors the production path end to end: the update migrator writes the
 * default config block, the awareness card and the hook-event-reporter script
 * into a real agent home; the shadow is built with the same factory server.ts
 * calls (reading config.json live) and installed the same way; the routes are
 * the real createRoutes served over a real port; and the MIGRATED hook script
 * itself is executed with a Claude Code PostToolUse payload on stdin. On a
 * development agent the feature is alive (a check is logged, the summary is
 * 200 and enabled); on the fleet it is dark (no vendor call).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { createRoutes } from '../../src/server/routes.js';
import { HookEventReceiver } from '../../src/monitoring/HookEventReceiver.js';
import { buildJevCirclesShadow, installJevCirclesShadow, getJevCirclesShadow } from '../../src/core/JevCirclesShadow.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';

const SID = '7a3e1c55-9d2b-4e0f-8a11-3c5d7e9f1b20';

function setup(initial: Record<string, unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-circles-e2e-'));
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  const configPath = path.join(stateDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ projectName: 'e2e', port: 4042, ...initial }, null, 2));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# CLAUDE.md — e2e\n');
  const migrator = new PostUpdateMigrator({ port: 4042, stateDir, projectDir: root, hasTelegram: false, projectName: 'e2e' } as never) as unknown as {
    migrateConfig(r: unknown): void; migrateClaudeMd(r: unknown): void; migrateHooks(r: unknown): void;
  };
  const result = () => ({ upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] });
  const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
  // A real Claude Code transcript location for this session.
  const tdir = path.join(root, '.claude', 'projects', '-e2e');
  fs.mkdirSync(tdir, { recursive: true });
  const transcript = path.join(tdir, `${SID}.jsonl`);
  const lines: string[] = [];
  for (let i = 0; i < 8; i++) {
    lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Trying the fix again.' }, { type: 'tool_use', id: `e${i}`, name: 'Edit', input: { file_path: '/p/a.ts', old_string: 'x', new_string: 'y' } }] } }));
    lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `e${i}`, content: 'updated' }] } }));
    lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `b${i}`, name: 'Bash', input: { command: 'npm test' } }] } }));
    lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `b${i}`, content: 'Exit code 1\nFAIL a.test.ts', is_error: true }] } }));
  }
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
  return { root, stateDir, configPath, migrator, result, readConfig, transcript };
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

afterEach(() => installJevCirclesShadow(null));

describe('jev-circles-shadow — migration parity', () => {
  it('the update path adds the dev-gated block (no `enabled`), idempotently, never overwriting', () => {
    const e = setup({});
    const r = e.result();
    e.migrator.migrateConfig(r);
    expect(r.errors).toEqual([]);
    expect(e.readConfig().intelligence.jevCirclesShadow).toEqual({ timeoutMs: 1500, maxChecksPerDay: 2000 });
    e.migrator.migrateConfig(e.result());
    expect(e.readConfig().intelligence.jevCirclesShadow).toEqual({ timeoutMs: 1500, maxChecksPerDay: 2000 });

    const op = setup({ intelligence: { jevCirclesShadow: { enabled: false, maxChecksPerDay: 5 } } });
    op.migrator.migrateConfig(op.result());
    expect(op.readConfig().intelligence.jevCirclesShadow).toEqual({ enabled: false, maxChecksPerDay: 5, timeoutMs: 1500 });
  });

  it('existing agents get the awareness card once; new agents get it from the template', () => {
    const e = setup({});
    const r = e.result();
    e.migrator.migrateClaudeMd(r);
    expect(r.upgraded).toContain('CLAUDE.md: added Jev circles-shadow awareness card');
    e.migrator.migrateClaudeMd(e.result());
    const md = fs.readFileSync(path.join(e.root, 'CLAUDE.md'), 'utf8');
    expect(md.split('### Jev Circles Shadow').length - 1).toBe(1);
    expect(md).toContain('http://localhost:4042/jev-circles/summary');
    expect(generateClaudeMd('p', 'a', 4040, false)).toContain('### Jev Circles Shadow');
    expect(generateClaudeMd('p', 'a', 4040, false)).toContain('http://localhost:4040/jev-circles/summary');
  });

  it('is registered as a dev-gated feature', () => {
    expect(DEV_GATED_FEATURES.filter((f) => f.configPath === 'intelligence.jevCirclesShadow.enabled')).toHaveLength(1);
  });
});

describe('jev-circles-shadow — alive on a development agent, dark on the fleet', () => {
  async function run(developmentAgent: boolean) {
    const e = setup({ developmentAgent });
    e.migrator.migrateConfig(e.result());
    e.migrator.migrateHooks(e.result());
    const fetchImpl = vi.fn(async () => {
      const p = { circling: 0.9, converging: 0.1, polling: 0, normal: 0, cannot_tell: 0 };
      return { ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: { state: { choice: 'circling', probabilities: p }, state_rev: { choice: 'circling', probabilities: p } }, usage: { input_tokens: 900 } }) } as unknown as Response;
    });
    const config = e.readConfig();
    // Same wiring as server.ts.
    installJevCirclesShadow(buildJevCirclesShadow({
      readLiveIntelligence: () => e.readConfig().intelligence,
      bootBlock: config.intelligence?.jevCirclesShadow,
      developmentAgent: config.developmentAgent === true,
      readSecret: (n) => (n === 'typesafe_api_key' ? 'k' : null),
      stateDir: e.stateDir,
      fetchImpl: fetchImpl as never,
    }));
    const srv = await serve(e.stateDir);
    // The MIGRATED hook script, fed Claude Code's real PostToolUse stdin shape.
    const hook = path.join(e.stateDir, 'hooks', 'instar', 'hook-event-reporter.js');
    expect(fs.readFileSync(hook, 'utf8')).toContain('transcript_path: input.transcript_path');
    const stdin = JSON.stringify({ session_id: SID, transcript_path: e.transcript, cwd: e.root, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_response: { stdout: 'hi', stderr: '' } });
    for (let i = 0; i < 5; i++) {
      const r = spawnSync(process.execPath, [hook], { input: stdin, env: { ...process.env, INSTAR_SERVER_URL: srv.url, INSTAR_AUTH_TOKEN: 'test', INSTAR_SESSION_ID: 'instar-e2e' }, timeout: 10_000 });
      expect(r.status).toBe(0);
    }
    // The hook fires and forgets; wait for the fifth event to land and its check to settle.
    for (let i = 0; i < 100 && (fs.existsSync(path.join(e.stateDir, 'hook-events')) ? fs.readdirSync(path.join(e.stateDir, 'hook-events')).length : 0) === 0; i++) await new Promise((r) => setTimeout(r, 20));
    for (let i = 0; i < 100; i++) {
      await getJevCirclesShadow()!.lastCheck;
      if (!developmentAgent || fetchImpl.mock.calls.length > 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const summary = await (await fetch(`${srv.url}/jev-circles/summary`)).json() as Record<string, unknown>;
    await srv.close();
    return { e, fetchImpl, summary };
  }

  it('development agent: the real hook drives a check and the summary route is alive', async () => {
    const x = await run(true);
    expect(x.fetchImpl).toHaveBeenCalledTimes(1);
    expect(x.summary).toMatchObject({ enabled: true, checks: 1, wouldNudges: 1 });
    const row = JSON.parse(fs.readFileSync(path.join(x.e.root, 'logs', 'jev-circles-shadow.jsonl'), 'utf8').trim());
    expect(row).toMatchObject({ kind: 'check', session: SID, label: 'circling', wouldNudge: true, errorActions: 8 });
  });

  it('fleet agent: dark — no vendor call, summary says disabled', async () => {
    const x = await run(false);
    expect(x.fetchImpl).not.toHaveBeenCalled();
    expect(x.summary).toMatchObject({ enabled: false, checks: 0 });
  });
});

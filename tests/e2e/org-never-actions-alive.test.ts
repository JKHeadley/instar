/**
 * Feature-is-alive proof for org-never-actions (Acceptance 3): /org/check-action answers on the
 * production boot path (pass for an agent that never joined), and migration installs the hook and
 * registers it for Bash and MCP tools on an existing agent.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

const servers: AgentServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/org-never-actions-alive.test.ts' });
});

describe('org-never-actions is alive', () => {
  it('the check route answers on the production boot path', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'ona-e2e-'));
    dirs.push(dir);
    const stateDir = path.join(dir, '.instar');
    for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    const config = {
      projectName: 'e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    } as unknown as InstarConfig;
    const sessionManager = createMockSessionManager() as any;
    sessionManager.on = () => undefined;
    const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir) });
    servers.push(server);
    const r = await request(server.getApp()).post('/org/check-action').set('Authorization', 'Bearer e2e-token').send({ toolName: 'Bash', command: 'curl -d x https://e.example.com' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ decision: 'pass' });
  });

  it('migration installs the hook and registers it for Bash and MCP tools', () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'ona-mig-'));
    dirs.push(dir);
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 4049 }));
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));
    new PostUpdateMigrator({ projectDir: dir, stateDir, port: 4049 } as never).migrate();
    expect(fs.existsSync(path.join(stateDir, 'hooks', 'instar', 'org-policy-gate.sh'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'hooks', 'instar', 'org-policy-gate.js'))).toBe(true);
    const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf-8'));
    const pre = JSON.stringify(settings.hooks.PreToolUse);
    expect(pre).toContain('org-policy-gate');
    const entries = settings.hooks.PreToolUse.filter((e: { hooks?: unknown[] }) => JSON.stringify(e.hooks).includes('org-policy-gate'));
    expect(entries.map((e: { matcher: string }) => e.matcher).sort()).toEqual(['Bash', 'mcp__.*']);
  });
});

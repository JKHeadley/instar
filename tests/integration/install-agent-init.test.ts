/**
 * The installer's create-agent step against the real `init`, in a temporary home: the person's
 * purpose lands in the identity, no extra question or GitHub repository appears, and the agent
 * can't install its own start-on-login job.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildInstallHandlers, installInitOptions, type InstallEnv } from '../../src/commands/install.js';
import { initProject } from '../../src/commands/init.js';
import { newInstallProgress } from '../../src/commands/install/progress.js';

describe('install: create the agent', () => {
  let home: string;
  let homedir: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'install-init-'));
    homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
  });

  afterEach(() => {
    homedir.mockRestore();
    SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/install cleanup' });
  });

  it('creates a working agent in the default home, and redoes one left half-built', async () => {
    const answers = { agentName: 'scout', agentRole: 'keep my week organized', door: 'claude-code' as const };
    let inits = 0;
    const env = {
      logFile: path.join(home, 'install.log'),
      now: Date.now,
      initAgent: async (a) => { inits++; await initProject(installInitOptions(a)); },
    } as InstallEnv;
    const handler = buildInstallHandlers(env)['agent-init']!;
    const progress = newInstallProgress('do-init');

    expect(await handler(answers, progress)).toEqual({ kind: 'done' });

    const dir = path.join(home, '.instar', 'agents', 'scout');
    const config = JSON.parse(fs.readFileSync(path.join(dir, '.instar', 'config.json'), 'utf-8'));
    expect(config.dashboardPin).toMatch(/^\d{6}$/);
    expect(config.autostart?.autoInstall).toBe(false);
    expect(fs.readFileSync(path.join(dir, '.instar', 'AGENT.md'), 'utf-8')).toContain('keep my week organized');

    expect(config.tunnel.enabled).toBe(false);

    // A crash can leave a config before init finished, so a retry sets it aside and starts clean.
    expect(await handler(answers, progress)).toEqual({ kind: 'done' });
    expect(inits).toBe(2);
    const agents = fs.readdirSync(path.join(home, '.instar', 'agents'));
    expect(agents).toContain('scout');
    expect(agents.some((name) => name.startsWith('scout.partial-'))).toBe(true);
  }, 120_000);
});

import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { RECOVERY_MARKER } from '../../src/monitoring/compactionCanary.js';

it('migrates the compact hook budget so slow local reads can finish before Claude cancels recovery', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-compact-timeout-'));
  const stateDir = path.join(projectDir, '.instar');
  const settingsPath = path.join(projectDir, '.claude', 'settings.json');
  const delayedReads: string[] = [];
  const server = createServer((req, res) => {
    const pathname = (req.url ?? '').split('?')[0];
    res.setHeader('Connection', 'close');
    if (pathname === '/self-knowledge/session-context' || pathname === '/docs/session-context') {
      delayedReads.push(pathname);
      return void setTimeout(() => res.end('{}'), 2700);
    }
    res.end('{}');
  });
  try {
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as AddressInfo).port;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port, projectName: 'synthetic-compact', contextBudget: { compactionRecovery: { enabled: true } } }));
    const builtin = { type: 'command', command: 'bash "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/session-start.sh"', timeout: 5 };
    const custom = { type: 'command', command: 'bash custom-hook.sh', timeout: 5 };
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: [
      { matcher: 'startup', hooks: [builtin] },
      { matcher: 'compact', hooks: [builtin, custom] },
    ] } }));
    const migrator = new PostUpdateMigrator({ projectDir, stateDir, port, hasTelegram: true, projectName: 'synthetic-compact' });
    migrator.repairCompactionRecoveryHooks();
    const groups = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks.SessionStart;
    const [compact, preservedCustom] = groups.find((group: { matcher: string }) => group.matcher === 'compact').hooks;
    expect(compact.timeout).toBeGreaterThan(5);
    expect(preservedCustom).toEqual(custom);
    expect(groups.find((group: { matcher: string }) => group.matcher === 'startup').hooks[0].timeout).toBe(5);

    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile('bash', [path.join(stateDir, 'hooks', 'instar', 'session-start.sh')], {
        cwd: projectDir,
        timeout: compact.timeout * 1000,
        env: {
          PATH: process.env.PATH,
          HOME: projectDir,
          CLAUDE_PROJECT_DIR: projectDir,
          INSTAR_AGENT_HOME: projectDir,
          INSTAR_AUTH_TOKEN: 'synthetic',
          INSTAR_FRAMEWORK: 'claude-code',
          INSTAR_TELEGRAM_TOPIC: '777001',
        },
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
      child.stdin!.end(JSON.stringify({ source: 'compact', session_id: 'synthetic-session' }));
    });
    expect(delayedReads).toEqual(['/self-knowledge/session-context', '/docs/session-context']);
    expect(output).toContain(RECOVERY_MARKER);
    expect(output).toContain('=== END IDENTITY RECOVERY ===');
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/integration/context-budget-claude-recovery-timeout.test.ts' });
  }
}, 60_000);

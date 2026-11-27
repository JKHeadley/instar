import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SQL_COMMAND_CONTEXT_CHECK } from '../../src/core/sqlCommandContext.js';

it('the production hook repair replaces a stale installed guard and remains idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-context-update-'));
  try {
    const stateDir = path.join(dir, '.instar');
    const builtins = path.join(stateDir, 'hooks', 'instar');
    const custom = path.join(stateDir, 'hooks', 'custom');
    fs.mkdirSync(builtins, { recursive: true });
    fs.mkdirSync(custom, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'context-update', port: 4343, safety: { level: 1 } }));
    const guard = path.join(builtins, 'dangerous-command-guard.sh');
    // An existing installed built-in hook is executable. Overwrite changes its
    // content; this fixture does not introduce an unrelated file-mode repair.
    fs.writeFileSync(guard, '#!/bin/sh\nexit 2\n', { mode: 0o755 });
    const customHook = path.join(custom, 'preserve.sh');
    fs.writeFileSync(customHook, 'operator-custom-hook\n');
    const migrator = new PostUpdateMigrator({ stateDir, projectDir: dir, port: 4343, sessions: { claudePath: 'claude' } } as never);
    // This supported repair calls the same always-overwrite migrateHooks step
    // as the update lifecycle, without running unrelated migrations.
    const first = migrator.repairCompactionRecoveryHooks();
    expect(first.errors.filter((e) => e.includes('dangerous-command'))).toEqual([]);
    expect(first.upgraded).toContain('hooks/instar/dangerous-command-guard.sh');
    const installed = fs.readFileSync(guard, 'utf8');
    expect(installed).toContain(SQL_COMMAND_CONTEXT_CHECK);
    expect(fs.statSync(guard).mode & 0o111).not.toBe(0);
    const sql = ['DELETE', 'FROM', 'records'].join(' ');
    const run = (command: string) => spawnSync('bash', [guard, command], { cwd: dir, encoding: 'utf8', timeout: 10_000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
    expect(run(`rg '${sql}' src`).status).toBe(0);
    expect(run(`sqlite3 fixture.db '${sql}'`).status).toBe(2);
    const second = migrator.repairCompactionRecoveryHooks();
    expect(second.errors.filter((e) => e.includes('dangerous-command'))).toEqual([]);
    expect(fs.readFileSync(guard, 'utf8')).toBe(installed);
    expect(fs.readFileSync(customHook, 'utf8')).toBe('operator-custom-hook\n');
    expect(fs.existsSync(path.join(dir, 'fixture.db'))).toBe(false);
  } finally {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'SQL command-context update fixture teardown' });
  }
});

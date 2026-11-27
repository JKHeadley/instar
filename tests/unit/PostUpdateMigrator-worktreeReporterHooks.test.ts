/**
 * A hook on WorktreeCreate / WorktreeRemove is Claude Code's implementation of worktree
 * creation/removal (it must print the path). The event reporter prints nothing, so it
 * broke `claude --worktree` and worktree-isolated subagents. These tests run the real
 * migrateSettings chain and check the reporter is removed from those two events only.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import type { MigrationResult } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { HOOK_EVENT_TEMPLATES } from '../../src/data/http-hook-templates.js';

const REPORTER = 'node "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/hook-event-reporter.js"';
let projectDir: string | undefined;

function setup(hooks: Record<string, unknown>): void {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-hooks-'));
  fs.mkdirSync(path.join(projectDir!, '.instar'), { recursive: true });
  fs.mkdirSync(path.join(projectDir!, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(projectDir!, '.instar', 'config.json'), JSON.stringify({ port: 4042, projectName: 'wt-test' }));
  fs.writeFileSync(path.join(projectDir!, '.claude', 'settings.json'), JSON.stringify({ hooks }, null, 2));
}

function runMigrateSettings(): { hooks: Record<string, Array<{ hooks: Array<{ command?: string }> }>>; result: MigrationResult } {
  const migrator = new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir!, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'wt-test',
  });
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateSettings(r: MigrationResult): void }).migrateSettings(result);
  const settings = JSON.parse(fs.readFileSync(path.join(projectDir!, '.claude', 'settings.json'), 'utf-8'));
  return { hooks: settings.hooks, result };
}

const reporterEntry = { matcher: '', hooks: [{ type: 'command', command: REPORTER, timeout: 3000 }] };

afterEach(() => {
  if (!projectDir) return;
  SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-worktreeReporterHooks.test.ts:cleanup' });
  projectDir = undefined;
});

describe('removeWorktreeReporterHooks', () => {
  it('the template no longer registers the reporter on the worktree events', () => {
    const events = HOOK_EVENT_TEMPLATES.map((t) => t.event);
    expect(events).not.toContain('WorktreeCreate');
    expect(events).not.toContain('WorktreeRemove');
  });

  it('removes the reporter from WorktreeCreate and WorktreeRemove on an existing agent', () => {
    setup({ WorktreeCreate: [reporterEntry], WorktreeRemove: [reporterEntry], Stop: [reporterEntry] });
    const { hooks, result } = runMigrateSettings();
    expect(hooks.WorktreeCreate).toBeUndefined();
    expect(hooks.WorktreeRemove).toBeUndefined();
    // Other reporter events are untouched.
    expect(JSON.stringify(hooks.Stop)).toContain('hook-event-reporter.js');
    expect(result.upgraded.some((u) => u.includes('WorktreeCreate/WorktreeRemove'))).toBe(true);
  });

  it('also removes an old HTTP-style reporter that the chain converts to a command first', () => {
    setup({
      WorktreeCreate: [{ matcher: '', hooks: [{ type: 'http', url: 'http://localhost:4042/hooks/events?instar_sid=${INSTAR_SESSION_ID}', timeout: 5 }] }],
    });
    const { hooks } = runMigrateSettings();
    expect(hooks.WorktreeCreate).toBeUndefined();
  });

  it("keeps an operator's own worktree hook on those events", () => {
    const own = { matcher: '', hooks: [{ type: 'command', command: 'bash my-worktree-create.sh', timeout: 30 }] };
    setup({ WorktreeCreate: [own, reporterEntry] });
    const { hooks } = runMigrateSettings();
    expect(hooks.WorktreeCreate).toHaveLength(1);
    expect(hooks.WorktreeCreate[0].hooks[0].command).toBe('bash my-worktree-create.sh');
  });

  it('is idempotent', () => {
    setup({ WorktreeCreate: [reporterEntry], Stop: [reporterEntry] });
    runMigrateSettings();
    const first = fs.readFileSync(path.join(projectDir!, '.claude', 'settings.json'), 'utf-8');
    const { result } = runMigrateSettings();
    expect(fs.readFileSync(path.join(projectDir!, '.claude', 'settings.json'), 'utf-8')).toBe(first);
    expect(result.upgraded.some((u) => u.includes('WorktreeCreate/WorktreeRemove'))).toBe(false);
  });
});

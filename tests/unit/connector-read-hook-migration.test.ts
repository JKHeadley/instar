import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { deriveEffect } from '../../src/data/effect-kinds.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-hook-'));
const stateDir = path.join(dir, '.instar');
fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ trustJourney: { legacyImportedAt: '2026-11-23T00:00:00Z' } }));
fs.writeFileSync(path.join(stateDir, 'state', 'trust-legacy-kinds.json'), JSON.stringify({ legacyKinds: [], readToolNames: [] }));
const migrator = new PostUpdateMigrator({ projectDir: dir, stateDir, port: 4321, projectName: 'test', hasTelegram: false });
const fresh = path.join(dir, 'fresh-hook.mjs');
fs.writeFileSync(fresh, migrator.getHookContent('external-operation-gate'));
afterAll(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/connector-read-hook-migration.test.ts' }));

function runHook(hookPath: string, name: string, imported = true) {
  const bootstrap = `globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    process.stdout.write(JSON.stringify(body));
    return { json: async () => ({ action: body.mutability === 'read' ? 'proceed' : 'block', reason: 'fixture policy' }) };
  }; await import(${JSON.stringify(pathToFileURL(hookPath).href)});`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', bootstrap], {
    input: JSON.stringify({ tool_name: name, tool_input: { repo_full_name: 'owner/repo', pr_number: 1 } }),
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: imported ? dir : path.join(dir, 'not-imported'), INSTAR_AUTH_TOKEN: '', INSTAR_SESSION_NAME: '' },
  });
}

const names = [
  'mcp__threadline__threadline_agents', 'mcp__threadline__threadline_discover', 'mcp__threadline__threadline_send',
  'mcp__threadline__threadline_pair', 'mcp__threadline__threadline__agents', 'mcp__unrelated__threadline_agents',
  'mcp__codex_apps__github__fetch_pr', 'mcp__codex_apps__github_get_pr_info',
  'mcp__other_engine__github__list_pull_requests', 'mcp__other_engine__github_search_code',
  'mcp__bridge__github__read_file', 'mcp__github__get_pr_info',
  'mcp__codex_apps__github__create_pull_request', 'mcp__codex_apps__github_push_files',
  'mcp__other_engine__github__comment_on_pr', 'mcp__other_engine__github_merge_pull_request',
  'mcp__bridge__github__update_file', 'mcp__bridge__github_delete_file',
  'mcp__bridge__github_fetch_and_push', 'mcp__bridge__github_read_then_comment',
  'mcp__bridge__github_search_and_merge', 'mcp__bridge__execute_get_pr_info', 'mcp__bridge__opaque', 'mcp__bridge__github_inspect_read_only', 'mcp__bridge__github__inspect_read_only', 'mcp__bridge__github_mystery_get_pr',
];

describe('generated connector hook, executed with governed-service state', () => {
  it.each(names)('%s matches server classification without changing grants', (name) => {
    const result = runHook(fresh, name);
    expect(result.error).toBeUndefined();
    const effect = deriveEffect(name, {})!;
    expect(result.status, result.stderr).toBe(effect.operation === 'read' ? 0 : 2);
    expect(JSON.parse(result.stdout)).toMatchObject({ service: effect.service, mutability: effect.operation, tool_name: name });
  });
  it.each(['mcp__workflow__inspect_read', 'mcp__workflow__launch_get_status', 'mcp__workflow__unknown_get'])('%s is an unknown direct verb, not a connector namespace', (name) => {
    const result = runHook(fresh, name);
    expect(result.status, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout).mutability).toBe('modify');
  });
  it('fresh agents take the same read fast path and still govern mutations', () => {
    const read = runHook(fresh, 'mcp__any_engine__github_fetch_pr', false);
    expect(read.status, read.stderr).toBe(0);
    expect(read.stdout).toBe(''); // no evaluate call for an ungoverned read
    const write = runHook(fresh, 'mcp__any_engine__github_fetch_and_push', false);
    expect(write.status, write.stderr).toBe(2);
  });
});

describe('existing-agent update path', () => {
  it('overwrites a stale built-in hook on every migration, preserves custom hooks and remains idempotent', () => {
    const hook = path.join(stateDir, 'hooks', 'instar', 'external-operation-gate.js');
    const custom = path.join(stateDir, 'hooks', 'custom', 'owner-hook.js');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.mkdirSync(path.dirname(custom), { recursive: true });
    fs.writeFileSync(hook, '// old shipped classifier');
    fs.writeFileSync(custom, '// owner customization');
    const first = migrator.repairCompactionRecoveryHooks();
    expect(first.upgraded).toContain('hooks/instar/external-operation-gate.js (MCP tool safety gate)');
    expect(first.errors.filter((e) => e.includes('external-operation-gate'))).toEqual([]);
    expect(fs.readFileSync(hook, 'utf8')).toBe(fs.readFileSync(fresh, 'utf8'));
    for (const name of ['mcp__codex_apps__github__fetch_pr', 'mcp__codex_apps__github_push_files', 'mcp__other__opaque',
      'mcp__threadline__threadline_agents', 'mcp__threadline__threadline_send']) {
      const result = runHook(hook, name);
      expect(result.status, result.stderr).toBe(deriveEffect(name, {})?.operation === 'read' ? 0 : 2);
    }
    migrator.repairCompactionRecoveryHooks();
    expect(fs.readFileSync(hook, 'utf8')).toBe(fs.readFileSync(fresh, 'utf8'));
    expect(fs.readFileSync(custom, 'utf8')).toBe('// owner customization');
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'trust-legacy-kinds.json'), 'utf8'))).toEqual({ legacyKinds: [], readToolNames: [] });
  });
});

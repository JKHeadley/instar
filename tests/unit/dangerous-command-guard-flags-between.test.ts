// safe-git-allow: test file — fs.rmSync is per-test tmpdir cleanup only.
/**
 * The guard's destructive git checks must not depend on the exact spelling. On 2026-11-05 a reset with `-q`
 * before the hard flag ran in a live agent home, because the guard matched only the literal phrase. All three
 * writers carry the same patterns; the two runnable ones are run here.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

const REPO_ROOT = path.resolve(__dirname, '../..');
const migrated = (new PostUpdateMigrator({ stateDir: '/tmp/no-state', projectDir: '/tmp/no-proj', port: 4042, sessions: { claudePath: 'claude' } } as never) as unknown as { getDangerousCommandGuard(): string }).getDangerousCommandGuard();
const template = fs.readFileSync(path.join(REPO_ROOT, 'src/templates/hooks/dangerous-command-guard.sh'), 'utf-8');

let dir: string;
const scripts: Record<string, string> = {};
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-guard-flags-'));
  for (const [name, body] of [['migrated', migrated], ['template', template]] as const) {
    scripts[name] = path.join(dir, `${name}.sh`);
    fs.writeFileSync(scripts[name], body, { mode: 0o755 });
  }
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* test cleanup */ } }); // safe-fs-allow

const run = (script: string, command: string) => spawnSync('bash', [script, JSON.stringify({ command })], { cwd: dir, encoding: 'utf-8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });

const BLOCKED = [
  'git reset -q --hard origin/main',
  'git reset --quiet --hard',
  'git -C /some/path reset --hard',
  'git -c a=b reset -q --hard HEAD~1',
  'cd x; git reset -q --hard origin/main',
  'git clean -xfd',
  'git clean -f',
  'git clean -d -f',
  'git clean --force',
  'git -C /some/path clean -fd',
  'git push origin mine --force',
  'git push -u origin mine -f',
  'git -C /some/path push -f',
  'git reset --hard',
  'git clean -fd',
  'git push --force',
];
const ALLOWED = [
  'git reset --soft HEAD~1',
  'git reset -q -- a.txt',
  'git reset HEAD; echo --hard',
  'git clean -nd',
  'git status --force-nothing',
  'git push origin mine',
  'git push --force-with-lease origin mine',
  'git push -u origin feature-file',
];

describe.each(['migrated', 'template'])('%s guard', (name) => {
  it.each(BLOCKED)('blocks: %s', (command) => {
    const r = run(scripts[name], command);
    expect(r.status, r.stdout).not.toBe(0);
    expect(r.stderr).toContain('BLOCKED');
  });
  it.each(ALLOWED)('allows: %s', (command) => {
    const r = run(scripts[name], command);
    expect(r.stderr).not.toContain('BLOCKED: Potentially destructive');
  });
});

describe('every writer carries the patterns', () => {
  it('init.ts inline copy', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/commands/init.ts'), 'utf-8');
    for (const verb of ['reset', 'clean', 'push']) expect(src).toContain(`git +([^|;&]* +)?${verb} +`);
    expect(src).toMatch(/grep -qiE "\\*\$pattern"/);
  });
});

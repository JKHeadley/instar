// safe-git-allow: test file — fs.rmSync is per-test tmpdir cleanup only.
/**
 * SEC-043: the guard every update installs had lost the database-schema destruction rules that the
 * setup template carries, and the template's "--accept-data-loss" rule never fired (grep read the
 * pattern as an option). All three writers now carry the same rules; the two runnable ones are run.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-guard-db-'));
  for (const [name, body] of [['migrated', migrated], ['template', template]] as const) {
    scripts[name] = path.join(dir, `${name}.sh`);
    fs.writeFileSync(scripts[name], body, { mode: 0o755 });
  }
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* test cleanup */ } }); // safe-fs-allow

const run = (script: string, command: string) => spawnSync('bash', [script, JSON.stringify({ command })], { cwd: dir, encoding: 'utf-8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });

const ALWAYS = ['npx prisma db push --accept-data-loss', 'npx prisma migrate reset --force', 'prisma migrate reset'];
const RISKY = ['npx prisma db push', 'npx prisma migrate deploy'];
const ALLOWED = ['npx prisma generate', 'npx prisma migrate dev --name add_users', 'npx prisma studio'];

describe.each(['migrated', 'template'])('%s guard — database schema rules', (name) => {
  it.each(ALWAYS)('always blocks: %s', (command) => {
    const r = run(scripts[name], command);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('BLOCKED: Catastrophic');
  });
  it.each(RISKY)('blocks at level 1: %s', (command) => {
    const r = run(scripts[name], command);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('BLOCKED: Potentially destructive');
  });
  it.each(ALLOWED)('allows: %s', (command) => {
    const r = run(scripts[name], command);
    expect(r.stderr).not.toContain('BLOCKED');
  });
});

describe('every writer carries the database rules', () => {
  it('init.ts inline copy', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/commands/init.ts'), 'utf-8');
    const guard = src.slice(src.indexOf("'dangerous-command-guard.sh'), `#!/bin/bash"));
    for (const p of ['"--accept-data-loss"', '"prisma migrate reset"', '"prisma db push"', '"prisma migrate deploy"']) expect(guard).toContain(p);
    expect(guard).toContain('grep -qi -e "\\$pattern"');
  });
});

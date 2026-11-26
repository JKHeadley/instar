// safe-git-allow: test file — fs.rmSync is per-test tmpdir cleanup only.
/**
 * A literal credential on a command line is readable by every process on the machine through ps while
 * the command runs, and process samplers record it (argv-token incident, 2026-11-17: a GitHub token was
 * seen in a test command's argv). The guard refuses such a command in every writer, and points at the
 * way that keeps the secret off the command line: read it inside the command.
 *
 * The token shapes below are assembled at run time so this file itself carries no credential shape.
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

const fake = {
  githubClassic: 'gh' + 'p_' + 'A1b2'.repeat(9),
  githubOauth: 'gh' + 'o_' + 'Z9y8'.repeat(9),
  githubFineGrained: 'github' + '_pat_' + 'x'.repeat(22) + '_' + 'Y'.repeat(59),
  anthropic: 'sk-' + 'ant-' + 'api03-' + 'q'.repeat(40),
  slack: 'xo' + 'xb-' + '1234567890-' + 'abcdefghijklmnop',
  telegram: '9163230303' + ':AA' + 'H'.repeat(33),
};

let dir: string;
const scripts: Record<string, string> = {};
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-guard-cred-'));
  for (const [name, body] of [['migrated', migrated], ['template', template]] as const) {
    scripts[name] = path.join(dir, `${name}.sh`);
    fs.writeFileSync(scripts[name], body, { mode: 0o755 });
  }
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* test cleanup */ } }); // safe-fs-allow

const run = (script: string, command: string) => spawnSync('bash', [script, JSON.stringify({ command })], { cwd: dir, encoding: 'utf-8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });

describe('dangerous-command-guard: a literal credential in a command is always refused', () => {
  for (const name of ['template', 'migrated'] as const) {
    it(`${name}: every credential shape is refused, with the way to read it instead`, () => {
      const commands = [
        `GH_TOKEN=${fake.githubClassic} npx vitest run tests/unit/x.test.ts`,
        `gh api user -H "Authorization: token ${fake.githubOauth}"`,
        `git clone https://x-access-token:${fake.githubFineGrained}@github.com/o/r.git`,
        `ANTHROPIC_API_KEY=${fake.anthropic} node probe.mjs`,
        `curl -H "Authorization: Bearer ${fake.slack}" https://slack.com/api/auth.test`,
        `curl https://api.telegram.org/bot${fake.telegram}/getMe`,
      ];
      for (const command of commands) {
        const r = run(scripts[name], command);
        expect(r.status, command).toBe(2);
        expect(r.stderr).toContain('literal credential');
        expect(r.stderr).toContain('$(gh auth token)');
      }
    });

    it(`${name}: reading the secret inside the command, and a short or partial shape, pass`, () => {
      for (const command of [
        'GH_TOKEN="$(gh auth token)" npx vitest run tests/unit/x.test.ts',
        'TOKEN="$(node .instar/scripts/secret-get.mjs telegram_pr2760_test_bot_token)" node probe.mjs',
        "grep -E 'gh[pousr]_[A-Za-z0-9]{36}' src/x.ts",
        'echo ghp_short',
        'git log --oneline -3',
      ]) {
        const r = run(scripts[name], command);
        expect(r.status, `${command}\n${r.stderr}`).not.toBe(2);
      }
    });
  }

  it('init.ts inline copy carries the same rule (with its $ escapes)', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/commands/init.ts'), 'utf-8');
    expect(src).toContain("if echo \"\\$INPUT\" | grep -qE -e '(gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,}|sk-ant-[A-Za-z0-9_-]{20,}|xox[abprs]-[0-9A-Za-z-]{20,}|[0-9]{8,10}:AA[A-Za-z0-9_-]{33})'; then");
    expect(src).toContain('GH_TOKEN="\\$(gh auth token)"');
  });
});

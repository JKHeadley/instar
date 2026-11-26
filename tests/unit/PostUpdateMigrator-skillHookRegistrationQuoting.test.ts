/**
 * Installed /autonomous and /build skills get the quoted Stop-hook registration.
 *
 * Bug (Astra review of PR #2093): installBuiltinSkills() never overwrites, and
 * the whole-file skill migrations treat the pre-fix copies as current, so an
 * installed skill kept its unquoted registration line. Running that block after
 * an update rewrote the quoted settings command (migrateSettings) back to the
 * unquoted form, which fails in a home path with a space or apostrophe.
 *
 * Covers: upgrade of the shipped pre-fix copies in a home named
 * "Justin's Agent Home", then running the installed registration block — the
 * command stays quoted and executes; custom content is kept; second run no-op.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

const REPO = path.resolve(__dirname, '..', '..');

// Each skill: the current (quoted) line and the pre-fix line it shipped with.
const SKILLS = {
  autonomous: {
    hook: '.claude/skills/autonomous/hooks/autonomous-stop-hook.sh',
    quoted: String.raw`correct = 'bash \"\${CLAUDE_PROJECT_DIR}/.claude/skills/autonomous/hooks/autonomous-stop-hook.sh\"'`,
    shipped: String.raw`correct = 'bash \${CLAUDE_PROJECT_DIR}/.claude/skills/autonomous/hooks/autonomous-stop-hook.sh'`,
    marker: 'autonomous-stop-hook',
  },
  build: {
    hook: '.instar/hooks/instar/build-stop-hook.sh',
    quoted: String.raw`'command': 'bash \"\${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/build-stop-hook.sh\"'`,
    shipped: `'command': 'bash .instar/hooks/instar/build-stop-hook.sh'`,
    marker: 'build-stop-hook',
  },
} as const;
type SkillName = keyof typeof SKILLS;

function bundled(name: SkillName): string {
  return fs.readFileSync(path.join(REPO, '.claude', 'skills', name, 'SKILL.md'), 'utf8');
}

/** The pre-fix installed copy: the bundled skill with the shipped unquoted line. */
function preFix(name: SkillName): string {
  const text = bundled(name);
  expect(text).toContain(SKILLS[name].quoted);
  return text.split(SKILLS[name].quoted).join(SKILLS[name].shipped);
}

/** The installed skill's `python3 -c` block that registers its Stop hook. */
function registrationBlock(skillText: string, marker: string): string {
  const block = skillText.split('```bash\n').map(x => x.split('```')[0])
    .find(x => x.startsWith('python3 -c "\nimport json') && x.includes(marker) && x.includes('hooks.append'));
  expect(block).toBeTruthy();
  return block!;
}

describe('PostUpdateMigrator — installed skill Stop-hook registration is quoted', () => {
  let root: string;
  let home: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-hook-quoting-'));
    home = path.join(root, "Justin's Agent Home");
    fs.mkdirSync(path.join(home, '.instar'), { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-skillHookRegistrationQuoting.test.ts' });
  });

  function install(name: SkillName, text: string): string {
    const file = path.join(home, '.claude', 'skills', name, 'SKILL.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  }

  function migrate(): MigrationResult {
    const migrator = new PostUpdateMigrator({
      projectDir: home, stateDir: path.join(home, '.instar'), port: 4042, hasTelegram: false, projectName: 'test',
    });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (migrator as unknown as { migrateSkillStopHookRegistrationQuoting(r: MigrationResult): void })
      .migrateSkillStopHookRegistrationQuoting(result);
    return result;
  }

  for (const name of Object.keys(SKILLS) as SkillName[]) {
    const spec = SKILLS[name];

    it(`${name}: the pre-fix installed block registers an unquoted command that fails from a subdirectory of this home`, () => {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
      execFileSync('bash', ['-c', registrationBlock(preFix(name), spec.marker)], { cwd: home, env: { ...process.env, CLAUDE_PROJECT_DIR: home }, stdio: 'pipe' });
      const cmd = stopCommands(spec.marker)[0];
      expect(cmd).not.toContain('"');
      stubHook(spec.hook);
      expect(() => execFileSync('bash', ['-c', cmd], { cwd: path.join(home, '.instar'), env: { ...process.env, CLAUDE_PROJECT_DIR: home }, stdio: 'pipe' })).toThrow();
    });

    it(`${name}: after migration the installed block keeps the command quoted and runnable`, () => {
      const custom = '\n\n## My own notes\nkeep me\n';
      const file = install(name, preFix(name) + custom);
      const result = migrate();
      expect(result.errors).toEqual([]);
      expect(result.upgraded).toEqual([`.claude/skills/${name}/SKILL.md (Stop hook registration quotes the hook path)`]);
      const upgraded = fs.readFileSync(file, 'utf8');
      expect(upgraded).toBe(bundled(name) + custom);

      // Settings already hold the quoted command (as migrateSettings leaves them).
      const quotedCmd = `bash "\${CLAUDE_PROJECT_DIR}/${spec.hook}"`;
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
        hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: quotedCmd, timeout: 10000 }] }] },
      }));
      const run = () => execFileSync('bash', ['-c', registrationBlock(upgraded, spec.marker)], { cwd: home, env: { ...process.env, CLAUDE_PROJECT_DIR: home }, stdio: 'pipe' });
      run();
      expect(stopCommands(spec.marker)).toEqual([quotedCmd]);

      // From empty settings the block also writes the quoted command.
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
      run();
      expect(stopCommands(spec.marker)).toEqual([quotedCmd]);

      stubHook(spec.hook);
      const out = execFileSync('bash', ['-c', quotedCmd], { cwd: path.join(home, '.instar'), env: { ...process.env, CLAUDE_PROJECT_DIR: home }, encoding: 'utf8' });
      expect(out).toContain('hook-ran');

      // Second run is a no-op.
      const again = migrate();
      expect(again).toEqual({ upgraded: [], skipped: [], errors: [] });
      expect(fs.readFileSync(file, 'utf8')).toBe(upgraded);
    });
  }

  it('build: the unreleased round-1 unquoted line is upgraded too', () => {
    const roundOne = `'command': 'bash \${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/build-stop-hook.sh'`;
    const file = install('build', bundled('build').split(SKILLS.build.quoted).join(roundOne));
    expect(migrate().errors).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(bundled('build'));
  });

  it('a custom skill without the shipped line is left untouched; missing skills are skipped', () => {
    const file = install('autonomous', '# my own autonomous skill\ncorrect = "bash my-hook.sh"\n');
    const result = migrate();
    expect(result).toEqual({ upgraded: [], skipped: [], errors: [] });
    expect(fs.readFileSync(file, 'utf8')).toBe('# my own autonomous skill\ncorrect = "bash my-hook.sh"\n');
  });

  function stopCommands(marker: string): string[] {
    const s = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    return (s.hooks?.Stop ?? []).flatMap((e: { hooks?: Array<{ command?: string }> }) => e.hooks ?? [])
      .map((h: { command?: string }) => h.command ?? '').filter((c: string) => c.includes(marker));
  }

  function stubHook(rel: string): void {
    const hook = path.join(home, rel);
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, 'echo hook-ran\n');
  }
});

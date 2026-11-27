// safe-git-allow: the test builds a throwaway git repository in a temporary directory to give the advisory lint a merge base to diff against.
/**
 * scripts/lint-awareness-entry-registry.mjs (docs/specs/awareness-entry-registry.md 3.6):
 * an ADVISORY notice for awareness text added the old way. It never fails.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'lint-awareness-entry-registry.mjs');

const TEMPLATES = [
  "import x from 'y';",
  'export function generateClaudeMd(port: number): string {',
  '  let content = `# CLAUDE.md',
  '}',
  '`;',
  '  content += recovery(port);',
  '  return content;',
  '}',
  '',
  'export function recovery(port: number): string {',
  "  let content = '';",
  "  content += 'not in generateClaudeMd';",
  '  return content;',
  '}',
  '',
].join('\n');

const MIGRATOR = [
  'export class PostUpdateMigrator {',
  '  private other(): void {',
  '    const a = 1;',
  '  }',
  '  private patchClaudeMdContent(input: string, result: R): { content: string; patched: boolean } {',
  '    let content = input;',
  '    let patched = false;',
  '    return { content, patched };',
  '  }',
  '  private after(): void {',
  '    const b = 2;',
  '  }',
  '}',
  '',
].join('\n');

let repo: string;

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Lint Test', '-c', 'user.email=lint-test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'ignore' });
}

function write(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
}

function initRepo(branch: string): void {
  git('init', '-q', '-b', branch);
  write('src/scaffold/templates.ts', TEMPLATES);
  write('src/core/PostUpdateMigrator.ts', MIGRATOR);
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'base');
}

function run(): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', repo], { encoding: 'utf-8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

beforeEach(() => { repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-awareness-registry-')); });
afterEach(() => {
  SafeFsExecutor.safeRmSync(repo, { recursive: true, force: true, operation: 'tests/unit/lint-awareness-entry-registry.test.ts' });
});

describe('lint-awareness-entry-registry (advisory)', () => {
  it('prints a notice naming the line and the entry folder, and exits 0, for lines added inside patchClaudeMdContent', () => {
    initRepo('main');
    git('checkout', '-q', '-b', 'feature');
    write('src/core/PostUpdateMigrator.ts', MIGRATOR.replace('    let patched = false;\n', "    let patched = false;\n    if (!content.includes('X')) {\n      content += 'X';\n    }\n"));
    git('commit', '-q', '--no-verify', '-am', 'old way');
    const r = run();
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/NOTICE \(advisory, nothing fails\)/);
    expect(r.out).toContain('inside patchClaudeMdContent (src/core/PostUpdateMigrator.ts:8, and 2 more)');
    expect(r.out).toContain('src/data/awareness/');
  });

  it('prints a notice for an added `content +=` line inside generateClaudeMd, also when it is not committed yet', () => {
    initRepo('main');
    git('checkout', '-q', '-b', 'feature');
    write('src/scaffold/templates.ts', TEMPLATES.replace('  content += recovery(port);\n', '  content += recovery(port);\n  content += NEW_SECTION(port);\n'));
    const r = run();
    expect(r.status).toBe(0);
    expect(r.out).toContain('adds a `content +=` line inside generateClaudeMd (src/scaffold/templates.ts:7)');
    expect(r.out).toContain('src/data/awareness/README.md');
  });

  it('is silent about an unrelated edit: another function, or a non-append line in generateClaudeMd', () => {
    initRepo('main');
    git('checkout', '-q', '-b', 'feature');
    write('src/core/PostUpdateMigrator.ts', MIGRATOR.replace('    const a = 1;\n', '    const a = 1;\n    const c = 3;\n').replace('    const b = 2;\n', "    const b = 2;\n    content += 'after the function';\n"));
    write('src/scaffold/templates.ts', TEMPLATES
      .replace('  let content = `# CLAUDE.md\n', '  let content = `# CLAUDE.md\nA reworded template line.\n')
      .replace("  content += 'not in generateClaudeMd';\n", "  content += 'not in generateClaudeMd';\n  content += 'still not in it';\n"));
    git('commit', '-q', '--no-verify', '-am', 'unrelated');
    const r = run();
    expect(r.status).toBe(0);
    expect(r.out).not.toMatch(/NOTICE/);
    expect(r.out).toMatch(/OK \(no awareness text added the old way\)/);
  });

  it('prints "not checked" and exits 0 without a merge base', () => {
    initRepo('trunk');
    write('src/core/PostUpdateMigrator.ts', MIGRATOR.replace('    let patched = false;\n', "    let patched = false;\n    content += 'X';\n"));
    const r = run();
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/not checked \(no merge base with main/);
    expect(r.out).not.toMatch(/NOTICE/);
  });

  it('exits 0 even where there is no repository at all', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/not checked/);
  });

  it('is in the lint chain', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.lint).toContain('node scripts/lint-awareness-entry-registry.mjs');
  });
});

// safe-git-allow: test fixture builds throwaway git repos in a per-test tmpdir (isolated HOME, no global config).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const keptNames = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.gitignore', '.claude', '.codex', '.mcp.json', 'instar.config.json'];
export const reviewNotice = 'Kept project files may still hold Instar instructions or hooks. Your agent can review these files read-only and propose removals for you to approve.';
export const backupNotice = 'Only already committed changes can be pushed. Uncommitted changes are NOT in the backup and will be deleted with the agent folder. Commits outside the configured push can also be lost.';
export function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe', env: { HOME: dir, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } });
}
export function install(dir: string): void {
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.instar/config.json'), JSON.stringify({ projectName: 'zz-cmin' }));
}
export function seedKept(dir: string): void {
  for (const name of keptNames) {
    if (name === '.claude' || name === '.codex') {
      fs.mkdirSync(path.join(dir, name, 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(dir, name, 'hooks/user'), Buffer.from([0, 255, 10, 12]));
    } else fs.writeFileSync(path.join(dir, name), `user instructions: ${name}\n`);
  }
  fs.writeFileSync(path.join(dir, 'other.txt'), 'unrelated');
}
// Test-only recursive snapshot: never traverses symbolic links.
export function snapshot(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(rel: string): void {
    const p = path.join(dir, rel);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) result[rel] = `link:${fs.readlinkSync(p)}`;
    else if (st.isDirectory()) {
      result[rel] = 'directory';
      for (const child of fs.readdirSync(p).sort()) visit(path.join(rel, child));
    } else result[rel] = fs.readFileSync(p).toString('hex');
  }
  for (const name of fs.readdirSync(dir).sort()) if (name !== '.instar' && name !== '.git') visit(name);
  return result;
}

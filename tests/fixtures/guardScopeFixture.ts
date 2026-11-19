// safe-git-allow: test fixture — builds and removes throwaway temp checkouts (git init/commit, temp-tree cleanup) for the guard-runtime-state-scope tests.
/**
 * Fixtures for the guard-runtime-state-scope tests: a temp tree whose own path contains
 * `/.instar/`, with an instar checkout living under it exactly as an agent home does
 * (`<base>/.instar/agents/home`).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

/** Make `dir` an instar checkout: git repo, instar package signature, one tracked source file. */
export function makeInstarCheckout(dir: string): void {
  fs.mkdirSync(path.join(dir, 'src', 'core'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'instar' }));
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(dir, 'src', 'core', 'GitSync.ts'), 'export {};\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.instar/\n.worktrees/\nnode_modules*\n');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
}

export interface GuardFixture {
  base: string;
  /** `<base>/.instar/agents/home`: an instar checkout under a parent `/.instar/` folder. */
  home: string;
  /** A folder outside every checkout. */
  outside: string;
  /** A state dir for the ledger. */
  ledgerDir: string;
  cleanup: () => void;
}

export function makeGuardFixture(prefix = 'guard-scope-'): GuardFixture {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const home = path.join(base, '.instar', 'agents', 'home');
  fs.mkdirSync(home, { recursive: true });
  makeInstarCheckout(home);
  fs.mkdirSync(path.join(home, '.instar', 'state'), { recursive: true });
  fs.mkdirSync(path.join(home, '.worktrees'), { recursive: true });
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  const ledgerDir = path.join(base, 'ledger');
  return {
    base, home, outside, ledgerDir,
    cleanup: () => {
      // Restore permissions a test removed so the temp tree can be deleted.
      const walk = (d: string): void => {
        try { fs.chmodSync(d, 0o755); } catch { /* ignore */ }
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p); else try { fs.chmodSync(p, 0o644); } catch { /* ignore */ }
        }
      };
      walk(base);
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

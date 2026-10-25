/**
 * Agent-owned memory (operator rule 2026-09-25: logins hold tokens and quota,
 * never data). `<config home>/projects/<key>/memory` must be a link to the
 * agent's own folder, whatever was there before — and nothing is ever deleted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureAgentOwnedMemory,
  ensureAgentOwnedMemoryAllHomes,
  canonicalProjectRoot,
  claudeProjectKey,
  mergeMemoryIndex,
} from '../../src/core/AgentOwnedMemory.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let root: string;
let agentHome: string;
let loginA: string;
let loginB: string;
let origHome: string | undefined;

const keyOf = (p: string) => claudeProjectKey(fs.realpathSync(p))!;
const memLink = (login: string) => path.join(login, 'projects', keyOf(agentHome), 'memory');
const owned = () => path.join(agentHome, '.instar', 'agent-memory');
function write(file: string, content: string, mtime?: Date): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mtime) fs.utimesSync(file, mtime, mtime);
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-owned-memory-')));
  agentHome = path.join(root, 'agent');
  loginA = path.join(root, '.claude-followme-a');
  loginB = path.join(root, '.claude-followme-b');
  fs.mkdirSync(path.join(agentHome, '.instar'), { recursive: true });
  fs.writeFileSync(path.join(agentHome, '.instar', 'config.json'), '{}');
  fs.mkdirSync(loginA);
  fs.mkdirSync(loginB);
  origHome = process.env.HOME;
  process.env.HOME = root;
});
afterEach(() => {
  process.env.HOME = origHome;
  SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/agent-owned-memory.test.ts' });
});

describe('ensureAgentOwnedMemory — no memory folder yet', () => {
  it('creates the agent-owned folder and links the login to it', () => {
    const r = ensureAgentOwnedMemory({ agentHome, configHome: loginA });
    expect(r.action).toBe('linked');
    expect(fs.lstatSync(memLink(loginA)).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(memLink(loginA))).toBe(fs.realpathSync(owned()));
  });

  it('a memory written under one login is read under another', () => {
    ensureAgentOwnedMemory({ agentHome, configHome: loginA });
    ensureAgentOwnedMemory({ agentHome, configHome: loginB });
    write(path.join(memLink(loginA), 'rule.md'), 'standing rule');
    expect(fs.readFileSync(path.join(memLink(loginB), 'rule.md'), 'utf8')).toBe('standing rule');
  });
});

describe('ensureAgentOwnedMemory — an existing symlink', () => {
  it('leaves a correct link alone (idempotent)', () => {
    ensureAgentOwnedMemory({ agentHome, configHome: loginA });
    const before = fs.lstatSync(memLink(loginA));
    const r = ensureAgentOwnedMemory({ agentHome, configHome: loginA });
    expect(r.action).toBe('already-linked');
    expect(fs.lstatSync(memLink(loginA)).ino).toBe(before.ino);
    expect(fs.existsSync(`${memLink(loginA)}.pre-shared`)).toBe(false);
  });

  it('a link placed by someone else (outside this agent) is left alone', () => {
    const elsewhere = path.join(root, 'other-agent', '.instar', 'agent-memory');
    write(path.join(elsewhere, 'theirs.md'), 'x');
    fs.mkdirSync(path.dirname(memLink(loginA)), { recursive: true });
    fs.symlinkSync(elsewhere, memLink(loginA));
    const r = ensureAgentOwnedMemory({ agentHome, configHome: loginA });
    expect(r.action).toBe('skipped');
    expect(fs.realpathSync(memLink(loginA))).toBe(fs.realpathSync(elsewhere));
    expect(fs.existsSync(path.join(owned(), 'theirs.md'))).toBe(false);
  });

  it('a stale link of our own (into this agent home) is merged, set aside, and replaced', () => {
    const stale = path.join(agentHome, '.instar', 'old-memory');
    write(path.join(stale, 'only-there.md'), 'x');
    fs.mkdirSync(path.dirname(memLink(loginA)), { recursive: true });
    fs.symlinkSync(stale, memLink(loginA));
    const r = ensureAgentOwnedMemory({ agentHome, configHome: loginA });
    expect(r.action).toBe('migrated');
    expect(fs.readFileSync(path.join(owned(), 'only-there.md'), 'utf8')).toBe('x');
    expect(fs.lstatSync(r.setAsidePath!).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(stale, 'only-there.md'), 'utf8')).toBe('x');
    expect(fs.realpathSync(memLink(loginA))).toBe(fs.realpathSync(owned()));
  });
});

describe('ensureAgentOwnedMemory — an existing real folder', () => {
  it('merges: union of files, newest wins, older differing copy kept in _superseded', () => {
    const old = new Date('2026-09-01T00:00:00Z');
    const recent = new Date('2026-09-20T00:00:00Z');
    write(path.join(owned(), 'shared-newer-in-login.md'), 'agent old', old);
    write(path.join(owned(), 'shared-newer-in-agent.md'), 'agent new', recent);
    write(path.join(owned(), 'same.md'), 'same', old);
    write(path.join(owned(), 'agent-only.md'), 'a', old);
    write(path.join(owned(), 'MEMORY.md'), '- [Agent only](agent-only.md) — a\n- [Shared L](shared-newer-in-login.md) — agent line\n', old);

    const loginMem = memLink(loginA);
    write(path.join(loginMem, 'shared-newer-in-login.md'), 'login new', recent);
    write(path.join(loginMem, 'shared-newer-in-agent.md'), 'login old', old);
    write(path.join(loginMem, 'same.md'), 'same', recent);
    write(path.join(loginMem, 'login-only.md'), 'l', old);
    write(path.join(loginMem, 'MEMORY.md'), '- [Shared L](shared-newer-in-login.md) — login line\n- [Login only](login-only.md) — l\n', recent);

    const r = ensureAgentOwnedMemory({ agentHome, configHome: loginA });
    expect(r.action).toBe('migrated');

    const read = (f: string) => fs.readFileSync(path.join(owned(), f), 'utf8');
    expect(read('login-only.md')).toBe('l');
    expect(read('agent-only.md')).toBe('a');
    expect(read('same.md')).toBe('same');
    expect(read('shared-newer-in-login.md')).toBe('login new');
    expect(read('shared-newer-in-agent.md')).toBe('agent new');

    const superseded = fs.readdirSync(path.join(owned(), '_superseded'));
    const contents = superseded.filter((f) => !f.startsWith('MEMORY.md')).map((f) => fs.readFileSync(path.join(owned(), '_superseded', f), 'utf8')).sort();
    expect(contents).toEqual(['agent old', 'login old']);
    // The agent's index as it was before the merge is kept too.
    const oldIndex = superseded.filter((f) => f.startsWith('MEMORY.md'));
    expect(oldIndex).toHaveLength(1);
    expect(fs.readFileSync(path.join(owned(), '_superseded', oldIndex[0]), 'utf8')).toContain('agent line');

    const index = read('MEMORY.md');
    expect(index).toContain('(agent-only.md)');
    expect(index).toContain('(login-only.md)');
    expect(index).toContain('login line'); // the login's copy won, so its index line wins
    expect(index).not.toContain('agent line');
    expect(index.match(/shared-newer-in-login\.md/g)).toHaveLength(1);

    // The old folder is renamed, never deleted, and its contents are intact.
    expect(r.setAsidePath).toBe(`${loginMem}.pre-shared`);
    expect(fs.readFileSync(path.join(r.setAsidePath!, 'login-only.md'), 'utf8')).toBe('l');
    expect(fs.realpathSync(loginMem)).toBe(fs.realpathSync(owned()));
  });

  it('never overwrites an earlier memory.pre-shared', () => {
    const loginMem = memLink(loginA);
    write(path.join(`${loginMem}.pre-shared`, 'earlier.md'), 'earlier');
    write(path.join(loginMem, 'new.md'), 'new');
    const r = ensureAgentOwnedMemory({ agentHome, configHome: loginA });
    expect(r.setAsidePath).not.toBe(`${loginMem}.pre-shared`);
    expect(fs.readFileSync(path.join(`${loginMem}.pre-shared`, 'earlier.md'), 'utf8')).toBe('earlier');
    expect(fs.readFileSync(path.join(r.setAsidePath!, 'new.md'), 'utf8')).toBe('new');
  });

  it('a second run after migration changes nothing', () => {
    write(path.join(memLink(loginA), 'x.md'), 'x');
    ensureAgentOwnedMemory({ agentHome, configHome: loginA });
    const r = ensureAgentOwnedMemory({ agentHome, configHome: loginA });
    expect(r.action).toBe('already-linked');
  });
});

describe('ensureAgentOwnedMemory — when it must not act', () => {
  it('skips a folder that is not an agent home', () => {
    SafeFsExecutor.safeRmSync(path.join(agentHome, '.instar', 'config.json'), { force: true, operation: 'tests/unit/agent-owned-memory.test.ts' });
    expect(ensureAgentOwnedMemory({ agentHome, configHome: loginA }).action).toBe('skipped');
    expect(fs.existsSync(path.join(loginA, 'projects'))).toBe(false);
  });

  it('never creates a login config home that does not exist', () => {
    const missing = path.join(root, '.claude-never-enrolled');
    expect(ensureAgentOwnedMemory({ agentHome, configHome: missing }).action).toBe('skipped');
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('a throwaway (temp-dir) agent never links into a real login folder', () => {
    const realDir = path.resolve(__dirname); // an existing directory outside the temp folder
    const r = ensureAgentOwnedMemory({ agentHome, configHome: realDir });
    expect(r.action).toBe('skipped');
    expect(fs.existsSync(path.join(realDir, 'projects'))).toBe(false);
  });
});

describe('project key', () => {
  it('matches Claude Code: every non-alphanumeric character becomes a dash', () => {
    expect(claudeProjectKey('/Users/x/.instar/agents/echo')).toBe('-Users-x--instar-agents-echo');
    expect(claudeProjectKey('/' + 'a'.repeat(250))).toBeNull();
  });

  it('a git worktree resolves to its main checkout, a subfolder to the repo root', () => {
    fs.mkdirSync(path.join(agentHome, '.git', 'worktrees', 'wt'), { recursive: true });
    fs.writeFileSync(path.join(agentHome, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    const wt = path.join(agentHome, '.worktrees', 'wt');
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(agentHome, '.git', 'worktrees', 'wt')}\n`);
    expect(canonicalProjectRoot(path.join(wt, 'src'))).toBe(agentHome);
    expect(canonicalProjectRoot(path.join(agentHome, '.instar'))).toBe(agentHome);

    // A worktree session shares the agent's own memory folder.
    const r = ensureAgentOwnedMemory({ agentHome, configHome: loginA, cwd: wt });
    expect(r.ownedDir).toBe(owned());
  });

  it('another project (another agent\'s home, or a folder a person also uses) is never taken over', () => {
    const other = path.join(root, 'other-agent');
    write(path.join(other, '.instar', 'config.json'), '{}');
    write(path.join(loginA, 'projects', keyOf(other), 'memory', 'theirs.md'), 'theirs');
    const r = ensureAgentOwnedMemory({ agentHome, configHome: loginA, cwd: other });
    expect(r.action).toBe('skipped');
    expect(fs.lstatSync(path.join(loginA, 'projects', keyOf(other), 'memory')).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(agentHome, '.instar', 'agent-memory-projects'))).toBe(false);
  });
});

describe('mergeMemoryIndex', () => {
  it('keys on the linked filename and keeps the owned order', () => {
    const merged = mergeMemoryIndex('# Index\n- [A](a.md) — a\n', '# Index\n- [B](b.md) — b\n- [A](a.md) — other a\n');
    expect(merged).toBe('# Index\n- [A](a.md) — a\n- [B](b.md) — b\n');
  });
});

describe('every login on the host, and the update migrator', () => {
  it('links every ~/.claude* home and reports each', () => {
    fs.mkdirSync(path.join(root, '.claude'));
    write(path.join(memLink(loginB), 'b.md'), 'b');
    const results = ensureAgentOwnedMemoryAllHomes(agentHome, root);
    expect(results.map((r) => path.basename(r.configHome)).sort()).toEqual(['.claude', '.claude-followme-a', '.claude-followme-b']);
    expect(results.every((r) => !r.error)).toBe(true);
    for (const home of [path.join(root, '.claude'), loginA, loginB]) {
      expect(fs.realpathSync(memLink(home))).toBe(fs.realpathSync(owned()));
    }
    expect(fs.readFileSync(path.join(owned(), 'b.md'), 'utf8')).toBe('b');
  });

  it('PostUpdateMigrator links existing agents on update, and is idempotent', () => {
    write(path.join(memLink(loginA), 'kept.md'), 'kept');
    const migrator = new PostUpdateMigrator({ projectDir: agentHome, stateDir: path.join(agentHome, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
    const run = () => {
      const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
      (migrator as unknown as { migrateAgentOwnedMemory(r: typeof result): void }).migrateAgentOwnedMemory(result);
      return result;
    };
    const first = run();
    expect(first.errors).toEqual([]);
    expect(first.upgraded.some((u) => u.includes('migrated') && u.includes('.claude-followme-a'))).toBe(true);
    expect(first.upgraded.some((u) => u.includes('linked') && u.includes('.claude-followme-b'))).toBe(true);
    expect(fs.readFileSync(path.join(owned(), 'kept.md'), 'utf8')).toBe('kept');
    const second = run();
    expect(second).toEqual({ upgraded: [], skipped: [], errors: [] });
  });

  it('CLAUDE.md migration rewrites the old per-machine auto-memory line, once', () => {
    const oldLine = "2. **`~/.claude/projects/<project-path>/memory/MEMORY.md`** — Claude Code's auto-memory. Claude Code writes here automatically based on conversation patterns. It's per-machine, not synced by Instar, and you don't control what goes in it.";
    fs.writeFileSync(path.join(agentHome, 'CLAUDE.md'), `# Agent\n\n${oldLine}\n`);
    const migrator = new PostUpdateMigrator({ projectDir: agentHome, stateDir: path.join(agentHome, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
    const run = () => {
      const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
      (migrator as unknown as { migrateClaudeMd(r: typeof result): void }).migrateClaudeMd(result);
      return result;
    };
    expect(run().upgraded).toContain('CLAUDE.md: auto-memory is agent-owned, not per login');
    const content = fs.readFileSync(path.join(agentHome, 'CLAUDE.md'), 'utf8');
    expect(content).not.toContain("It's per-machine, not synced by Instar");
    expect(content).toContain('a link to `.instar/agent-memory/`');
    expect(run().upgraded).not.toContain('CLAUDE.md: auto-memory is agent-owned, not per login');
  });
});

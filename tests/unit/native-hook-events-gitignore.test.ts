// safe-git-allow: test fixture builds a throwaway git repo in a tmpdir to exercise ignore + untrack behaviour
/**
 * Native hook events — hook telemetry kept out of git
 * (docs/specs/native-hook-events.md D1).
 *
 * Acceptance criterion 5c (git half): after the migration `git check-ignore`
 * succeeds for both directories and a previously tracked hook-events file is
 * untracked — in an agent home whose commits instar's git sync makes. In a
 * project-bound agent (the user's own repository) only the ignore line is
 * added and the tracked file is left, with a notice. Idempotent.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

function home(agentType: 'standalone' | 'project-bound') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-hooks-git-'));
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(path.join(stateDir, 'hook-events'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'subagent-tracking'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 't', port: 4040, agentType }));
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(stateDir, 'hook-events', 'c1.jsonl'), '{"receivedAt":"x","payload":{"event":"Stop"}}\n');
  fs.writeFileSync(path.join(stateDir, 'subagent-tracking', 'c1.jsonl'), '{}\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe', env: ENV }).toString();
  git('init', '-q');
  git('add', '.gitignore', '.instar/hook-events/c1.jsonl');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  const migrate = () => {
    const m = new PostUpdateMigrator({ projectDir: root, stateDir, port: 4040, hasTelegram: false, projectName: 't' });
    const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
    (m as unknown as { migrateHookTelemetryGitignore(r: unknown): void }).migrateHookTelemetryGitignore(result);
    return result;
  };
  const ignored = (rel: string) => {
    try { git('check-ignore', '-q', rel); return true; } catch { return false; }
  };
  return { root, git, migrate, ignored };
}

describe('hook telemetry gitignore migration', () => {
  it('standalone agent home: both dirs ignored, the tracked file untracked (working copy kept), idempotent', () => {
    const h = home('standalone');
    expect(h.git('ls-files', '.instar/hook-events').trim()).toBe('.instar/hook-events/c1.jsonl');
    const r = h.migrate();
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
    expect(h.ignored('.instar/hook-events/new.jsonl')).toBe(true);
    expect(h.ignored('.instar/subagent-tracking/new.jsonl')).toBe(true);
    expect(h.git('ls-files', '.instar/hook-events').trim()).toBe('');
    expect(fs.existsSync(path.join(h.root, '.instar', 'hook-events', 'c1.jsonl'))).toBe(true);
    const gi = fs.readFileSync(path.join(h.root, '.gitignore'), 'utf8');
    const r2 = h.migrate();
    expect(fs.readFileSync(path.join(h.root, '.gitignore'), 'utf8')).toBe(gi);
    expect(r2.upgraded).toEqual([]);
  });

  it('project-bound agent (the user\'s own repo): ignore lines added, tracked file left tracked with a notice', () => {
    const h = home('project-bound');
    const r = h.migrate();
    expect(h.ignored('.instar/hook-events/new.jsonl')).toBe(true);
    expect(h.ignored('.instar/subagent-tracking/x.jsonl')).toBe(true);
    expect(h.git('ls-files', '.instar/hook-events').trim()).toBe('.instar/hook-events/c1.jsonl');
    expect(r.skipped.some(s => s.includes('left tracked'))).toBe(true);
    // Nothing staged in the user's repository.
    expect(h.git('diff', '--cached', '--name-only').trim()).toBe('');
  });
});

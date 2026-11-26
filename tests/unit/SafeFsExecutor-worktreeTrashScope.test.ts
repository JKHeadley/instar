/**
 * The worktree trash carve-out (docs/specs/reaper-removal-out-of-process.md §2).
 * Every test runs from a home path that itself contains `/.instar/`, as the real
 * agent home does (`~/.instar/agents/<name>/`), so the broad `.instar/`
 * runtime-state carve-out cannot make a refusal test pass by accident.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SafeFsExecutor,
  WorktreeTrashScopeError,
  canonicalizeLeafPath,
  decideWorktreeTrashScope,
  type WorktreeTrashScope,
} from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/SafeFsExecutor-worktreeTrashScope.test.ts';

describe('SafeFsExecutor worktreeTrashScope', () => {
  let root: string;
  let home: string;
  let worktrees: string;
  let trash: string;
  let auditDir: string;
  const scope = (allowedSources: string[] = []): WorktreeTrashScope => ({ worktreesDir: worktrees, trashRoot: trash, allowedSources });

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trash-scope-')));
    home = path.join(root, '.instar', 'agents', 'echo');
    worktrees = path.join(home, '.worktrees');
    trash = path.join(worktrees, '.trash');
    fs.mkdirSync(trash, { recursive: true });
    auditDir = path.join(root, 'audit');
    process.env.INSTAR_AUDIT_LOG_DIR = auditDir;
  });
  afterEach(() => {
    delete process.env.INSTAR_AUDIT_LOG_DIR;
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: OP });
  });

  const auditLines = (): Array<Record<string, unknown>> => {
    try { return fs.readFileSync(path.join(auditDir, 'destructive-ops.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
    catch { return []; }
  };

  it('the test home path contains /.instar/ (so the broad carve-out would allow anything here)', () => {
    expect(home.includes(`${path.sep}.instar${path.sep}`)).toBe(true);
  });

  describe('decides alone, ahead of the runtime-state carve-out', () => {
    it('a delete outside the trash root is refused even though the path contains /.instar/', () => {
      const live = path.join(worktrees, 'live');
      fs.mkdirSync(live);
      expect(() => SafeFsExecutor.safeRmSync(live, { recursive: true, force: true, operation: OP, worktreeTrashScope: scope() }))
        .toThrow(WorktreeTrashScopeError);
      expect(fs.existsSync(live)).toBe(true);
      const denied = auditLines().filter((l) => l.outcome === 'denied');
      expect(String(denied.at(-1)?.reason)).toMatch(/worktree-trash-scope:trash/);
    });

    it('without the option, the same path is allowed by the runtime-state carve-out (the hole the option must not fall through to)', () => {
      const live = path.join(worktrees, 'other');
      fs.mkdirSync(live);
      SafeFsExecutor.safeRmSync(live, { recursive: true, force: true, operation: OP });
      expect(fs.existsSync(live)).toBe(false);
      expect(auditLines().some((l) => l.reason === 'agent-runtime-state-carveout')).toBe(true);
    });

    it('the trash root itself is not strictly inside itself: refused', () => {
      expect(decideWorktreeTrashScope(trash, scope(), 'trash')).toMatchObject({ ok: false });
    });

    it('a folder strictly inside the trash root is allowed', () => {
      const t = path.join(trash, 'abc');
      fs.mkdirSync(t);
      expect(decideWorktreeTrashScope(t, scope(), 'trash')).toEqual({ ok: true, canonical: t });
    });

    it('a symlinked trash root is refused', () => {
      SafeFsExecutor.safeRmSync(trash, { recursive: true, force: true, operation: OP });
      const elsewhere = path.join(root, 'elsewhere');
      fs.mkdirSync(elsewhere);
      fs.symlinkSync(elsewhere, trash);
      fs.mkdirSync(path.join(elsewhere, 'x'));
      const v = decideWorktreeTrashScope(path.join(trash, 'x'), scope(), 'trash');
      expect(v.ok).toBe(false);
      expect((v as { reason: string }).reason).toMatch(/symlink/);
    });

    it('a trash root that is not directly inside the worktrees folder is refused', () => {
      const other = path.join(home, 'not-trash');
      fs.mkdirSync(other);
      fs.mkdirSync(path.join(other, 'x'));
      expect(decideWorktreeTrashScope(path.join(other, 'x'), { worktreesDir: worktrees, trashRoot: other }, 'trash').ok).toBe(false);
    });

    it('`..` escapes and a symlink inside the trash pointing out are refused', () => {
      expect(decideWorktreeTrashScope(path.join(trash, 'a', '..'), scope(), 'trash').ok).toBe(false);
      expect(decideWorktreeTrashScope(`${trash}/../live`, scope(), 'trash').ok).toBe(false);
      expect(decideWorktreeTrashScope(path.join(trash, '.'), scope(), 'trash').ok).toBe(false);
    });
  });

  describe('canonicalizeLeafPath', () => {
    it('a missing target is realpath(parent) + basename; a symlinked parent resolves', () => {
      const realParent = path.join(root, 'real');
      fs.mkdirSync(realParent);
      fs.symlinkSync(realParent, path.join(root, 'link'));
      expect(canonicalizeLeafPath(path.join(root, 'link', 'missing'))).toBe(path.join(realParent, 'missing'));
    });
    it('refuses `.` and `..` as the last name', () => {
      expect(() => canonicalizeLeafPath(`${root}/.`)).toThrow();
      expect(() => canonicalizeLeafPath(`${root}/..`)).toThrow();
    });
  });

  describe('safeRenameDirSync', () => {
    it('renames an allowed direct child of the worktrees folder into the trash', () => {
      const src = path.join(worktrees, 'wt1');
      fs.mkdirSync(src);
      fs.writeFileSync(path.join(src, 'f'), 'x');
      const dest = path.join(trash, 'attempt-1');
      SafeFsExecutor.safeRenameDirSync(src, dest, { operation: OP, worktreeTrashScope: scope([src]) });
      expect(fs.existsSync(src)).toBe(false);
      expect(fs.readFileSync(path.join(dest, 'f'), 'utf8')).toBe('x');
    });

    it('a source not in allowedSources is refused, untouched', () => {
      const src = path.join(worktrees, 'wt2');
      fs.mkdirSync(src);
      expect(() => SafeFsExecutor.safeRenameDirSync(src, path.join(trash, 'a'), { operation: OP, worktreeTrashScope: scope([]) })).toThrow(WorktreeTrashScopeError);
      expect(fs.existsSync(src)).toBe(true);
    });

    it('a source deeper than a direct child, `.trash` itself, or a symlink is refused', () => {
      const deep = path.join(worktrees, 'wt3', 'sub');
      fs.mkdirSync(deep, { recursive: true });
      expect(() => SafeFsExecutor.safeRenameDirSync(deep, path.join(trash, 'a'), { operation: OP, worktreeTrashScope: scope([deep]) })).toThrow(/direct child/);
      expect(() => SafeFsExecutor.safeRenameDirSync(trash, path.join(trash, 'a'), { operation: OP, worktreeTrashScope: scope([trash]) })).toThrow(WorktreeTrashScopeError);
      const target = path.join(root, 'live-target');
      fs.mkdirSync(target);
      const link = path.join(worktrees, 'linked');
      fs.symlinkSync(target, link);
      expect(() => SafeFsExecutor.safeRenameDirSync(link, path.join(trash, 'b'), { operation: OP, worktreeTrashScope: scope([link]) })).toThrow(/real folder/);
      expect(fs.existsSync(target)).toBe(true);
    });

    it('a destination outside the trash root, or one that exists, is refused', () => {
      const src = path.join(worktrees, 'wt4');
      fs.mkdirSync(src);
      expect(() => SafeFsExecutor.safeRenameDirSync(src, path.join(worktrees, 'elsewhere'), { operation: OP, worktreeTrashScope: scope([src]) })).toThrow(/strictly inside/);
      fs.mkdirSync(path.join(trash, 'taken'));
      expect(() => SafeFsExecutor.safeRenameDirSync(src, path.join(trash, 'taken'), { operation: OP, worktreeTrashScope: scope([src]) })).toThrow(/already exists/);
      expect(fs.existsSync(src)).toBe(true);
    });

    it('requires the scope option', () => {
      const src = path.join(worktrees, 'wt5');
      fs.mkdirSync(src);
      expect(() => SafeFsExecutor.safeRenameDirSync(src, path.join(trash, 'a'), { operation: OP } as never)).toThrow(WorktreeTrashScopeError);
    });
  });

  describe('safeRmTreeInSubprocess', () => {
    it('a symlink to a live folder inside the trash is removed as a link; the live folder survives', async () => {
      const live = path.join(home, 'node_modules-live');
      fs.mkdirSync(path.join(live, 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(live, 'pkg', 'index.js'), 'live');
      const t = path.join(trash, 'attempt-sym');
      fs.mkdirSync(path.join(t, 'deep'), { recursive: true });
      fs.symlinkSync(live, path.join(t, 'node_modules'));
      fs.symlinkSync(live, path.join(t, 'deep', 'link'));
      fs.writeFileSync(path.join(t, 'deep', 'file'), 'x');
      fs.chmodSync(path.join(t, 'deep', 'file'), 0o444);
      const r = await SafeFsExecutor.safeRmTreeInSubprocess(t, { operation: OP, worktreeTrashScope: scope(), timeoutMs: 30_000 });
      expect(r.ok).toBe(true);
      expect(fs.existsSync(t)).toBe(false);
      expect(fs.readFileSync(path.join(live, 'pkg', 'index.js'), 'utf8')).toBe('live');
      const outcome = auditLines().filter((l) => l.verb === 'safeRmTreeInSubprocess');
      expect(outcome.map((l) => l.outcome)).toEqual(['allowed', 'allowed']); // guard row, then exit row
    });

    it('a target outside the trash throws before any process starts', () => {
      const live = path.join(worktrees, 'live2');
      fs.mkdirSync(live);
      expect(() => SafeFsExecutor.safeRmTreeInSubprocess(live, { operation: OP, worktreeTrashScope: scope(), timeoutMs: 1_000 })).toThrow(WorktreeTrashScopeError);
      expect(fs.existsSync(live)).toBe(true);
    });

    it('a missing trash folder is a no-op success', async () => {
      const r = await SafeFsExecutor.safeRmTreeInSubprocess(path.join(trash, 'gone'), { operation: OP, worktreeTrashScope: scope(), timeoutMs: 5_000 });
      expect(r.ok).toBe(true);
    });
  });
});

/**
 * Git/fs-backed signal sources + side-effects for the OrphanedWorkSentinel.
 * Kept separate from the classifier so the sentinel stays unit-testable with
 * fakes. Reuses the AgentWorktreeReaper's git helpers (listWorktrees / isClean /
 * isInUse) so worktree discovery + process-cwd liveness have ONE implementation.
 *
 * All git queries are read-only (SafeGitExecutor.readSync). "Preservation" is a
 * NON-destructive patch write (git diff → a file under the state dir): it never
 * mutates the worktree, its index, or any ref — the stranded work stays exactly
 * where it is (this sentinel never removes a worktree), and the patch is belt-
 * and-suspenders insurance against a LATER reaper.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SafeGitExecutor } from '../core/SafeGitExecutor.js';
import { makeAgentWorktreeReaperDeps, type ReadGit } from './agentWorktreeGit.js';
import type {
  OrphanedWorkSentinelDeps,
  OrphanedWorktreeInfo,
  OrphanedWorkEvent,
} from './OrphanedWorkSentinel.js';

const readGitOpts = (cwd: string) => ({
  cwd,
  encoding: 'utf-8' as const,
  timeout: 30_000,
  operation: 'src/monitoring/orphanedWorkGit.ts',
  // The agent home is a checkout of the instar source tree, so reads trip the
  // SourceTreeGuard without these. readSync still rejects any destructive shape.
  sourceTreeReadOk: true,
  sourceTreeWorktreeManagerOk: true,
});

const defaultReadGit: ReadGit = (args, cwd) => SafeGitExecutor.readSync(args, readGitOpts(cwd));

/**
 * Build the production deps for the OrphanedWorkSentinel.
 *
 * @param opts.raiseAttention injected by the server wiring (needs the attention
 *   store); called with the durable event for ONE deduped attention item.
 */
export function makeOrphanedWorkSentinelDeps(opts: {
  instarRepo: string;
  worktreesDir: string;
  stateDir: string;
  raiseAttention: (event: OrphanedWorkEvent) => void;
  readGit?: ReadGit;
  cwdRoots?: () => Set<string>;
  now?: () => number;
}): OrphanedWorkSentinelDeps {
  const readGit = opts.readGit ?? defaultReadGit;
  // Reuse the reaper's git helpers for the shared signals (one implementation).
  const base = makeAgentWorktreeReaperDeps({
    instarRepo: opts.instarRepo,
    worktreesDir: opts.worktreesDir,
    readGit,
    cwdRoots: opts.cwdRoots,
    now: opts.now,
  });

  const eventsLog = path.join(opts.stateDir, 'orphaned-work.jsonl');
  const patchesDir = path.join(opts.stateDir, 'orphaned-work-patches');

  const porcelain = (p: string): string => {
    try { return readGit(['-C', p, 'status', '--porcelain'], p); }
    catch { /* @silent-fallback-ok: best-effort porcelain ENRICHMENT for the captured detail/patch — the orphaned-work DETECTION itself runs through base.isClean()/hasUncommittedWork, never this helper; a failed status read just omits the detailed listing, it can never suppress a detection */ return ''; }
  };

  const slug = (p: string): string => path.basename(p).replace(/[^a-z0-9-]+/gi, '-');

  return {
    listWorktrees: (): OrphanedWorktreeInfo[] => base.listWorktrees(),

    hasUncommittedWork: (p: string): boolean => !base.isClean(p),

    isInUse: (p: string): boolean => base.isInUse(p),

    workSignature: (p: string): string => {
      // Content-sensitive: the dirty file SET (porcelain) plus the tracked diff,
      // so re-stranded work that GREW (new edits, not just the same files) gets a
      // new signature and re-surfaces, while an unchanged frozen state dedupes.
      let diff = '';
      try { diff = readGit(['-C', p, 'diff', 'HEAD'], p); } catch { /* best-effort */ }
      return crypto.createHash('sha256').update(porcelain(p) + '\x00' + diff).digest('hex').slice(0, 12);
    },

    lastActivityMs: (p: string): number | null => {
      // Newest mtime among the DIRTY files + the index — bounded by the number of
      // changed files (cheap), and exactly the set whose recency tells us whether
      // the work is still being actively written.
      let newest = 0;
      const consider = (abs: string) => {
        try { const m = fs.statSync(abs).mtimeMs; if (m > newest) newest = m; }
        catch { /* missing/unreadable → ignore */ }
      };
      consider(path.join(p, '.git', 'index'));
      for (const line of porcelain(p).split('\n')) {
        const rel = line.slice(3).trim(); // strip the 2-char status + space
        if (!rel) continue;
        // Rename lines look like "old -> new"; stat the new path.
        const file = rel.includes(' -> ') ? rel.split(' -> ')[1] : rel;
        consider(path.join(p, file));
      }
      return newest > 0 ? newest : null;
    },

    preserve: (info: OrphanedWorktreeInfo): void => {
      // NON-destructive: capture the tracked diff (read-only) + the untracked
      // file list to a durable patch under the state dir. Never touches the
      // worktree, its index, or any ref.
      fs.mkdirSync(patchesDir, { recursive: true });
      const diff = readGit(['-C', info.path, 'diff', 'HEAD'], info.path);
      const untracked = readGit(['-C', info.path, 'ls-files', '--others', '--exclude-standard'], info.path);
      const stamp = String(opts.now ? opts.now() : Date.now());
      const file = path.join(patchesDir, `${slug(info.path)}-${stamp}.patch`);
      const header =
        `# Orphaned-work preservation patch\n` +
        `# worktree: ${info.path}\n` +
        `# branch: ${info.branch ?? '(detached)'}\n` +
        `# head: ${info.headSha}\n` +
        `# untracked files (NOT in the diff below):\n` +
        untracked.split('\n').filter(Boolean).map((u) => `#   ${u}`).join('\n') +
        `\n# --- tracked diff (git apply this) ---\n`;
      fs.writeFileSync(file, header + diff, 'utf-8');
    },

    record: (event: OrphanedWorkEvent): void => {
      try {
        fs.mkdirSync(opts.stateDir, { recursive: true });
        fs.appendFileSync(eventsLog, JSON.stringify(event) + '\n', 'utf-8');
      } catch { /* recording is best-effort; never throw the scan pass */ }
    },

    raiseAttention: opts.raiseAttention,

    now: opts.now,
  };
}

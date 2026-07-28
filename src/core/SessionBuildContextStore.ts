import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { StateManager } from './StateManager.js';
import { sessionBuildContextKeyFor } from './WriteDomainRegistry.js';

/**
 * LEGACY shared kv key (pre standby-write-reconciliation §3.3). The store is
 * now re-keyed PER MACHINE (`session-build-context-<machineId>`, machine id
 * from the coordinator/mesh identity, literal 'local' on identity-less
 * installs) so each machine reads/writes ONLY its own key — single writer per
 * file, no recurring git-sync merge conflicts. This legacy key is left INERT
 * (entries self-drain via the 6h max age) and removed by a one-time cleanup on
 * the lease holder — never migrated.
 */
export const LEGACY_BUILD_CONTEXT_STATE_KEY = 'session-build-context';
export const DEFAULT_BUILD_CONTEXT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface SessionBuildContextEntry {
  spawnCwd: string;
  currentCwd: string;
  branch?: string;
  updatedAt: number;
}

export type SessionBuildContextState = Record<string, SessionBuildContextEntry>;

export interface SessionBuildContextRestore {
  entry: SessionBuildContextEntry;
  note: string;
}

export function isEligibleBuildContextCwd(spawnCwd: string, currentCwd: string): boolean {
  if (!spawnCwd || !currentCwd) return false;
  const spawn = path.resolve(spawnCwd);
  const current = path.resolve(currentCwd);
  if (spawn === current) return false;
  return current.split(path.sep).includes('.worktrees');
}

export function formatBuildContextRestoreNote(entry: SessionBuildContextEntry): string {
  const branchLine = entry.branch ? `  branch:   ${entry.branch}\n` : '';
  return [
    '[BUILD-CONTEXT RESTORE] Before this restart you were building in:',
    `  worktree: ${entry.currentCwd}`,
    branchLine ? branchLine.trimEnd() : null,
    `Your shell is back in ${entry.spawnCwd} after the restart — cd ${entry.currentCwd} before continuing your build.`,
    'Do NOT start over in agent-home; your work is in that worktree.',
  ].filter((line): line is string => line != null).join('\n');
}

export class SessionBuildContextStore {
  constructor(
    private readonly state: StateManager,
    private readonly opts: {
      now?: () => number;
      execFileSync?: typeof execFileSync;
      maxAgeMs?: number;
      /**
       * Coordinator/mesh identity machine id (standby-write-reconciliation
       * §3.3 round-2 L3: NEVER StateManager._machineId — that setter has no
       * production caller). May be a getter because the mesh identity resolves
       * AFTER SessionManager construction. null/absent ⇒ the literal 'local'
       * (single-machine installs: no peers ⇒ no second writer ⇒ no fork).
       */
      machineId?: string | null | (() => string | null);
    } = {},
  ) {}

  /** The per-machine kv key (charset-jailed so validateKey always passes). */
  stateKey(): string {
    const raw = typeof this.opts.machineId === 'function' ? this.opts.machineId() : this.opts.machineId;
    return sessionBuildContextKeyFor(raw ?? null);
  }

  record(tmuxSession: string, spawnCwd: string, currentCwd: string): void {
    const now = this.now();
    const all = this.readAll();
    const prior = all[tmuxSession];
    const normalizedSpawn = path.resolve(spawnCwd);
    const normalizedCurrent = path.resolve(currentCwd);

    if (prior?.spawnCwd === normalizedSpawn && prior.currentCwd === normalizedCurrent) {
      return;
    }

    const branch = this.readBranch(normalizedCurrent);
    all[tmuxSession] = {
      spawnCwd: normalizedSpawn,
      currentCwd: normalizedCurrent,
      ...(branch ? { branch } : {}),
      updatedAt: now,
    };
    this.writeAll(all);
  }

  getRestore(tmuxSession: string): SessionBuildContextRestore | null {
    const entry = this.readAll()[tmuxSession];
    if (!entry) return null;
    if (!isEligibleBuildContextCwd(entry.spawnCwd, entry.currentCwd)) return null;
    if (this.now() - entry.updatedAt > this.maxAgeMs()) return null;
    if (!fs.existsSync(entry.currentCwd)) return null;
    return { entry, note: formatBuildContextRestoreNote(entry) };
  }

  readAll(): SessionBuildContextState {
    // Build-context restore is inherently machine-local (the recorded worktree
    // path is on THIS disk), so reads never need peers' keys (§3.3).
    const raw = this.state.get<unknown>(this.stateKey());
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: SessionBuildContextState = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const entry = value as Partial<SessionBuildContextEntry>;
      if (
        typeof entry.spawnCwd !== 'string'
        || typeof entry.currentCwd !== 'string'
        || typeof entry.updatedAt !== 'number'
      ) continue;
      out[key] = {
        spawnCwd: entry.spawnCwd,
        currentCwd: entry.currentCwd,
        ...(typeof entry.branch === 'string' && entry.branch.trim() ? { branch: entry.branch } : {}),
        updatedAt: entry.updatedAt,
      };
    }
    return out;
  }

  private writeAll(state: SessionBuildContextState): void {
    this.state.set(this.stateKey(), state);
  }

  private readBranch(cwd: string): string | null {
    if (!fs.existsSync(cwd)) return null;
    try {
      const out = (this.opts.execFileSync ?? execFileSync)(
        'git',
        ['-C', cwd, 'branch', '--show-current'],
        { encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const branch = String(out).trim();
      return branch || null;
    } catch {
      // @silent-fallback-ok — branch name is best-effort enrichment; cwd restore still works without it.
      return null;
    }
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private maxAgeMs(): number {
    return this.opts.maxAgeMs ?? DEFAULT_BUILD_CONTEXT_MAX_AGE_MS;
  }
}

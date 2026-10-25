import fs from 'node:fs';
import { SafeGitExecutor, SafeGitExecutorError } from './SafeGitExecutor.js';
import { SourceTreeGuardError } from './SourceTreeGuard.js';

export type LeaseMedium = 'git' | 'local' | 'unchecked';
export type LeaseMediumReason =
  | 'no-git-sync-manager'
  | 'switch-off'
  | 'tracked'
  | 'untracked-addable'
  | 'ignored'
  | `check-error:${string}`;

export interface LeaseMediumSelection {
  medium: LeaseMedium;
  reason: LeaseMediumReason;
}

type GitRead = (args: readonly string[], opts: { cwd: string; timeout: number; operation: string }) => string;

export interface SelectLeaseMediumOptions {
  projectDir: string;
  registryAbsPath: string;
  hasGitSyncManager: boolean;
  mediumCheckEnabled?: boolean;
  readGit?: GitRead;
  exists?: (filePath: string) => boolean;
}

export interface LeaseMediumReporter {
  report(event: { feature: string; primary: string; fallback: string; reason: string; impact: string; internalOnly?: boolean }): void;
}

export function reportLeaseMediumSelection(
  selection: LeaseMediumSelection,
  registeredPeerCount: number,
  reporter: LeaseMediumReporter,
  log: (message: string) => void = () => {},
): void {
  if (selection.reason === 'ignored') {
    const message = 'registry.json is git-ignored, so the lease uses the local store plus the network (a supported mode); tracking the file and restarting would move it to git.';
    if (registeredPeerCount === 0) {
      log(message);
      return;
    }
    reporter.report({
      feature: 'multiMachine.leaseMedium',
      primary: 'git can carry the multi-machine lease registry',
      fallback: 'LocalLeaseStore plus the authenticated network lease transport',
      reason: message,
      impact: 'lease durability is local; tracking registry.json and restarting moves the lease to git',
      internalOnly: true,
    });
  } else if (selection.reason.startsWith('check-error:')) {
    reporter.report({
      feature: 'multiMachine.leaseMedium',
      primary: 'verify whether git can carry registry.json',
      fallback: 'GitLeaseStore (today\'s behavior)',
      reason: `${selection.reason.slice('check-error:'.length)} while checking registry.json; will be re-checked at the next restart`,
      impact: 'the lease remains on git because the medium check was inconclusive',
      internalOnly: true,
    });
  }
}

function checkErrorKind(err: unknown): string {
  if (err instanceof SafeGitExecutorError || err instanceof SourceTreeGuardError) return 'refused';
  const shaped = err as { code?: unknown; status?: unknown; signal?: unknown } | null;
  if (shaped?.code === 'ETIMEDOUT') return 'timeout';
  if (typeof shaped?.status === 'number' && shaped.status !== 1) return `git-exit-${shaped.status}`;
  if (shaped?.signal != null) return `signal-${String(shaped.signal)}`;
  return 'spawn-error';
}

/** Resolve the lease medium once at boot. Check errors deliberately preserve today's git store. */
export function selectLeaseMedium(options: SelectLeaseMediumOptions): LeaseMediumSelection {
  if (!options.hasGitSyncManager) return { medium: 'local', reason: 'no-git-sync-manager' };
  if (options.mediumCheckEnabled === false) return { medium: 'unchecked', reason: 'switch-off' };
  const exists = options.exists ?? fs.existsSync;
  if (!exists(options.registryAbsPath)) return { medium: 'git', reason: 'check-error:registry-missing' };
  const readGit = options.readGit ?? ((args, opts) => SafeGitExecutor.readSync(args, opts));
  const readOptions = {
    cwd: options.projectDir,
    timeout: 2_000,
    operation: 'lease-medium-selection',
  };
  try {
    readGit(['ls-files', '--error-unmatch', '--', options.registryAbsPath], readOptions);
    return { medium: 'git', reason: 'tracked' };
  } catch (err) {
    if ((err as { status?: unknown } | null)?.status !== 1) {
      return { medium: 'git', reason: `check-error:${checkErrorKind(err)}` };
    }
  }
  try {
    const ignored = readGit(
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--', options.registryAbsPath],
      readOptions,
    );
    return ignored.trim()
      ? { medium: 'local', reason: 'ignored' }
      : { medium: 'git', reason: 'untracked-addable' };
  } catch (err) {
    return { medium: 'git', reason: `check-error:${checkErrorKind(err)}` };
  }
}

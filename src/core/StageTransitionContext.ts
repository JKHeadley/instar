/**
 * The single production assembly point for StageTransitionValidator evidence.
 *
 * Keeping all dependencies here prevents a route from remembering one helper
 * while silently omitting the next. Spec files, convergence reports, and merge
 * commits all resolve against `canonicalMainRef`; the working checkout is only
 * the local git object store and may be on any branch.
 */

import { execFileSync } from 'node:child_process';
import { SafeGitExecutor } from './SafeGitExecutor.js';
import { withSyncOp } from './InFlightSyncOpMarker.js';
import { resolveGhBinary } from './resolveGhBinary.js';
import {
  StageTransitionWiringError,
  type GhPrView,
  type ValidationContext,
} from './StageTransitionValidator.js';

export interface StageTransitionArtifactInput {
  specPath?: unknown;
  prNumber?: unknown;
  taskFlowRecordId?: unknown;
  skippedReason?: unknown;
  skippedBy?: unknown;
  unskippedAt?: unknown;
}

export interface ProductionStageTransitionContextInput {
  targetRepoPath: string;
  artifact: StageTransitionArtifactInput;
}

export interface ProductionStageTransitionContextDependencies {
  /** Test seam. Production resolves one live canonical-main snapshot lazily. */
  resolveCanonicalMainSnapshot?: (repoPath: string) => string;
}

export function createProductionStageTransitionContext(
  input: ProductionStageTransitionContextInput,
  dependencies: ProductionStageTransitionContextDependencies = {},
): ValidationContext {
  if (!input.targetRepoPath) {
    throw new StageTransitionWiringError('targetRepoPath is required');
  }

  const { artifact } = input;
  let canonicalMainSnapshot: string | undefined;
  const context: ValidationContext = {
    targetRepoPath: input.targetRepoPath,
    resolveCanonicalMainRef: () => {
      if (canonicalMainSnapshot) return canonicalMainSnapshot;
      canonicalMainSnapshot = (
        dependencies.resolveCanonicalMainSnapshot ?? resolveCanonicalMainSnapshot
      )(input.targetRepoPath);
      return canonicalMainSnapshot;
    },
    specPath: typeof artifact.specPath === 'string' ? artifact.specPath : undefined,
    prNumber: typeof artifact.prNumber === 'number' ? artifact.prNumber : undefined,
    taskFlowRecordId: typeof artifact.taskFlowRecordId === 'string' ? artifact.taskFlowRecordId : undefined,
    skippedReason: typeof artifact.skippedReason === 'string' ? artifact.skippedReason : undefined,
    skippedBy: typeof artifact.skippedBy === 'string' ? artifact.skippedBy : undefined,
    unskippedAt: typeof artifact.unskippedAt === 'string' ? artifact.unskippedAt : undefined,
    readRepositoryArtifact: async (ref, repoRelativePath) =>
      readRegularFileAtRef(input.targetRepoPath, ref, repoRelativePath),
    ghPrView: async (prNumber) => {
      const ghBin = resolveGhBinary();
      if (!ghBin) {
        throw new Error(
          'the GitHub CLI (gh) could not be found. The server may be running with a ' +
          'minimal PATH; set INSTAR_GH_PATH to its absolute path. The merge cannot be ' +
          'verified without it, so this transition is refused rather than assumed.',
        );
      }
      const out = withSyncOp(() => execFileSync(
        ghBin,
        ['pr', 'view', String(prNumber), '--json', 'state,mergeCommit,statusCheckRollup'],
        { cwd: input.targetRepoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
      ));
      return JSON.parse(out) as GhPrView;
    },
    gitMergeBaseIsAncestor: (sha, branch) => {
      try {
        SafeGitExecutor.readSync(['merge-base', '--is-ancestor', sha, branch], {
          cwd: input.targetRepoPath,
          operation: 'projects.advance.mergeBaseIsAncestor',
          stdio: ['ignore', 'ignore', 'ignore'],
          sourceTreeReadOk: true,
        });
        return true;
      } catch (err) {
        const status = (err as { status?: unknown }).status;
        if (status === 1) return false;
        throw new Error(
          `merge-base --is-ancestor could not be verified (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    },
  };

  assertCompleteStageTransitionContext(context);
  return context;
}

export function assertCompleteStageTransitionContext(ctx: ValidationContext): void {
  const missing: string[] = [];
  if (!ctx.canonicalMainRef?.trim() && typeof ctx.resolveCanonicalMainRef !== 'function') {
    missing.push('canonicalMainRef/resolveCanonicalMainRef');
  }
  if (typeof ctx.readRepositoryArtifact !== 'function') missing.push('readRepositoryArtifact');
  if (typeof ctx.ghPrView !== 'function') missing.push('ghPrView');
  if (typeof ctx.gitMergeBaseIsAncestor !== 'function') missing.push('gitMergeBaseIsAncestor');
  if (missing.length > 0) {
    throw new StageTransitionWiringError(`incomplete validator context: ${missing.join(', ')}`);
  }
}

/**
 * Resolve the live canonical main branch to one immutable commit OID.
 *
 * The remote identity comes from GitHub (using the absolute-path resolver that
 * works under launchd). Forks resolve to their parent repository. `ls-remote`
 * then establishes the current remote head without mutating local refs. The
 * returned OID is immutable, so spec and report reads within one request cannot
 * straddle two moving snapshots. Any failure throws and becomes an
 * unverifiable-evidence verdict at the validator boundary.
 */
function resolveCanonicalMainSnapshot(repoPath: string): string {
  const ghBin = resolveGhBinary();
  if (!ghBin) {
    throw new Error(
      'the GitHub CLI (gh) could not be found; canonical repository identity cannot be verified',
    );
  }

  const raw = withSyncOp(() => execFileSync(
    ghBin,
    ['repo', 'view', '--json', 'nameWithOwner,parent'],
    { cwd: repoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
  ));
  const repoView = JSON.parse(raw) as {
    nameWithOwner?: unknown;
    parent?: { nameWithOwner?: unknown } | null;
  };
  const canonicalRepo = typeof repoView.parent?.nameWithOwner === 'string'
    ? repoView.parent.nameWithOwner
    : repoView.nameWithOwner;
  if (typeof canonicalRepo !== 'string' || !canonicalRepo.trim()) {
    throw new Error('GitHub did not return a canonical repository identity');
  }

  const remotes = SafeGitExecutor.readSync(['remote', '-v'], {
    cwd: repoPath,
    operation: 'projects.advance.resolveCanonicalRemote',
    sourceTreeReadOk: true,
  });
  const candidates: string[] = [];
  for (const line of remotes.split('\n')) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (!match) continue;
    const [, name, url] = match;
    if (githubRepositoryFromRemote(url) === canonicalRepo.toLowerCase()) candidates.push(name);
  }
  if (candidates.length === 0) {
    throw new Error(`no git remote matches canonical repository ${canonicalRepo}`);
  }
  const remote = candidates.includes('upstream')
    ? 'upstream'
    : candidates.includes('origin')
      ? 'origin'
      : candidates[0];

  const remoteHead = SafeGitExecutor.readSync(
    ['ls-remote', '--exit-code', remote, 'refs/heads/main'],
    {
      cwd: repoPath,
      operation: 'projects.advance.resolveCanonicalMainSnapshot',
      sourceTreeReadOk: true,
      maxBuffer: 1024 * 1024,
    },
  ).trim();
  const headMatch = /^([0-9a-f]{40,64})\s+refs\/heads\/main$/i.exec(remoteHead);
  if (!headMatch) {
    throw new Error(`canonical repository ${canonicalRepo} has no unambiguous refs/heads/main`);
  }
  return headMatch[1];
}

function githubRepositoryFromRemote(remoteUrl: string): string | null {
  const match = /github\.com(?::|\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(remoteUrl);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

/** Read exactly one regular blob without consulting the working tree. */
function readRegularFileAtRef(repoPath: string, ref: string, repoRelativePath: string): string | null {
  const literalPathspec = `:(literal)${repoRelativePath}`;
  const tree = SafeGitExecutor.readSync(
    ['ls-tree', '-z', '--full-tree', ref, '--', literalPathspec],
    {
      cwd: repoPath,
      operation: 'projects.advance.repositoryArtifactTree',
      sourceTreeReadOk: true,
      maxBuffer: 1024 * 1024,
    },
  );
  if (!tree) return null;

  const records = tree.split('\0').filter(Boolean);
  if (records.length !== 1) {
    throw new Error(`expected one exact tree entry, got ${records.length}`);
  }
  const match = /^(\d+) ([^ ]+) ([0-9a-f]+)\t([\s\S]+)$/.exec(records[0]);
  if (!match) throw new Error('git ls-tree returned an unparseable entry');
  const [, mode, type, oid, returnedPath] = match;
  if (returnedPath !== repoRelativePath) {
    throw new Error(`git ls-tree returned unexpected path "${returnedPath}"`);
  }
  if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) {
    throw new Error(`repository artifact is not a regular file (mode ${mode}, type ${type})`);
  }

  return SafeGitExecutor.readSync(['cat-file', 'blob', oid], {
    cwd: repoPath,
    operation: 'projects.advance.repositoryArtifactBlob',
    sourceTreeReadOk: true,
    maxBuffer: 10 * 1024 * 1024,
  });
}

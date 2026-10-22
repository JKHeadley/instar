/**
 * Builds the LocalVerifyService for the agent server (spec
 * docs/specs/local-verify-merge-authority.md §2).
 *
 * Repo-gated like the green-PR watcher: constructed only when
 * `monitoring.localVerify.enabled` is true AND the server runs from an instar
 * source checkout. Otherwise null, and the routes answer 503. The verifier's own
 * code (this module, the orchestrator, the child entry) always comes from the
 * running server's install, never from the PR being verified.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createAuthenticatedGitHubCliRuntimeResolver } from '../core/githubRuntime.js';
import { PROTECTED_PATH_PREFIXES } from '../monitoring/greenPrAutomergeWiring.js';
import { LocalVerifyService, appendLocalVerifyAudit, type UpdatePendingState } from './LocalVerifyService.js';
import { computeVerifierVersion } from './verifierVersion.js';
import type { RestartHold } from '../core/UpdateGate.js';
import { buildDefaultServiceSeams, scrubbedEnv } from './serviceSeams.js';
import { realGit } from './orchestratorSeams.js';
import { verifyPaths } from './orchestrator.js';
import { FloorGate } from './floorGate.js';
import { StatusReconciler, type StatusReconcilerSeams } from './StatusReconciler.js';
import { buildFloorGateGitHubSeams, buildGhRunner, buildReconcilerGitHubSeams, type GhRunner } from './reconcilerSeams.js';
import type { LocalVerifyRecord } from './record.js';
import type { MainHealthSnapshot } from './mainHealth.js';
import type { ContextPin, EvaluateRequiredContexts, FloorMode } from './statusProjection.js';

export interface LocalVerifyConfigBlock {
  enabled?: boolean;
  operatorGhLogin?: string;
  /** Post `instar/local-verify` statuses for real (default false: dry-run, the posts are only audited). */
  postStatuses?: boolean;
}

/** Late-bound hooks: the service is built before the reconciler that consumes these. */
export interface LocalVerifyHooks {
  onRecord?(record: LocalVerifyRecord): void;
  onMainHealthChange?(snap: MainHealthSnapshot, prev: MainHealthSnapshot): void;
  signal?(key: string, detail: Record<string, unknown>): void;
}

export interface LocalVerifyWiringOpts {
  config: LocalVerifyConfigBlock | undefined;
  /** The green-PR block's `expectedGhLogin` (the agent's own GitHub login). */
  expectedGhLogin: string | undefined;
  repo: string;
  /** The server's working directory (the instar source checkout). */
  repoPath: string;
  /** The agent's `.instar` directory. */
  stateDir: string;
  /** The agent home (`.worktrees/.verify/` lives under it). */
  agentHome: string;
  machineId: string;
  onStarved?: (info: { pr: number; headSha: string; waitedMs: number }) => void;
  /** Override the child entry (tests running from source point at the built dist). */
  mainEntry?: string;
  hooks?: LocalVerifyHooks;
}

export type LocalVerifyWiringResult =
  | { service: LocalVerifyService; reason: null }
  | { service: null; reason: 'disabled' | 'no-source-checkout' | 'no-gh-login' | 'no-entry' };

/** The child entry installed next to this module (dist/localVerify/runVerifyMain.js). */
export function installedMainEntry(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'runVerifyMain.js');
}

export function buildLocalVerifyService(opts: LocalVerifyWiringOpts): LocalVerifyWiringResult {
  if (opts.config?.enabled !== true) return { service: null, reason: 'disabled' };
  if (!fs.existsSync(path.join(opts.repoPath, '.git')) || !fs.existsSync(path.join(opts.repoPath, 'scripts', 'safe-merge.mjs'))) {
    return { service: null, reason: 'no-source-checkout' };
  }
  const expected = (opts.expectedGhLogin ?? '').trim();
  if (!expected) return { service: null, reason: 'no-gh-login' };
  const mainEntry = opts.mainEntry ?? installedMainEntry();
  if (!fs.existsSync(mainEntry)) return { service: null, reason: 'no-entry' };

  const githubRuntime = createAuthenticatedGitHubCliRuntimeResolver({ stateDir: opts.stateDir });
  const seams = buildDefaultServiceSeams({
    repo: opts.repo,
    resolveGitHubEnv: () => {
      try { return githubRuntime().env; } catch { return null; } // @silent-fallback-ok — no explicit GitHub identity makes every request refuse as pr-unreadable
    },
  });
  const service = new LocalVerifyService(
    {
      repo: opts.repo,
      stateDir: opts.stateDir,
      agentHome: opts.agentHome,
      expectedGhLogin: expected,
      operatorGhLogin: opts.config.operatorGhLogin?.trim() || null,
      // A content hash of the installed verifier code, not the package version: a release
      // that leaves the verifier untouched keeps every green record.
      verifierVersion: computeVerifierVersion(path.dirname(mainEntry), undefined, { protectedList: PROTECTED_PATH_PREFIXES }),
      nodePath: process.execPath,
      mainEntry,
      remoteUrl: `https://github.com/${opts.repo}.git`,
      machineId: opts.machineId,
      nodeVersion: process.version,
      protectedList: PROTECTED_PATH_PREFIXES,
      baseEnv: scrubbedEnv(),
    },
    {
      ...seams,
      onStarved: opts.onStarved,
      onRecord: (r) => opts.hooks?.onRecord?.(r),
      onMainHealthChange: (snap, prev) => opts.hooks?.onMainHealthChange?.(snap, prev),
      signal: (k, d) => opts.hooks?.signal?.(k, d),
      isAncestor: (a, d) => isAncestorInBareClone(opts.agentHome, a, d),
    },
  );
  return { service, reason: null };
}

/** The narrow AutoUpdater surface the verifier uses. */
export interface LocalVerifyAutoUpdaterView {
  setRestartHold(key: string, provider: () => RestartHold[]): void;
  getStatus(): {
    maxDeferralHours?: number;
    config?: { autoApply?: boolean };
    pendingUpdate?: string | null;
    coalescingUntil?: string | null;
    pendingUpdateDetectedAt?: string | null;
  };
  /** What would hold a restart right now (sessions, then `hold:<name>` entries). */
  getRestartBlockers?(): string[];
}

/**
 * Spec §2 Restarts rule (b), read from the AutoUpdater: "update pending" means autoApply is
 * on and `pendingUpdate` is set or `coalescingUntil` holds a time (not the `'notified'`
 * placeholder), timed from `pendingUpdateDetectedAt`. `otherBlockers`: anything other than
 * this verifier's own hold would delay the restart anyway. Pure.
 */
export function updatePendingFromAutoUpdater(
  status: ReturnType<LocalVerifyAutoUpdaterView['getStatus']>,
  blockers: readonly string[] | null,
): UpdatePendingState {
  const coalescingIsTime = typeof status.coalescingUntil === 'string' && status.coalescingUntil !== 'notified'
    && Number.isFinite(Date.parse(status.coalescingUntil));
  const pending = status.config?.autoApply === true && (status.pendingUpdate != null || coalescingIsTime);
  const since = status.pendingUpdateDetectedAt ? Date.parse(status.pendingUpdateDetectedAt) : Number.NaN;
  return {
    pending,
    pendingSinceMs: Number.isFinite(since) ? since : null,
    // Unknown blockers count as "something else is delaying": never pause on a guess.
    otherBlockers: blockers === null || blockers.some((b) => !b.startsWith('hold:local-verify')),
  };
}

/**
 * Register the local-verify restart hold with the AutoUpdater, and give the service the
 * rule (b) view of it. While a verify runs, an automatic update restart waits for it
 * (bounded by the run's own ceiling and the gate's `maxDeferralHours`); a manual apply is
 * not held. While an update is pending and only this hold delays it, no NEW verify starts,
 * so a busy queue cannot hold updates indefinitely. `extraHolds` is the seam for the spec's
 * later "hold heads whose projected status is success" rule (merges, not live yet).
 */
export function registerLocalVerifyRestartHold(
  autoUpdater: LocalVerifyAutoUpdaterView,
  service: LocalVerifyService,
  extraHolds?: () => RestartHold[],
): void {
  autoUpdater.setRestartHold('local-verify', () => {
    const hours = autoUpdater.getStatus().maxDeferralHours;
    const maxDeferralMs = (typeof hours === 'number' && Number.isFinite(hours) ? hours : 4) * 3_600_000;
    return [...service.restartHolds(maxDeferralMs), ...(extraHolds?.() ?? [])];
  });
  service.setUpdatePendingProvider(() => {
    let blockers: string[] | null = null;
    try { blockers = autoUpdater.getRestartBlockers ? autoUpdater.getRestartBlockers() : null; } catch { blockers = null; }
    return updatePendingFromAutoUpdater(autoUpdater.getStatus(), blockers);
  });
}

/**
 * `git merge-base --is-ancestor` in the verifier's own bare clone, through its git
 * funnel (SafeGitExecutor with the local-verify carve-out). 0 → true, 1 → false,
 * anything else (missing object, no clone) → null: health stays unhealthy.
 */
export async function isAncestorInBareClone(agentHome: string, ancestor: string, descendant: string): Promise<boolean | null> {
  const p = verifyPaths(agentHome, descendant);
  if (!fs.existsSync(p.bare)) return null;
  const r = await realGit(['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: p.verifyRoot, gitDir: p.bare, operation: 'local-verify:is-ancestor', timeoutMs: 30_000,
  }, p.verifyRoot);
  return r.status === 0 ? true : r.status === 1 ? false : null;
}

// ── Status projection / reconcile loop (piece 3a) ───────────────────────

export type ApproverAcceptanceFromExecutorStatus = (body: unknown, operatorGhLogin: string | null) => { matches: boolean; reason: string };

export interface SafeMergeFloorExports {
  evaluate: EvaluateRequiredContexts;
  /** ACTIONS_FLOOR_CONTEXTS: REQUIRED_CONTEXTS_FLOOR + the pinned classic contexts, excluding instar/local-verify. */
  actionsFloor: ContextPin[];
  /** Decision 16: the same acceptance judgement safe-merge applies. */
  approverAcceptance: ApproverAcceptanceFromExecutorStatus;
}

/**
 * Load safe-merge's own evaluation function, Actions-floor constant and approver
 * acceptance judgement from the source checkout (one implementation, never a copy).
 * A safe-merge that lacks any of them builds no reconciler.
 */
export async function loadSafeMergeFloor(repoPath: string): Promise<SafeMergeFloorExports | null> {
  try {
    const mod = await import(pathToFileURL(path.join(repoPath, 'scripts', 'safe-merge.mjs')).href) as {
      evaluateRequiredContexts?: EvaluateRequiredContexts; ACTIONS_FLOOR_CONTEXTS?: ContextPin[];
      approverAcceptanceFromExecutorStatus?: ApproverAcceptanceFromExecutorStatus;
    };
    if (typeof mod.evaluateRequiredContexts !== 'function' || !Array.isArray(mod.ACTIONS_FLOOR_CONTEXTS)
      || typeof mod.approverAcceptanceFromExecutorStatus !== 'function') return null;
    return {
      evaluate: mod.evaluateRequiredContexts,
      actionsFloor: mod.ACTIONS_FLOOR_CONTEXTS.map((f) => ({ ...f })),
      approverAcceptance: mod.approverAcceptanceFromExecutorStatus,
    };
  } catch {
    return null; // @silent-fallback-ok — no evaluator ⇒ the reconciler is not built (reason no-safe-merge-floor)
  }
}

export interface StatusReconcilerWiringOpts {
  repo: string;
  repoPath: string;
  stateDir: string;
  machineId: string;
  /** The agent's own GitHub login (green-PR `expectedGhLogin`). */
  expectedGhLogin: string | undefined;
  operatorGhLogin: string | null;
  service: LocalVerifyService | null;
  /** Live config readers. */
  localVerifyEnabled(): boolean;
  postStatuses(): boolean;
  configFloor(): FloorMode;
  watcherRepo(): string;
  lease: { holdsLease(): boolean; leaseEpoch(): number | null; leaseHolder(): string | null };
  signal?(key: string, detail: Record<string, unknown>): void;
  /**
   * GET /feedback-factory/execute/status on this agent's own server (what safe-merge
   * reads); null when it could not be read. Absent ⇒ the acceptance never matches.
   */
  readExecutorStatus?(): Promise<{ status: number; body: unknown } | null>;
  /** Test overrides. */
  gh?: GhRunner;
  floorExports?: SafeMergeFloorExports;
}

export type StatusReconcilerWiringResult =
  | { reconciler: StatusReconciler; floorGate: FloorGate; reason: null }
  | { reconciler: null; floorGate: null; reason: 'no-source-checkout' | 'no-gh-login' | 'no-safe-merge-floor' };

export async function buildStatusReconciler(opts: StatusReconcilerWiringOpts): Promise<StatusReconcilerWiringResult> {
  if (!fs.existsSync(path.join(opts.repoPath, '.git')) || !fs.existsSync(path.join(opts.repoPath, 'scripts', 'safe-merge.mjs'))) {
    return { reconciler: null, floorGate: null, reason: 'no-source-checkout' };
  }
  const login = (opts.expectedGhLogin ?? '').trim();
  if (!login) return { reconciler: null, floorGate: null, reason: 'no-gh-login' };
  const floor = opts.floorExports ?? await loadSafeMergeFloor(opts.repoPath);
  if (!floor) return { reconciler: null, floorGate: null, reason: 'no-safe-merge-floor' };

  let gh = opts.gh;
  if (!gh) {
    const runtime = createAuthenticatedGitHubCliRuntimeResolver({ stateDir: opts.stateDir });
    gh = buildGhRunner(() => {
      try { return runtime().env; } catch { return null; } // @silent-fallback-ok — no explicit identity ⇒ every read is null and nothing posts
    });
  }
  const auditPath = path.join(opts.stateDir, 'logs', 'local-verify.jsonl');
  const audit = (event: Record<string, unknown>) => appendLocalVerifyAudit(auditPath, { src: 'status', ...event }, Date.now());
  const setTimer = (fn: () => void, ms: number) => { const t = setTimeout(fn, ms); t.unref?.(); };
  const floorGate = new FloorGate(
    { repo: opts.repo, configFloor: opts.configFloor, watcherRepo: opts.watcherRepo },
    { ...buildFloorGateGitHubSeams(opts.repo, gh), now: () => Date.now(), signal: opts.signal, audit },
  );
  const seams: StatusReconcilerSeams = {
    ...buildReconcilerGitHubSeams(opts.repo, gh),
    holdsLease: () => opts.lease.holdsLease(),
    leaseEpoch: () => opts.lease.leaseEpoch(),
    leaseHolder: () => opts.lease.leaseHolder(),
    // Decision 16: the executor's acceptance, judged exactly as safe-merge judges it.
    readApproverAcceptance: async () => {
      if (!opts.readExecutorStatus) return { matches: false, reason: 'executor-status-unwired' };
      const ex = await opts.readExecutorStatus().catch(() => null);
      if (!ex || ex.status !== 200) return { matches: false, reason: ex && ex.status === 503 ? 'executor-not-constructed' : 'executor-status-unreadable' };
      return floor.approverAcceptance(ex.body, opts.operatorGhLogin);
    },
    now: () => Date.now(),
    setTimer,
    signal: opts.signal,
    audit,
  };
  const reconciler = new StatusReconciler({
    repo: opts.repo, agentLogin: login, operatorGhLogin: opts.operatorGhLogin, machineId: opts.machineId,
    postStatuses: opts.postStatuses, localVerifyEnabled: opts.localVerifyEnabled,
    actionsFloor: floor.actionsFloor, evaluate: floor.evaluate,
  }, seams, floorGate, opts.service);
  return { reconciler, floorGate, reason: null };
}

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

import { installedSafeMergePath } from '../core/installedSafeMerge.js';
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

/** Where the server's own (installed) safe-merge lives — shared with the green-PR watcher. */
export { installedSafeMergePath };

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
      // The same computation, over the files as they are NOW: an update that replaced the dist
      // under this still-running server holds the queue for the restart instead of burning it.
      installedVerifierVersion: () => computeVerifierVersion(path.dirname(mainEntry), undefined, { protectedList: PROTECTED_PATH_PREFIXES }),
    },
  );
  return { service, reason: null };
}

// ── The merge line (CMT-980) ─────────────────────────────────────────────

/** The watcher surface the merge line drives (GreenPrAutoMerger.tick with a hand-off). */
export interface MergeLineWatcher {
  tick(opts: { handoff: { pr: number; head: string } }): Promise<{ acted: boolean; reason: string }>;
}

/** The status-loop surface the merge line reads before a hand-off. */
export interface MergeLineStatusView {
  knowsHead(headSha: string): boolean;
  /** A listing pass, or the one already running (never a `busy` short-circuit). */
  awaitPass(): Promise<unknown>;
  submit(headSha: string, trigger: string): Promise<void>;
  headState(headSha: string): string | null;
  postingLive(): boolean;
}

export interface MergeLineWiringOpts {
  service: LocalVerifyService;
  /** The green-PR watcher; null ⇒ the merge line is inert (records are merged at the watcher's ticks, as before). */
  watcher: MergeLineWatcher | null;
  /** The status reconcile loop; null ⇒ no status gate before the hand-off. */
  status: MergeLineStatusView | null;
  /** Live kill switch (`monitoring.localVerify.mergeLine`, absent ⇒ on). */
  enabled: () => boolean;
}

/**
 * Connect the verifier's green records to the watcher: a hand-off merges exactly the
 * verified PR at once, after the required `instar/local-verify` status for its head is
 * on GitHub (posted now and read back, instead of racing the 60 s loop), while the
 * verifier holds its queue so the next PR is tested on top of the merge. Every merge
 * gate stays the watcher's and safe-merge's. Returns whether the line is wired.
 */
export function wireMergeLine(opts: MergeLineWiringOpts): { wired: boolean; reason: 'no-watcher' | null } {
  if (!opts.watcher) {
    opts.service.setMergeHandoff(null);
    return { wired: false, reason: 'no-watcher' };
  }
  const watcher = opts.watcher;
  // The switch is read by the service BEFORE a hold opens (so `mergeLine()` reports it and a
  // disabled line books no hold, counter or audit); the check here is the belt.
  opts.service.setMergeHandoff(async (record) => {
    if (!opts.enabled()) return { acted: false, reason: 'disabled' };
    const st = opts.status;
    if (st) {
      try {
        // A head the loop has not listed yet cannot be posted for: list first (the running pass, or one now), then post.
        if (!st.knowsHead(record.headSha)) await st.awaitPass();
        await st.submit(record.headSha, 'merge-line');
      } catch { /* @silent-fallback-ok: the read-back below decides; an unposted status means no hand-off, never a blind merge attempt */ }
      const state = st.headState(record.headSha);
      // Live posting: GitHub must hold `success` for the head, or the merge would be refused and burn a ladder attempt.
      if (st.postingLive() && state !== 'success') return { acted: false, reason: `status-${state ?? 'absent'}` };
    }
    return watcher.tick({ handoff: { pr: record.pr, head: record.headSha } });
  }, { enabled: opts.enabled });
  return { wired: true, reason: null };
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
    /** The applied-but-not-restarted state: the restart is waiting (holds, sessions, window). */
    restartDeferral?: { active?: boolean; firstDeferredAt?: string | null } | null;
  };
  /** What would hold a restart right now (sessions, then `hold:<name>` entries). */
  getRestartBlockers?(): string[];
}

/**
 * Spec §2 Restarts rule (b), read from the AutoUpdater: "update pending" means autoApply is
 * on and `pendingUpdate` is set or `coalescingUntil` holds a time (not the `'notified'`
 * placeholder), OR the update is applied and its restart is deferred (`restartDeferral.active`),
 * timed from the earlier of `pendingUpdateDetectedAt` and `restartDeferral.firstDeferredAt`. `otherBlockers`: anything other than
 * this verifier's own hold would delay the restart anyway. Pure.
 */
export function updatePendingFromAutoUpdater(
  status: ReturnType<LocalVerifyAutoUpdaterView['getStatus']>,
  blockers: readonly string[] | null,
): UpdatePendingState {
  const coalescingIsTime = typeof status.coalescingUntil === 'string' && status.coalescingUntil !== 'notified'
    && Number.isFinite(Date.parse(status.coalescingUntil));
  const beforeApply = status.config?.autoApply === true && (status.pendingUpdate != null || coalescingIsTime);
  // After the apply the AutoUpdater clears pendingUpdate and only its durable restart
  // deferral says an update is waiting. That waiting restart is pending too: without it a
  // busy queue starts the next verify seconds after each one ends and the restart, retried
  // every 5 minutes, waits for the queue to drain (2026-10-25: v1.3.1429 held for hours).
  const deferral = status.restartDeferral;
  const restartWaiting = deferral?.active === true;
  const pending = beforeApply || restartWaiting;
  const detected = status.pendingUpdateDetectedAt ? Date.parse(status.pendingUpdateDetectedAt) : Number.NaN;
  const deferred = restartWaiting && deferral?.firstDeferredAt ? Date.parse(deferral.firstDeferredAt) : Number.NaN;
  const candidates = [detected, deferred].filter((x) => Number.isFinite(x));
  return {
    pending,
    // The earliest known start, so the 120-minute cap counts the whole wait.
    pendingSinceMs: candidates.length > 0 ? Math.min(...candidates) : null,
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

export interface SafeMergeFloorExports {
  evaluate: EvaluateRequiredContexts;
  /** ACTIONS_FLOOR_CONTEXTS: REQUIRED_CONTEXTS_FLOOR + the pinned classic contexts, excluding instar/local-verify. */
  actionsFloor: ContextPin[];
}

/**
 * Load safe-merge's own evaluation function and Actions-floor constant from the
 * INSTALLED safe-merge (one implementation, never
 * a copy; never the working checkout — spec §2). A safe-merge that lacks any of
 * them builds no reconciler.
 */
export async function loadSafeMergeFloor(safeMergePath: string = installedSafeMergePath()): Promise<SafeMergeFloorExports | null> {
  try {
    const mod = await import(pathToFileURL(safeMergePath).href) as {
      evaluateRequiredContexts?: EvaluateRequiredContexts; ACTIONS_FLOOR_CONTEXTS?: ContextPin[];
    };
    if (typeof mod.evaluateRequiredContexts !== 'function' || !Array.isArray(mod.ACTIONS_FLOOR_CONTEXTS)) return null;
    return {
      evaluate: mod.evaluateRequiredContexts,
      actionsFloor: mod.ACTIONS_FLOOR_CONTEXTS.map((f) => ({ ...f })),
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
  const floor = opts.floorExports ?? await loadSafeMergeFloor();
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

/**
 * The focused preflight switch is resolved live for each child and defaults off.
 * Builds the LocalVerifyService for the agent server (spec
 * docs/specs/local-verify-merge-authority.md §2).
 *
 * Repo-gated like the green-PR watcher: constructed only when
 * `monitoring.localVerify.enabled` is true AND the server runs from an instar
 * source checkout. Otherwise null, and the routes answer 503. The verifier's own
 * code (this module, the orchestrator, the child entry) always comes from the
 * running server's install, never from the PR being verified.
 */

import { parseSmallPeerTrialPolicy } from './smallPeerMemory.js';
import { identityKeyLookup, loadMachineSigner, type MachineKeyLookup, type MachineSigner } from '../core/AppRecordSignatures.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { installedSafeMergePath } from '../core/installedSafeMerge.js';
import { createAuthenticatedGitHubCliRuntimeResolver } from '../core/githubRuntime.js';
import { PROTECTED_PATH_PREFIXES } from '../monitoring/greenPrAutomergeWiring.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { LocalVerifyService, appendLocalVerifyAudit, type LocalVerifyServiceSeams, type UpdatePendingState } from './LocalVerifyService.js';
import { parsePeerBorrowedExtras, parsePeerMainRun, parsePeerProgress, type PeerClient, type PeerResult, type PeerRunAnswer, type PeerStatus } from './peer.js';
import { computeVerifierVersion } from './verifierVersion.js';
import type { RestartHold } from '../core/UpdateGate.js';
import { buildDefaultServiceSeams, scrubbedEnv } from './serviceSeams.js';
import { localVerifyTempRoot, realGit } from './orchestratorSeams.js';
import { reapLeftovers, realReapDeps, type LeftoverPrefix, type ReapDeps, type ReapOptions } from './leftoverReaper.js';
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
  /** This machine may run verifies a coordinator hands it (spec local-verify-capacity.md Part D). Default off. */
  peer?: { enabled?: boolean };
  /** Explicitly calibrated verification-only policy for one small peer. Omit to disable. */
  smallPeerTrial?: import('./smallPeerMemory.js').SmallPeerTrialPolicy;
  /** Coordinator: hand `main` verifies to peers while main is healthy (default false; docs/specs/local-verify-main-on-peer.md). Read live. */
  mainOnPeers?: boolean;
  /**
   * A failed test file that only imports a changed file may be re-run alone, three times, when
   * every one of its failed tests has failed and passed alone on a `main` verify in the last 7
   * days (default false; docs/specs/local-verify-import-related-rerun.md). Read live at each run start.
   */
  importRelatedRerun?: boolean;
  /**
   * `off` (default), `on` or `alternate`: on this machine, each lane of a pull request's verify
   * runs a small first part before the rest (the change's own test files, the files it failed on
   * last time, and the coordinator's likely-failing list), so a failure in one of them ends the
   * verify within a couple of minutes. `alternate` is the trial setting: half of the pull
   * requests (docs/specs/local-verify-likely-failing-first.md). Read live at each run start.
   */
  likelyFailingFirst?: 'off' | 'on' | 'alternate';
  /** Coordinator: peers it may hand verifies to (`[{ machineId, url }]`, at most 2). Default none. */
  peers?: Array<{ machineId: string; url: string }>;
  /**
   * Operator controls on the queue: hold a change, and move a change to the front, without a
   * restart (default false; docs/specs/local-verify-queue-controls.md). Read live.
   */
  queueControls?: boolean;
  /**
   * The session that operates the line (a session name). A lease move that leaves holds behind is
   * announced to it as an agent message; absent ⇒ an attention item instead. Read live.
   */
  operatorSession?: string;
  /** macOS: run each verify as an Interactive launchd job so it uses the performance cores (default true). */
  performanceCores?: boolean;
}

/** Late-bound hooks: the service is built before the reconciler that consumes these. */
/**
 * The attention item for a local-verify signal. A starved PR is `upsert`: `createAttentionItem`
 * returns an existing row unchanged (a RESOLVED one too), which would hide a later queue
 * episode of the same PR; `upsertAttentionItem` reopens it. Within one stay in the queue
 * `starvedRaised` already limits the signal to once.
 */
export function localVerifyAttentionItem(key: string, detail: Record<string, unknown>): {
  id: string; title: string; summary: string; priority: 'HIGH' | 'MEDIUM'; mode: 'upsert' | 'create';
} {
  const id = typeof detail.head === 'string' && key === 'local-verify:mirror-pending' ? `${key}:${detail.head}` : key;
  if (key.startsWith('local-verify:first-part-cost-limit:')) {
    return { id, mode: 'upsert', priority: 'HIGH', title: 'Local Verify: first-part trial reached a cost limit',
      summary: String(detail.note ?? '').slice(0, 900) };
  }
  if (key.startsWith('local-verify:memory-pressure:')) {
    // One item per machine, reopened by a later episode (upsert); closed when memory recovers.
    return {
      id, mode: 'upsert', priority: 'HIGH',
      title: detail.who === 'self' ? 'Local Verify: this machine is short of memory' : 'Local Verify: a test machine is short of memory',
      summary: String(typeof detail.note === 'string' ? detail.note : JSON.stringify(detail)).slice(0, 900),
    };
  }
  if (key.startsWith('local-verify:starved:')) {
    const n = String(detail.interruptions ?? 0);
    const waited = String(detail.waitedMinutes ?? '?');
    return {
      id, mode: 'upsert', priority: 'MEDIUM',
      title: `Local Verify: PR #${String(detail.pr)} cannot finish its check`,
      summary: detail.reason === 'interrupted'
        ? `Server restarts killed this PR's check ${n} times before it could finish (waiting ${waited} min). The merge line is stuck behind it.`
        : `This PR has waited ${waited} min for its check without finishing (killed by restarts ${n} times). The merge line is stuck behind it.`,
    };
  }
  if (key.startsWith('local-verify:borrowed-helper-owner:') || key.startsWith('local-verify:borrowed-helper-event:')) {
    // One item per helper event (the id is in the key), raised once by the coordinator. The owner's
    // item exists only when a borrowed pass made main red or a helper lapsed for a fault three times in 7 days.
    const owner = key.startsWith('local-verify:borrowed-helper-owner:');
    return {
      id, mode: 'create', priority: owner ? 'HIGH' : 'MEDIUM',
      title: owner ? 'Local Verify: a borrowed machine needs the owner\'s attention' : 'Local Verify: a borrowed machine\'s result was wrong or its counting ended',
      summary: String(typeof detail.note === 'string' ? detail.note : JSON.stringify(detail)).slice(0, 900),
    };
  }
  // Queue controls (docs/specs/local-verify-queue-controls.md): each id carries its time, so each event is one item.
  const operatorTitle = key.startsWith('local-verify:operator-hold-due:') ? 'Local Verify: a held change is past its expected release'
    : key.startsWith('local-verify:operator-file-unreadable:') ? 'Local Verify: the list of held changes could not be read'
      : key.startsWith('local-verify:operator-lease-moved:') ? 'Local Verify: held changes stayed on a machine that no longer runs the line' : null;
  if (operatorTitle) {
    return {
      id, mode: 'create', title: operatorTitle,
      summary: String(typeof detail.note === 'string' ? detail.note : JSON.stringify(detail)).slice(0, 900),
      priority: key.startsWith('local-verify:operator-file-unreadable:') ? 'HIGH' : 'MEDIUM',
    };
  }
  return {
    id, mode: 'create',
    title: `local-verify: ${key.replace(/^local-verify:/, '')}`,
    // A signal that carries a plain-words `note` (the main-red hold item) reads as that note.
    summary: (typeof detail.note === 'string' ? detail.note : JSON.stringify(detail)).slice(0, 900),
    priority: ['local-verify:no-required-checks', 'local-verify:main-red', 'local-verify:required-but-not-posting'].includes(key) ? 'HIGH' : 'MEDIUM',
  };
}

export interface LocalVerifyHooks {
  onRecord?(record: LocalVerifyRecord): void;
  onMainHealthChange?(snap: MainHealthSnapshot, prev: MainHealthSnapshot): void;
  signal?(key: string, detail: Record<string, unknown>): void;
  /** Close a deduped attention item whose condition ended. */
  clearSignal?(key: string, resolution: string): void;
}

export interface LocalVerifyWiringOpts {
  config: LocalVerifyConfigBlock | undefined;
  /** The green-PR block's `expectedGhLogin` (the agent's own GitHub login). */
  expectedGhLogin: string | undefined;
  /** `monitoring.localVerify.operatorGhLogin`, read live (no restart to apply a change). */
  liveOperatorGhLogin?: () => string | null;
  repo: string;
  /** The server's working directory (the instar source checkout). */
  repoPath: string;
  /** The agent's `.instar` directory. */
  stateDir: string;
  /** The agent home (`.worktrees/.verify/` lives under it). */
  agentHome: string;
  machineId: string;
  /** Absent ⇒ the starved signal goes to `hooks.signal` as `local-verify:starved:<pr>` (one attention item per PR). */
  onStarved?: LocalVerifyServiceSeams['onStarved'];
  /** Override the child entry (tests running from source point at the built dist). */
  mainEntry?: string;
  hooks?: LocalVerifyHooks;
  /** This machine's memory state in plain words, or null (machine memory care). Absent ⇒ never held. */
  selfMemoryPressure?: () => string | null;
  /**
   * The process table the backstop leftover sweep reads and signals. Absent ⇒ the real one,
   * except under a test runner (VITEST), where a built service must never signal the test
   * host's own processes unless the test passes deps explicitly. null ⇒ no sweep.
   */
  reapDeps?: ReapDeps | null;
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
  // A coordinator merges, so it must run from an instar source checkout. A machine without
  // one may still run as a PEER (it never merges): a peer-only service (Part D).
  const sourceCheckout = fs.existsSync(path.join(opts.repoPath, '.git')) && fs.existsSync(path.join(opts.repoPath, 'scripts', 'safe-merge.mjs'));
  const peerOnly = !sourceCheckout && opts.config.peer?.enabled === true;
  if (!sourceCheckout && !peerOnly) {
    return { service: null, reason: 'no-source-checkout' };
  }
  const expected = (opts.expectedGhLogin ?? '').trim();
  if (!expected) return { service: null, reason: 'no-gh-login' };
  const mainEntry = opts.mainEntry ?? installedMainEntry();
  if (!fs.existsSync(mainEntry)) return { service: null, reason: 'no-entry' };

  const githubRuntime = createAuthenticatedGitHubCliRuntimeResolver({ stateDir: opts.stateDir });
  const seams = buildDefaultServiceSeams({
    repo: opts.repo,
    priorityKey: `${opts.stateDir}:${opts.machineId}`,
    // Default on (macOS only); `localVerify.performanceCores: false` turns it off.
    ...(opts.config.performanceCores !== false ? {
      performanceCores: {
        stateDir: opts.stateDir,
        onFallback: (reason: string) => DegradationReporter.getInstance().report({
          feature: 'LocalVerify.performanceCores', primary: 'run on the performance cores (launchd Interactive job)',
          fallback: 'plain detached spawn (efficiency cores under a session-started server)', reason,
          impact: 'verify lanes may run several times slower and hit their deadlines while sessions are busy',
        }),
      },
    } : {}),
    resolveGitHubEnv: () => {
      try { return githubRuntime().env; } catch { return null; } // @silent-fallback-ok — no explicit GitHub identity makes every request refuse as pr-unreadable
    },
  });
  const reapDeps = opts.reapDeps !== undefined ? opts.reapDeps : (process.env.VITEST ? null : realReapDeps());
  const service = new LocalVerifyService(
    {
      repo: opts.repo,
      stateDir: opts.stateDir,
      agentHome: opts.agentHome,
      expectedGhLogin: expected,
      operatorGhLogin: opts.config.operatorGhLogin?.trim() || null,
      ...(opts.liveOperatorGhLogin ? { liveOperatorGhLogin: opts.liveOperatorGhLogin } : {}),
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
      ...(peerOnly ? { peerOnly: true } : {}),
    },
    {
      ...seams,
      // The starved signal used to reach only the audit log (nothing was wired to it), so a
      // queue whose head could never finish stayed invisible. It is an attention signal now.
      // one item per PR (`starvedRaised` is kept across a push, so the PR alarms once per stay in the queue).
      onStarved: opts.onStarved ?? ((i) => opts.hooks?.signal?.(`local-verify:starved:${i.pr}`, {
        pr: i.pr, headSha: i.headSha, waitedMinutes: Math.round(i.waitedMs / 60_000),
        reason: i.reason ?? 'waited', interruptions: i.interruptions ?? 0,
      })),
      onRecord: (r) => opts.hooks?.onRecord?.(r),
      // A degradation the run child noticed rides its result here; this server's reporter is the
      // one /health reads, so the record is made here, never by the child.
      onDegradation: (e) => DegradationReporter.getInstance().report(e),
      onMainHealthChange: (snap, prev) => opts.hooks?.onMainHealthChange?.(snap, prev),
      signal: (k, d) => opts.hooks?.signal?.(k, d),
      clearSignal: (k, r) => opts.hooks?.clearSignal?.(k, r),
      // Machine memory care: this machine's own memory state (late-bound: the load sampler
      // starts after this service), and the backstop sweep of leftover test processes.
      selfMemoryPressure: () => opts.selfMemoryPressure?.() ?? null,
      ...(reapDeps ? { reapLeftovers: (prefixes: LeftoverPrefix[], o?: ReapOptions) => reapLeftovers(reapDeps, prefixes, o) } : {}),
      tempRoot: () => localVerifyTempRoot(),
      isAncestor: (a, d) => isAncestorInBareClone(opts.agentHome, a, d),
      firstPartHistory: async (green, red) => {
        const p = verifyPaths(opts.agentHome, red);
        const result = await realGit(['log', '--reverse', '--format=%H%x09%s', `${green}..${red}`], {
          cwd: p.verifyRoot, gitDir: p.bare, operation: 'local-verify:first-part-history', timeoutMs: 30_000,
        }, p.verifyRoot);
        return result.status === 0 ? result.stdout.trim().split('\n').filter(Boolean).map((line) => ({ head: line.slice(0, 40), message: line.slice(41) })) : null;
      },
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
    /** This process is installing an update or has installed bytes awaiting its restart. */
    updateActivationPendingSince?: string | null;
    /** The applied-but-not-restarted state: the restart is waiting (holds, sessions, window). */
    restartDeferral?: { active?: boolean; firstDeferredAt?: string | null; currentBlockers?: string[] } | null;
  };
  /** What would hold a restart right now (sessions, then `hold:<name>` entries). */
  getRestartBlockers?(): string[];
  /** A local-verify hold just ended: retry a restart deferred on it now. */
  recheckRestartHolds?(): void;
}

/**
 * Spec §2 Restarts rule (b), read from the AutoUpdater: "update pending" means autoApply is
 * on and `pendingUpdate` is set or `coalescingUntil` holds a time (not the `'notified'`
 * placeholder), OR the update is installing/awaiting this process's restart, OR its restart
 * is deferred (`restartDeferral.active`). `otherBlockers`: anything other than
 * this verifier's own hold would delay the restart anyway. Pure.
 */
export function updatePendingFromAutoUpdater(
  status: ReturnType<LocalVerifyAutoUpdaterView['getStatus']>,
  blockers: readonly string[] | null,
): UpdatePendingState {
  const coalescingIsTime = typeof status.coalescingUntil === 'string' && status.coalescingUntil !== 'notified'
    && Number.isFinite(Date.parse(status.coalescingUntil));
  const beforeApply = status.config?.autoApply === true && (status.pendingUpdate != null || coalescingIsTime);
  // After the apply the AutoUpdater clears pendingUpdate. The process-local marker
  // spans the request-to-restart gap even when no durable deferral exists; the durable
  // deferral also says an update is waiting. Without these signals a
  // busy queue starts the next verify seconds after each one ends and the restart, retried
  // every 5 minutes, waits for the queue to drain (2026-10-25: v1.3.1429 held for hours).
  const deferral = status.restartDeferral;
  const restartWaiting = deferral?.active === true;
  const activationSince = status.updateActivationPendingSince ? Date.parse(status.updateActivationPendingSince) : Number.NaN;
  const activationPending = Number.isFinite(activationSince);
  const pending = beforeApply || restartWaiting || activationPending;
  const detected = status.pendingUpdateDetectedAt ? Date.parse(status.pendingUpdateDetectedAt) : Number.NaN;
  const deferred = restartWaiting && deferral?.firstDeferredAt ? Date.parse(deferral.firstDeferredAt) : Number.NaN;
  // Installation starts a fresh bounded pause. An old detection must not let a
  // verifier begin in the narrow interval before the restart request takes effect.
  const candidates = (activationPending ? [activationSince] : [detected, deferred]).filter((x) => Number.isFinite(x));
  return {
    pending,
    // A bounded 120-minute pause, from install start when this process needs activation.
    pendingSinceMs: candidates.length > 0 ? Math.min(...candidates) : null,
    // During the short install/restart decision, the fence wins even if another
    // blocker is present: that blocker can disappear before the restart request.
    // Once deferred, the marker clears and the original blocker exception applies.
    otherBlockers: activationPending ? false : blockers === null || blockers.some((b) => !b.startsWith('hold:local-verify')),
    ...(restartWaiting && deferral?.currentBlockers?.some((b) => b.startsWith('local-verify:peer-')) ? { restartHeldForPeer: true } : {}),
  };
}

/**
 * Register the local-verify restart hold with the AutoUpdater, and give the service the
 * rule (b) view of it. While a verify runs, an automatic update restart waits for it
 * (bounded by the run's own ceiling and the gate's `maxDeferralHours`); a manual apply
 * also waits unless it explicitly forces a restart. While an update is pending and
 * only this hold delays it, no NEW verify starts,
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
  service.setRunEndedListener(autoUpdater.recheckRestartHolds ? () => autoUpdater.recheckRestartHolds!() : null);
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
  /** `monitoring.localVerify.operatorGhLogin`, read live (no restart to apply a change). */
  liveOperatorGhLogin?: () => string | null;
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
    repo: opts.repo, agentLogin: login, operatorGhLogin: opts.operatorGhLogin, ...(opts.liveOperatorGhLogin ? { liveOperatorGhLogin: opts.liveOperatorGhLogin } : {}), machineId: opts.machineId,
    postStatuses: opts.postStatuses, localVerifyEnabled: opts.localVerifyEnabled,
    actionsFloor: floor.actionsFloor, evaluate: floor.evaluate,
  }, seams, floorGate, opts.service);
  return { reconciler, floorGate, reason: null };
}

// ── Peer verifiers (spec local-verify-capacity.md Part D) ────────────────

/**
 * The coordinator's HTTP client to its peers: the agent's Bearer token over the pool's own
 * addresses, a short timeout per call, and every failure reported as null (the caller's
 * bounded recovery decides). `fetchImpl` is the test seam.
 */
export function makePeerClient(authToken: string, agentId: string, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): PeerClient {
  const call = async (url: string, init: RequestInit): Promise<{ status: number; body: unknown } | null> => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { ...init, signal: ac.signal, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${authToken}`, 'X-Instar-AgentId': agentId, 'Content-Type': 'application/json' } });
      const text = await r.text();
      let body: unknown = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; } // @silent-fallback-ok — an unparseable body reads as no answer
      return { status: r.status, body };
    } catch {
      return null; // @silent-fallback-ok — unreachable / timed out: the coordinator's bounded recovery handles it
    } finally {
      clearTimeout(t);
    }
  };
  return {
    async status(peer) {
      const r = await call(`${peer.url}/local-verify/peer-status`, { method: 'GET' });
      if (!r || r.status !== 200 || !r.body || typeof r.body !== 'object') return null;
      const b = r.body as PeerStatus & { enabled?: boolean };
      if (b.enabled === false) return null;
      if (typeof b.verifierVersion !== 'string' || typeof b.policyHash !== 'string' || typeof b.slotBusy !== 'boolean') return null;
      const hint = (b as { signerKeyHash?: unknown }).signerKeyHash;
      const trial = parseSmallPeerTrialPolicy(b.smallPeerTrial);
      return { ...(trial ? { smallPeerTrial: trial } : {}), inFlight: b.inFlight ?? null, verifierVersion: b.verifierVersion, policyHash: b.policyHash, slotBusy: b.slotBusy,
        ...(typeof hint === 'string' && /^[0-9a-f]{64}$/.test(hint) ? { signerKeyHash: hint } : {}),
        // Borrowed helpers: the peer's helper events, helpers and baseline wish, each strictly shaped or left out.
        ...parsePeerBorrowedExtras(r.body as Record<string, unknown>) };
    },
    async run(peer, req) {
      const r = await call(`${peer.url}/local-verify/peer-run`, { method: 'POST', body: JSON.stringify(req) });
      if (!r || !r.body || typeof r.body !== 'object') return null;
      const b = r.body as PeerRunAnswer;
      if (b.ok === true && b.attemptId === req.attemptId) return b;
      if (b.ok === false && typeof b.reason === 'string') return b;
      return null;
    },
    async result(peer, attemptId) {
      const r = await call(`${peer.url}/local-verify/peer-result?attemptId=${encodeURIComponent(attemptId)}`, { method: 'GET' });
      if (!r || r.status !== 200 || !r.body || typeof r.body !== 'object') return null;
      const b = r.body as PeerResult;
      if (b.state === 'unknown') return { state: 'unknown' };
      // docs/specs/local-verify-peer-works-through-restart.md E: the peer's progress rides along, bounded and shape-checked.
      if (b.state === 'running') {
        const raw = (r.body as { progress?: unknown }).progress;
        return raw === undefined ? { state: 'running' } : { state: 'running', progress: parsePeerProgress(raw) };
      }
      if (b.state === 'done' && 'record' in b && b.record) {
        const rawBody = r.body as { record: unknown; run?: unknown; requestDigest?: unknown; sig?: unknown };
        const run = parsePeerMainRun(rawBody.run);
        // SEC-113 D1: the raw body as received rides along, so the signature is checked before any reshaping.
        return {
          state: 'done', record: b.record, ...(run ? { run } : {}),
          raw: { record: rawBody.record, run: rawBody.run, requestDigest: rawBody.requestDigest, sig: rawBody.sig },
        };
      }
      return null;
    },
    async trialReceipts(peer, coordinator, attemptIds) {
      const r = await call(`${peer.url}/local-verify/trial-receipts?coordinator=${encodeURIComponent(coordinator)}&ids=${encodeURIComponent(attemptIds.join(','))}`, { method: 'GET' });
      return r?.status === 200 && Array.isArray(r.body) ? r.body.slice(0, 8) : [];
    },
    async acknowledgeTrial(peer, ack) {
      const r = await call(`${peer.url}/local-verify/trial-receipts/ack`, { method: 'POST', body: JSON.stringify(ack) });
      return r?.status === 200 && (r.body as {ok?: unknown} | null)?.ok === true;
    },
    async trialLease(peer, request) {
      const r = await call(`${peer.url}/local-verify/peer-trial-lease`, { method: 'POST', body: JSON.stringify(request) });
      if (r?.status !== 200) return null;
      const b = r.body as { nonce?: unknown } | null;
      return typeof b?.nonce === 'string' && /^[a-f0-9]{32}$/.test(b.nonce) ? b.nonce : null;
    },
    async cancel(peer, attemptId) {
      await call(`${peer.url}/local-verify/peer-cancel`, { method: 'POST', body: JSON.stringify({ attemptId }) });
    },
  };
}

/** Wire the peer settings (read live), the client and the lease view onto a built service. */
export function wireLocalVerifyPeers(
  svc: Pick<LocalVerifyService, 'setPeerWiring'>,
  o: {
    liveConfig: { get<T>(key: string, fallback: T): T };
    authToken: string;
    agentId: string;
    lease: { holdsLease(): boolean; leaseEpoch(): number | null; holderMachineId(): string | null } | null;
    fetchImpl?: typeof fetch;
    /** Resource-aware placement §4: a peer's fit for a full verify; absent ⇒ no filter. */
    peerFit?: (machineId: string) => import('./LocalVerifyService.js').PeerFit;
    /** SEC-113 D1: the agent state dir, for this machine's signer and the pinned peer keys. Absent ⇒ unsigned answers and no peer dispatch. */
    stateDir?: string;
  },
): void {
  const signer = o.stateDir ? loadMachineSigner(o.stateDir) : null;
  svc.setPeerWiring({
    signer,
    smallPeerTrial: () => o.liveConfig.get<unknown>('monitoring.localVerify.smallPeerTrial', null),
    keyLookupFactory: o.stateDir ? () => identityKeyLookup(o.stateDir!) : null,
    ...(o.peerFit ? { peerFit: o.peerFit } : {}),
    peerRoleEnabled: () => o.liveConfig.get<boolean>('monitoring.localVerify.peer.enabled', false) === true,
    peers: () => o.liveConfig.get<unknown>('monitoring.localVerify.peers', []),
    // Off unless set: a `main` verify stays on the coordinator (docs/specs/local-verify-main-on-peer.md).
    mainOnPeers: () => o.liveConfig.get<boolean>('monitoring.localVerify.mainOnPeers', false) === true,
    client: makePeerClient(o.authToken, o.agentId, o.fetchImpl),
    lease: o.lease,
  });
}
/**
 * The live switches the server reads at each decision (absent ⇒ on):
 * `monitoring.localVerify.mainRedHold` (CMT-1033), `monitoring.localVerify.failFast` and
 * `monitoring.localVerify.laneShards` (processes per slow lane; absent ⇒ the policy defaults).
 * `monitoring.localVerify.importRelatedRerun` and `monitoring.localVerify.queueControls` are the
 * exceptions: absent ⇒ OFF, on only by a real `true`; so is
 * `monitoring.localVerify.peerWorksThroughRestart.enabled` (absent ⇒ OFF).
 */
export function wireLocalVerifySwitches(
  svc: Pick<LocalVerifyService, 'setMainRedHoldEnabled' | 'setFailFastEnabled' | 'setLaneShards' | 'setPreflightMode' | 'setImportRelatedRerunEnabled' | 'setQueueControlsEnabled' | 'setPeerWorksThroughRestart'>
    & Partial<Pick<LocalVerifyService, 'setLikelyFailingFirst' | 'setLikelyFailingFirstOff'>>,
  liveConfig: { get<T>(key: string, fallback: T): T; set?(key: string, value: unknown): void },
): void {
  svc.setMainRedHoldEnabled(() => liveConfig.get<boolean>('monitoring.localVerify.mainRedHold', true) !== false);
  svc.setFailFastEnabled(() => liveConfig.get<boolean>('monitoring.localVerify.failFast', true) !== false);
  // Processes per slow lane, e.g. { "integration": 1, "e2e": 2 } to return to the pre-2026-10-27 split.
  svc.setLaneShards(() => liveConfig.get<unknown>('monitoring.localVerify.laneShards', null));
  svc.setPreflightMode(() => liveConfig.get<unknown>('monitoring.localVerify.preflightMode', 'off'));
  // Off unless set: an import-related failed file is refused its re-run, as before (docs/specs/local-verify-import-related-rerun.md).
  svc.setImportRelatedRerunEnabled(() => liveConfig.get<boolean>('monitoring.localVerify.importRelatedRerun', false) === true);
  // Off unless set: no hold or front route answers and stored choices are not applied (docs/specs/local-verify-queue-controls.md).
  svc.setQueueControlsEnabled(() => liveConfig.get<boolean>('monitoring.localVerify.queueControls', false) === true);
  // docs/specs/local-verify-peer-works-through-restart.md: absent or anything but `true` ⇒ off (today's behaviour). No default is written.
  svc.setPeerWorksThroughRestart(() => liveConfig.get<unknown>('monitoring.localVerify.peerWorksThroughRestart.enabled', false));
  // Off unless set to `on` or `alternate` on THIS machine: each lane then runs a small first part
  // before the rest (docs/specs/local-verify-likely-failing-first.md). Read at the start of each verify.
  svc.setLikelyFailingFirst?.(() => liveConfig.get<unknown>('monitoring.localVerify.likelyFailingFirst', 'off'));
  // A cost limit writes off to this machine's live config.
  const set = liveConfig.set?.bind(liveConfig);
  svc.setLikelyFailingFirstOff?.(set ? () => set('monitoring.localVerify.likelyFailingFirst', 'off') : null);
}

/**
 * Queue controls: how a lease-loss notice reaches the session that operates the line (spec
 * docs/specs/local-verify-queue-controls.md, Multi-machine posture). The session's name is
 * `monitoring.localVerify.operatorSession`, read live; absent or empty means not set, and the
 * service then raises an attention item instead. `send` is the server's agent-message sender
 * (the one POST /messages/send uses); only a `delivered` (or `read`) phase counts as sent.
 */
export function wireLocalVerifyOperatorNotice(
  svc: Pick<LocalVerifyService, 'setOperatorNotifier'>,
  o: {
    liveConfig: { get<T>(key: string, fallback: T): T };
    send: (session: string, subject: string, body: string) => Promise<{ phase?: string } | null | undefined>;
  },
): void {
  svc.setOperatorNotifier(async ({ subject, body }) => {
    const raw = o.liveConfig.get<unknown>('monitoring.localVerify.operatorSession', null);
    const session = typeof raw === 'string' ? raw.trim() : '';
    if (!session || session.length > 200) return { sent: false, phase: 'no-session-set' };
    const r = await o.send(session, subject, body);
    const phase = r && typeof r.phase === 'string' ? r.phase : null;
    // Sent = the router injected it into the session (`delivered`, or the later `read`). A message
    // only `queued` for a session that is not running may never be read, so it does not count.
    return { sent: phase === 'delivered' || phase === 'read', phase };
  });
}

/**
 * Whether the merge watcher may treat a PR head as verified: a PASSING record
 * only. A failed record used to count, so a PR whose verify failed was picked
 * as the oldest eligible, refused by safe-merge, backed off and finally given
 * up, holding the front of the merge line the whole time (2026-11-02).
 */
export function hasPassingRecord(
  svc: { getRecord(pr: number, head: string, base: string): { outcome?: string } | null | undefined },
  pr: number, head: string, base: string,
): boolean {
  return svc.getRecord(pr, head, base)?.outcome === 'success';
}

// ── Borrowed helpers, run-machine side (docs/specs/local-verify-borrowed-unit-slices.md, F) ──

/** What the borrowed-helper wiring needs beyond the service. */
export interface BorrowedWiringOpts {
  liveConfig: { get<T>(key: string, fallback: T): T };
  stateDir: string;
  agentHome: string;
  machineId: string;
  authToken: string;
  agentId: string;
  version: string;
  fetchImpl?: typeof fetch;
  /** Test seams; production loads this machine's signer and pinned keys from `stateDir`. */
  signer?: MachineSigner | null;
  keyLookup?: () => MachineKeyLookup;
  /** TEST ONLY (e2e): replace the tree-reading seams; production reads this machine's verify clone. */
  treeSeams?: Partial<Pick<import('./BorrowedShadow.js').BorrowedShadowDeps, 'unitFiles' | 'treeReader' | 'localUnitReport'>> & { treeFiles?: (commit: string) => Promise<Array<{ file: string; ms: number | null }>> };
  /** The serving lease: only the coordinator sends notices and keeps baseline results. Absent: a single machine (always the coordinator). */
  lease?: { holdsLease(): boolean } | null;
  /** The existing attention seam (the same hooks the service signals through). */
  hooks?: Pick<LocalVerifyHooks, 'signal'>;
  /** This server's port: the verify child reaches the borrowed proxy on loopback. Absent: no verify is offered a helper. */
  port?: number;
  /** One row in the maturation ladder's evidence log; production passes the shared `featureEvidence`. */
  evidence?: (row: { kind: 'fired' | 'held'; reason: string; subject: string; context: Record<string, string | number | boolean | null> }) => void;
}

/** The attention keys of helper notices: one item per event, for the line's session and (only in the two stated cases) the owner. */
export const BORROWED_NOTICE_KEYS = Object.freeze({ line: 'local-verify:borrowed-helper-event', owner: 'local-verify:borrowed-helper-owner' });

/**
 * Wire the run machine's borrowed-helper side onto a built service (docs/specs/local-verify-borrowed-slices-count.md, F):
 * the practice record, the asking rate, the loopback proxy, the baseline results and the helper
 * events (BorrowedRunMachine), and the detached observer of this machine's own `main` verifies
 * (BorrowedShadow), both on ONE practice record. Inert unless `monitoring.localVerify.borrowed.mode`
 * is `'practice'` or `'count'` (the first design's `'shadow'` reads as `'practice'`; read live);
 * never written as a config default. Neither is awaited by a verify.
 */
export async function wireBorrowedRunMachine(
  svc: Pick<LocalVerifyService, 'setMainRunObserver' | 'setBorrowedRunSeam'> & Partial<Pick<LocalVerifyService, 'ancestry'>>,
  o: BorrowedWiringOpts,
): Promise<{ shadow: import('./BorrowedShadow.js').BorrowedShadow; machine: import('./BorrowedRunMachine.js').BorrowedRunMachine }> {
  const [{ BorrowedShadow }, { BorrowedRunMachine }, { makeHelperClient }, seams, { parseBorrowedConfig }, { LOCAL_VERIFY_LIMITS }, { BorrowedPracticeStore }, { MainFileCountsStore }] = await Promise.all([
    import('./BorrowedShadow.js'), import('./BorrowedRunMachine.js'), import('./borrowedClient.js'), import('./borrowedRunSeams.js'), import('./helper/helperConfig.js'), import('./policy.js'),
    import('./borrowedState.js'), import('./mainFileCounts.js'),
  ]);
  const auditPath = path.join(o.stateDir, 'logs', 'local-verify.jsonl');
  const audit = (e: Record<string, unknown>) => appendLocalVerifyAudit(auditPath, { src: 'borrowed', ...e }, Date.now());
  const config = () => parseBorrowedConfig(o.liveConfig.get<unknown>('monitoring.localVerify.borrowed', null), o.machineId);
  const client = makeHelperClient(o.authToken, o.agentId, o.fetchImpl);
  const signer = o.signer !== undefined ? o.signer : loadMachineSigner(o.stateDir);
  const keyLookup = o.keyLookup ?? (() => identityKeyLookup(o.stateDir));
  const store = new BorrowedPracticeStore(o.stateDir);
  const fetchImpl = o.fetchImpl ?? fetch;
  const machine = new BorrowedRunMachine({
    config, store, client, signer, keyLookup, machineId: o.machineId,
    // The file's hash goes to the SAME audit log it is later checked against (no `src` tag needed to find it).
    baseline: new MainFileCountsStore({ stateDir: o.stateDir, audit: (e) => appendLocalVerifyAudit(auditPath, e, Date.now()) }),
    isCoordinator: () => (o.lease ? o.lease.holdsLease() : true),
    postPeerBaseline: async (peer, body) => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 30_000);
      try {
        const r = await fetchImpl(`${peer.url}/local-verify/peer-baseline`, { method: 'POST', body: JSON.stringify(body), signal: ac.signal, headers: { Authorization: `Bearer ${o.authToken}`, 'X-Instar-AgentId': o.agentId, 'Content-Type': 'application/json' } });
        return r.status === 200;
      } catch { return false; } // @silent-fallback-ok: an unreachable peer is offered the baseline again later
      finally { clearTimeout(t); }
    },
    postPeerMainRed: async (peer, body) => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 30_000);
      try {
        const r = await fetchImpl(`${peer.url}/local-verify/peer-main-red`, { method: 'POST', body: JSON.stringify(body), signal: ac.signal, headers: { Authorization: `Bearer ${o.authToken}`, 'X-Instar-AgentId': o.agentId, 'Content-Type': 'application/json' } });
        return r.status === 200;
      } catch { return false; } // @silent-fallback-ok: the caller audits it as not sent and tries once more a minute later
      finally { clearTimeout(t); }
    },
    audit,
    // The existing attention seam, one item per event id. The owner's item is raised only for the two cases the spec names.
    notify: (who, event, text, ownerReason) => o.hooks?.signal?.(`${who === 'owner' ? BORROWED_NOTICE_KEYS.owner : BORROWED_NOTICE_KEYS.line}:${event.id}`, {
      note: who === 'owner' ? `${text} The owner is told because ${ownerReason === 'main-red-after-pass' ? 'a borrowed pass made main red' : 'this helper lapsed for a fault three times in 7 days'}.` : text,
      helper: event.helper, lane: event.lane, kind: event.kind, runMachineId: event.runMachineId, audience: who,
    }),
    ...(o.evidence ? { evidence: o.evidence } : {}),
    ...(typeof o.port === 'number' ? { port: o.port } : {}),
    // The dry run reads the commit's test files from this machine's verify clone.
    treeFiles: o.treeSeams?.treeFiles ?? ((commit: string) => seams.treeTestFiles(o.agentHome, commit)),
    ...(svc.ancestry ? { isAncestor: (a: string, b: string) => svc.ancestry!(a, b) } : {}),
  });
  const shadow = new BorrowedShadow({
    config, client, signer, keyLookup,
    machineId: o.machineId,
    stateDir: o.stateDir,
    version: o.version,
    localWorkers: LOCAL_VERIFY_LIMITS.unitWorkersParallel,
    unitFiles: (head) => seams.unitFilesWithDurations(o.agentHome, head),
    treeReader: (head) => seams.verifyCloneTreeReader(o.agentHome, head),
    localUnitReport: (head) => seams.localUnitReport(o.agentHome, head),
    audit,
    store, asking: machine.helperAsking(),
    // Main verifies' comparisons feed the same practice record, through its one update path.
    recordVerify: (helper, outcomes) => machine.recordVerify(helper, outcomes),
    ...(o.treeSeams ?? {}),
  });
  svc.setMainRunObserver(shadow);
  svc.setBorrowedRunSeam(machine);
  return { shadow, machine };
}

/** The main-verify observer of `wireBorrowedRunMachine` (kept for callers that only need it). */
export async function wireBorrowedShadow(
  svc: Pick<LocalVerifyService, 'setMainRunObserver' | 'setBorrowedRunSeam'>,
  o: BorrowedWiringOpts,
): Promise<import('./BorrowedShadow.js').BorrowedShadow> {
  return (await wireBorrowedRunMachine(svc, o)).shadow;
}

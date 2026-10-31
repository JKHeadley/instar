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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { installedSafeMergePath } from '../core/installedSafeMerge.js';
import { createAuthenticatedGitHubCliRuntimeResolver } from '../core/githubRuntime.js';
import { PROTECTED_PATH_PREFIXES } from '../monitoring/greenPrAutomergeWiring.js';
import { LocalVerifyService, appendLocalVerifyAudit, type LocalVerifyServiceSeams, type UpdatePendingState } from './LocalVerifyService.js';
import type { PeerClient, PeerResult, PeerRunAnswer, PeerStatus } from './peer.js';
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
  /** This machine may run verifies a coordinator hands it (spec local-verify-capacity.md Part D). Default off. */
  peer?: { enabled?: boolean };
  /** Coordinator: peers it may hand verifies to (`[{ machineId, url }]`, at most 2). Default none. */
  peers?: Array<{ machineId: string; url: string }>;
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
      onMainHealthChange: (snap, prev) => opts.hooks?.onMainHealthChange?.(snap, prev),
      signal: (k, d) => opts.hooks?.signal?.(k, d),
      clearSignal: (k, r) => opts.hooks?.clearSignal?.(k, r),
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
  /** A local-verify hold just ended: retry a restart deferred on it now. */
  recheckRestartHolds?(): void;
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
      return { inFlight: b.inFlight ?? null, verifierVersion: b.verifierVersion, policyHash: b.policyHash, slotBusy: b.slotBusy };
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
      if (b.state === 'unknown' || b.state === 'running') return { state: b.state };
      if (b.state === 'done' && 'record' in b && b.record) return { state: 'done', record: b.record };
      return null;
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
  },
): void {
  svc.setPeerWiring({
    peerRoleEnabled: () => o.liveConfig.get<boolean>('monitoring.localVerify.peer.enabled', false) === true,
    peers: () => o.liveConfig.get<unknown>('monitoring.localVerify.peers', []),
    client: makePeerClient(o.authToken, o.agentId, o.fetchImpl),
    lease: o.lease,
  });
}
/**
 * The live switches the server reads at each decision (absent ⇒ on):
 * `monitoring.localVerify.mainRedHold` (CMT-1033), `monitoring.localVerify.failFast` and
 * `monitoring.localVerify.laneShards` (processes per slow lane; absent ⇒ the policy defaults).
 */
export function wireLocalVerifySwitches(
  svc: Pick<LocalVerifyService, 'setMainRedHoldEnabled' | 'setFailFastEnabled' | 'setLaneShards' | 'setPreflightMode'>,
  liveConfig: { get<T>(key: string, fallback: T): T },
): void {
  svc.setMainRedHoldEnabled(() => liveConfig.get<boolean>('monitoring.localVerify.mainRedHold', true) !== false);
  svc.setFailFastEnabled(() => liveConfig.get<boolean>('monitoring.localVerify.failFast', true) !== false);
  // Processes per slow lane, e.g. { "integration": 1, "e2e": 2 } to return to the pre-2026-10-27 split.
  svc.setLaneShards(() => liveConfig.get<unknown>('monitoring.localVerify.laneShards', null));
  svc.setPreflightMode(() => liveConfig.get<unknown>('monitoring.localVerify.preflightMode', 'off'));
}

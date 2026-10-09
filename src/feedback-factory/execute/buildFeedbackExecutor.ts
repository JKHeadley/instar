/**
 * Production construction of the feedback executor (docs/specs/feedback-triage-and-execution.md §4).
 * Called from AgentServer right after triage is built, inside the operated-drain block, so the
 * executor shares the drain database, the triage owner fence and the epoch. Test seams
 * (`overrides`) replace only the external boundaries (git, GitHub, sandbox runtime, sessions).
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { InstarConfig } from '../../core/types.js';
import type { InitiativeTracker } from '../../core/InitiativeTracker.js';
import type { SessionManager } from '../../core/SessionManager.js';
import type { FeedbackDrainStore } from '../drain/FeedbackDrainStore.js';
import type { FeedbackProcessingService } from '../processing/FeedbackProcessingService.js';
import { resolveCommitIdentity } from '../../core/InstarWorktreeManager.js';
import { getHostSpawnSemaphore } from '../../core/hostSpawnSemaphore.js';
import { DegradationReporter } from '../../monitoring/DegradationReporter.js';
import type { FeedbackTriageRouteContext } from '../triage/buildFeedbackTriage.js';
import type { AttentionInput } from '../triage/FeedbackTriageService.js';
import { FeedbackExecuteStore } from './FeedbackExecuteStore.js';
import { FeedbackExecutorService, type ConfinedSessionPort, type ExecutorAdmission, type FeedbackExecutorServiceOptions } from './FeedbackExecutorService.js';
import { resolveExecuteConfig } from './executePolicy.js';
import { SandboxRuntimeRunner } from './ConfinedRunner.js';
import { DepsCache } from './depsCache.js';
import { GhGateway, SafeAttemptGit, type AttemptGit, type GitHubGateway } from './executorPorts.js';
import { SecretStore } from '../../core/SecretStore.js';
import { secretKeyPaths } from '../../core/SecretSync.js';
import { OPEN_PR_STATES } from './FeedbackExecuteStore.js';

const execFileAsync = promisify(execFile);

/** The `triggeredBy` every executor-started session carries. */
export const FEEDBACK_EXECUTOR_TRIGGER = 'feedback-executor';

export interface FeedbackExecuteRouteContext {
  service: FeedbackExecutorService;
  store: FeedbackExecuteStore;
  ownerMachineId: () => string | null;
  isCanonicalOwner: () => boolean;
  fetchFromOwner: (route: string) => Promise<{ status: number; body: unknown } | null>;
  ownerCache: Map<string, { body: unknown; fetchedAt: number }>;
}

/** True when `dir` is a git checkout of the instar source (the default source repository). */
export function isInstarSourceCheckout(dir: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string };
    return pkg.name === 'instar' && fs.existsSync(path.join(dir, '.git'));
  } catch { return false; } // @silent-fallback-ok: an unreadable manifest is not a source checkout → no-source-repo
}

/**
 * The Playwright profile registry's accounts and the owned-identities registry, read-only (names
 * only). A registry file that EXISTS but cannot be parsed is reported as unreadable — the executor
 * then treats the approver as not independent (fail closed), never as "no accounts".
 */
const vaultNamesCache = new Map<string, { mtimeMs: number; size: number; names: string[] }>();

/**
 * The agent vault's key NAMES (never values), cached by the vault file's mtime and size. No vault
 * file → `[]` (nothing to match); a vault that exists but cannot be decrypted → null, which the
 * review gate treats as NOT independent (an unreadable vault proves nothing).
 */
export function readVaultNames(stateDir: string, read: () => unknown = () => new SecretStore({ stateDir }).read()): string[] | null {
  const vaultPath = path.join(stateDir, 'secrets', 'config.secrets.enc');
  let st: fs.Stats;
  try { st = fs.statSync(vaultPath); } catch { return []; } // @silent-fallback-ok: no vault → no names to match (readable, empty)
  const cached = vaultNamesCache.get(vaultPath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.names;
  try {
    // The decrypted object is not retained beyond this traversal; only key names leave it.
    const names = secretKeyPaths(read() as Parameters<typeof secretKeyPaths>[0]);
    vaultNamesCache.set(vaultPath, { mtimeMs: st.mtimeMs, size: st.size, names });
    return names;
  } catch { vaultNamesCache.delete(vaultPath); return null; } // @silent-fallback-ok: unreadable → not independent (fail closed)
}

export function readIdentityFacts(stateDir: string, readVault: () => string[] | null = () => readVaultNames(stateDir)): { profileAccounts: Array<{ service: string; identity: string; vaultRefs: string[] }>; ownedIdentities: Array<{ service: string; identity: string }>; vaultNames: string[] | null; unreadableSources: string[] } {
  const profileAccounts: Array<{ service: string; identity: string; vaultRefs: string[] }> = [];
  const unreadableSources: string[] = [];
  const read = (file: string, label: string): unknown => {
    if (!fs.existsSync(file)) return null;
    // RULE 3: EXEMPT — reads the agent's own registry files (stable local JSON contracts), never a provider's state.
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { unreadableSources.push(label); return null; } // @silent-fallback-ok: recorded as unreadable → fail closed
  };
  const reg = read(path.join(stateDir, 'state', 'playwright-profiles.json'), 'playwright-profiles') as { profiles?: Array<{ accounts?: Array<{ service?: string; identity?: string; vaultRefs?: string[] }> }> } | null;
  if (reg !== null && (typeof reg !== 'object' || (reg.profiles !== undefined && !Array.isArray(reg.profiles)))) unreadableSources.push('playwright-profiles');
  for (const profile of Array.isArray(reg?.profiles) ? reg!.profiles! : []) for (const a of profile.accounts ?? []) {
    if (typeof a.service === 'string' && typeof a.identity === 'string') profileAccounts.push({ service: a.service, identity: a.identity, vaultRefs: Array.isArray(a.vaultRefs) ? a.vaultRefs.map(String) : [] });
  }
  const ownedIdentities: Array<{ service: string; identity: string }> = [];
  const owned = read(path.join(stateDir, 'owned-identities.json'), 'owned-identities');
  if (owned !== null && !Array.isArray(owned)) unreadableSources.push('owned-identities');
  if (Array.isArray(owned)) for (const o of owned) {
    const entry = o as { service?: string; identity?: string };
    if (typeof entry.service === 'string' && typeof entry.identity === 'string') ownedIdentities.push({ service: entry.service, identity: entry.identity });
  }
  return { profileAccounts, ownedIdentities, vaultNames: readVault(), unreadableSources };
}

export function buildFeedbackExecutor(input: {
  config: InstarConfig;
  drainStore: FeedbackDrainStore;
  triage: FeedbackTriageRouteContext;
  processing: FeedbackProcessingService;
  initiativeTracker: InitiativeTracker;
  sessionManager: SessionManager | null;
  selfMachineId: string;
  ownerMachineId: () => string | null;
  ownerEpoch: () => number;
  isCanonicalOwner: () => boolean;
  enabled: () => boolean;
  quotaShedding: () => boolean;
  updatePending: () => boolean;
  raiseAttention: (item: AttentionInput) => Promise<void>;
  tunnelUrl: () => string | null;
  overrides?: Partial<Pick<FeedbackExecutorServiceOptions, 'git' | 'github' | 'runner' | 'deps' | 'sessions' | 'admission' | 'identityFacts' | 'commitIdentity' | 'clock' | 'sleep' | 'sessionWaitMs'>> & { homeDir?: string };
}): FeedbackExecuteRouteContext {
  const { config } = input;
  const agentHome = path.resolve(config.projectDir);
  const clock = input.overrides?.clock ?? Date.now;
  const store = new FeedbackExecuteStore(input.drainStore, input.triage.store, { clock });
  const executeStateDir = path.join(config.stateDir, 'state', 'feedback-factory', 'execute');
  const resolveConfig = () => resolveExecuteConfig(config.feedbackFactory?.execute as Record<string, unknown> | undefined, agentHome, isInstarSourceCheckout);
  const runner = input.overrides?.runner ?? new SandboxRuntimeRunner({ settingsDir: path.join(executeStateDir, 'srt-settings') });
  const testRunnerHoldersFile = path.join(os.homedir(), '.instar', 'host-test-runner-holders.json');
  const deps = input.overrides?.deps ?? new DepsCache({
    root: path.join(agentHome, '.worktrees', '.feedback-deps'), agentHome, trashRoot: path.join(executeStateDir, 'trash'), runner, testRunnerHoldersFile,
  });
  const ghPath = 'gh';
  const github = input.overrides?.github ?? new GhGateway({ ghPath, cwd: config.stateDir, safeMergeScript: path.join(resolveConfig().sourceRepoPath ?? agentHome, 'scripts', 'safe-merge.mjs') });

  const sm = input.sessionManager;
  let cachedFrameworkVersion: { value: string | null; at: number } | null = null;
  const sessions: ConfinedSessionPort = input.overrides?.sessions ?? {
    async spawnConfined(spawn) {
      if (!sm) throw new Error('confinement-unavailable: no session manager');
      // A fixed --session-id: the transcript lands at a known name, so the canary can judge what
      // actually reached the model from it.
      const sessionUuid = randomUUID();
      const session = await sm.spawnSession({ name: spawn.name, prompt: spawn.prompt, cwd: spawn.cwd, omitAuthEnv: true, framework: 'claude-code', sessionId: sessionUuid,
        confinement: { framework: 'claude-code', settingsPath: spawn.settingsPath, tmpDir: spawn.tmpDir }, maxDurationMinutes: spawn.maxDurationMinutes, triggeredBy: FEEDBACK_EXECUTOR_TRIGGER });
      return { sessionName: session.tmuxSession, sessionId: session.id, transcript: session.confinedConfigHome ? { configHome: session.confinedConfigHome, sessionUuid } : null };
    },
    plannedSessionName: (name) => (sm ? sm.plannedTmuxSessionName(name) : name),
    async spawnTrusted(spawn) {
      if (!sm) throw new Error('no session manager');
      // triggeredBy marks it for the Playwright profile route, which refuses to activate a profile for it.
      const session = await sm.spawnSession({ name: spawn.name, prompt: spawn.prompt, disableProjectMcp: true, maxDurationMinutes: spawn.maxDurationMinutes, triggeredBy: FEEDBACK_EXECUTOR_TRIGGER });
      return { sessionName: session.tmuxSession, sessionId: session.id };
    },
    isAlive: (name) => (sm ? sm.isSessionAlive(name) : false),
    async stop(name) {
      if (!sm) return false;
      const session = sm.listRunningSessions().find((s) => s.tmuxSession === name);
      return session ? sm.killSession(session.id) : false;
    },
    async remoteStop(machineId, name, sessionUuid) {
      if (!sessionUuid) return false;
      try {
        const response = await fetch(`http://localhost:${config.port}/sessions/${encodeURIComponent(name)}/remote-close`, {
          method: 'POST', headers: { Authorization: `Bearer ${config.authToken ?? ''}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ machineId, sessionUuid }), signal: AbortSignal.timeout(10_000),
        });
        return response.ok;
      } catch { return false; } // @silent-fallback-ok: the caller audits a failed stop; the claim epoch fence still prevents two builds
    },
    async frameworkVersion() {
      if (cachedFrameworkVersion && clock() - cachedFrameworkVersion.at < 60 * 60_000) return cachedFrameworkVersion.value;
      let value: string | null = null;
      try { value = (await execFileAsync(config.sessions?.claudePath || 'claude', ['--version'], { timeout: 15_000 })).stdout.trim().slice(0, 80) || null; } catch { value = null; } // @silent-fallback-ok: an unknown version still stamps the canary ('unknown')
      cachedFrameworkVersion = { value, at: clock() };
      return value;
    },
  };

  const admission: ExecutorAdmission = input.overrides?.admission ?? {
    spawnLimiterSaturated: () => {
      try { const status = getHostSpawnSemaphore().status(); return status.liveHolders >= status.cap; } catch { return true; } // @silent-fallback-ok: an unreadable limiter refuses admission (safe side)
    },
    quotaShedding: input.quotaShedding,
    updatePending: input.updatePending,
  };

  const identity = input.overrides?.commitIdentity ?? (() => resolveCommitIdentity(resolveConfig().sourceRepoPath ?? agentHome, config.stateDir));

  const service = new FeedbackExecutorService({
    triageStore: input.triage.store,
    store,
    audit: input.triage.audit,
    processing: input.processing,
    initiatives: input.initiativeTracker,
    git: input.overrides?.git ?? new SafeAttemptGit(),
    github,
    runner,
    deps,
    sessions,
    admission,
    identityFacts: input.overrides?.identityFacts ?? (() => readIdentityFacts(config.stateDir)),
    rankedWork: () => input.triage.service.queue().map((item) => ({ initiativeId: String(item.initiativeId), clusterId: String(item.clusterId) })),
    enabled: input.enabled,
    config: resolveConfig,
    paths: { agentHome, stateDir: config.stateDir, configPath: path.join(config.stateDir, 'config.json'), testRunnerHoldersFile, ...(input.overrides?.homeDir ? { homeDir: input.overrides.homeDir } : {}) },
    selfMachineId: input.selfMachineId,
    ownerMachineId: input.ownerMachineId,
    ownerEpoch: input.ownerEpoch,
    isCanonicalOwner: input.isCanonicalOwner,
    commitIdentity: identity,
    ghCredentialHelper: `!${ghPath} auth git-credential`,
    raiseAttention: input.raiseAttention,
    reportDegradation: (event) => DegradationReporter.getInstance().report(event),
    dashboardLink: () => `${input.tunnelUrl() ?? `http://localhost:${config.port}`}/dashboard?tab=feedback-drain`,
    ...(input.overrides?.sleep ? { sleep: input.overrides.sleep } : {}),
    ...(input.overrides?.sessionWaitMs !== undefined ? { sessionWaitMs: input.overrides.sessionWaitMs } : {}),
    clock,
  });

  return {
    service, store, ownerMachineId: input.ownerMachineId, isCanonicalOwner: input.isCanonicalOwner,
    fetchFromOwner: input.triage.fetchFromOwner, ownerCache: new Map(),
  };
}

/**
 * The stop path when the executor itself is NOT built (triage dark or failed to start): every
 * open executor PR still has GitHub auto-merge turned off (idempotent), so turning triage off can
 * never leave an armed PR merging unattended. Read-only on the database (no owner fence is held
 * without triage); a PR that cannot be disarmed raises a HIGH Attention line.
 */
export async function disarmExecutorPrsWithoutExecutor(input: {
  drainStore: FeedbackDrainStore;
  sourceRepoPath: string | null;
  git?: Pick<AttemptGit, 'githubRemote'>;
  github?: Pick<GitHubGateway, 'disableAuto'>;
  stateDir: string;
  raiseAttention: (item: AttentionInput) => Promise<void>;
}): Promise<{ checked: number; disarmed: number; failed: number }> {
  const db = input.drainStore.sharedDatabase();
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='execution'").get();
  if (!table) return { checked: 0, disarmed: 0, failed: 0 };
  const states = [...OPEN_PR_STATES];
  const rows = db.prepare(`SELECT attempt_id AS attemptId, pr_number AS prNumber FROM execution WHERE pr_number IS NOT NULL AND state IN (${states.map(() => '?').join(',')})`).all(...states) as Array<{ attemptId: string; prNumber: number }>;
  if (rows.length === 0) return { checked: 0, disarmed: 0, failed: 0 };
  const git = input.git ?? new SafeAttemptGit();
  const github = input.github ?? new GhGateway({ cwd: input.stateDir, safeMergeScript: path.join(input.sourceRepoPath ?? input.stateDir, 'scripts', 'safe-merge.mjs') });
  const slug = input.sourceRepoPath ? (await git.githubRemote(input.sourceRepoPath))?.slug ?? null : null;
  let disarmed = 0;
  let failed = 0;
  for (const row of rows) {
    const ok = slug ? await github.disableAuto(slug, row.prNumber) : false;
    if (ok) { disarmed++; continue; }
    failed++;
    try {
      await input.raiseAttention({ id: `feedback-execute:disarm-failed:${row.attemptId}:executor-not-built`, title: `Could not disarm auto-merge on PR #${row.prNumber}`,
        summary: `Feedback triage is off, so the feedback executor is not running, and GitHub auto-merge could not be confirmed off for PR #${row.prNumber}. Disable it on GitHub directly.`,
        category: 'monitoring', priority: 'HIGH', sourceContext: 'feedback-execute:disarm' });
    } catch { /* @silent-fallback-ok: the boot log line below still records the failure */ }
  }
  return { checked: rows.length, disarmed, failed };
}

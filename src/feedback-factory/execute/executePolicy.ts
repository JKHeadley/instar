/**
 * Feedback executor policy (docs/specs/feedback-triage-and-execution.md §4).
 *
 * Pure constants and builders: the live config, the tooling/protected path list the diff
 * gate refuses, and the ONE confinement policy applied two ways — as a Claude Code
 * `--settings` file for the build session, and as a sandbox-runtime settings file for every
 * command the executor itself runs inside the session workspace. Nothing here performs I/O.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROTECTED_PATH_PREFIXES } from '../../monitoring/greenPrAutomergeWiring.js';
import { CLAUDE_CONFINED_PERMISSION_ARGS, isCredentialEnvName } from '../../core/credentialEnvNames.js';

export { CLAUDE_CONFINED_PERMISSION_ARGS, isCredentialEnvName };

export const HOUR_MS = 60 * 60_000;
export const DAY_MS = 24 * HOUR_MS;
/** Claim lease (§4 step 2). A session's wall clock never exceeds it. */
export const EXECUTION_LEASE_MS = 6 * HOUR_MS;
/** Each confined test or gate run (§4 step 4, resource limits). */
export const CONFINED_COMMAND_TIMEOUT_MS = 20 * 60_000;
/** Captured output per confined command. */
export const CONFINED_OUTPUT_CAP_BYTES = 5 * 1024 * 1024;
/** Workspace plus temp directory, checked between steps. */
export const WORKSPACE_DISK_CAP_BYTES = 2 * 1024 * 1024 * 1024;
/** Change set caps (§4 step 8). */
export const CHANGESET_MAX_FILES = 200;
export const CHANGESET_MAX_BYTES = 2 * 1024 * 1024;
/** Result file notes cap (§4 step 7). */
export const RESULT_NOTES_MAX = 1_000;
/** merge-armed confirmation deadline and the single merge retry delay (§4 step 9). */
export const MERGE_ARMED_DEADLINE_MS = 24 * HOUR_MS;
export const MERGE_RETRY_DELAY_MS = HOUR_MS;
/** verify: the cluster must stay quiet this long after the fix ships in a release. */
export const VERIFY_QUIET_MS = 30 * DAY_MS;
/** Dependency install retry ladder (§4 step 3). */
export const DEPS_RETRY_LADDER_MS = [30 * 60_000, HOUR_MS, 4 * HOUR_MS] as const;
/** The summary must show deps-unavailable within this long. */
export const DEPS_STATUS_LATENCY_MS = 300_000;
export const EXECUTE_TICK_MIN_INTERVAL_MS = 30_000;
/** Bump when a canary probe changes: a new stamp forces a fresh full-gate base canary. */
export const CANARY_VERSION = 'feedback-canary-v1';
/** The exact sandbox runtime version this feature is pinned to (package.json pins the same). */
export const SANDBOX_RUNTIME_PACKAGE = '@anthropic-ai/sandbox-runtime';
export const SANDBOX_RUNTIME_VERSION = '0.0.77';
export const EVIDENCE_FILE = '.feedback-evidence.json';
export const RESULT_FILE = '.feedback-result.json';
export const HOLD_LABEL = 'hold';
/** Native modules built from the base SHA (the pinned allow-list, §4 step 3). */
export const NATIVE_REBUILD_ALLOWLIST = ['better-sqlite3', 'sqlite-vec'] as const;
/** Hosts the native rebuild step alone may reach (prebuilt binaries and headers). */
export const NATIVE_REBUILD_NETWORK = ['registry.npmjs.org', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'nodejs.org'] as const;

export interface ExecuteLiveConfig {
  /**
   * Dry run (the default, a conservative choice recorded in the side-effects artifact): the
   * executor evaluates admission and preconditions and records the attempt it WOULD start, but
   * spawns nothing, pushes nothing and merges nothing. `dryRun: false` is the operator's flip.
   */
  dryRun: boolean;
  sourceRepoPath: string | null;
  maxConcurrent: number;
  maxStartsPerDay: number;
  maxOpenPrs: number;
  /** The repository's lint gate, run confined in the workspace (fixed path, step c). */
  lintCommand: string;
  /** A small, bounded test smoke the base canary runs once per stamp (an always-red environment cannot pass). */
  baseSmokeTests: string[];
  /** Session wall clock in minutes (≤ the lease). */
  maxDurationMinutes: number;
  /**
   * The fork (`owner/name`) every attempt branch is pushed to; the pull request is opened from it
   * against the canonical repository. A fork PR gets a read-only GITHUB_TOKEN and no repository
   * secrets in CI, so code the session wrote never runs with the canonical repository's
   * credentials before review. Unset, or equal to the canonical repository, the executor refuses
   * to publish (`publish-fork-unset`).
   */
  publishRepo: string | null;
  actionTopicId?: number;
}

export const EXECUTE_CONFIG_DEFAULTS = {
  maxConcurrent: 2,
  maxStartsPerDay: 6,
  maxOpenPrs: 4,
  lintCommand: 'npm run lint',
  baseSmokeTests: ['tests/unit/feedback-factory/triage-floors.test.ts'],
  maxDurationMinutes: 300,
} as const;

export function resolveExecuteConfig(raw: Record<string, unknown> | undefined, agentHome: string, isSourceCheckout: (dir: string) => boolean): ExecuteLiveConfig {
  const int = (v: unknown, dflt: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : dflt;
  };
  const configured = typeof raw?.sourceRepoPath === 'string' && raw.sourceRepoPath.trim() ? path.resolve(raw.sourceRepoPath) : null;
  const sourceRepoPath = configured ?? (isSourceCheckout(agentHome) ? path.resolve(agentHome) : null);
  const topic = Number(raw?.actionTopicId);
  const publish = typeof raw?.publishRepo === 'string' && /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(raw.publishRepo.trim()) ? raw.publishRepo.trim() : null;
  const smoke = Array.isArray(raw?.baseSmokeTests) ? (raw!.baseSmokeTests as unknown[]).filter((t): t is string => typeof t === 'string' && /^tests\/[\w./-]+$/.test(t)).slice(0, 10) : null;
  return {
    dryRun: raw?.dryRun !== false,
    sourceRepoPath,
    maxConcurrent: int(raw?.maxConcurrent, EXECUTE_CONFIG_DEFAULTS.maxConcurrent, 0, 10),
    maxStartsPerDay: int(raw?.maxStartsPerDay, EXECUTE_CONFIG_DEFAULTS.maxStartsPerDay, 0, 50),
    maxOpenPrs: int(raw?.maxOpenPrs, EXECUTE_CONFIG_DEFAULTS.maxOpenPrs, 0, 50),
    lintCommand: typeof raw?.lintCommand === 'string' && raw.lintCommand.trim() ? raw.lintCommand.trim().slice(0, 300) : EXECUTE_CONFIG_DEFAULTS.lintCommand,
    baseSmokeTests: smoke && smoke.length > 0 ? smoke : [...EXECUTE_CONFIG_DEFAULTS.baseSmokeTests],
    maxDurationMinutes: int(raw?.maxDurationMinutes, EXECUTE_CONFIG_DEFAULTS.maxDurationMinutes, 10, EXECUTION_LEASE_MS / 60_000),
    publishRepo: publish,
    ...(Number.isSafeInteger(topic) && topic !== 0 ? { actionTopicId: topic } : {}),
  };
}

// ── Diff gate: tooling and protected paths (§4 step 8) ───────────────────────

const TOOLING_PREFIXES = ['.husky/', 'scripts/', '.github/', '.claude/', 'src/feedback-factory/execute/'];
const TOOLING_BASENAMES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock',
  '.gitattributes', '.gitmodules', '.npmrc', '.yarnrc', '.yarnrc.yml', '.mcp.json', '.nvmrc', '.node-version', 'Makefile', 'makefile',
  '.lintstagedrc', '.prettierrc', '.editorconfig',
]);
const TOOLING_PATTERNS = [
  /(^|\/)(vitest|jest|playwright|vite|tsup|esbuild|rollup|webpack|babel|eslint|prettier|commitlint|lint-staged|stylelint)(\.[\w-]+)*\.(config|workspace)\.[cm]?[jt]s(on)?$/i,
  /(^|\/)vitest\.workspace\.[\w]+$/i, /(^|\/)tsconfig[\w.-]*\.json$/i, /(^|\/)\.(babelrc|eslintrc|lintstagedrc|prettierrc|commitlintrc)[\w.]*$/i,
  /(^|\/)\.env(\.[\w-]+)?$/i,
];

/** True when a change to `relPath` must never reach a PR without the operator. */
export function isToolingPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (TOOLING_PREFIXES.some((prefix) => p === prefix.slice(0, -1) || p.startsWith(prefix))) return true;
  if (PROTECTED_PATH_PREFIXES.some((prefix) => (prefix.endsWith('/') ? p.startsWith(prefix) : p === prefix))) return true;
  const base = p.split('/').pop() ?? p;
  if (TOOLING_BASENAMES.has(base)) return true;
  return TOOLING_PATTERNS.some((re) => re.test(p));
}

// ── The confinement policy (§4 step 4) ───────────────────────────────────────

export interface ConfinementPaths {
  /** The session workspace: the only writable tree (minus its .git/ and the evidence file). */
  workspace: string;
  /** Per-attempt temp directory (TMPDIR for every confined command). */
  tmpDir: string;
  /** The read-only dependency cache the workspace's node_modules points at. */
  depsCache: string;
  /** The agent home (reads denied except the workspace and the dependency cache). */
  agentHome: string;
  /** The publish clone: no access at all from inside the sandbox. */
  publishClone: string;
  /** The host test-runner holders file (writable so the concurrency cap keeps working). */
  testRunnerHoldersFile: string;
  /** The user's home directory (for credential paths). */
  homeDir?: string;
}

/** Credential locations a confined process may never read. */
export function credentialReadDenies(homeDir: string = os.homedir()): string[] {
  const h = (rel: string) => path.join(homeDir, rel);
  return [
    h('.config'), h('.ssh'), h('.claude'), h('.claude.json'), h('.codex'), h('.aws'), h('.gnupg'), h('.docker'),
    h('.npmrc'), h('.netrc'), h('.git-credentials'), h('.gitconfig'), h('.kube'), h('Library/Keychains'),
    h('Library/Application Support/Claude'), h('.local/share/keyrings'),
  ];
}

export interface SandboxRuntimeSettings {
  network: { allowedDomains: string[]; deniedDomains: string[]; allowLocalBinding: boolean; allowUnixSockets: string[] };
  filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[]; denyWrite: string[] };
  enableWeakerNestedSandbox: false;
  enableWeakerNetworkIsolation: false;
  allowAppleEvents: false;
}

/**
 * The sandbox-runtime settings for executor-run commands. Reads: denied across the agent home
 * and the credential locations, re-allowed only for the workspace and the dependency cache
 * (sandbox-runtime gives allowRead precedence inside a denied region; the publish clone and
 * credential paths are more specific denies and stay denied). Writes: only the workspace, its
 * temp directory and the test-runner holders file, never its .git/ or the evidence file.
 * Network: empty allowlist (strict), unless the caller is the native-rebuild step.
 */
export function buildSandboxRuntimeSettings(p: ConfinementPaths, opts: { network?: readonly string[]; extraWrite?: string[] } = {}): SandboxRuntimeSettings {
  const workspaceGit = path.join(p.workspace, '.git');
  return {
    network: { allowedDomains: [...(opts.network ?? [])], deniedDomains: [], allowLocalBinding: false, allowUnixSockets: [] },
    filesystem: {
      // The WHOLE home directory and the shared temp directories are read-denied (other agents'
      // homes, follow-me config homes, sign-in files, shell history, other users' temp files);
      // only the attempt's own trees are re-allowed. The toolchain lives outside home.
      denyRead: [...new Set([p.homeDir ?? os.homedir(), p.agentHome, p.publishClone, ...credentialReadDenies(p.homeDir), ...systemTempDenies(p.workspace)])],
      allowRead: [p.workspace, p.depsCache, p.tmpDir],
      allowWrite: [p.workspace, p.tmpDir, ...testRunnerSemaphoreFiles(p.testRunnerHoldersFile), ...(opts.extraWrite ?? [])],
      denyWrite: [workspaceGit, path.join(p.workspace, EVIDENCE_FILE), path.join(p.workspace, '.claude'), p.depsCache, p.publishClone, ...systemTempDenies(p.workspace)],
    },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
  };
}

/**
 * Shared system temp directories. Claude Code's sandbox allows writes there by default; the policy
 * allows only the attempt's own temp directory, so the shared ones are denied (unless one is an
 * ancestor of the workspace, which never holds in production where the workspace is under the
 * agent home).
 */
export function systemTempDenies(workspace: string): string[] {
  const candidates = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp'];
  try { candidates.push(fs.realpathSync(os.tmpdir())); } catch { candidates.push(os.tmpdir()); } // @silent-fallback-ok: the unresolved temp path is still denied
  const ws = path.resolve(workspace);
  return [...new Set(candidates)].filter((dir) => !ws.startsWith(`${path.resolve(dir)}${path.sep}`));
}

/**
 * The host test-runner semaphore's working files beside its holders file (holders, lock, witness
 * directory, event ledger), so the concurrency cap keeps working for confined test runs. Its
 * tuning files stay read-only.
 */
export function testRunnerSemaphoreFiles(holdersFile: string): string[] {
  const dir = path.dirname(holdersFile);
  return [holdersFile, path.join(dir, 'host-test-runner-holders.lock'), path.join(dir, 'host-test-runner-witness'), path.join(dir, 'host-test-runner-events.jsonl')];
}

/**
 * Claude Code permission paths use `//abs/path` for absolute paths. Claude Code applies deny
 * rules before allow rules, so a parent deny would also deny the workspace inside it; instead
 * the agent home's siblings of the workspace are denied one by one (`listChildren`), enumerated
 * at spawn time. The canary checks the result before every attempt.
 */
function abs(p: string): string { return `/${path.resolve(p)}`; }

export interface ClaudeSettingsInput {
  paths: ConfinementPaths;
  /** Entries directly under the agent home (enumerated by trusted code just before spawn). */
  agentHomeChildren: string[];
  /** Entries directly under `<agent home>/.worktrees/`. */
  worktreeChildren: string[];
}

export function buildClaudeSandboxSettings(input: ClaudeSettingsInput): Record<string, unknown> {
  const p = input.paths;
  const worktrees = path.join(p.agentHome, '.worktrees');
  const allowedUnderWorktrees = new Set([path.resolve(p.workspace), path.resolve(path.dirname(p.depsCache)), path.resolve(p.depsCache), path.resolve(p.tmpDir)]);
  const deniedPaths = new Set<string>();
  for (const child of input.agentHomeChildren) {
    const full = path.resolve(p.agentHome, child);
    if (full === path.resolve(worktrees)) continue;
    deniedPaths.add(full);
  }
  for (const child of input.worktreeChildren) {
    const full = path.resolve(worktrees, child);
    if (allowedUnderWorktrees.has(full)) continue;
    deniedPaths.add(full);
  }
  deniedPaths.add(path.resolve(p.publishClone));
  for (const c of credentialReadDenies(p.homeDir)) deniedPaths.add(path.resolve(c));
  // The session runs in `dontAsk` permission mode (CLAUDE_CONFINED_PERMISSION_ARGS): anything not
  // allowed below is refused, including paths created after spawn. The deny rules are defence in
  // depth (deny always wins; Edit rules cover every file-writing tool). No broad `dir/*` deny:
  // permission patterns follow gitignore rules, where `.worktrees/*` would also deny the
  // workspace and temp directory beneath it (the live canary showed exactly that).
  const deny: string[] = ['WebFetch', 'WebSearch', 'mcp__*'];
  for (const d of [...deniedPaths].sort()) deny.push(`Read(${abs(d)}/**)`, `Read(${abs(d)})`, `Edit(${abs(d)}/**)`, `Edit(${abs(d)})`);
  // The dependency cache (and every cache beside it) is read-only, and the workspace's
  // node_modules link points into it: an Edit/Write through either path is denied explicitly, so a
  // file tool can never write into the shared cache even where it resolves the link.
  for (const d of [path.join(p.workspace, '.git'), path.join(p.workspace, '.claude'), path.join(p.workspace, 'node_modules'), p.depsCache, path.dirname(p.depsCache)]) {
    deny.push(`Edit(${abs(d)}/**)`, `Edit(${abs(d)})`);
  }
  deny.push(`Edit(${abs(path.join(p.workspace, EVIDENCE_FILE))})`);
  const runtime = buildSandboxRuntimeSettings(p);
  // Claude Code keeps its own shell bookkeeping in its temp directory; the confined spawn points
  // that at the attempt's temp directory (CLAUDE_CODE_TMPDIR), which also takes the shared system
  // temp out of the session's writable set. An explicit system-temp deny here would break that
  // bookkeeping (every Bash call then reports a failure), so it is left to CLAUDE_CODE_TMPDIR and
  // verified by the session canary's system-temp probe.
  const tempDenies = new Set(systemTempDenies(p.workspace));
  const filesystem = { ...runtime.filesystem, denyWrite: runtime.filesystem.denyWrite.filter((d) => !tempDenies.has(d)) };
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      network: { allowedDomains: [], allowLocalBinding: false, allowUnixSockets: [] },
      filesystem,
    },
    permissions: {
      defaultMode: 'dontAsk',
      deny,
      allow: [
        'Bash', 'TodoWrite',
        `Read(${abs(p.workspace)}/**)`, `Edit(${abs(p.workspace)}/**)`,
        `Read(${abs(p.tmpDir)}/**)`, `Edit(${abs(p.tmpDir)}/**)`,
        `Read(${abs(p.depsCache)}/**)`,
      ],
      additionalDirectories: [],
    },
    enableAllProjectMcpServers: false,
    hooks: {},
    env: { TMPDIR: p.tmpDir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  };
}


/**
 * `omitAuthEnv`: the environment a confined command gets. Starts from a minimal allow-list
 * (PATH, HOME, LANG, TERM, SHELL, USER) rather than the full parent environment, then drops
 * anything credential-shaped even from that list.
 */
export function confinedEnv(parent: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'USER', 'LOGNAME', 'NODE_OPTIONS_SAFE'];
  const out: Record<string, string> = {};
  for (const key of keep) {
    const value = parent[key];
    if (typeof value === 'string' && !isCredentialEnvName(key)) out[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (isCredentialEnvName(key)) continue;
    out[key] = value;
  }
  out.CI = '1';
  out.GIT_CONFIG_NOSYSTEM = '1';
  out.GIT_CONFIG_GLOBAL = '/dev/null';
  out.GIT_TERMINAL_PROMPT = '0';
  return out;
}


/**
 * The fork an attempt publishes to, or null when publication must be refused: no fork is
 * configured, or the configured repository IS the canonical one (a same-repository branch would
 * run CI with the canonical repository's secrets).
 */
export function publishFork(cfg: Pick<ExecuteLiveConfig, 'publishRepo'>, canonicalSlug: string): { slug: string; owner: string } | null {
  const fork = cfg.publishRepo;
  if (!fork || fork.toLowerCase() === canonicalSlug.toLowerCase()) return null;
  return { slug: fork, owner: fork.split('/')[0] };
}

/** The branch an attempt publishes on — outside Green-PR Auto-Merge's namespace. */
export function attemptBranch(initiativeId: string, attempt: number): string {
  // pathSlug carries a hash, so two different initiative ids can never share a branch.
  return `feedback/${pathSlug(initiativeId)}-a${attempt}`;
}

export function safeSlug(value: string): string {
  return String(value).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
}

/** A short, collision-resistant directory stem for an item (unix socket paths under it stay short). */
export function pathSlug(initiativeId: string): string {
  const hash = createHash('sha256').update(String(initiativeId)).digest('hex').slice(0, 8);
  return `${safeSlug(initiativeId).slice(0, 24).replace(/-+$/, '')}-${hash}`;
}

export function attemptId(initiativeId: string, attempt: number): string {
  return `${initiativeId}:a${attempt}`;
}

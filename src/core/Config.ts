/**
 * Auto-detection and configuration management.
 *
 * Finds tmux, Claude CLI, and project structure automatically.
 * Adapted from dawn-server's config.ts — the battle-tested version.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeConfigWithSecrets } from './SecretMigrator.js';
import os from 'node:os';
import type { InstarConfig, SessionManagerConfig, JobSchedulerConfig, FeedbackConfig, AgentType } from './types.js';

const DEFAULT_PORT = 4040;
const DEFAULT_MAX_SESSIONS = 10;
const DEFAULT_MAX_PARALLEL_JOBS = 2;

export function getInstarVersion(): string {
  try {
    // Walk up from this file to find package.json
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++) {
      const pkgPath = path.join(dir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === 'instar') return pkg.version;
      }
      dir = path.dirname(dir);
    }
  } catch {
    // @silent-fallback-ok — version detection defaults to 0.0.0
  }
  return '0.0.0';
}

export function detectGitPath(): string | null {
  const candidates = [
    '/usr/bin/git',
    '/opt/homebrew/bin/git',  // macOS ARM (Homebrew)
    '/usr/local/bin/git',     // macOS Intel / Linux
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Fallback: check PATH
  try {
    const result = execFileSync('which', ['git'], { encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch {
    // @silent-fallback-ok — git path detection
  }

  return null;
}

export function detectGhPath(): string | null {
  const candidates = [
    '/opt/homebrew/bin/gh',   // macOS ARM (Homebrew)
    '/usr/local/bin/gh',      // macOS Intel / Linux
    '/usr/bin/gh',            // Linux system
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Fallback: check PATH
  try {
    const result = execFileSync('which', ['gh'], { encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch {
    // @silent-fallback-ok — gh path detection
  }

  return null;
}

export function detectTmuxPath(): string | null {
  const candidates = [
    '/opt/homebrew/bin/tmux',  // macOS ARM (Homebrew)
    '/usr/local/bin/tmux',     // macOS Intel / Linux
    '/usr/bin/tmux',           // Linux system
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Fallback: check PATH
  try {
    const result = execFileSync('which', ['tmux'], { encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch {
    // @silent-fallback-ok — tmux path detection loop
  }

  return null;
}

/**
 * Per-framework CLI binary identifiers.
 *
 * Provider-portability v1.0.0: every framework Instar can drive has its
 * own CLI binary. `detectFrameworkBinary` locates it across the common
 * install paths (npm-global, Homebrew, nvm/fnm, system PATH) without
 * baking any single absolute path into the codebase. Add a framework
 * here and detection works automatically.
 */
export type FrameworkBinary =
  | 'claude'      // Claude Code CLI
  | 'codex'       // OpenAI Codex CLI
  | 'gemini'      // Gemini CLI
  | 'aider'       // Aider
  | 'goose'       // Block Goose
  | 'cursor-cli'  // Cursor CLI
  | 'opencode'    // OpenCode
  | 'plandex';    // Plandex

/**
 * Generic framework binary detection. Searches:
 *   1. Framework-specific install location (e.g. `~/.claude/local/claude`)
 *   2. Standard system paths (`/usr/local/bin`, `/opt/homebrew/bin`)
 *   3. npm global bin (where `npm install -g` lands)
 *   4. nvm-managed bin directories
 *   5. asdf shims (`$ASDF_DATA_DIR/shims` or `~/.asdf/shims`) + `asdf which`
 *   6. System PATH (via `which`)
 *
 * Returns the absolute path or null if not found.
 *
 * Never hardcodes developer-specific install paths — the result depends
 * on what's installed on THIS machine, not where the binary lives on
 * the developer's machine.
 */
// Per-process memo. Binary locations don't change within a process lifetime, and
// loadConfig (the main caller) runs both detectClaudePath + detectCodexPath on every
// invocation — uncached, a Claude-only host paid the full asdf/which subprocess cost
// for codex on every config load. Cache positive AND negative results.
const _frameworkBinaryCache = new Map<FrameworkBinary, string | null>();

/** Test-only: clear the detection memo. */
export function _resetFrameworkBinaryCache(): void {
  _frameworkBinaryCache.clear();
}

export function detectFrameworkBinary(name: FrameworkBinary): string | null {
  const cached = _frameworkBinaryCache.get(name);
  if (cached !== undefined) return cached;
  const result = detectFrameworkBinaryUncached(name);
  _frameworkBinaryCache.set(name, result);
  return result;
}

function detectFrameworkBinaryUncached(name: FrameworkBinary): string | null {
  const home = process.env.HOME || '';
  const candidates: string[] = [];

  // Framework-specific known locations.
  switch (name) {
    case 'claude':
      candidates.push(path.join(home, '.claude', 'local', 'claude'));
      break;
    case 'codex':
      candidates.push(path.join(home, '.codex', 'bin', 'codex'));
      break;
    case 'gemini':
      candidates.push(path.join(home, '.gemini', 'bin', 'gemini'));
      break;
    default:
      // No framework-specific path; falls through to system + PATH.
      break;
  }

  // Standard system locations.
  candidates.push(`/opt/homebrew/bin/${name}`); // macOS ARM
  candidates.push(`/usr/local/bin/${name}`);    // macOS Intel / Linux
  candidates.push(`/usr/bin/${name}`);           // Linux system

  // npm global bin (where `npm install -g <pkg>` lands).
  try {
    const npmPrefix = execFileSync('npm', ['config', 'get', 'prefix'], {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    if (npmPrefix) candidates.push(path.join(npmPrefix, 'bin', name));
  } catch {
    // @silent-fallback-ok — npm prefix detection
  }

  // nvm-managed bin.
  if (process.env.NVM_BIN) {
    candidates.push(path.join(process.env.NVM_BIN, name));
  }

  // nvm version dirs. nvm installs node — and globally-installed CLIs like the
  // `claude`/`codex` binaries — under ~/.nvm/versions/node/<version>/bin, and the
  // launchd/login PATH frequently excludes that dir (same reason the asdf shim
  // search below exists) with NVM_BIN unset outside an nvm-initialized shell. So a
  // binary that works in the user's terminal is invisible to a server spawned by
  // launchd. Prefer the RUNNING node's version, then any other installed version
  // that has the binary. (2026-05-31: an nvm-only machine's session spawn crashed
  // because claudePath resolved to null — the binary was here but unscanned.)
  try {
    const nvmNodeRoot = path.join(home, '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmNodeRoot)) {
      candidates.push(path.join(nvmNodeRoot, process.version, 'bin', name));
      for (const ver of fs.readdirSync(nvmNodeRoot)) {
        candidates.push(path.join(nvmNodeRoot, ver, 'bin', name));
      }
    }
  } catch {
    // @silent-fallback-ok — nvm version-dir scan
  }

  // asdf-managed shims. asdf installs CLIs as shims under its data dir, and
  // the launchd/login PATH frequently excludes that dir — so a binary that
  // works in the user's interactive terminal is invisible to instar without
  // this. Prefer the SHIM (not the resolved install path) so asdf's per-dir
  // version selection (`.tool-versions`) is respected at spawn time.
  // Honors ASDF_DATA_DIR, else the default ~/.asdf.
  const asdfDataDir = process.env.ASDF_DATA_DIR || path.join(home, '.asdf');
  candidates.push(path.join(asdfDataDir, 'shims', name));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // asdf resolution probe — covers non-default shim layouts. Resolve the `asdf`
  // binary by ABSOLUTE path first: in the launchd/login environment (the very case
  // the shim search above exists for) `asdf` is itself off PATH, so `execFileSync('asdf'...)`
  // would throw and the fallback would be dead weight. Only shell out if we can locate asdf.
  const asdfBin = [
    path.join(asdfDataDir, '..', 'bin', 'asdf'),
    path.join(home, '.asdf', 'bin', 'asdf'),
    '/opt/homebrew/bin/asdf',
    '/usr/local/bin/asdf',
  ].find((p) => fs.existsSync(p));
  if (asdfBin) {
    try {
      const asdfResult = execFileSync(asdfBin, ['which', name], {
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim();
      if (asdfResult && fs.existsSync(asdfResult)) return asdfResult;
    } catch {
      // @silent-fallback-ok — name not managed by asdf
    }
  }

  // Last resort: PATH lookup.
  try {
    const result = execFileSync('which', [name], {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch {
    // @silent-fallback-ok — which fallback
  }

  return null;
}

/**
 * Detect the Claude Code CLI. Convenience wrapper preserved for
 * backwards-compat with existing call sites. New code should use
 * `detectFrameworkBinary('claude')` directly.
 */
export function detectClaudePath(): string | null {
  return detectFrameworkBinary('claude');
}

/**
 * Detect the OpenAI Codex CLI. Provider-portability v1.0.0 sibling of
 * detectClaudePath. Replaces hardcoded developer-specific path that
 * previously lived in `src/providers/adapters/openai-codex/config.ts`.
 */
export function detectCodexPath(): string | null {
  return detectFrameworkBinary('codex');
}

/**
 * Detect the Gemini CLI. Apprenticeship Step 2 sibling of
 * detectClaudePath / detectCodexPath. The known-location probe
 * (`~/.gemini/bin/gemini`) + the standard install search are already
 * wired in `detectFrameworkBinary('gemini')`; this is the convenience
 * wrapper the gemini-cli intelligence provider + config consume.
 */
export function detectGeminiPath(): string | null {
  return detectFrameworkBinary('gemini');
}

// ── Framework Prerequisite Check ───────────────────────────────────────

/**
 * Inputs to the framework-prerequisite check. Pure-function shape so the
 * check is unit-testable without spawning a real Config.load() against
 * the host filesystem.
 */
export interface FrameworkPrerequisiteInput {
  /** Framework selected by config or env. */
  configuredFramework: 'claude-code' | 'codex-cli' | 'gemini-cli';
  /** Path to claude binary if detected, else null. */
  claudePathDetected: string | null;
  /** Path to codex binary if detected, else null. */
  codexPathDetected: string | null;
  /** Path to gemini binary if detected, else null. */
  geminiPathDetected?: string | null;
}

export interface FrameworkPrerequisiteResult {
  /** True when the configured framework's binary is present. */
  satisfied: boolean;
  /**
   * Human-readable error message when satisfied=false. Includes the
   * install URL/command for the missing framework.
   */
  error?: string;
}

/**
 * Check whether the configured framework's required binary is available.
 *
 * Provider-portability v1.0.0: this replaces the v0.x unconditional
 * "Claude CLI not found" error that blocked every non-Claude install
 * at startup. Now codex-cli installs only need the codex binary,
 * claude-code installs only need the claude binary.
 */
export function checkFrameworkPrerequisite(
  input: FrameworkPrerequisiteInput,
): FrameworkPrerequisiteResult {
  switch (input.configuredFramework) {
    case 'claude-code':
      if (!input.claudePathDetected) {
        return {
          satisfied: false,
          error:
            'Claude CLI not found. INSTAR_FRAMEWORK is set to claude-code (or unset, '
            + 'which defaults to claude-code). Install from: https://docs.anthropic.com/en/docs/claude-code '
            + 'or switch frameworks via INSTAR_FRAMEWORK=codex-cli.',
        };
      }
      return { satisfied: true };
    case 'codex-cli':
      if (!input.codexPathDetected) {
        return {
          satisfied: false,
          error:
            'Codex CLI not found. INSTAR_FRAMEWORK is set to codex-cli. '
            + 'Install with: npm install -g @openai/codex',
        };
      }
      return { satisfied: true };
    case 'gemini-cli':
      if (!input.geminiPathDetected) {
        return {
          satisfied: false,
          error:
            'Gemini CLI not found. INSTAR_FRAMEWORK is set to gemini-cli. '
            + 'Install with: npm install -g @google/gemini-cli',
        };
      }
      return { satisfied: true };
    default: {
      const _exhaustive: never = input.configuredFramework;
      void _exhaustive;
      return { satisfied: false, error: 'Unknown framework' };
    }
  }
}

/**
 * Resolve the configured framework from a (possibly-undefined) config
 * file value and the current environment. Pure function so callers can
 * unit-test the resolution independently.
 */
export function resolveConfiguredFramework(
  configValue: 'claude-code' | 'codex-cli' | 'gemini-cli' | undefined,
  envValue: string | undefined,
  enabledFrameworks?: ('claude-code' | 'codex-cli' | 'gemini-cli')[],
): 'claude-code' | 'codex-cli' | 'gemini-cli' {
  // Precedence:
  //   1. sessions.framework (explicit per-install runtime override)
  //   2. INSTAR_FRAMEWORK env (explicit runtime override for this boot)
  //   3. enabledFrameworks[0] (the persisted install choice the wizard
  //      writes — this is what a codex-cli-only / gemini-cli-only agent
  //      actually has set; added in the framework-spawn-portability fix so
  //      the runtime honors the wizard's framework choice even when
  //      sessions.framework and the env are both unset)
  //   4. 'claude-code' (historical default)
  if (configValue === 'claude-code' || configValue === 'codex-cli' || configValue === 'gemini-cli') {
    return configValue;
  }
  const env = envValue?.trim().toLowerCase();
  if (env === 'codex-cli' || env === 'codex') return 'codex-cli';
  if (env === 'gemini-cli' || env === 'gemini') return 'gemini-cli';
  if (env === 'claude-code' || env === 'claude') return 'claude-code';
  const first = enabledFrameworks?.[0];
  if (first === 'claude-code' || first === 'codex-cli' || first === 'gemini-cli') return first;
  return 'claude-code';
}

// ── Provider Credentials ───────────────────────────────────────────────

/**
 * Build the credentials map from raw config file contents.
 *
 * Provider-portability v1.0.0: migrates the legacy single-provider
 * fields (`sessions.anthropicApiKey`, `sessions.anthropicBaseUrl`) into
 * the new multi-provider `credentials` map. If both are present, the
 * explicit `credentials.anthropic` wins.
 *
 * Returns a copy — never mutates the input.
 */
function buildCredentialsMap(
  sessionsConfig: Record<string, unknown> | undefined,
): Record<string, import('./types.js').ProviderCredential> | undefined {
  if (!sessionsConfig) return undefined;

  const existingMap = sessionsConfig['credentials'] as
    | Record<string, import('./types.js').ProviderCredential>
    | undefined;
  const credentials: Record<string, import('./types.js').ProviderCredential> = {
    ...(existingMap ?? {}),
  };

  // Legacy field migration: only fill in if not explicitly set.
  if (!credentials['anthropic']) {
    const legacyKey = sessionsConfig['anthropicApiKey'] as string | undefined;
    const legacyBaseUrl = sessionsConfig['anthropicBaseUrl'] as string | undefined;
    if (legacyKey || legacyBaseUrl) {
      // OAuth tokens start with `sk-ant-oat`; everything else is an API key.
      const kind: import('./types.js').ProviderCredentialKind =
        legacyKey && legacyKey.startsWith('sk-ant-oat') ? 'oauth-token' : 'api-key';
      credentials['anthropic'] = {
        kind,
        value: legacyKey ?? '',
        ...(legacyBaseUrl ? { baseUrl: legacyBaseUrl } : {}),
      };
    }
  }

  return Object.keys(credentials).length > 0 ? credentials : undefined;
}

/**
 * Look up a provider's credential. Returns null when none is configured.
 *
 * Use this in any code path that previously read `config.anthropicApiKey`
 * — the helper consults the new `credentials` map first and falls back
 * to the legacy field for 'anthropic' so existing installs continue to
 * work without migration.
 *
 * @example
 *   const cred = getProviderCredential(config, 'anthropic');
 *   if (cred?.kind === 'oauth-token') { ... }
 */
export function getProviderCredential(
  config: import('./types.js').SessionManagerConfig,
  providerId: string,
): import('./types.js').ProviderCredential | null {
  const fromMap = config.credentials?.[providerId];
  if (fromMap) return fromMap;

  // Backwards-compat for the only previously-supported provider.
  if (providerId === 'anthropic' && config.anthropicApiKey !== undefined) {
    const value = config.anthropicApiKey;
    const kind: import('./types.js').ProviderCredentialKind = value.startsWith('sk-ant-oat')
      ? 'oauth-token'
      : 'api-key';
    return {
      kind,
      value,
      ...(config.anthropicBaseUrl ? { baseUrl: config.anthropicBaseUrl } : {}),
    };
  }

  return null;
}

/**
 * Build env vars to inject into a spawned subprocess for the given
 * provider credential. Provider-aware: maps the credential to the env
 * var the framework's CLI expects.
 *
 * For Anthropic:
 *   - oauth-token → CLAUDE_CODE_OAUTH_TOKEN set, ANTHROPIC_API_KEY cleared
 *   - api-key     → ANTHROPIC_API_KEY set, CLAUDE_CODE_OAUTH_TOKEN cleared
 *   - baseUrl     → ANTHROPIC_BASE_URL set
 *
 * For OpenAI/Codex:
 *   - api-key     → OPENAI_API_KEY set
 *   - oauth-token → (no env var — Codex CLI reads its own auth.json)
 *
 * For Google/Gemini:
 *   - api-key     → GOOGLE_API_KEY set
 *
 * Returns a flat list of [`-e`, `KEY=value`, ...] suitable for tmux
 * `new-session -e KEY=VAL`. Empty if the credential is missing/unknown.
 */
export function buildProviderEnvFlags(
  providerId: string,
  credential: import('./types.js').ProviderCredential,
): ReadonlyArray<string> {
  const flags: string[] = [];
  const push = (key: string, value: string): void => {
    flags.push('-e', `${key}=${value}`);
  };

  switch (providerId) {
    case 'anthropic':
      if (credential.kind === 'oauth-token') {
        push('CLAUDE_CODE_OAUTH_TOKEN', credential.value);
        push('ANTHROPIC_API_KEY', '');
      } else {
        push('ANTHROPIC_API_KEY', credential.value);
        push('CLAUDE_CODE_OAUTH_TOKEN', '');
      }
      if (credential.baseUrl) {
        push('ANTHROPIC_BASE_URL', credential.baseUrl);
      }
      break;

    case 'openai':
      // Codex CLI reads ~/.codex/auth.json for OAuth — the subscription path
      // requires no env vars on this side. The raw-API-key path is forbidden
      // per Spec 12 Rule 1 ("OpenAI path constraints"): Codex must route via
      // ChatGPT subscription OAuth; raw OPENAI_API_KEY is not an acceptable
      // routine path. If a caller wires up an api-key credential for openai,
      // that's a misconfiguration we refuse loudly rather than silently
      // emitting the leak.
      //
      // RULE 3: EXEMPT — this OPENAI_API_KEY identifier is part of the
      // refusal text in the spec-enforcement message, not an emission of
      // the value as an env var.
      if (credential.kind === 'api-key') {
        throw new Error(
          'buildProviderEnvFlags refuses openai api-key credential: ' +
            'Spec 12 Rule 1 forbids the raw OPENAI_API_KEY path. ' +
            'Codex must route through ChatGPT subscription OAuth in ' +
            '~/.codex/auth.json. See specs/provider-portability/' +
            '12-openai-path-constraints.md for the migration path.',
        );
      }
      // OAuth path: no env vars to emit (Codex reads ~/.codex/auth.json).
      // baseUrl override remains legitimate for user-installed Codex proxies
      // (Spec 12 § "Scope clarification — user-installed proxies are
      // user-owned compatibility").
      if (credential.baseUrl) {
        push('OPENAI_BASE_URL', credential.baseUrl);
      }
      break;

    case 'google':
      if (credential.kind === 'api-key') {
        push('GOOGLE_API_KEY', credential.value);
      }
      if (credential.baseUrl) {
        push('GEMINI_BASE_URL', credential.baseUrl);
      }
      break;

    default:
      // Unknown provider — return empty. Adapters can implement their
      // own env-mapping when they register; this default is safe.
      break;
  }

  return flags;
}

export function detectProjectDir(startDir?: string): string {
  let dir = startDir || process.cwd();

  // Walk up to find a directory with CLAUDE.md or .git
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'CLAUDE.md')) || fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }

  return process.cwd();
}

/**
 * Get the path to the standalone agents directory.
 */
export function standaloneAgentsDir(): string {
  return path.join(os.homedir(), '.instar', 'agents');
}

/**
 * Resolve an agent directory from a name or path.
 *
 * Resolution order:
 * 1. If nameOrPath is an absolute path under ~/.instar/agents/ or cwd, use it
 * 2. If nameOrPath matches a standalone agent name, return ~/.instar/agents/<name>/
 * 3. If no argument, use detectProjectDir() (existing behavior)
 */
export function resolveAgentDir(nameOrPath?: string): string {
  if (!nameOrPath) {
    return detectProjectDir();
  }

  // Absolute path — verify it's under a known location
  if (path.isAbsolute(nameOrPath)) {
    const resolved = fs.realpathSync(nameOrPath);
    const agentsDir = standaloneAgentsDir();
    if (resolved.startsWith(agentsDir) || resolved === process.cwd() || resolved.startsWith(process.cwd())) {
      return resolved;
    }
    // Allow any existing directory with .instar in it
    if (fs.existsSync(path.join(resolved, '.instar', 'config.json'))) {
      return resolved;
    }
    throw new Error(`Path "${nameOrPath}" does not appear to be a valid agent directory.`);
  }

  // Check if it's a standalone agent name
  const agentDir = path.join(standaloneAgentsDir(), nameOrPath);
  if (fs.existsSync(path.join(agentDir, '.instar', 'config.json'))) {
    return agentDir;
  }

  // Check global registry for the name (dynamic import to avoid circular deps)
  try {
    const registryPath = path.join(os.homedir(), '.instar', 'registry.json');
    if (fs.existsSync(registryPath)) {
      const data = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      const entries = Array.isArray(data.entries) ? data.entries : [];
      const entry = entries.find((e: { name: string }) => e.name === nameOrPath);
      if (entry?.path) return entry.path;
    }
  } catch { /* registry may not exist yet */ }

  throw new Error(
    `Agent "${nameOrPath}" not found. Check standalone agents at ${standaloneAgentsDir()}/ ` +
    `or use an absolute path.`
  );
}

export function loadConfig(projectDir?: string): InstarConfig {
  const resolvedProjectDir = projectDir || detectProjectDir();
  const configPath = path.join(resolvedProjectDir, '.instar', 'config.json');
  const stateDir = path.join(resolvedProjectDir, '.instar');

  // Load config file if it exists
  let fileConfig: Partial<InstarConfig> = {};
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
      throw new Error(
        `Failed to parse ${configPath}: ${err instanceof Error ? err.message : err}\n` +
        `Check that .instar/config.json contains valid JSON.`
      );
    }
  }

  // Merge encrypted secrets into config (replaces { "secret": true } placeholders)
  // This is transparent — single-machine users without a SecretStore see no change.
  try {
    fileConfig = mergeConfigWithSecrets(fileConfig as Record<string, unknown>, stateDir) as Partial<InstarConfig>;
  } catch {
    // Non-fatal — config works without secrets (just missing the secret values)
  }

  const tmuxPath = fileConfig.sessions?.tmuxPath || detectTmuxPath();
  // Provider-portability v1.0.0: boot requires the configured framework's
  // binary, not Claude unconditionally. resolveConfiguredFramework picks
  // from (sessions.framework | INSTAR_FRAMEWORK | default claude-code).
  // checkFrameworkPrerequisite gates startup — codex-cli installs no
  // longer get rejected just because Claude isn't installed.
  const configuredFramework = resolveConfiguredFramework(
    (fileConfig.sessions as Record<string, unknown> | undefined)?.['framework'] as
      | 'claude-code'
      | 'codex-cli'
      | undefined,
    process.env['INSTAR_FRAMEWORK'],
    // The wizard/init persists the framework choice as top-level
    // enabledFrameworks. Without this third input, a codex-cli-only
    // agent (sessions.framework + INSTAR_FRAMEWORK both unset) would
    // resolve to claude-code and spawn Claude sessions on every
    // message — the framework-portability bug.
    fileConfig.enabledFrameworks as ('claude-code' | 'codex-cli' | 'gemini-cli')[] | undefined,
  );
  const claudePathDetected = fileConfig.sessions?.claudePath || detectClaudePath();
  const codexPathDetected = detectCodexPath();
  const geminiPathDetected = detectGeminiPath();

  if (!tmuxPath) {
    throw new Error('tmux not found. Install with: brew install tmux (macOS) or apt install tmux (Linux)');
  }
  const prereq = checkFrameworkPrerequisite({
    configuredFramework,
    claudePathDetected,
    codexPathDetected,
    geminiPathDetected,
  });
  if (!prereq.satisfied) {
    throw new Error(prereq.error!);
  }

  // The SessionManagerConfig's claudePath field is kept for backwards-compat
  // with existing spawn paths; for codex-cli / gemini-cli installs it carries
  // the selected framework's binary path. Spawn paths will be migrated to read
  // `frameworkBinaryPath` (or similar) in a follow-up slice.
  const claudePath =
    configuredFramework === 'codex-cli'
      ? (codexPathDetected ?? claudePathDetected ?? '')
      : configuredFramework === 'gemini-cli'
        ? (geminiPathDetected ?? claudePathDetected ?? '')
        : (claudePathDetected ?? '');

  const projectName = fileConfig.projectName || path.basename(resolvedProjectDir);

  const sessions: SessionManagerConfig = {
    tmuxPath,
    claudePath,
    // Expose every detected framework binary so spawnInteractiveSession
    // can route a session to any framework without re-running detection.
    frameworkBinaryPaths: {
      ...(claudePathDetected ? { 'claude-code': claudePathDetected } : {}),
      ...(codexPathDetected ? { 'codex-cli': codexPathDetected } : {}),
      ...(geminiPathDetected ? { 'gemini-cli': geminiPathDetected } : {}),
    },
    // The resolved runtime framework. Both spawn paths read this as
    // the default when no per-call framework override is given, so a
    // codex-cli agent spawns Codex on EVERY path (jobs + messages).
    framework: configuredFramework,
    projectDir: resolvedProjectDir,
    maxSessions: fileConfig.sessions?.maxSessions ?? DEFAULT_MAX_SESSIONS,
    protectedSessions: fileConfig.sessions?.protectedSessions || [`${projectName}-server`],
    completionPatterns: fileConfig.sessions?.completionPatterns || [
      'has been automatically paused',
      'Session ended',
      'Interrupted by user',
    ],
    authToken: fileConfig.authToken as string | undefined,
    port: (fileConfig.port as number | undefined) ?? 4040,
    anthropicApiKey: fileConfig.sessions?.anthropicApiKey as string | undefined,
    anthropicBaseUrl: fileConfig.sessions?.anthropicBaseUrl as string | undefined,
    credentials: buildCredentialsMap(fileConfig.sessions as Record<string, unknown> | undefined),
  };

  const scheduler: JobSchedulerConfig = {
    jobsFile: fileConfig.scheduler?.jobsFile || path.join(stateDir, 'jobs.json'),
    // Default-on. Autonomous-continuity tasks (org-intent drift audits,
    // threadline sync, post-update self-healing) only fire when the
    // scheduler runs; defaulting to off silently broke continuity for
    // codex-instar agents whose configs didn't ship an explicit enabled
    // field. ConfigDefaults.ts also backfills the field idempotently in
    // PostUpdateMigrator. codex-instar audit Item 5.
    enabled: fileConfig.scheduler?.enabled ?? true,
    maxParallelJobs: fileConfig.scheduler?.maxParallelJobs ?? DEFAULT_MAX_PARALLEL_JOBS,
    quotaThresholds: fileConfig.scheduler?.quotaThresholds || {
      normal: 75,
      elevated: 85,
      critical: 92,
      shutdown: 95,
    },
    authToken: fileConfig.authToken as string | undefined,
  };

  // Auto-generate contextSigningKey if not present (persists to config file)
  let contextSigningKey = fileConfig.contextSigningKey as string | undefined;
  if (!contextSigningKey && fs.existsSync(configPath)) {
    contextSigningKey = crypto.randomBytes(32).toString('hex');
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      raw.contextSigningKey = contextSigningKey;
      fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');
    } catch {
      // Non-fatal — integrity verification will be skipped if key can't be persisted
      contextSigningKey = undefined;
    }
  }

  const host = fileConfig.host || '127.0.0.1';

  // Warn if binding to a non-loopback address without auth token
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && !fileConfig.authToken) {
    console.warn(
      `[Config] WARNING: Server binding to ${host} without authToken configured. ` +
      `This exposes the API without authentication. Set authToken in .instar/config.json.`
    );
  }

  return {
    // Spread fileConfig as base so all optional fields (safety, evolution,
    // agentAutonomy, externalOperations, autonomyProfile, notifications,
    // responseReview, inputGuard, dashboard, moltbridge, etc.) pass through.
    // Explicitly constructed fields below override the spread.
    ...fileConfig,
    projectName,
    projectDir: resolvedProjectDir,
    stateDir,
    port: fileConfig.port || DEFAULT_PORT,
    host,
    version: getInstarVersion(),
    sessions,
    scheduler,
    users: fileConfig.users || [],
    messaging: fileConfig.messaging || [],
    monitoring: {
      quotaTracking: true,
      memoryMonitoring: true,
      healthCheckIntervalMs: 30000,
      ...fileConfig.monitoring,
      // Watchdog default-enabled so compaction-idle detection runs everywhere.
      // Cost is ~free (30s poll cadence with structural process check first).
      // Without this, sessions that compact via Telegram/Slack go dead silently.
      watchdog: fileConfig.monitoring?.watchdog ?? { enabled: true },
      // Telemetry defaults: strictly opt-in
      telemetry: fileConfig.monitoring?.telemetry ?? { enabled: false },
    },
    authToken: fileConfig.authToken,
    dashboardPin: fileConfig.dashboardPin,
    relationships: fileConfig.relationships || {
      relationshipsDir: path.join(stateDir, 'relationships'),
      maxRecentInteractions: 20,
    },
    feedback: {
      enabled: true,
      webhookUrl: 'https://dawn.bot-me.ai/api/instar/feedback',
      feedbackFile: path.join(stateDir, 'feedback.json'),
      ...fileConfig.feedback,
    },
    dispatches: fileConfig.dispatches,
    updates: fileConfig.updates,
    publishing: fileConfig.publishing,
    tunnel: fileConfig.tunnel,
    threadline: fileConfig.threadline,
    agentType: resolvedProjectDir.startsWith(standaloneAgentsDir())
      ? 'standalone'
      : (fileConfig as Record<string, unknown>).agentType as AgentType | undefined || 'project-bound',
    contextSigningKey,
  };
}

/**
 * Ensure the state directory structure exists.
 */
export function ensureStateDir(stateDir: string): void {
  const dirs = [
    stateDir,
    path.join(stateDir, 'state'),
    path.join(stateDir, 'state', 'sessions'),
    path.join(stateDir, 'state', 'jobs'),
    path.join(stateDir, 'relationships'),
    path.join(stateDir, 'views'),
    path.join(stateDir, 'logs'),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

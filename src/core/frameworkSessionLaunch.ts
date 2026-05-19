/**
 * frameworkSessionLaunch — per-framework launch arg builders for
 * Instar-managed tmux sessions.
 *
 * Provider-portability v1.0.0: before this module, `SessionManager`
 * hardcoded the Claude CLI's flag set directly inline (Telegram-driven
 * interactive sessions used `claude --dangerously-skip-permissions
 * [--resume <id>]`). That left Codex sessions and future frameworks
 * unreachable from the Telegram topic flow.
 *
 * Adding a framework: implement a builder below and register it in
 * `BUILDERS`. The exhaustiveness check in `buildInteractiveLaunch`
 * forces a compile error if a case is missed.
 */

import type { IntelligenceFramework } from './intelligenceProviderFactory.js';

/**
 * Cross-framework generic model tiers. Higher-level code (UpgradeNotify,
 * StallTriage, etc.) should think in tiers, not in framework-specific
 * names — each framework maps the tier to its own preferred model via
 * `resolveModelForFramework`. The legacy Claude-only tier names
 * ('haiku'|'sonnet'|'opus') still resolve correctly for back-compat.
 */
export type GenericModelTier = 'fast' | 'balanced' | 'capable';

/**
 * Map a generic tier or framework-specific name to the concrete model
 * string that should be passed to the framework's CLI. Pass-through for
 * anything that isn't a recognized generic tier (so callers can still
 * provide a raw model id when needed).
 *
 * Claude tier names ('haiku'|'sonnet'|'opus') ARE generic to claude-code
 * (the CLI accepts them as `--model` aliases) so we let them pass
 * through verbatim there.
 */
export function resolveModelForFramework(
  framework: IntelligenceFramework,
  modelOrTier: string | undefined,
): string | undefined {
  if (!modelOrTier) return undefined;
  const key = modelOrTier.toLowerCase();

  if (framework === 'claude-code') {
    // fast/balanced/capable → haiku/sonnet/opus for the Claude CLI's
    // `--model` flag. Anything else (already-correct tier name or raw
    // model id like 'claude-sonnet-4-6') passes straight through.
    if (key === 'fast') return 'haiku';
    if (key === 'balanced') return 'sonnet';
    if (key === 'capable') return 'opus';
    return modelOrTier;
  }
  if (framework === 'codex-cli') {
    // Generic tiers map to the empirically-working subscription-path
    // defaults from src/providers/adapters/openai-codex/models.ts.
    // Claude-style tier names from legacy callers also map to a
    // sensible Codex equivalent (haiku→fast, sonnet→balanced,
    // opus→capable) so an unported call site doesn't immediately
    // crash for a Codex agent.
    if (key === 'fast' || key === 'haiku') return 'gpt-5.2';
    if (key === 'balanced' || key === 'sonnet') return 'gpt-5.3-codex';
    if (key === 'capable' || key === 'opus') return 'gpt-5.4';
    return modelOrTier;
  }
  return modelOrTier;
}

export interface InteractiveLaunchOptions {
  /** Absolute path to the CLI binary for the selected framework. */
  binaryPath: string;
  /**
   * Optional session ID to resume into. Claude uses `--resume <id>` (flag).
   * Codex uses `resume <id>` (subcommand inserted right after the binary);
   * unsupported frameworks may ignore.
   */
  resumeSessionId?: string;
  /**
   * Codex requires a sandbox mode. Defaults to `danger-full-access` for
   * agentic sessions — these run autonomously and need the same
   * permission scope Claude gets via `--dangerously-skip-permissions`.
   */
  codexSandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /**
   * Optional model override for the launched session. Accepts a generic
   * tier ('fast'|'balanced'|'capable'), a framework-specific tier name,
   * or a raw model id. Resolution per-framework happens in the builder.
   * When unset, each builder uses its own subscription-safe default
   * ('balanced' for Codex; Claude inherits its CLI's account default).
   */
  defaultModel?: string;
  /**
   * Phase 6 local-model adapter — when set on a codex-cli launch, emits
   * `--oss --local-provider <provider>` so the interactive session
   * talks to a local Ollama/LM Studio instance.
   */
  codexLocalProvider?: 'ollama' | 'lmstudio';
}

export interface InteractiveLaunchSpec {
  /** Args to append after the tmux env-var block, starting with the binary path. */
  argv: string[];
  /**
   * Framework-specific environment-variable additions/clears the caller
   * should merge into the tmux `-e` flags. Keys map to values; an empty
   * string clears the variable in the spawned session.
   */
  envOverrides: Record<string, string>;
}

type Builder = (options: InteractiveLaunchOptions) => InteractiveLaunchSpec;

const claudeCodeBuilder: Builder = (options) => {
  const argv: string[] = [options.binaryPath, '--dangerously-skip-permissions'];
  if (options.resumeSessionId) {
    argv.push('--resume', options.resumeSessionId);
  }
  return {
    argv,
    envOverrides: {
      // Prevent nested Claude Code detection when Echo runs inside Claude.
      CLAUDECODE: '',
    },
  };
};

const codexCliBuilder: Builder = (options) => {
  // Claude's `--dangerously-skip-permissions` means BOTH "no approval
  // prompts" AND "no sandbox on shell exec." Codex splits these into
  // two flags. Initial attempts used `--sandbox workspace-write
  // --ask-for-approval never` to silence approvals, but that leaves
  // Codex's seatbelt sandbox in place — which blocks the agent from
  // reaching localhost (where the instar server lives, where
  // telegram-reply relays through) and blocks writes outside the
  // project (which the relay script needs for its outbox). Codex's
  // single-flag parity for "autonomous, no guardrails on exec" is
  // `--dangerously-bypass-approvals-and-sandbox`. Use that as the
  // default for instar's autonomous agent topics. Callers wanting a
  // safer profile can override via codexSandboxMode (which switches
  // back to the flag-pair form below).
  // Codex CLI's default model is `gpt-5.2-codex`, which OpenAI retired
  // from ChatGPT-subscription auth on 2026-04-14 (Community thread
  // 1378986). Sessions launched without an explicit model on
  // subscription auth fail with "not supported when using Codex with a
  // ChatGPT account." `gpt-5.3-codex` is the coding-specialist tier
  // that empirically works on the subscription path (see
  // providers/adapters/openai-codex/models.ts for the full map). API-
  // key users can still override by editing ~/.codex/config.toml or
  // setting CODEX_MODEL — passing the flag here only sets the default
  // for this session.
  // Resolve via the shared tier-mapper so callers can pass a generic
  // tier OR a raw model id from config. Default to the subscription-
  // safe 'balanced' tier when nothing is specified — matches the prior
  // hardcoded 'gpt-5.3-codex' behavior but now reads from config.
  // Phase 6: when codexLocalProvider is set, skip the tier resolver
  // (local models like 'llama3.2:latest' don't share OpenAI's
  // vocabulary) and pass the model verbatim. Builder also appends
  // --oss --local-provider <p> below.
  const isLocal = options.codexLocalProvider !== undefined;
  const resolvedModel = isLocal
    ? (options.defaultModel ?? 'llama3.2:latest')
    : (resolveModelForFramework('codex-cli', options.defaultModel) ?? 'gpt-5.3-codex');

  // Codex's `resume` is a subcommand (`codex resume <SESSION_ID>`), not a
  // flag. When resuming, insert it as the first argument after the binary
  // path — every other flag (`--model`, `--sandbox`, etc.) is accepted by
  // the `resume` subcommand and behaves the same as on a fresh launch
  // (verified against codex 0.130 `codex resume --help`). When not
  // resuming, argv stays in the original fresh-launch shape.
  //
  // Stale-id handling: if the tracked SESSION_ID no longer exists in
  // Codex's session store (~/.codex/sessions/...), `codex resume` exits
  // non-zero at startup and the tmux pane shows an error. SessionManager's
  // respawn logic catches the dead pane and the route handler can clear
  // the stale resume id (per existing PR #248 framework-swap pattern).
  // We don't pre-validate filesystem presence here to avoid coupling the
  // launch helper to Codex's on-disk session layout.
  const resumePrefix: string[] = options.resumeSessionId
    ? ['resume', options.resumeSessionId]
    : [];

  const argv: string[] = [
    options.binaryPath,
    ...resumePrefix,
    '--model', resolvedModel,
  ];
  if (isLocal) {
    argv.push('--oss', '--local-provider', options.codexLocalProvider!);
  }
  if (options.codexSandboxMode) {
    argv.push('--sandbox', options.codexSandboxMode, '--ask-for-approval', 'never');
  } else {
    argv.push('--dangerously-bypass-approvals-and-sandbox');
  }
  return {
    argv,
    envOverrides: {
      // Codex doesn't honor CLAUDECODE; we still clear it as
      // defense-in-depth so a Codex session can't be mis-detected as
      // a Claude one by downstream tooling that grep's env vars.
      CLAUDECODE: '',
    },
  };
};

const BUILDERS: Record<IntelligenceFramework, Builder> = {
  'claude-code': claudeCodeBuilder,
  'codex-cli': codexCliBuilder,
};

/**
 * Build the argv + env overrides for a Telegram/Slack-driven
 * interactive session in the given framework.
 *
 * @example
 *   const spec = buildInteractiveLaunch('codex-cli', { binaryPath: '/usr/local/bin/codex' });
 *   // → spec.argv = ['/usr/local/bin/codex', '--sandbox', 'danger-full-access']
 *   // → spec.envOverrides = { CLAUDECODE: '' }
 */
export function buildInteractiveLaunch(
  framework: IntelligenceFramework,
  options: InteractiveLaunchOptions,
): InteractiveLaunchSpec {
  const builder = BUILDERS[framework];
  if (!builder) {
    throw new Error(`No interactive launch builder registered for framework "${framework}"`);
  }
  return builder(options);
}

/**
 * Resolve which framework an interactive session should run under,
 * given a per-call override (e.g., from telegramTopicMap.framework),
 * the agent-level `sessions.framework` config field, and the
 * `INSTAR_FRAMEWORK` env var. First match wins.
 */
export function resolveInteractiveFramework(input: {
  perCall?: IntelligenceFramework;
  configFramework?: IntelligenceFramework;
  envFramework?: IntelligenceFramework | null;
}): IntelligenceFramework {
  return input.perCall ?? input.configFramework ?? input.envFramework ?? 'claude-code';
}

/**
 * Options for a headless (prompt-and-exit) launch. Mirrors the shape
 * SessionManager.spawnSession passes when invoking the CLI with a
 * one-shot prompt — Claude uses `-p <prompt>`, Codex uses
 * `exec --json <prompt>`.
 */
export interface HeadlessLaunchOptions {
  /** Absolute path to the CLI binary for the selected framework. */
  binaryPath: string;
  /** The one-shot prompt to send. */
  prompt: string;
  /**
   * Optional model identifier passed straight through to the CLI's
   * model flag. For Claude this is a tier name (opus/sonnet/haiku) or
   * a full id; for Codex this is a Codex model id (gpt-5.3-codex etc.).
   * Caller is responsible for picking the right shape — see
   * intelligenceProviderFactory's resolveModelId for tier-to-model
   * mapping per framework.
   */
  model?: string;
  /**
   * Codex sandbox mode override. Defaults to
   * `--dangerously-bypass-approvals-and-sandbox` (Claude's
   * `--dangerously-skip-permissions` parity) when absent.
   */
  codexSandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /**
   * Phase 6 local-model adapter — when set, the codex-cli builder
   * emits `--oss --local-provider <provider>` so the spawn talks to a
   * local Ollama/LM Studio instance instead of OpenAI. The model field
   * becomes the local model id (e.g. `llama3.2:latest`,
   * `qwen2.5-coder:7b`). The `defaultModel` (for raw tier resolution)
   * is bypassed since local models don't share OpenAI's tier
   * vocabulary.
   */
  codexLocalProvider?: 'ollama' | 'lmstudio';
}

export interface HeadlessLaunchSpec {
  /** Args to append after the tmux env-var block, starting with the binary path. */
  argv: string[];
  /**
   * Framework-specific environment-variable additions/clears. Caller
   * merges these into the tmux `-e` flags alongside the universal
   * INSTAR_* / DATABASE_URL clearing block.
   */
  envOverrides: Record<string, string>;
}

type HeadlessBuilder = (options: HeadlessLaunchOptions) => HeadlessLaunchSpec;

const claudeCodeHeadlessBuilder: HeadlessBuilder = (options) => {
  const argv: string[] = [options.binaryPath, '--dangerously-skip-permissions'];
  const resolved = resolveModelForFramework('claude-code', options.model);
  if (resolved) {
    argv.push('--model', resolved);
  }
  argv.push('-p', options.prompt);
  return {
    argv,
    envOverrides: {
      // Same nested-detection prevention as interactive launches.
      CLAUDECODE: '',
    },
  };
};

const codexCliHeadlessBuilder: HeadlessBuilder = (options) => {
  // Mirror the openai-codex adapter's transport spawn shape:
  //   `codex exec --json --skip-git-repo-check -s <sandbox> -m <model> <prompt>`
  // The `--json` flag makes Codex emit a JSONL event stream on stdout
  // instead of TUI output — same data the agenticSessionHeadless path
  // already consumes for normalization.
  const sandbox = options.codexSandboxMode ?? 'workspace-write';
  // Phase 6 local-provider branch — when codexLocalProvider is set,
  // emit `--oss --local-provider <p>` and pass the model verbatim
  // (local models like `llama3.2:latest` don't map through the
  // OpenAI tier vocabulary). Otherwise, the OpenAI/ChatGPT-subscription
  // path with the standard tier resolver.
  const isLocal = options.codexLocalProvider !== undefined;
  const model = isLocal
    ? (options.model ?? 'llama3.2:latest')
    : (resolveModelForFramework('codex-cli', options.model) ?? 'gpt-5.3-codex');
  const argv: string[] = [
    options.binaryPath,
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-s', sandbox,
  ];
  if (isLocal) {
    argv.push('--oss', '--local-provider', options.codexLocalProvider!);
  }
  argv.push('-m', model, options.prompt);
  return {
    argv,
    envOverrides: {
      // Spec 12 Rule 1a is enforced inside Codex CLI's process tree via
      // the env-allowlist helper. The tmux -e block here adds session-
      // level overrides; the canonical OPENAI_API_KEY scrubbing happens
      // when SessionManager merges these with the universal block AND
      // the framework-specific provider-env logic.
      CLAUDECODE: '',
    },
  };
};

const HEADLESS_BUILDERS: Record<IntelligenceFramework, HeadlessBuilder> = {
  'claude-code': claudeCodeHeadlessBuilder,
  'codex-cli': codexCliHeadlessBuilder,
};

/**
 * Build the argv + env overrides for a headless (one-shot prompt)
 * session in the given framework. Companion to `buildInteractiveLaunch`
 * for the prompt-and-exit path that backs SessionManager.spawnSession,
 * UpgradeNotifyManager, PipeSessionSpawner, and any future code that
 * needs an agent to handle a single prompt without staying interactive.
 *
 * @example
 *   const spec = buildHeadlessLaunch('codex-cli', {
 *     binaryPath: '/usr/local/bin/codex',
 *     prompt: 'summarize this thread',
 *     model: 'gpt-5.3-codex',
 *   });
 *   // → spec.argv = ['/usr/local/bin/codex', 'exec', '--json',
 *   //                '--skip-git-repo-check', '-s', 'workspace-write',
 *   //                '-m', 'gpt-5.3-codex', 'summarize this thread']
 */
export function buildHeadlessLaunch(
  framework: IntelligenceFramework,
  options: HeadlessLaunchOptions,
): HeadlessLaunchSpec {
  const builder = HEADLESS_BUILDERS[framework];
  if (!builder) {
    throw new Error(`No headless launch builder registered for framework "${framework}"`);
  }
  return builder(options);
}

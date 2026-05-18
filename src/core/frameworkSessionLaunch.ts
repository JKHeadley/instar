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

export interface InteractiveLaunchOptions {
  /** Absolute path to the CLI binary for the selected framework. */
  binaryPath: string;
  /**
   * Optional session ID to resume into. Claude uses `--resume <id>`;
   * Codex uses `--resume <id>` too but interprets the id differently;
   * unsupported frameworks may ignore.
   */
  resumeSessionId?: string;
  /**
   * Codex requires a sandbox mode. Defaults to `danger-full-access` for
   * agentic sessions — these run autonomously and need the same
   * permission scope Claude gets via `--dangerously-skip-permissions`.
   */
  codexSandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
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
  const argv: string[] = [
    options.binaryPath,
    '--model', 'gpt-5.3-codex',
  ];
  if (options.codexSandboxMode) {
    argv.push('--sandbox', options.codexSandboxMode, '--ask-for-approval', 'never');
  } else {
    argv.push('--dangerously-bypass-approvals-and-sandbox');
  }
  // Codex's `resume` is a subcommand (`codex resume <id>`), not a flag.
  // For the interactive launch path, callers who want to resume should
  // use the subcommand form; we keep the flag-style behavior off for
  // now since the legacy v0.x Claude code passes `--resume <id>` flat
  // and we want consistent argv shape. Resume support for Codex lands
  // when the topic-resume map is generalized.
  if (options.resumeSessionId) {
    // Best-effort: pass the id as the first non-flag positional under
    // the hood would require the `resume` subcommand. For now, skip
    // resume for Codex and start fresh; the warning helps users notice.
    console.warn(
      `[frameworkSessionLaunch] Codex resume requested (id=${options.resumeSessionId}) but codex CLI's "resume" is a subcommand, not a flag — starting fresh. Will be supported when TopicResumeMap is generalized.`,
    );
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
  if (options.model) {
    argv.push('--model', options.model);
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
  const model = options.model ?? 'gpt-5.3-codex';
  const argv: string[] = [
    options.binaryPath,
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-s', sandbox,
    '-m', model,
    options.prompt,
  ];
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

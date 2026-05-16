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
  // Codex's interactive REPL takes its sandbox + approval policy via
  // flags. Claude's `--dangerously-skip-permissions` means
  // "act autonomously, no human approval prompts" — the equivalent for
  // Codex is `--sandbox workspace-write` (writes restricted to the
  // project) + `--ask-for-approval never`. This is safer than
  // `danger-full-access` (which removes the sandbox entirely) while
  // still letting the agent operate without prompting on every step.
  // Operators wanting a tighter or looser sandbox can override via
  // codexSandboxMode.
  const sandbox = options.codexSandboxMode ?? 'workspace-write';
  const argv: string[] = [
    options.binaryPath,
    '--sandbox', sandbox,
    '--ask-for-approval', 'never',
  ];
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

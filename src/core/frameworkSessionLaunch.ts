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
import { codexSupportsHookTrustBypass } from './codexCapabilities.js';
import { EFFORT_LEVELS, type EffortLevel, type ThinkingMode } from './topicProfileValidation.js';

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
    // Light/medium/heavy mapping. NOTE (2026-06-03): OpenAI retired gpt-5.2 from
    // the ChatGPT-account Codex surface (it now 400s "not supported … with a
    // ChatGPT account"), so the `fast` tier moved off it onto the cheapest model
    // still accepted — gpt-5.4-mini (== balanced). Keep this in lockstep with
    // src/providers/adapters/openai-codex/models.ts (the single source of the
    // full rationale + the drift-resilience follow-up).
    if (key === 'fast' || key === 'haiku') return 'gpt-5.4-mini';   // light tier — gpt-5.2 retired 2026-06-03
    if (key === 'balanced' || key === 'sonnet') return 'gpt-5.4-mini'; // medium — cheapest reasoning
    if (key === 'capable' || key === 'opus') return 'gpt-5.5';      // heavy — frontier reasoning
    return modelOrTier;
  }
  if (framework === 'gemini-cli') {
    // Generic tiers map to the verified-working Gemini model ids (kept in sync
    // with src/providers/adapters/gemini-cli/models.ts — single source of truth).
    // Claude-style tier names from legacy callers map to a sensible Gemini
    // equivalent so an unported call site doesn't crash for a Gemini agent.
    // gemini-2.5-flash is the verified one-shot default (v0.25.2, cached-OAuth).
    if (key === 'fast' || key === 'haiku') return 'gemini-2.5-flash';
    if (key === 'balanced' || key === 'sonnet') return 'gemini-2.5-flash';
    if (key === 'capable' || key === 'opus') return 'gemini-3.1-pro-preview';
    return modelOrTier;
  }
  if (framework === 'pi-cli') {
    // pi is multi-provider by design — its `--model` flag takes a
    // `provider/id` pattern and the PROVIDER is the agent's config choice
    // (frameworkDefaultModels['pi-cli'], e.g. 'openai-codex/gpt-5.5' or a
    // models.json custom provider). Generic tiers therefore have no
    // universal mapping here; they resolve inside the configured provider's
    // own vocabulary downstream. Everything passes through verbatim — an
    // invalid pattern fails loudly in pi's own model resolution, never
    // silently on a wrong provider (PI-HARNESS-INTEGRATION-SPEC §2.2).
    return modelOrTier;
  }
  return modelOrTier;
}

/**
 * Concrete model an interactive launch will use after applying the builder's
 * own default. Keep user-facing post-spawn reporting on this same seam so a
 * defaulted model is never guessed independently from the argv builder.
 */
export function resolveInteractiveLaunchModel(
  framework: IntelligenceFramework,
  configuredModel: string | undefined,
  codexLocalProvider?: 'ollama' | 'lmstudio',
): string | undefined {
  if (framework === 'codex-cli') {
    if (codexLocalProvider) return configuredModel ?? 'llama3.2:latest';
    return resolveModelForFramework(framework, configuredModel) ?? 'gpt-5.5';
  }
  if (framework === 'gemini-cli') {
    return resolveModelForFramework(framework, configuredModel) ?? 'gemini-2.5-flash';
  }
  return resolveModelForFramework(framework, configuredModel);
}

/**
 * Build the Codex `-c` config overrides that pin the threadline MCP server to
 * a specific agent's stdio entry. This wins over whatever `[mcp_servers."threadline"]`
 * the SHARED ~/.codex/config.toml currently holds — fixing the multi-agent
 * last-writer-wins collision where the most-recently-booted codex agent's
 * registration clobbered everyone else's. Empty when no override is requested
 * (e.g. claude-code launches, or codex agents without threadline configured).
 */
function codexThreadlineMcpFlags(mcp?: { command: string; args: string[] }): string[] {
  if (!mcp) return [];
  return [
    '-c', `mcp_servers.threadline.command=${JSON.stringify(mcp.command)}`,
    '-c', `mcp_servers.threadline.args=${JSON.stringify(mcp.args)}`,
    '-c', `mcp_servers.threadline.kind=${JSON.stringify('stdio')}`,
  ];
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
  /**
   * Per-spawn Codex threadline MCP override. When set on a codex-cli launch,
   * emits `-c mcp_servers.threadline.{command,args}=...` so THIS agent's codex
   * session uses ITS OWN threadline MCP regardless of which agent last won the
   * SHARED ~/.codex/config.toml (last-writer-wins collision). See
   * resolveThreadlineMcpEntry / CODEX-MULTIAGENT-THREADLINE-SPEC.
   */
  codexThreadlineMcp?: { command: string; args: string[] };
  /**
   * Warm-session A2A (claude-code only): when set, the interactive claude
   * session is launched with `--session-id <uuid>` so its transcript is created
   * at a deterministic id. The warm keep-alive worker uses this so an eviction
   * mid-thread can fall back losslessly to `--resume <uuid>` (#746). Mutually
   * exclusive with `resumeSessionId` (resume wins — you cannot set a new id when
   * reloading an existing transcript). No effect on non-claude frameworks.
   */
  sessionId?: string;
  /**
   * pi-cli only: directory pi persists its session JSONL files into
   * (`--session-dir`). SessionManager pins this to the agent's state dir so
   * pi transcripts are durable + reap-log-coherent instead of landing in
   * pi's per-cwd default location (PI-HARNESS-INTEGRATION-SPEC §2.2).
   * No effect on non-pi frameworks.
   */
  piSessionDir?: string;
  /**
   * Subscription & Auth Standard P1.3 (claude-code only): the per-account config
   * home for this session. When set, the builder injects
   * `CLAUDE_CONFIG_DIR=<configHome>` into envOverrides so the launched Claude
   * session authenticates under THAT account's login instead of inheriting the
   * parent agent's. This is the swap mechanism — selecting/swapping an account =
   * launching (or `--resume`-ing) with that account's configHome. No effect on
   * non-claude frameworks. NEVER a token — just the login location.
   */
  configHome?: string;
  /**
   * Dynamic MCP Lifecycle (claude-code only): the MCP-config CLI flags this
   * session should launch with — e.g. `['--strict-mcp-config', '--mcp-config',
   * '<filtered.json>']` to launch with only a lean subset of `.mcp.json`. Built
   * by `SessionManager.buildSessionMcpFlags` (state-file/baseline resolution,
   * fail-safe to `[]`). An empty/absent array ⇒ no flags ⇒ Claude reads the full
   * project `.mcp.json` exactly as today (the dark default). No effect on
   * non-claude frameworks (their builders ignore it — MCP `--mcp-config` is
   * Claude-Code-specific). See DYNAMIC-MCP-LIFECYCLE-SPEC.
   */
  mcpFlags?: string[];
  /**
   * Topic Profile §6 — per-topic thinking mode. Mapped per framework:
   *  - claude-code: `--effort <low|medium|high|max>` (the live CLI's verified
   *    launch flag); `off` → MAX_THINKING_TOKENS=0 via envOverrides (the flag
   *    has no off level).
   *  - codex-cli: `-c model_reasoning_effort=<low|medium|high|xhigh>`;
   *    `max` → xhigh; `off` → low (Codex reasoning models have no off — the
   *    caller discloses the remap once, §4).
   *  - gemini-cli / pi-cli: strict no-op (no reasoning knob shipped).
   */
  thinkingMode?: ThinkingMode;
  /**
   * Topic Profile — per-topic Claude Code `--effort` level pin (a DIRECT pin
   * of the CLI flag value: low|medium|high|xhigh|max). When set, the
   * claude-code builder pushes `--effort <level>` at spawn. Validated against
   * the closed enum INSIDE the builder (defense in depth) — an unknown value
   * is dropped, never passed to the CLI. Strict no-op on non-claude
   * frameworks. Distinct from `thinkingMode` (which the builders MAP onto the
   * reasoning knob); `effort` is the launch flag verbatim.
   */
  effort?: EffortLevel;
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
  // Topic Profile — direct `--effort` pin, emitted right after
  // --dangerously-skip-permissions. Validated against the closed enum INSIDE
  // the builder (defense in depth): an unknown value is dropped, never passed
  // to the CLI. A direct pin WINS over the thinkingMode→effort mapping below
  // (the thinkingMode branch is skipped when a direct effort is present so
  // `--effort` is never emitted twice).
  const directEffort = validateEffortLevel(options.effort);
  if (directEffort) {
    argv.push('--effort', directEffort);
  }
  if (options.resumeSessionId) {
    argv.push('--resume', options.resumeSessionId);
  } else if (options.sessionId) {
    // Warm-session A2A: pin a deterministic conversation id (claude-only) so an
    // eviction mid-thread can `--resume <uuid>` losslessly (#746). Mutually
    // exclusive with --resume (resume reloads an existing transcript; you can't
    // also set a new id), so this only fires when not resuming.
    argv.push('--session-id', options.sessionId);
  }
  // Honor the configured default model when one is set. Previously this
  // builder silently dropped options.defaultModel — unlike the Codex and
  // Gemini builders, which both push --model — so frameworkDefaultModels
  // ['claude-code'] had NO effect on interactive Claude sessions (they
  // always ran the CLI's account default). That contradicted the documented
  // contract on InteractiveLaunchOptions.defaultModel ("Claude inherits its
  // CLI's account default" only WHEN UNSET). When a default IS set we resolve
  // the tier→model alias (fast/balanced/capable → haiku/sonnet/opus; raw ids
  // pass through) and pin it via --model. When unset we push nothing, so the
  // CLI's own account default is preserved — the user can still /model-switch
  // within the session.
  const resolvedModel = resolveModelForFramework('claude-code', options.defaultModel);
  if (resolvedModel) {
    argv.push('--model', resolvedModel);
  }
  const envOverrides: Record<string, string> = {
    // Prevent nested Claude Code detection when Echo runs inside Claude.
    CLAUDECODE: '',
  };
  // Topic Profile §6 — thinking mode. The live CLI's `--effort` flag carries
  // low/medium/high/max; `off` has no flag level, so it rides the
  // MAX_THINKING_TOKENS=0 env channel (thinking disabled). Skipped when a
  // direct effort pin already emitted `--effort` (the pin wins; no duplicate).
  const claudeEffort = directEffort ? null : claudeEffortForThinkingMode(options.thinkingMode);
  if (claudeEffort) {
    argv.push('--effort', claudeEffort);
  } else if (!directEffort && options.thinkingMode === 'off') {
    envOverrides.MAX_THINKING_TOKENS = '0';
  }
  // Subscription & Auth Standard P1.3: when a per-account config home is given,
  // launch this Claude session under THAT account's login (the swap mechanism).
  // The login location only — never a token.
  if (options.configHome) {
    envOverrides.CLAUDE_CONFIG_DIR = options.configHome;
  }
  // Dynamic MCP Lifecycle (claude-code only): launch with a lean/explicit MCP set
  // when SessionManager.buildSessionMcpFlags resolved one. Empty/absent ⇒ no flags
  // ⇒ full project .mcp.json (the dark default). The caller already fail-safed to
  // [] on any error, so a bad resolution can never strand the launch here.
  if (Array.isArray(options.mcpFlags) && options.mcpFlags.length > 0) {
    argv.push(...options.mcpFlags);
  }
  return { argv, envOverrides };
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
  const resolvedModel = resolveInteractiveLaunchModel(
    'codex-cli',
    options.defaultModel,
    options.codexLocalProvider,
  )!;

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
  // Run instar's own safety hooks (installCodexHooks) without the interactive
  // "trust these hooks?" prompt that would otherwise freeze an unattended
  // session. Gated on a capability probe — codex <0.133 lacks the flag and would
  // reject it. Safe-by-construction: instar writes the hooks and owns the launch.
  if (codexSupportsHookTrustBypass(options.binaryPath)) {
    argv.push('--dangerously-bypass-hook-trust');
  }
  argv.push(...codexThreadlineMcpFlags(options.codexThreadlineMcp));
  // Topic Profile §6 — thinking mode → codex reasoning effort. `max` → xhigh;
  // `off` → low (codex reasoning models have no off level; the profile write
  // path disclosed the remap once, §4).
  const codexEffort = codexReasoningEffortForThinkingMode(options.thinkingMode);
  if (codexEffort) {
    argv.push('-c', `model_reasoning_effort=${JSON.stringify(codexEffort)}`);
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

const geminiCliBuilder: Builder = (options) => {
  // Gemini CLI interactive launch (apprenticeship Step 2 minimal body).
  // Resume is a FLAG (`--resume latest|<index>`), unlike Codex's `resume`
  // subcommand.
  //
  // APPROVAL MODE — the agentic launch auto-approves, exactly like the rest of
  // the fleet: Claude agents launch with `--dangerously-skip-permissions` and
  // codex agents with `--dangerously-bypass-approvals-and-sandbox`. A Gemini
  // *agent* doing autonomous work (Codey drives it through real tasks in the
  // apprenticeship's Step 4) must not block on per-tool confirmation, so the
  // interactive autonomous launch uses `--yolo` (Gemini's equivalent of
  // skip-permissions/bypass). This is the SESSION path. The lockdown
  // (`--approval-mode default`, no tools) lives ONLY on the one-shot
  // intelligence-provider EVALUATION path (GeminiCliIntelligenceProvider —
  // the analog of `codex exec --sandbox read-only`), never here.
  const resolvedModel = resolveInteractiveLaunchModel('gemini-cli', options.defaultModel)!;
  const argv: string[] = [options.binaryPath, '-m', resolvedModel, '--yolo'];
  if (options.resumeSessionId) {
    // Gemini resumes by `latest` or a numeric index. The tracked resume id is
    // passed through verbatim (callers store whatever --list-sessions surfaced).
    argv.push('--resume', options.resumeSessionId);
  }
  return {
    argv,
    envOverrides: {
      // Defense-in-depth: clear CLAUDECODE so a Gemini session can't be
      // mis-detected as a Claude one by env-grepping tooling.
      CLAUDECODE: '',
    },
  };
};

const piCliBuilder: Builder = (options) => {
  // pi interactive launch (PI-HARNESS-INTEGRATION-SPEC §2.2). pi has NO
  // permission system at all (YOLO by design — containment is the harness
  // wrapper's job, same posture as Claude's --dangerously-skip-permissions
  // fleet default), so there is no approval flag to pass.
  const argv: string[] = [options.binaryPath];
  if (options.piSessionDir) {
    // Durable transcripts: pin the session store into the agent state dir
    // instead of pi's per-cwd default.
    argv.push('--session-dir', options.piSessionDir);
  }
  // Resume and fresh-pin both map to `--session-id <id>` — pi's flag is
  // create-or-resume (deterministic id), verified hands-on in the P0.1 eval.
  // Resume wins when both are set, mirroring the claude-code builder.
  const pinnedId = options.resumeSessionId ?? options.sessionId;
  if (pinnedId) {
    argv.push('--session-id', pinnedId);
  }
  // Model is a `provider/id` pattern (pass-through resolution — see
  // resolveModelForFramework). When unset, pi uses its own configured
  // default provider/model, which keeps parity with Claude's
  // "inherit the CLI's account default" behavior.
  const resolvedModel = resolveModelForFramework('pi-cli', options.defaultModel);
  if (resolvedModel) {
    argv.push('--model', resolvedModel);
  }
  return {
    argv,
    envOverrides: {
      // Defense-in-depth: clear CLAUDECODE so a pi session can't be
      // mis-detected as a Claude one by env-grepping tooling.
      CLAUDECODE: '',
    },
  };
};

const BUILDERS: Record<IntelligenceFramework, Builder> = {
  'claude-code': claudeCodeBuilder,
  'codex-cli': codexCliBuilder,
  'gemini-cli': geminiCliBuilder,
  'pi-cli': piCliBuilder,
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
   * Codex sandbox mode override. When set → `-s <mode> --ask-for-approval
   * never`. When absent, the headless default is `-s workspace-write` (jobs
   * stay sandboxed) unless `codexAllowMcpTools` is set, which selects
   * `--dangerously-bypass-approvals-and-sandbox` for reply workers.
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
  /**
   * Per-spawn Codex threadline MCP override — see InteractiveLaunchOptions.
   * Emits `-c mcp_servers.threadline.{command,args}=...` so this agent's
   * headless codex worker (notably Threadline inbound-reply spawns) uses ITS
   * OWN threadline MCP, not whichever agent last won the shared config.
   */
  codexThreadlineMcp?: { command: string; args: string[] };
  /**
   * When true, a codex-cli headless spawn launches with
   * `--dangerously-bypass-approvals-and-sandbox` so it can make MCP tool calls
   * (e.g. threadline_send to reply). Required for Threadline inbound-reply
   * workers — codex cancels MCP calls under any sandbox. Leave false for jobs:
   * they keep the workspace-write sandbox (they ingest external content and
   * don't use MCP). No effect on non-codex frameworks.
   */
  codexAllowMcpTools?: boolean;
  /**
   * Topic Profile — per-topic Claude Code `--effort` level pin (a DIRECT pin
   * of the CLI flag value: low|medium|high|xhigh|max). When set, the
   * claude-code headless builder pushes `--effort <level>` right after the
   * `--model` block and before the `-p` prompt. Validated against the closed
   * enum INSIDE the builder — an unknown value is dropped. No-op on non-claude
   * frameworks.
   */
  effort?: EffortLevel;
  /** Claude Code dynamic-workflow opt-in. Claude deliberately does not expose
   * ultracode as a `--effort` value; the supported programmatic surface is the
   * `ultracode` prompt keyword. Strict no-op on non-Claude frameworks. */
  ultracode?: boolean;
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

export function withClaudeUltracodePrompt(prompt: string, enabled?: boolean): string {
  return enabled ? `ultracode\n\n${prompt}` : prompt;
}

const claudeCodeHeadlessBuilder: HeadlessBuilder = (options) => {
  const argv: string[] = [options.binaryPath, '--dangerously-skip-permissions'];
  const resolved = resolveModelForFramework('claude-code', options.model);
  if (resolved) {
    argv.push('--model', resolved);
  }
  // Topic Profile — direct `--effort` pin, emitted right after the --model
  // block and before the `-p` prompt positional. Validated against the closed
  // enum INSIDE the builder (defense in depth): an unknown value is dropped.
  const headlessEffort = validateEffortLevel(options.effort);
  if (headlessEffort) {
    argv.push('--effort', headlessEffort);
  }
  argv.push('-p', withClaudeUltracodePrompt(options.prompt, options.ultracode));
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
  //   `codex exec --json --skip-git-repo-check <approval/sandbox> -m <model> <prompt>`
  // The `--json` flag makes Codex emit a JSONL event stream on stdout
  // instead of TUI output — same data the agenticSessionHeadless path
  // already consumes for normalization.
  // Phase 6 local-provider branch — when codexLocalProvider is set,
  // emit `--oss --local-provider <p>` and pass the model verbatim
  // (local models like `llama3.2:latest` don't map through the
  // OpenAI tier vocabulary). Otherwise, the OpenAI/ChatGPT-subscription
  // path with the standard tier resolver.
  const isLocal = options.codexLocalProvider !== undefined;
  const model = isLocal
    ? (options.model ?? 'llama3.2:latest')
    : (resolveModelForFramework('codex-cli', options.model) ?? 'gpt-5.5');
  const argv: string[] = [
    options.binaryPath,
    'exec',
    '--json',
    '--skip-git-repo-check',
  ];
  if (isLocal) {
    argv.push('--oss', '--local-provider', options.codexLocalProvider!);
  }
  // Sandbox/approval selection:
  //   • explicit codexSandboxMode  → `-s <mode> --ask-for-approval never`
  //   • codexAllowMcpTools (reply)  → `--dangerously-bypass-approvals-and-sandbox`
  //   • default (jobs)              → `-s workspace-write`
  //
  // Why bypass is required for MCP: under ANY `-s <sandbox>` + `--ask-for-
  // approval never`, `codex exec` cancels MCP tool calls ("user cancelled MCP
  // tool call"), AND the sandbox blocks the MCP server's localhost transport —
  // both verified against codex 0.133. So a Threadline reply worker (which MUST
  // call threadline_send) can only succeed under full bypass. We scope that to
  // reply spawns (codexAllowMcpTools) and keep scheduled JOBS sandboxed under
  // workspace-write, since jobs ingest external content and don't use MCP.
  if (options.codexSandboxMode) {
    argv.push('-s', options.codexSandboxMode, '--ask-for-approval', 'never');
  } else if (options.codexAllowMcpTools) {
    argv.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    argv.push('-s', 'workspace-write');
  }
  // Run instar's own safety hooks without a persisted-trust requirement (same
  // rationale as the interactive builder; capability-gated for codex <0.133).
  if (codexSupportsHookTrustBypass(options.binaryPath)) {
    argv.push('--dangerously-bypass-hook-trust');
  }
  // -c overrides must precede the positional prompt in `codex exec`.
  argv.push(...codexThreadlineMcpFlags(options.codexThreadlineMcp));
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

const geminiCliHeadlessBuilder: HeadlessBuilder = (options) => {
  // Gemini CLI headless (prompt-and-exit) — the CANONICAL one-shot argv:
  //   gemini -m <model> --approval-mode default -p <prompt>
  // This mirrors the gemini adapter's transport (buildGeminiOneShotArgv).
  // --approval-mode default is pinned (NEVER --yolo / --approval-mode yolo on
  // this path); the prompt is exactly one argv element (the value of -p), so a
  // leading-dash prompt can't be re-parsed as a flag.
  const model = resolveModelForFramework('gemini-cli', options.model) ?? 'gemini-2.5-flash';
  const argv: string[] = [
    options.binaryPath,
    '-m', model,
    '--approval-mode', 'default',
    '-p', options.prompt,
  ];
  return {
    argv,
    envOverrides: {
      // The canonical Google/Gemini billing-var scrubbing happens when
      // SessionManager merges these with the universal block + the
      // framework-specific provider-env logic (the Rule-1a analog lives in
      // providers/adapters/gemini-cli/transport/geminiSpawn.ts for the
      // direct-spawn path). Clear CLAUDECODE as defense-in-depth.
      CLAUDECODE: '',
    },
  };
};

const piCliHeadlessBuilder: HeadlessBuilder = (options) => {
  // pi headless (prompt-and-exit) — the canonical one-shot argv, verified
  // hands-on in the P0.1 eval (pi 0.78.1):
  //   pi -p --mode json --no-session --offline [--model provider/id] <prompt>
  // `--mode json` emits a JSONL event stream on stdout (message/tool events
  // with usage + cost on message_end) — same consumption shape as
  // `codex exec --json`. `--no-session` keeps one-shots ephemeral.
  // `--offline` skips pi's startup network operations (first-boot fd/ripgrep
  // downloads, update checks) so a job spawn can't stall on GitHub.
  // The prompt is exactly one argv element, so a leading-dash prompt can't
  // be re-parsed as a flag (same hardening note as the gemini builder).
  const argv: string[] = [options.binaryPath, '-p', '--mode', 'json', '--no-session', '--offline'];
  const resolvedModel = resolveModelForFramework('pi-cli', options.model);
  if (resolvedModel) {
    argv.push('--model', resolvedModel);
  }
  argv.push(options.prompt);
  return {
    argv,
    envOverrides: {
      // Same nested-detection prevention as the other builders.
      CLAUDECODE: '',
    },
  };
};

const HEADLESS_BUILDERS: Record<IntelligenceFramework, HeadlessBuilder> = {
  'claude-code': claudeCodeHeadlessBuilder,
  'codex-cli': codexCliHeadlessBuilder,
  'gemini-cli': geminiCliHeadlessBuilder,
  'pi-cli': piCliHeadlessBuilder,
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

/**
 * Extra claude-code headless flags spliced before the `-p` prompt positional:
 *  - `--allowedTools <list>` — the per-session tool-scope allowlist.
 *  - `--strict-mcp-config --mcp-config {"mcpServers":{}}` — the no-project-MCP
 *    spawn: a headless one-shot `claude -p` session that inherits the project
 *    `.mcp.json` HANGS on boot when that set includes interactively-authenticated
 *    remote MCP servers (they can't complete OAuth headless), so it never
 *    processes its prompt. An empty strict MCP config makes claude ignore the
 *    project config and start with zero MCP servers (verified live: a mentor
 *    autonomous-fix loop session stalled ~4.5 min at 0.1% CPU on MCP init; with
 *    this flag a headless spawn boots in ~9s).
 *
 * Returns `[]` for non-claude frameworks or when neither option is requested, so
 * the caller can splice unconditionally. Pure + order-stable for testing.
 */
/**
 * Defense-in-depth clamp for the direct `--effort` pin: returns the value
 * verbatim when it is a member of the closed enum, else null (the builder
 * drops it). The resolver already fails-open, but the builder is a second
 * untrusted entry point — an unknown value must never reach the CLI. Exported
 * for unit tests.
 */
export function validateEffortLevel(value: string | undefined | null): EffortLevel | null {
  if (value != null && (EFFORT_LEVELS as readonly string[]).includes(value)) {
    return value as EffortLevel;
  }
  return null;
}

/**
 * Topic Profile §6 — map the generic thinking-mode enum to the Claude CLI's
 * `--effort` levels. `off` returns null (it rides the MAX_THINKING_TOKENS=0
 * env channel instead — the flag has no off level). Exported for the L5
 * canary + unit tests.
 */
export function claudeEffortForThinkingMode(
  mode: ThinkingMode | undefined,
): 'low' | 'medium' | 'high' | 'max' | null {
  switch (mode) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'max':
      return 'max';
    default:
      return null; // off / unset — no flag emitted
  }
}

/**
 * Topic Profile §6 — map the generic thinking-mode enum to codex
 * `model_reasoning_effort` levels. `max` → xhigh; `off` → low (codex has no
 * off — the §4 write path discloses the remap once). Exported for the L5
 * canary + unit tests.
 */
export function codexReasoningEffortForThinkingMode(
  mode: ThinkingMode | undefined,
): 'low' | 'medium' | 'high' | 'xhigh' | null {
  switch (mode) {
    case 'off':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'max':
      return 'xhigh';
    default:
      return null; // unset — codex uses its configured default
  }
}

export function claudeHeadlessExtraFlags(opts: {
  framework: IntelligenceFramework | string;
  allowedTools?: string[];
  disableProjectMcp?: boolean;
}): string[] {
  if (opts.framework !== 'claude-code') return [];
  const flags: string[] = [];
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    flags.push('--allowedTools', opts.allowedTools.join(','));
  }
  if (opts.disableProjectMcp) {
    flags.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');
  }
  return flags;
}

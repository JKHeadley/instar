/**
 * frameworkProcessSignals — per-framework predicates and grep needles
 * for finding agentic-CLI processes on the host.
 *
 * Provider-portability v1.0.0: before this module, OrphanProcessReaper
 * hardcoded Claude's binary patterns inline:
 *
 *   const claudeBinaryPattern = /(^|\/)claude(\s|$)/;
 *   const claudeNodePattern = /@anthropic-ai\/claude-code|claude-code\/cli/;
 *
 * That made the reaper blind to orphaned Codex processes — those would
 * accumulate forever, defeating the reaper's purpose. This module
 * exposes per-framework `binaryPattern`, `nodePattern`, exclusion list,
 * and `psGrepNeedle` (the bracket-escape pattern used in `ps … | grep`
 * to filter the process listing efficiently before parsing).
 *
 * The reaper iterates `listProcessSignals()` to scan EVERY known
 * framework on each poll — a user can have both Claude and Codex
 * installed and both can leak processes.
 */

import type { IntelligenceFramework } from '../core/intelligenceProviderFactory.js';

export interface FrameworkProcessSignal {
  /** Stable framework id (matches IntelligenceFramework). */
  readonly framework: IntelligenceFramework;
  /** Human-readable name for log lines and user-facing alerts. */
  readonly displayName: string;
  /**
   * Bracket-escaped grep needle used in the `ps … | grep '[X]…'`
   * pipeline. The bracket trick keeps grep itself from matching its
   * own command line.
   * @example "[c]laude" or "[c]odex"
   */
  readonly psGrepNeedle: string;
  /**
   * Matches the framework binary in a `ps -o command=` line —
   * either bare (`claude --print`), at a path tail (`/usr/local/bin/claude foo`),
   * or as the bare token (`claude` with nothing after).
   */
  readonly binaryPattern: RegExp;
  /**
   * Matches npx/node-wrapped invocations of the framework's CLI
   * (e.g., `node …/@anthropic-ai/claude-code/cli.js`).
   */
  readonly nodePattern: RegExp;
  /**
   * Substrings that, when found in the command line, EXCLUDE the
   * process from being treated as a framework session. These cover
   * adjacent MCP servers and helpers whose names share the framework
   * prefix.
   */
  readonly exclusionSubstrings: ReadonlyArray<string>;
}

const CLAUDE_CODE_SIGNAL: FrameworkProcessSignal = {
  framework: 'claude-code',
  displayName: 'Claude',
  psGrepNeedle: '[c]laude',
  binaryPattern: /(^|\/)claude(\s|$)/,
  nodePattern: /@anthropic-ai\/claude-code|claude-code\/cli/,
  exclusionSubstrings: [
    'claude-in-chrome',
    'claude-mcp',
    'playwright-mcp',
    'mcp-remote',
    'exa-mcp',
    'payments-mcp',
  ],
};

const CODEX_CLI_SIGNAL: FrameworkProcessSignal = {
  framework: 'codex-cli',
  displayName: 'Codex',
  psGrepNeedle: '[c]odex',
  binaryPattern: /(^|\/)codex(\s|$)/,
  // OpenAI's Codex CLI is published as @openai/codex-cli; older
  // experimental builds shipped under `codex-cli/` paths. Cover both.
  nodePattern: /@openai\/codex|codex-cli\/cli|codex-cli\/bin/,
  exclusionSubstrings: [
    'codex-mcp',
    // Common false-positive: VS Code "code" binary path can occur with
    // "x-codex" suffix in helper threads — covered by the binary-pattern
    // boundary, but explicit exclusion catches edge cases.
    'vscode-codex',
  ],
};

const GEMINI_CLI_SIGNAL: FrameworkProcessSignal = {
  framework: 'gemini-cli',
  displayName: 'Gemini',
  psGrepNeedle: '[g]emini',
  binaryPattern: /(^|\/)gemini(\s|$)/,
  // Gemini CLI is published as @google/gemini-cli; older/experimental builds
  // shipped under `gemini-cli/` paths. Cover both (node/npx-wrapped form).
  nodePattern: /@google\/gemini-cli|gemini-cli\/(cli|bin)/,
  exclusionSubstrings: [
    // `gemini mcp` server shares the prefix and must NOT be counted as a
    // framework session — the analog of codex's 'codex-mcp' exclusion.
    'gemini-mcp',
  ],
};

const PROCESS_SIGNALS: Record<IntelligenceFramework, FrameworkProcessSignal> = {
  'claude-code': CLAUDE_CODE_SIGNAL,
  'codex-cli': CODEX_CLI_SIGNAL,
  'gemini-cli': GEMINI_CLI_SIGNAL,
};

/** Process helpers that appear at the START of command lines and are NEVER framework binaries. */
const COMMON_HELPER_PROCESSES = [
  'cloudflared',
  'caffeinate',
  'tee',
  'tail',
  'cat',
  'grep',
  'awk',
  'sed',
];

/**
 * Decide whether `command` looks like one of the configured framework
 * binaries. Returns the matched signal or null. Centralizes the helper-
 * prefix check (`cloudflared`, `caffeinate`, etc.) so each framework
 * doesn't have to re-implement it.
 */
export function matchProcessSignal(
  command: string,
  signals: ReadonlyArray<FrameworkProcessSignal> = listProcessSignals(),
): FrameworkProcessSignal | null {
  const trimmed = command.trimStart();
  for (const helper of COMMON_HELPER_PROCESSES) {
    if (trimmed.startsWith(helper)) return null;
  }

  for (const signal of signals) {
    if (signal.binaryPattern.test(command) || signal.nodePattern.test(command)) {
      if (signal.exclusionSubstrings.some(e => command.includes(e))) continue;
      return signal;
    }
  }

  return null;
}

/**
 * Enumerate every known framework signal. Used by the reaper to
 * build the ps-grep pipeline and to scan against every framework.
 */
export function listProcessSignals(): ReadonlyArray<FrameworkProcessSignal> {
  return (Object.keys(PROCESS_SIGNALS) as IntelligenceFramework[]).map(
    f => PROCESS_SIGNALS[f],
  );
}

/**
 * Get the signal for a specific framework. Returns null when the
 * framework is unrecognized (typed shouldn't happen, but defensive).
 */
export function getProcessSignal(framework: IntelligenceFramework): FrameworkProcessSignal | null {
  return PROCESS_SIGNALS[framework] ?? null;
}

/**
 * Common helper-process prefix list — exported for tests that want to
 * verify the reaper's helper-rejection logic without duplicating it.
 */
export function listCommonHelperProcesses(): ReadonlyArray<string> {
  return COMMON_HELPER_PROCESSES;
}

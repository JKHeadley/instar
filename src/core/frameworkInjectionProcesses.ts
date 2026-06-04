/**
 * frameworkInjectionProcesses — single source of truth for which foreground
 * processes a Threadline live-injection (warm-session A2A) may type into.
 *
 * WHY THIS EXISTS (framework-agnosticism requirement): live-inject is gated by a
 * process-name allowlist (MessageDelivery checks `pane_current_command` against
 * ALLOWED_INJECTION_PROCESSES). If that list only knows `claude`, the warm-session
 * keep-alive worker can only ever be a claude-code session — a structurally
 * Claude-specific solution. Instar runs multiple agentic frameworks (claude-code,
 * codex-cli, gemini-cli, and future ones), and a warm A2A worker runs in the LOCAL
 * agent's framework. So the allowlist must be DERIVED from the framework registry,
 * not hardcoded to one framework.
 *
 * Adding a framework: add its IntelligenceFramework value to
 * FRAMEWORK_INJECTION_PROCESS_NAMES below. The framework-agnosticism test
 * (`tests/unit/framework-agnosticism.test.ts`) FAILS if a framework has a launch
 * builder but no injection-process entry (or vice-versa), so neither half can be
 * forgotten — warm sessions stay framework-general by construction, not willpower.
 */

import type { IntelligenceFramework } from './intelligenceProviderFactory.js';

/**
 * Shell process names that are always safe injection targets. NOT framework-
 * specific — a session sitting at a shell prompt is injectable regardless of
 * which agent CLI launched it.
 */
export const INJECTION_SHELL_PROCESSES: readonly string[] = ['bash', 'zsh', 'fish', 'sh', 'dash'];

/**
 * Per-framework interactive process names — the foreground `pane_current_command`
 * a LIVE interactive session of that framework reports under tmux.
 *
 * macOS note: a live Claude Code pane reports `claude.exe` (NOT `claude`) for
 * `#{pane_current_command}`. Without `claude.exe` here, every macOS Threadline
 * live-inject is refused ("Unsafe foreground process: claude.exe") — the
 * load-bearing bug that made the A2A warm-session inject path dead-on-arrival.
 */
export const FRAMEWORK_INJECTION_PROCESS_NAMES: Record<IntelligenceFramework, readonly string[]> = {
  'claude-code': ['claude', 'claude.exe'],
  'codex-cli': ['codex'],
  'gemini-cli': ['gemini'],
};

/** Union of every framework's interactive process names (deduped). */
export function allFrameworkInjectionProcessNames(): string[] {
  const names = new Set<string>();
  for (const list of Object.values(FRAMEWORK_INJECTION_PROCESS_NAMES)) {
    for (const n of list) names.add(n);
  }
  return [...names];
}

/** Interactive process names for a single framework (empty if unknown). */
export function injectionProcessNamesForFramework(framework: IntelligenceFramework): readonly string[] {
  return FRAMEWORK_INJECTION_PROCESS_NAMES[framework] ?? [];
}

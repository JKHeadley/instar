/**
 * The tool-free profile for a Codex call whose prompt holds outside text
 * (docs/specs/ecosystem-idea-pipeline.md §1). A read-only sandbox still lets
 * the model read local files and reach the web through its built-in tools, so
 * such a call asks for no tools at all.
 *
 * Two kinds of switch:
 * - `--disable <feature>` for the features the profile has always turned off.
 *   Codex refuses an unknown name here, so this list only holds names every
 *   supported Codex knows.
 * - `-c <key>=<value>` for the rest. Codex ignores an unknown `-c` key, so a
 *   newer switch costs nothing on an older Codex.
 *
 * `web_search` is a top-level setting, not a feature: it is on ("cached") by
 * default and only `web_search="disabled"` turns it off.
 */

/** Features turned off with `--disable` (all long-standing names). */
export const CODEX_TOOL_FREE_DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'apps',
  'browser_use',
  'computer_use',
] as const;

/** Settings applied with `-c`, safe on any Codex version. */
export const CODEX_TOOL_FREE_CONFIG = [
  'mcp_servers={}',
  'web_search="disabled"',
  'tools.web_search=false', // the older spelling of the same switch
  'features.view_image=false',
  'features.image_generation=false',
  'features.multi_agent=false',
  'features.multi_agent_v2=false',
  'features.plugins=false',
  'features.standalone_web_search=false',
  'features.goals=false',
  'features.skill_search=false',
  'features.tool_suggest=false',
  'features.remote_plugin=false',
] as const;

/**
 * How each tool the openai-codex adapter registers is closed by this profile.
 * The enforcement test requires an entry for every registered tool, so a new
 * built-in tool cannot be added without deciding how the tool-free call
 * closes it. `sandbox` means the read-only sandbox already refuses it.
 */
export const CODEX_TOOL_FREE_COVERAGE: Readonly<Record<string, string>> = {
  bash: 'shell_tool',
  apply_patch: 'sandbox',
  web_search: 'web_search="disabled"',
  image_gen: 'features.image_generation=false',
};

/** The argv fragment for a tool-free call. */
export function codexToolFreeArgs(): string[] {
  return [
    ...CODEX_TOOL_FREE_DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
    ...CODEX_TOOL_FREE_CONFIG.flatMap((c) => ['-c', c]),
  ];
}

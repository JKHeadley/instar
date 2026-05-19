/**
 * toolNameMapping — canonical tool-name vocabulary + per-framework mapping.
 *
 * Specs:
 *   - specs/instar-concepts/tool.md
 *   - specs/frameworks/claude-code/tools.md
 *   - specs/frameworks/codex-cli/tools.md
 *
 * Consumed by other Layer-3 primitives' renderers when they need to map
 * a canonical `allowed-tools` list to framework-native tool names.
 *
 * v0.1: ships the table + lookup helpers. The Skill primitive's `allowed-tools`
 * rendering (the C3 deferral from Skill convergence) wires in next.
 */

import type { IntelligenceFramework } from '../../core/intelligenceProviderFactory.js';

export interface ToolNameEntry {
  canonical: string;
  claude: string;
  codex: string;
}

export const TOOL_NAME_MAPPING: ReadonlyArray<ToolNameEntry> = [
  { canonical: 'read', claude: 'Read', codex: 'view' },
  { canonical: 'edit', claude: 'Edit', codex: 'apply_patch' },
  { canonical: 'write', claude: 'Write', codex: 'apply_patch' },
  { canonical: 'multi-edit', claude: 'MultiEdit', codex: 'apply_patch' },
  { canonical: 'bash', claude: 'Bash', codex: 'shell' },
  { canonical: 'grep', claude: 'Grep', codex: 'grep' },
  { canonical: 'glob', claude: 'Glob', codex: 'glob' },
  { canonical: 'web-fetch', claude: 'WebFetch', codex: 'read_url' },
  { canonical: 'web-search', claude: 'WebSearch', codex: 'web_search' },
  { canonical: 'task', claude: 'Task', codex: 'multi_agent' },
  { canonical: 'todo-write', claude: 'TodoWrite', codex: 'todo_write' },
  { canonical: 'notebook-edit', claude: 'NotebookEdit', codex: 'notebook_edit' },
];

const CANONICAL_INDEX = new Map<string, ToolNameEntry>(
  TOOL_NAME_MAPPING.map((e) => [e.canonical, e]),
);

const MCP_CANONICAL_RE = /^mcp:([a-z0-9][a-z0-9-]*):([a-z0-9][a-z0-9_-]*)$/i;

/**
 * Translate one canonical tool name into its framework-native form.
 *
 * Returns null if the canonical name is unknown. Callers should treat null
 * as a hard error (don't silently drop tool restrictions — that widens the
 * permission surface).
 */
export function renderCanonicalToolName(
  canonical: string,
  framework: IntelligenceFramework,
): string | null {
  const mcp = canonical.match(MCP_CANONICAL_RE);
  if (mcp) {
    const [, server, tool] = mcp;
    return framework === 'claude-code'
      ? `mcp__${server}__${tool}`
      : `mcp.${server}.${tool}`;
  }
  const entry = CANONICAL_INDEX.get(canonical);
  if (!entry) return null;
  return framework === 'claude-code' ? entry.claude : entry.codex;
}

/**
 * Translate an array of canonical tool names. Returns a parallel array where
 * each element is either the framework-native name or null (for unknown).
 * Useful in renderers that want to surface unknowns to the operator.
 */
export function renderCanonicalToolList(
  canonicals: ReadonlyArray<string>,
  framework: IntelligenceFramework,
): Array<{ canonical: string; native: string | null }> {
  return canonicals.map((c) => ({ canonical: c, native: renderCanonicalToolName(c, framework) }));
}

/**
 * List all known canonical tool names (for documentation + validation).
 */
export function listCanonicalToolNames(): ReadonlyArray<string> {
  return TOOL_NAME_MAPPING.map((e) => e.canonical);
}

/**
 * mcpProcessSignatures — the precise, allow-listed signatures for MCP-server
 * processes that the {@link McpProcessReaper} is permitted to consider.
 *
 * These are NOT framework (claude/codex/gemini) processes — they are the
 * long-lived MCP-server children a session spawns (Playwright, mcp-remote,
 * instar's own stdio MCP) that survive their owning session's death and
 * accumulate for days (see `.instar/apprenticeship/codey-task-mcp-leak-reaper.md`).
 *
 * The reaper matches ONLY these exact signatures — never a broad `node`/`npm`
 * match — so an unrelated node process can never be a reap candidate. Each
 * `psGrepNeedle` is bracket-escaped so the discovery `ps … | egrep` does not
 * match its own argv.
 */

export interface McpProcessSignature {
  /** Stable id for audit trails + tests. */
  readonly id: 'playwright-mcp' | 'mcp-remote' | 'instar-mcp-stdio';
  /** Human-readable label. */
  readonly label: string;
  /**
   * Substrings that must ALL appear in the process command for a match. A
   * conjunction keeps the match tight (e.g. requires both `mcp-remote` AND
   * the npm/exec shape rather than any line mentioning "mcp").
   */
  readonly commandIncludesAll: ReadonlyArray<string>;
  /** Bracket-escaped needle for the first-stage `ps … | egrep` discovery. */
  readonly psGrepNeedle: string;
}

export const MCP_PROCESS_SIGNATURES: ReadonlyArray<McpProcessSignature> = [
  {
    id: 'playwright-mcp',
    label: 'Playwright MCP server',
    commandIncludesAll: ['playwright', 'mcp'],
    psGrepNeedle: '[p]laywright.*mcp|[m]cp.*playwright',
  },
  {
    id: 'mcp-remote',
    label: 'mcp-remote bridge (e.g. Fathom)',
    commandIncludesAll: ['mcp-remote'],
    psGrepNeedle: '[m]cp-remote',
  },
  {
    id: 'instar-mcp-stdio',
    label: 'instar stdio MCP server',
    commandIncludesAll: ['mcp-stdio-entry'],
    psGrepNeedle: '[m]cp-stdio-entry',
  },
];

/** The alternation passed to the discovery `egrep -i '<needle>'`. */
export function mcpGrepAlternation(): string {
  return MCP_PROCESS_SIGNATURES.map((s) => s.psGrepNeedle).join('|');
}

/**
 * Match a process command against the allow-list. Returns the matched
 * signature, or null when the command is not a recognized MCP-server process.
 * Pure — exported for unit tests of both the match and the non-match side.
 */
export function matchMcpSignature(
  command: string,
  signatures: ReadonlyArray<McpProcessSignature> = MCP_PROCESS_SIGNATURES,
): McpProcessSignature | null {
  if (!command) return null;
  const lower = command.toLowerCase();
  for (const sig of signatures) {
    if (sig.commandIncludesAll.every((needle) => lower.includes(needle.toLowerCase()))) {
      return sig;
    }
  }
  return null;
}

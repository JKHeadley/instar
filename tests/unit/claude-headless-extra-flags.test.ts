/**
 * Tier-1 unit tests for claudeHeadlessExtraFlags — the pure builder for the
 * extra claude-code headless flags spliced before `-p` (the per-job
 * `--allowedTools` scope and the no-project-MCP `--strict-mcp-config` spawn).
 *
 * The MCP-disable path is the fix for a live dogfood finding: a headless mentor
 * autonomous-fix loop session inherited the project `.mcp.json` and HUNG ~4.5min
 * on auth-required remote MCP boot. `--strict-mcp-config` + an empty `--mcp-config`
 * makes claude start with zero MCP servers (verified: ~9s boot).
 */
import { describe, it, expect } from 'vitest';
import { claudeHeadlessExtraFlags } from '../../src/core/frameworkSessionLaunch.js';

describe('claudeHeadlessExtraFlags', () => {
  it('returns [] when neither option is requested (full-tool, project-MCP spawn)', () => {
    expect(claudeHeadlessExtraFlags({ framework: 'claude-code' })).toEqual([]);
  });

  it('emits --strict-mcp-config + an EMPTY --mcp-config when disableProjectMcp is set', () => {
    const flags = claudeHeadlessExtraFlags({ framework: 'claude-code', disableProjectMcp: true });
    expect(flags).toEqual(['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']);
    // The config must be EMPTY (no servers) — an inline string claude accepts.
    expect(flags).toContain('{"mcpServers":{}}');
    expect(JSON.parse(flags[flags.indexOf('--mcp-config') + 1])).toEqual({ mcpServers: {} });
  });

  it('emits --allowedTools for a non-empty allowlist', () => {
    expect(claudeHeadlessExtraFlags({ framework: 'claude-code', allowedTools: ['Bash', 'Read'] }))
      .toEqual(['--allowedTools', 'Bash,Read']);
  });

  it('omits --allowedTools for an empty allowlist (no scoping flag)', () => {
    expect(claudeHeadlessExtraFlags({ framework: 'claude-code', allowedTools: [] })).toEqual([]);
  });

  it('combines both: allowlist then MCP-disable, all before -p (order-stable)', () => {
    const flags = claudeHeadlessExtraFlags({
      framework: 'claude-code',
      allowedTools: ['Bash'],
      disableProjectMcp: true,
    });
    expect(flags).toEqual([
      '--allowedTools', 'Bash',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    ]);
  });

  it('returns [] for non-claude frameworks even when options are set (Codex MCP is separate)', () => {
    expect(claudeHeadlessExtraFlags({ framework: 'codex-cli', disableProjectMcp: true, allowedTools: ['Bash'] }))
      .toEqual([]);
  });
});

/**
 * Per-session MCP profiles (lever 1 of dynamic-MCP-lifecycle) — pure resolution.
 * Default-no-op is the load-bearing safety property: off / no-profile ⇒ null ⇒
 * the full .mcp.json is used unchanged. Both sides of each boundary are covered.
 */
import { describe, it, expect } from 'vitest';
import { resolveMcpProfileServers, filterMcpConfig, type McpProfilesConfig, type McpJson } from '../../src/core/sessionMcpProfile.js';

describe('resolveMcpProfileServers — default-no-op safety', () => {
  const cfg = (over: Partial<McpProfilesConfig>): McpProfilesConfig => ({ enabled: true, ...over });

  it('returns null when the feature is disabled (use full .mcp.json)', () => {
    expect(resolveMcpProfileServers(28130, { enabled: false, topicServers: { '28130': ['threadline'] } })).toBeNull();
    expect(resolveMcpProfileServers(28130, undefined)).toBeNull();
  });

  it('returns null when the topic has NO explicit profile (default keep-warm)', () => {
    expect(resolveMcpProfileServers(28130, cfg({ topicServers: { '999': ['threadline'] } }))).toBeNull();
    expect(resolveMcpProfileServers(undefined, cfg({ topicServers: { '28130': ['threadline'] } }))).toBeNull();
  });

  it('returns the explicit server subset for a profiled topic (number or string key)', () => {
    const c = cfg({ topicServers: { '28130': ['threadline', 'playwright'] } });
    expect(resolveMcpProfileServers(28130, c)).toEqual(['threadline', 'playwright']);
    expect(resolveMcpProfileServers('28130', c)).toEqual(['threadline', 'playwright']);
  });

  it('an explicit empty list means NO MCP servers for that topic', () => {
    expect(resolveMcpProfileServers(28130, cfg({ topicServers: { '28130': [] } }))).toEqual([]);
  });

  it('de-dupes and drops blanks', () => {
    expect(resolveMcpProfileServers(28130, cfg({ topicServers: { '28130': ['threadline', 'threadline', '', 'playwright'] } })))
      .toEqual(['threadline', 'playwright']);
  });
});

describe('filterMcpConfig — preserves shape, keeps only allowed servers', () => {
  const full: McpJson = {
    mcpServers: { playwright: { command: 'pw' }, threadline: { command: 'tl' } },
    otherTopLevel: { keep: true },
  };

  it('keeps only allowed servers, preserving other top-level fields', () => {
    const out = filterMcpConfig(full, ['threadline']);
    expect(Object.keys(out.mcpServers ?? {})).toEqual(['threadline']);
    expect(out.otherTopLevel).toEqual({ keep: true });
    // input not mutated
    expect(Object.keys(full.mcpServers ?? {})).toEqual(['playwright', 'threadline']);
  });

  it('an empty allow-list yields an empty mcpServers (no servers launch)', () => {
    expect(filterMcpConfig(full, [])).toEqual({ mcpServers: {}, otherTopLevel: { keep: true } });
  });

  it('ignores unknown server names in the allow-list', () => {
    const out = filterMcpConfig(full, ['threadline', 'does-not-exist']);
    expect(Object.keys(out.mcpServers ?? {})).toEqual(['threadline']);
  });

  it('tolerates a .mcp.json with no mcpServers key', () => {
    expect(filterMcpConfig({ foo: 1 } as McpJson, ['x'])).toEqual({ foo: 1, mcpServers: {} });
  });
});

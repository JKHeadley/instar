/**
 * Dynamic MCP config — pure baseline-resolution + load/offload mutation.
 * Every decision boundary is tested both sides. Default-no-op + dark.
 */
import { describe, it, expect } from 'vitest';
import {
  filterMcpConfig,
  resolveBaselineServers,
  mutateLoadedServers,
  DEFAULT_DYNAMIC_MCP_CONFIG,
  type DynamicMcpConfig,
  type McpJson,
} from '../../src/core/dynamicMcpConfig.js';

const fullMcp: McpJson = {
  mcpServers: {
    playwright: { command: 'npx', args: ['@playwright/mcp'] },
    threadline: { command: 'node', args: ['threadline.js'] },
  },
  someOtherTopLevel: true,
};

describe('filterMcpConfig', () => {
  it('keeps only the allowed servers and preserves other top-level fields', () => {
    const out = filterMcpConfig(fullMcp, ['threadline']);
    expect(Object.keys(out.mcpServers ?? {})).toEqual(['threadline']);
    expect(out.someOtherTopLevel).toBe(true);
  });

  it('ignores unknown names in the allow-list (cannot launch what is not defined)', () => {
    const out = filterMcpConfig(fullMcp, ['threadline', 'nope']);
    expect(Object.keys(out.mcpServers ?? {})).toEqual(['threadline']);
  });

  it('an empty allow-list yields zero servers', () => {
    const out = filterMcpConfig(fullMcp, []);
    expect(out.mcpServers).toEqual({});
  });

  it('does not mutate the input', () => {
    const snapshot = JSON.stringify(fullMcp);
    filterMcpConfig(fullMcp, ['playwright']);
    expect(JSON.stringify(fullMcp)).toBe(snapshot);
  });

  it('tolerates a config with no mcpServers field', () => {
    expect(filterMcpConfig({ x: 1 } as McpJson, ['a']).mcpServers).toEqual({});
  });
});

describe('resolveBaselineServers', () => {
  const names = ['playwright', 'threadline'];

  it('returns null when the feature is disabled (full .mcp.json — today)', () => {
    expect(resolveBaselineServers(names, { enabled: false, keepWarm: ['threadline'] })).toBeNull();
    expect(resolveBaselineServers(names, undefined)).toBeNull();
    expect(resolveBaselineServers(names, DEFAULT_DYNAMIC_MCP_CONFIG)).toBeNull();
  });

  it('returns null when enabled but no keepWarm trim is configured (opt-in only)', () => {
    expect(resolveBaselineServers(names, { enabled: true })).toBeNull();
  });

  it('returns the intersection of keepWarm with the real servers when enabled', () => {
    expect(resolveBaselineServers(names, { enabled: true, keepWarm: ['playwright'] })).toEqual(['playwright']);
  });

  it('drops a keepWarm name that does not exist in .mcp.json', () => {
    expect(resolveBaselineServers(names, { enabled: true, keepWarm: ['playwright', 'ghost'] })).toEqual(['playwright']);
  });

  it('de-dupes and drops blanks', () => {
    const cfg: DynamicMcpConfig = { enabled: true, keepWarm: ['threadline', 'threadline', ''] };
    expect(resolveBaselineServers(names, cfg)).toEqual(['threadline']);
  });

  it('an explicit empty keepWarm means launch with NO servers', () => {
    expect(resolveBaselineServers(names, { enabled: true, keepWarm: [] })).toEqual([]);
  });
});

describe('mutateLoadedServers — load', () => {
  const all = ['playwright', 'threadline'];

  it('adds a known, absent server', () => {
    const r = mutateLoadedServers(['threadline'], all, { kind: 'load', server: 'playwright' });
    expect(r).toMatchObject({ changed: true, reason: 'loaded' });
    expect(new Set(r.servers)).toEqual(new Set(['threadline', 'playwright']));
  });

  it('is a no-op when the server is already loaded', () => {
    const r = mutateLoadedServers(['playwright'], all, { kind: 'load', server: 'playwright' });
    expect(r).toMatchObject({ changed: false, reason: 'already-loaded' });
    expect(r.servers).toEqual(['playwright']);
  });

  it('rejects loading a server not defined in .mcp.json', () => {
    const r = mutateLoadedServers(['threadline'], all, { kind: 'load', server: 'payments-mcp' });
    expect(r).toMatchObject({ changed: false, reason: 'unknown-server' });
    expect(r.servers).toEqual(['threadline']);
  });
});

describe('mutateLoadedServers — offload', () => {
  const all = ['playwright', 'threadline'];

  it('removes a present server', () => {
    const r = mutateLoadedServers(['playwright', 'threadline'], all, { kind: 'offload', server: 'playwright' });
    expect(r).toMatchObject({ changed: true, reason: 'offloaded' });
    expect(r.servers).toEqual(['threadline']);
  });

  it('is a no-op when the server is not loaded', () => {
    const r = mutateLoadedServers(['threadline'], all, { kind: 'offload', server: 'playwright' });
    expect(r).toMatchObject({ changed: false, reason: 'not-loaded' });
    expect(r.servers).toEqual(['threadline']);
  });

  it('can offload down to an empty set', () => {
    const r = mutateLoadedServers(['playwright'], all, { kind: 'offload', server: 'playwright' });
    expect(r).toMatchObject({ changed: true, reason: 'offloaded' });
    expect(r.servers).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const current = ['playwright', 'threadline'];
    mutateLoadedServers(current, all, { kind: 'offload', server: 'playwright' });
    expect(current).toEqual(['playwright', 'threadline']);
  });
});

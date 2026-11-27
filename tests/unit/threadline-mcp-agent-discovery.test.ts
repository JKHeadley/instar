import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpRelayDiscoverer } from '../../src/threadline/mcp-http-client.js';

afterEach(() => vi.unstubAllGlobals());

describe('MCP discovery reads whole-agent relay status', () => {
  it('discovers through a standby whose local relay is off', async () => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      paths.push(url);
      return { ok: true, json: async () => url.endsWith('/threadline/status')
        ? { agent: { state: 'reachable' }, relay: { connected: false } }
        : { success: true, agents: [{ agentId: 'dawn', name: 'Dawn' }] } };
    }));
    const discoverer = createHttpRelayDiscoverer(4042, 'test-token');
    expect(await discoverer.discover({})).toEqual([expect.objectContaining({ agentId: 'dawn' })]);
    expect(paths).toHaveLength(2);
  });

  it('does not report an empty network when holder status is unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ agent: { state: 'unknown' }, relay: { connected: false } }) })));
    const discoverer = createHttpRelayDiscoverer(4042, 'test-token');
    await expect(discoverer.discover({})).rejects.toThrow('agent relay unavailable');
    expect(discoverer.connectionState).toBe('unavailable');
  });
  it('treats a vanished holder as a failed query, not a live empty network', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/threadline/status')
      ? { ok: true, json: async () => ({ agent: { state: 'reachable' } }) }
      : { ok: false, status: 503, json: async () => ({ success: false }) }));
    const discoverer = createHttpRelayDiscoverer(4042, 'test-token');
    await expect(discoverer.discover({})).rejects.toThrow('relay discover HTTP 503');
  });
});

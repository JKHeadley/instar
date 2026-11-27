import { describe, expect, it, vi } from 'vitest';
import { probeCurrentTunnelIdentity } from '../../src/tunnel/probeCurrentTunnelIdentity.js';

const base = { url: 'https://echo.example.test/', agentId: 'echo', port: 4042, authToken: 'test-token', delaysMs: [] };
const identity = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  json: async () => body,
}) as Response;

describe('current tunnel identity on wake', () => {
  it('keeps a reachable current tunnel only after a fresh authenticated identity check', async () => {
    const fetchImpl = vi.fn(async () => identity({ agentId: 'echo', port: 4042 })) as unknown as typeof fetch;
    expect(await probeCurrentTunnelIdentity({ ...base, fetchImpl })).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/echo\.example\.test\/whoami\?probe=[0-9a-f-]+$/), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer test-token', 'X-Instar-AgentId': 'echo', 'Cache-Control': 'no-cache' }),
    }));
  });

  it.each([
    ['wrong agent', identity({ agentId: 'other', port: 4042 })],
    ['wrong port', identity({ agentId: 'echo', port: 4040 })],
    ['HTTP failure', identity({ agentId: 'echo', port: 4042 }, 502)],
    ['malformed body', { ok: true, json: async () => { throw Error('bad json'); } } as Response],
  ])('requests recovery on %s', async (_name, response) => {
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch;
    expect(await probeCurrentTunnelIdentity({ ...base, fetchImpl })).toBe(false);
  });

  it('requests recovery on timeout/network failure and never trusts an absent URL or token', async () => {
    const fetchImpl = vi.fn(async () => { throw Error('network timeout'); }) as unknown as typeof fetch;
    expect(await probeCurrentTunnelIdentity({ ...base, fetchImpl })).toBe(false);
    expect(await probeCurrentTunnelIdentity({ ...base, url: null, fetchImpl })).toBe(false);
    expect(await probeCurrentTunnelIdentity({ ...base, authToken: undefined, fetchImpl })).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

/**
 * instar#2122: `instar wakeup` on Luna's Studio printed "Current location:
 * mac-studio" (the registry's lagging role) while the laptop held the lease,
 * then failed with "Invalid challenge signature" because it sent the handoff
 * challenge to its OWN server instead of the awake machine's.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { resolveAwakeMachine, resolveAwakeServerUrl } from '../../src/commands/machine.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'wakeup-targets-awake-machine.test:cleanup' }); });

function registry(): MachineIdentityManager {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeup-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'machines'), { recursive: true });
  const entry = (over: Record<string, unknown>) => ({ name: 'x', status: 'active', role: 'standby', pairedAt: 't', lastSeen: 't', ...over });
  fs.writeFileSync(path.join(dir, 'machines', 'registry.json'), JSON.stringify({ version: 1, machines: {
    m_ghost: entry({ name: 'mac-studio', role: 'awake', status: 'revoked', revokedAt: '2026-10-03T20:14:16.061Z' }),
    m_laptop: entry({ name: 'justin-mbp', role: 'standby', endpoints: [{ kind: 'tailscale', url: 'http://100.94.220.125:6060' }, { kind: 'lan', url: 'http://192.168.87.41:6060/' }], lastKnownUrl: 'https://luna-justin.example.dev' }),
    m_studio: entry({ name: 'mac-studio', role: 'standby' }),
  } }));
  return new MachineIdentityManager(dir);
}

const okJson = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;

describe('resolveAwakeMachine', () => {
  it('prefers the live lease holder reported by the local server over the lagging registry role', async () => {
    const mgr = registry();
    const fetchFn = (async () => okJson({ multiMachine: { syncStatus: { leaseHolder: 'm_laptop' } } })) as unknown as typeof fetch;
    const awake = await resolveAwakeMachine(mgr, 6060, fetchFn);
    expect(awake?.machineId).toBe('m_laptop');
    expect(awake?.entry.name).toBe('justin-mbp');
  });

  it('falls back to the registry awake role when no local server answers', async () => {
    const mgr = registry();
    mgr.updateRole('m_laptop', 'awake');
    const fetchFn = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const awake = await resolveAwakeMachine(mgr, 6060, fetchFn);
    expect(awake?.machineId).toBe('m_laptop');
  });

  it('ignores a lease holder the registry does not know or has revoked', async () => {
    const mgr = registry();
    mgr.updateRole('m_laptop', 'awake');
    const fetchFn = (async () => okJson({ multiMachine: { syncStatus: { leaseHolder: 'm_ghost' } } })) as unknown as typeof fetch;
    const awake = await resolveAwakeMachine(mgr, 6060, fetchFn);
    expect(awake?.machineId).toBe('m_laptop'); // registry fallback, not the revoked ghost
  });

  it('sends the agent auth token, since an unauthenticated /health omits the live lease (ACT-1306)', async () => {
    const mgr = registry();
    const seen: Array<Record<string, string>> = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push(headers);
      // Mirror the server: the multiMachine block is only on the authed branch.
      return headers.Authorization === 'Bearer tok-123'
        ? okJson({ multiMachine: { syncStatus: { leaseHolder: 'm_laptop' } } })
        : okJson({ status: 'ok' });
    }) as unknown as typeof fetch;
    const awake = await resolveAwakeMachine(mgr, 6060, fetchFn, 'tok-123');
    expect(seen[0].Authorization).toBe('Bearer tok-123');
    expect(awake?.machineId).toBe('m_laptop');
  });

  it('says so when a sent token gets the anonymous answer, then uses the registry', async () => {
    const mgr = registry();
    mgr.updateRole('m_laptop', 'awake');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fetchFn = (async () => okJson({ status: 'ok' })) as unknown as typeof fetch;
    const awake = await resolveAwakeMachine(mgr, 6060, fetchFn, 'stale-token');
    expect(awake?.machineId).toBe('m_laptop');
    expect(log.mock.calls.some(c => String(c[0]).includes('Live lease lookup was not authorized'))).toBe(true);
    log.mockRestore();
  });
});

describe('resolveAwakeServerUrl', () => {
  it('probes the awake machine\'s own addresses and returns the first that answers — never localhost', async () => {
    const mgr = registry();
    const tried: string[] = [];
    const fetchFn = (async (url: string) => {
      tried.push(url);
      if (url.startsWith('http://100.94.220.125:6060')) throw new Error('timeout');
      return okJson({ status: 'ok' });
    }) as unknown as typeof fetch;
    const url = await resolveAwakeServerUrl(mgr, 'm_laptop', fetchFn);
    expect(url).toBe('http://192.168.87.41:6060');
    expect(tried.some((u) => u.includes('localhost'))).toBe(false);
  });

  it('returns null when none of the addresses answer', async () => {
    const mgr = registry();
    const fetchFn = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    expect(await resolveAwakeServerUrl(mgr, 'm_laptop', fetchFn)).toBeNull();
    expect(await resolveAwakeServerUrl(mgr, 'm_studio', fetchFn)).toBeNull(); // no addresses at all
  });
});

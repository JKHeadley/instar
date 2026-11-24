import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startAccountsHarness } from '../design/harness/accountsServer.js';
import { buildAccountsPage } from '../../dashboard/console/accounts-model.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of close.splice(0)) await stop(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('Accounts fixture uses production HTTP read composition', () => {
  it('builds pooled account/machine/auth views from synthetic local providers through actual handlers', async () => {
    const harness = await startAccountsHarness(); close.push(harness.close);
    expect(new URL(harness.url).hostname).toBe('127.0.0.1');
    const [pool, relogin, inUse, machines] = await Promise.all([
      fetch(`${harness.url}/subscription-pool?scope=pool`).then(r => r.json()),
      fetch(`${harness.url}/subscription-relogin?scope=pool`).then(r => r.json()),
      fetch(`${harness.url}/subscription-pool/in-use`).then(r => r.json()),
      fetch(`${harness.url}/pool`).then(r => r.json()),
    ]);
    expect(pool.scope).toBe('pool'); expect(pool.pool.peersQueried).toBe(1); expect(pool.pool.failed).toEqual([]);
    expect(pool.accounts).toHaveLength(15); expect(pool.accounts.filter((a: { remote: boolean }) => a.remote)).toHaveLength(1);
    expect(pool.accounts.every((a: { machineId: string }) => ['seed-studio', 'seed-notebook'].includes(a.machineId))).toBe(true);
    expect(inUse.activeAccountId).toBe('seed-account-1'); expect(inUse.activeEmail).toBe('account-1@example.com');
    expect(relogin).toMatchObject({ enabled: true, episodes: [], blockers: [], scope: 'pool' });
    expect(machines.machines.map((m: { machineId: string }) => m.machineId).sort()).toEqual(['seed-notebook', 'seed-studio']);
    const page = buildAccountsPage({ ok: true, data: pool }, harness.now, { ...harness.options, inUse });
    expect(page.accounts).toHaveLength(14); expect(page.accounts.some((a: { stale: boolean }) => a.stale)).toBe(true);
    expect(harness.peerRequests.map(r => r.path).sort()).toEqual(['/subscription-pool', '/subscription-relogin']);
    expect(harness.home).toContain(harness.root); expect(harness.stateDirs.every(dir => dir.startsWith(harness.root))).toBe(true);
  });
  it('runs empty and unreadable raw stores through production availability behavior rather than canned responses', async () => {
    const harness = await startAccountsHarness(); close.push(harness.close);
    await harness.setState('empty'); const empty = await fetch(`${harness.url}/subscription-pool?scope=pool`).then(r => r.json());
    expect(empty.accounts).toEqual([]); expect(empty.pool.failed).toEqual([]);
    await harness.setState('error');
    const local = await fetch(`${harness.url}/subscription-pool`); expect(local.status).toBe(503);
    expect(await local.json()).toMatchObject({ error: 'subscription-pool-authority-unavailable', availability: 'invalid' });
    const pooled = await fetch(`${harness.url}/subscription-pool?scope=pool`).then(r => r.json());
    expect(pooled.accounts).toEqual([]); expect(pooled.pool.failed.some((row: { machineId: string }) => row.machineId === 'seed-studio')).toBe(true);
  });
  it('has no mutable or unlisted API, releases its port, and removes throwaway state on close', async () => {
    const harness = await startAccountsHarness();
    expect((await fetch(`${harness.url}/subscription-pool`, { method: 'POST', body: '{}' })).status).toBe(405);
    expect((await fetch(`${harness.url}/guards`)).status).toBe(404);
    const url = harness.url, root = harness.root; await harness.close();
    expect(fs.existsSync(root)).toBe(false); await expect(fetch(`${url}/pool`)).rejects.toThrow();
    await harness.close(); await expect(harness.setState('busy')).rejects.toThrow('closed');
  });
  it('works while host identity discovery and nonloopback network access are forbidden', async () => {
    vi.spyOn(os, 'homedir').mockImplementation(() => { throw new Error('Host HOME discovery forbidden'); });
    vi.spyOn(os, 'hostname').mockImplementation(() => { throw new Error('Host machine identity forbidden'); });
    const actualRead = fs.readFileSync.bind(fs);
    const repo = fileURLToPath(new URL('../../', import.meta.url));
    const fixturePrefix = path.join(os.tmpdir(), 'instar-design-accounts-');
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      const filename = file instanceof URL ? fileURLToPath(file) : typeof file === 'string' ? file : null;
      if (filename && !filename.startsWith(repo) && !filename.startsWith(fixturePrefix)) throw new Error('Host-file read forbidden');
      return actualRead(file, options as never);
    }) as typeof fs.readFileSync);
    const actualFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== '127.0.0.1') throw new Error('Nonloopback network forbidden');
      return actualFetch(input, init);
    });
    const harness = await startAccountsHarness(); close.push(harness.close);
    const result = await fetch(`${harness.url}/subscription-pool?scope=pool`).then(response => response.json());
    expect(result.accounts).toHaveLength(15);
    const active = await fetch(`${harness.url}/subscription-pool/in-use`).then(response => response.json());
    expect(active.activeAccountId).toBe('seed-account-1');
    for (const route of ['/mobile/browser-devices/status', '/work-board', '/health', '/mobile/health-issues']) {
      expect((await fetch(harness.url + route, { headers: { Authorization: `Bearer ${harness.bootNonce}` } })).status).toBe(200);
    }
    expect(os.homedir).not.toHaveBeenCalled(); expect(os.hostname).not.toHaveBeenCalled();
  });

  it('performs no filesystem writes while serving the production console assets', async () => {
    const harness = await startAccountsHarness(); close.push(harness.close);
    const actualWrite = fs.writeFileSync.bind(fs);
    const writes: string[] = [];
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const filename = file instanceof URL ? fileURLToPath(file) : typeof file === 'string' ? path.resolve(file) : null;
      writes.push(filename ?? '<file descriptor>');
      if (filename && !filename.startsWith(harness.root + path.sep)) throw new Error('Write outside fixture root forbidden');
      return actualWrite(file, ...args as [string, fs.WriteFileOptions]);
    }) as typeof fs.writeFileSync);
    for (const asset of ['/dashboard/console/', '/dashboard/console/accounts.js', '/dashboard/console/console.css']) {
      expect((await fetch(`${harness.url}${asset}`)).status).toBe(200);
    }
    expect(writes).toEqual([]);
    writeSpy.mockRestore(); // SafeFs disposal may append its ordinary audit record.
    await harness.close();
  });

});

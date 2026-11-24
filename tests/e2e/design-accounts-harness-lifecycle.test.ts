import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startAccountsHarness } from '../design/harness/accountsServer.js';
const stops: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); });
describe('Accounts fixture startup, raw state and disposal', () => {
  it('starts independent read-only compositions from raw seed stores and releases every lifecycle resource', async () => {
    const first = await startAccountsHarness(); stops.push(first.close);
    expect(first.stateDirs).toHaveLength(2);
    for (const dir of first.stateDirs) {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'subscription-pool.json'), 'utf8'));
      expect(raw.accounts.length).toBeGreaterThan(0);
      expect(raw.accounts.every((account: { configHome: string; email: string }) => account.configHome.startsWith(first.home) && account.email.endsWith('@example.com'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'machine-identity.json'))).toBe(false);
    }
    const inUse = await fetch(`${first.url}/subscription-pool/in-use`).then(r => r.json()); expect(inUse.activeAccountId).toBe('seed-account-1');
    const firstUrl = first.url, firstRoot = first.root; await first.close(); expect(fs.existsSync(firstRoot)).toBe(false);
    await expect(fetch(`${firstUrl}/pool`)).rejects.toThrow();
    const second = await startAccountsHarness('empty'); stops.push(second.close);
    expect(second.root).not.toBe(firstRoot);
    const empty = await fetch(`${second.url}/subscription-pool?scope=pool`).then(r => r.json()); expect(empty.accounts).toEqual([]);
    expect(second.peerRequests).toHaveLength(1); // Real peer plain read, never recursive scope=pool.
    const active = await fetch(`${second.url}/subscription-pool/in-use`).then(r => r.json()); expect(active.activeAccountId).toBeNull();
  });
  it('keeps fixture boot nonces origin-local, logs actual requests and leaves production assets intact on disposal', async () => {
    const first = await startAccountsHarness(), second = await startAccountsHarness(); stops.push(first.close, second.close);
    const production = fs.readFileSync('dashboard/console/accounts.js');
    expect(first.bootNonce).not.toBe(second.bootNonce);
    expect(first.consoleUrl).toBe(`${first.url}/dashboard/console/#/capacity/accounts`);
    const own = await fetch(`${first.url}/sessions`, { headers: { Authorization: `Bearer ${first.bootNonce}` } });
    expect(own.status).toBe(204); expect(await own.text()).toBe('');
    expect((await fetch(`${second.url}/sessions`, { headers: { Authorization: `Bearer ${first.bootNonce}` } })).status).toBe(401);
    expect((await fetch(`${second.url}/sessions`, { headers: { Authorization: `Bearer ${second.bootNonce}` } })).status).toBe(204);
    expect((await fetch(`${first.url}/dashboard/console/accounts.js`)).status).toBe(200);
    expect(first.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'GET', path: '/sessions', status: 204 }),
      expect.objectContaining({ method: 'GET', path: '/dashboard/console/accounts.js', status: 200 }),
    ]));
    expect(JSON.stringify(first.requests)).not.toContain(first.bootNonce);
    const url = first.url; await first.close();
    await expect(fetch(`${url}/dashboard/console/`)).rejects.toThrow();
    expect(fs.readFileSync('dashboard/console/accounts.js')).toEqual(production);
    expect((await fetch(`${second.url}/subscription-pool?scope=pool`)).status).toBe(200);
  });

  it('keeps surrounding reads synthetic and independent across fixture startup, failure and disposal', async () => {
    const first = await startAccountsHarness(), second = await startAccountsHarness('busy', { surroundingState: 'health-error' });
    stops.push(first.close, second.close);
    const headers = { Authorization: `Bearer ${first.bootNonce}` };
    for (const route of ['/mobile/browser-devices/status', '/work-board', '/health', '/mobile/health-issues']) expect((await fetch(first.url + route, { headers })).status).toBe(200);
    const wrong = await fetch(`${second.url}/mobile/browser-devices/status`, { headers }); expect(wrong.status).toBe(403);
    const failed = await fetch(`${second.url}/mobile/health-issues`, { headers: { Authorization: `Bearer ${second.bootNonce}` } }); expect(failed.status).toBe(500);
    expect(second.surroundingFailures).toHaveLength(1); expect(first.surroundingFailures).toEqual([]);
    const oldUrl = first.url; await first.close(); await expect(fetch(`${oldUrl}/health`)).rejects.toThrow();
    expect((await fetch(`${second.url}/subscription-pool?scope=pool`)).status).toBe(200);
  });

});

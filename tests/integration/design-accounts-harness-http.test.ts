import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { startAccountsHarness } from '../design/harness/accountsServer.js';
import { ACCOUNTS_CONSOLE_ASSETS } from '../design/harness/accountsConsoleAssets.js';
const stops: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); });
describe('shared production Accounts handlers over real fixture HTTP', () => {
  it('keeps the production route registrations and shared mobile reads wired to the extracted implementation', async () => {
    const routes = fs.readFileSync('src/server/routes.ts', 'utf8');
    for (const [route, handler] of [['/pool', 'pool'], ['/subscription-pool', 'subscriptionPool'], ['/subscription-relogin', 'subscriptionRelogin'], ['/subscription-pool/in-use', 'inUse']]) {
      expect(routes).toContain(`router.get('${route}', accountsReads.${handler})`);
    }
    expect(routes).toContain('const subscriptionPoolScopeView = accountsReads.subscriptionPoolScopeView');
    expect(routes).toContain('accountsView: () => subscriptionPoolScopeView()');
    const harness = await startAccountsHarness(); stops.push(harness.close);
    const response = await fetch(`${harness.url}/subscription-pool?scope=pool`);
    expect(response.status).toBe(200); const body = await response.json();
    const remote = body.accounts.filter((account: { remote: boolean }) => account.remote);
    expect(remote).toHaveLength(1); expect(remote[0]).toMatchObject({ machineId: 'seed-notebook', machineNickname: 'River Notebook' });
    expect(body.emailReconciliation.state).toBe('complete');
    expect(harness.peerRequests).toContainEqual({ machineId: 'seed-notebook', path: '/subscription-pool' });
  });
  it('returns the actual local authority failure and tolerant pool failure classification for invalid raw state', async () => {
    const harness = await startAccountsHarness('error'); stops.push(harness.close);
    const response = await fetch(`${harness.url}/subscription-pool`); expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ availability: 'invalid', machineId: 'seed-studio' });
    const poolResponse = await fetch(`${harness.url}/subscription-pool?scope=pool`); expect(poolResponse.status).toBe(200);
    const pool = await poolResponse.json(); expect(pool.accounts).toEqual([]);
    expect(pool.pool.failed).toEqual(expect.arrayContaining([{ machineId: 'seed-studio', error: 'peer-pool-invalid' }, { machineId: 'seed-notebook', error: 'error' }]));
  });
});

describe('production console assets and isolated fixture bootstrap', () => {
  it('serves the actual console entry and Accounts module bytes without changing real API results', async () => {
    const harness = await startAccountsHarness(); stops.push(harness.close);
    const index = await fetch(`${harness.url}/dashboard/console/`);
    expect(index.status).toBe(200); expect(await index.text()).toBe(fs.readFileSync('dashboard/console/index.html', 'utf8'));
    const accounts = await fetch(`${harness.url}/dashboard/console/accounts.js`);
    expect(accounts.status).toBe(200); expect(await accounts.text()).toBe(fs.readFileSync('dashboard/console/accounts.js', 'utf8'));
    const pool = await fetch(`${harness.url}/subscription-pool?scope=pool`).then(r => r.json()); expect(pool.accounts).toHaveLength(15);
  });
  it('exposes only an empty exact-GET sessions status for this fixture nonce', async () => {
    const harness = await startAccountsHarness(); stops.push(harness.close);
    const nonce = harness.bootNonce;
    const response = await fetch(`${harness.url}/sessions`, { headers: { Authorization: `Bearer ${nonce}` } });
    expect(response.status).toBe(204); expect(await response.text()).toBe('');
    expect((await fetch(`${harness.url}/sessions`, { headers: { Authorization: 'Bearer wrong-fixture' } })).status).toBe(401);
    expect((await fetch(`${harness.url}/sessions?scope=pool`, { headers: { Authorization: `Bearer ${nonce}` } })).status).toBe(404);
    expect((await fetch(`${harness.url}/sessions`, { method: 'HEAD', headers: { Authorization: `Bearer ${nonce}` } })).status).toBe(405);
    expect((await fetch(`${harness.url}/sessions`, { method: 'POST', headers: { Authorization: `Bearer ${nonce}` } })).status).toBe(405);
  });
  it('serves every mapped production asset byte-for-byte with its real content type and no nonce disclosure', async () => {
    const harness = await startAccountsHarness(); stops.push(harness.close);
    for (const asset of ACCOUNTS_CONSOLE_ASSETS) {
      const response = await fetch(`${harness.url}${asset.route}`);
      expect(response.status, asset.route).toBe(200);
      expect(response.headers.get('content-type'), asset.route).toContain(asset.contentType);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes, asset.route).toEqual(fs.readFileSync(asset.file));
      expect(bytes.includes(Buffer.from(harness.bootNonce)), asset.route).toBe(false);
    }
    expect(harness.requests.filter(request => request.method === 'GET' && request.status === 200).length).toBe(ACCOUNTS_CONSOLE_ASSETS.length);
    expect(JSON.stringify(harness.requests)).not.toContain(harness.bootNonce);
  });
  it('refuses traversal, unlisted files and mutation attempts while undeclared feature reads remain unavailable', async () => {
    const harness = await startAccountsHarness(); stops.push(harness.close);
    for (const url of ['/dashboard/console/..%2f..%2fsrc/server/routes.ts', '/dashboard/console/%2e%2e%2f%2e%2e%2ftests/design/seeds/accounts.json', '/src/server/routes.ts', '/dashboard/console/not-listed.js']) {
      expect((await fetch(`${harness.url}${url}`)).status, url).toBe(404);
    }
    for (const url of ['/mobile/browser-devices', '/work-board/cards/unlisted', '/guards', '/mobile/resources']) expect((await fetch(`${harness.url}${url}`)).status, url).toBe(404);
    for (const url of ['/dashboard/console/accounts.js', '/subscription-pool', '/sessions']) {
      expect((await fetch(`${harness.url}${url}`, { method: 'POST', headers: { Authorization: `Bearer ${harness.bootNonce}` }, body: '{}' })).status, url).toBe(405);
    }
    expect((await fetch(`${harness.url}/sessions?nonce=${harness.bootNonce}`, { headers: { Authorization: `Bearer ${harness.bootNonce}` } })).status).toBe(404);
    expect(JSON.stringify(harness.requests)).not.toContain(harness.bootNonce);
    const pool = await fetch(`${harness.url}/subscription-pool?scope=pool`).then(r => r.json()); expect(pool.accounts).toHaveLength(15);
  });

});

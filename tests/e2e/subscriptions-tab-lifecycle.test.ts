/**
 * E2E lifecycle test — Subscriptions dashboard tab (P2.2).
 *
 * Boots a REAL Express server with the inline /subscription-pool routes from
 * createRoutes() (the production path AgentServer uses), mounts the tab markup in
 * jsdom with the SHIPPED element ids, and drives the SHIPPED controller's
 * fetchImpl against the live HTTP server. Asserts the feature is genuinely alive
 * end-to-end:
 *   - feature ON (pool + wizard wired): accounts render with quota bars, pending
 *     logins render with the device code; no injected <script>/<a> survives
 *   - feature OFF (neither wired → routes 200 { enabled:false }): the friendly
 *     "not set up" copy, never a 503 / crash
 */
// @ts-nocheck — the tab controller is browser-native ESM.
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { PendingLoginStore } from '../../src/core/PendingLoginStore.js';
import { EnrollmentWizard } from '../../src/core/EnrollmentWizard.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { JSDOM } from 'jsdom';
import { createController } from '../../dashboard/subscriptions.js';

interface TestServer { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}
function bootApp(ctx: any): Promise<TestServer> {
  const app = express();
  app.use(express.json());
  app.use(createRoutes(ctx));
  return listen(app);
}

// Mirrors dashboard/index.html element ids for the Subscriptions tab.
const PANEL_HTML = `<!doctype html><body>
  <div id="subscriptionsPanel">
    <div id="subAccounts"></div>
    <div id="subPending"></div>
  </div>
</body>`;

function mountTab(baseUrl: string) {
  const doc = new JSDOM(PANEL_HTML).window.document;
  const els = { accounts: doc.getElementById('subAccounts'), pending: doc.getElementById('subPending') };
  const fetchImpl = (url: string, init?: any) => fetch(baseUrl + url, init);
  const c = createController({ doc, els, fetchImpl, now: () => Date.parse('2026-06-07T00:00:00Z') });
  c._state.active = true; // enable a manual tick() (start() would also schedule)
  return { doc, els, c };
}

describe('/subscription-pool — Subscriptions tab E2E feature-alive', () => {
  let server: TestServer;
  let dir: string;

  afterEach(async () => {
    await server?.close();
    try { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/subscriptions-tab-lifecycle.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  it('feature ON: accounts + pending logins render through the live server', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-tab-e2e-'));
    const pool = new SubscriptionPool({ stateDir: dir });
    pool.add({ id: 'a1', nickname: 'personal', provider: 'anthropic', framework: 'claude-code', configHome: '/h/.c1' });
    pool.update('a1', { lastQuota: { fiveHour: { utilizationPct: 12, resetsAt: '2026-06-07T01:00:00Z' }, sevenDay: { utilizationPct: 71, resetsAt: '2026-06-12T00:00:00Z' } } });
    const store = new PendingLoginStore({ stateDir: dir, now: () => Date.parse('2026-06-07T00:00:00Z') });
    const wizard = new EnrollmentWizard({ store, now: () => Date.parse('2026-06-07T00:00:00Z'),
      driveLogin: async () => ({ verificationUrl: 'https://auth.openai.com/codex/device', userCode: '7DAU-W4XJA', ttlMs: 15 * 60_000 }) });
    await wizard.start({ id: 'codex-1', label: 'codex', provider: 'openai', framework: 'codex-cli' });

    server = await bootApp({ config: { authToken: 't', stateDir: dir, port: 0 }, startTime: new Date(), subscriptionPool: pool, enrollmentWizard: wizard });
    const { els, c } = mountTab(server.url);
    await c.tick();

    expect(els.accounts.querySelector('.sub-account-nick')!.textContent).toBe('personal');
    expect(els.accounts.querySelectorAll('.sub-quota').length).toBe(2);
    expect(els.pending.querySelector('.sub-pending-code')!.textContent).toContain('7DAU-W4XJA');
    // safety: no live link / injected element survived the round-trip
    expect(els.pending.querySelector('a')).toBeNull();
    expect(els.accounts.querySelector('script')).toBeNull();
  });

  it('feature OFF: both routes 200 { enabled:false } → friendly not-set-up copy', async () => {
    server = await bootApp({ config: { authToken: 't', stateDir: '/tmp/.instar', port: 0 }, startTime: new Date() });
    // Routes are alive (not 503).
    const acc = await fetch(server.url + '/subscription-pool');
    const pend = await fetch(server.url + '/subscription-pool/pending-logins');
    expect(acc.status).toBe(200);
    expect(pend.status).toBe(200);
    expect((await pend.json()).enabled).toBe(false);
    const { els, c } = mountTab(server.url);
    await c.tick();
    expect(els.accounts.querySelector('.sub-disabled')).toBeTruthy();
  });
});

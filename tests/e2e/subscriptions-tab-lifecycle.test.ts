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
    <div id="subMatrix"></div>
    <div id="subAccounts"></div>
    <div id="subPending"></div>
  </div>
</body>`;

function mountTab(baseUrl: string) {
  const doc = new JSDOM(PANEL_HTML).window.document;
  const els = {
    accounts: doc.getElementById('subAccounts'),
    pending: doc.getElementById('subPending'),
    matrix: doc.getElementById('subMatrix'),
  };
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
    // The pending login now offers a tappable "Sign in" link to the trusted provider URL
    // (auth.openai.com) — the UX fix. The href is the provider's own OAuth URL, no token.
    const signin = els.pending.querySelector('a.sub-pending-signin') as HTMLAnchorElement | null;
    expect(signin).not.toBeNull();
    expect(signin!.getAttribute('href')).toBe('https://auth.openai.com/codex/device');
    expect(JSON.stringify(els.pending.innerHTML).toLowerCase()).not.toMatch(/token|secret|refresh|api_key/);
    // safety: no injected <script> survived the round-trip
    expect(els.accounts.querySelector('script')).toBeNull();
  });

  it('topic 29836 D1/D2/D3(a)/D5: the matrix cell carries the COMPLETE sign-in flow from the LIVE server, and a real poll tick never clobbers a half-typed code', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-tab-e2e-'));
    const pool = new SubscriptionPool({ stateDir: dir });
    pool.add({ id: 'a1', nickname: 'personal', provider: 'anthropic', framework: 'claude-code', configHome: '/h/.c1', email: 'a1@x.com' });
    const store = new PendingLoginStore({ stateDir: dir, now: () => Date.parse('2026-06-07T00:00:00Z') });
    const wizard = new EnrollmentWizard({ store, now: () => Date.parse('2026-06-07T00:00:00Z'),
      driveLogin: async () => ({ verificationUrl: 'https://claude.com/oauth/authorize?code=true&client_id=x', ttlMs: 15 * 60_000 }) });
    // A live follow-me attempt (the matrix "Set up" mid-flight state), enrolling a SECOND account.
    await wizard.start({
      id: 'justin-gmail', label: 'Justin', provider: 'anthropic', framework: 'claude-code',
      configHome: path.join(dir, '.claude-followme-justin-gmail'), expectedEmail: 'headley.justin@gmail.com',
    });

    server = await bootApp({
      config: { authToken: 't', stateDir: dir, port: 0 },
      startTime: new Date(),
      meshSelfId: 'm-self',
      subscriptionPool: pool,
      enrollmentWizard: wizard,
    });
    const { els, c } = mountTab(server.url);
    await c.tick();

    // D5: the production pending-logins read annotates pane liveness (no tmux in this
    // harness → the honest tri-state null, never a fabricated verdict).
    const pend = await (await fetch(server.url + '/subscription-pool/pending-logins')).json();
    expect(pend.logins[0]).toHaveProperty('paneAlive', null);

    // D2: the in-progress matrix cell renders the COMPLETE flow from server state.
    const cell = els.matrix!.querySelector('.sub-matrix-in-progress')!;
    expect(cell).toBeTruthy();
    // D3(a): the expected-account warning, rendered from the enrollment record.
    expect(cell.querySelector('.sub-matrix-expected')!.textContent).toContain('headley.justin@gmail.com');
    expect(cell.querySelector('a.sub-matrix-signin')!.getAttribute('href')).toContain('code=true');
    const code = cell.querySelector('input.sub-matrix-code-input') as HTMLInputElement;
    expect(code).toBeTruthy();
    expect(cell.querySelector('[data-matrix-cancel]')).toBeTruthy();
    expect(cell.querySelector('[data-ttl-expires]')).toBeTruthy();

    // D1: half-type a code, then run a REAL poll tick against the live server — the
    // typed state survives (the F9 hold), instead of being swapped for "◷ Signing in…".
    code.value = 'HALF-TYPED';
    await c.tick();
    expect(els.matrix!.contains(code)).toBe(true);
    expect(code.value).toBe('HALF-TYPED');
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

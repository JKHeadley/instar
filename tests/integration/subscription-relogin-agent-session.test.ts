/**
 * Skill-driven sign-in repair, integration tier (spec skill-driven-signin-repair):
 *  - the production-shaped runtime drives an episode through the agent-session helper (a fake
 *    session that posts the code the way a real helper would) to server-verified success;
 *  - approval is forced on this path; a missing helper account hands off to the operator;
 *  - the code route through the REAL middleware stack (CORS + bearer auth + JSON parser):
 *    loopback + per-episode token, no bearer needed, strict body, no CORS.
 */
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PlaywrightSeatLease } from '../../src/core/PlaywrightSeatLease.js';
import { createSubscriptionReloginRuntime } from '../../src/core/SubscriptionReloginRuntime.js';
import { createRoutes } from '../../src/server/routes.js';
import { authMiddleware, corsMiddleware } from '../../src/server/middleware.js';
import type { SubscriptionAccount, SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import type { SubscriptionLoginEpisode, SubscriptionLoginLedger } from '../../src/core/SubscriptionLoginLedger.js';
import type { EnrollmentWizard } from '../../src/core/EnrollmentWizard.js';
import type { QuotaPoller } from '../../src/core/QuotaPoller.js';
import type { IdentityOracle } from '../../src/core/CredentialLocationLedger.js';
import type { PlaywrightProfileRegistry } from '../../src/core/PlaywrightProfileRegistry.js';
import type { ClaudePasteBackController } from '../../src/core/ClaudePasteBackController.js';

const dirs: string[] = [];
const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of servers.splice(0)) await close();
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'relogin-agent-session integration cleanup' });
});

const CODE = 'c'.repeat(30) + '#' + 'd'.repeat(30);

function world(opts: { helperAccounts?: Array<Partial<SubscriptionAccount>>; mode?: 'approval' | 'unattended';
  codexCli?: 'signed-in' | 'signed-out'; codexSource?: 'codex-app-server' | 'codex-rollout'; helperPostsCode?: boolean;
  brokenFramework?: 'claude-code' | 'codex-cli'; codexLiveReadAvailable?: boolean } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-agent-session-')); dirs.push(stateDir);
  const userDataDir = path.join(stateDir, 'browser-profile'); fs.mkdirSync(userDataDir);
  const accounts = new Map<string, SubscriptionAccount>();
  const broken: SubscriptionAccount = { id: 'acct-broken', nickname: 'Broken', email: 'person@example.com',
    provider: opts.brokenFramework === 'codex-cli' ? 'openai' : 'anthropic', framework: opts.brokenFramework ?? 'claude-code', configHome: path.join(stateDir, 'slot-broken'), status: 'needs-reauth', enrolledAt: '2026-01-01T00:00:00Z', version: 1 };
  accounts.set(broken.id, broken);
  for (const [i, extra] of (opts.helperAccounts ?? [{}]).entries()) {
    const acct: SubscriptionAccount = { id: `acct-helper-${i}`, nickname: `Helper ${i}`, email: `helper${i}@example.com`,
      provider: 'anthropic', framework: 'claude-code', configHome: path.join(stateDir, `slot-helper-${i}`), status: 'active',
      enrolledAt: '2026-01-01T00:00:00Z', version: 1, ...extra } as SubscriptionAccount;
    accounts.set(acct.id, acct);
  }
  let source: SubscriptionLoginEpisode = { id: 81, accountId: broken.id, machineId: 'machine-1', openedAt: '2026-09-25T00:00:00Z',
    closedAt: null, causeClass: 'exchange-failed', corroboration: 'exchange-corroborated', outcome: null, provenance: 'observed' };
  const pool = { getAvailability: () => ({ state: 'ready' }), get: (id: string) => accounts.has(id) ? { ...accounts.get(id)! } : null,
    list: () => [...accounts.values()].map((a) => ({ ...a })),
    update: vi.fn((id: string, patch: Partial<SubscriptionAccount>) => { const next = { ...accounts.get(id)!, ...patch }; accounts.set(id, next); return next; }),
  } as unknown as SubscriptionPool;
  const ledger = { listEpisodes: () => [{ ...source }], recordStatus: vi.fn(() => {
    source = { ...source, closedAt: '2026-09-25T01:00:00Z', outcome: 'resolved' }; return { changed: true, episodeId: source.id };
  }) } as unknown as SubscriptionLoginLedger;
  let pending: any = null;
  const enrollment = { getById: () => pending, abandon: vi.fn(), refresh: vi.fn(), start: vi.fn(async () => (pending = {
    id: broken.id, label: broken.nickname, provider: 'anthropic', framework: 'claude-code', kind: 'url-code-paste',
    configHome: broken.configHome, verificationUrl: 'https://claude.ai/oauth/authorize?code=true', ttlExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    status: 'pending', reissueCount: 0, createdAt: '', updatedAt: '', version: 1 })) } as unknown as EnrollmentWizard;
  const profiles = { resolve: () => ({ profile: { id: 'profile-1' }, dirExists: true }), listProfiles: () => [{
    id: 'profile-1', userDataDir, description: '', isDefault: false, createdAt: '', dirExists: true,
    accounts: [{ service: 'google', identity: broken.email, owner: 'operator', vaultRefs: ['google_password_person'],
      vaultBindings: { password: 'google_password_person' },
      loginMethod: 'password', lastAsserted: true, lastVerifiedAt: null, note: '', danglingRefs: [] }] }] } as unknown as PlaywrightProfileRegistry;
  const loginChecks = new Map<string, 'ok' | 'signed-out' | 'unavailable'>();
  const pollAccount = vi.fn(async (acct: SubscriptionAccount) => ({
    source: acct.framework === 'codex-cli' ? (opts.codexSource ?? 'codex-app-server') : 'oauth-usage-endpoint-fallback',
    measuredAt: new Date().toISOString(), fiveHour: { utilizationPct: 10, resetsAt: '' } }));
  const pasteBack = { finish: vi.fn(async () => 'complete') } as unknown as ClaudePasteBackController;
  const tmux = new Map<string, boolean>();
  let runtime!: ReturnType<typeof createSubscriptionReloginRuntime>;
  const spawn = vi.fn(async (input: { name: string; prompt: string }) => {
    const tmuxSession = `proj-${input.name}`;
    tmux.set(tmuxSession, true);
    if (opts.helperPostsCode !== false) {
      // The fake helper does what section 3 does at the end: post the code with its token.
      const token = /X-Relogin-Helper-Token: ([A-Za-z0-9_-]+)/.exec(input.prompt)![1]!;
      const episodeId = input.name.slice('relogin-'.length);
      setTimeout(() => { runtime.helper!.submit(episodeId, token, { code: CODE }); }, 20);
    } else {
      setTimeout(() => tmux.set(tmuxSession, false), 20); // exits without finishing
    }
    return tmuxSession;
  });
  const kill = vi.fn((tmuxSession: string) => { tmux.set(tmuxSession, false); });
  runtime = createSubscriptionReloginRuntime({ stateDir, projectDir: stateDir, machineId: 'machine-1', mode: opts.mode ?? 'approval',
    unattendedPolicy: { identities: [broken.email], minimumSuccessfulRepairs: 0, minimumEvidenceDays: 0 },
    pool, ledger, enrollment, profiles,
    quotaPoller: { pollAccount, loginCheck: (id: string) => loginChecks.get(id) ?? 'unavailable' } as unknown as QuotaPoller,
    identityOracle: { resolveSlotTenant: vi.fn(async () => ({ email: broken.email })) } as unknown as IdentityOracle,
    pasteBack, createBrowser: () => { throw new Error('the driver browser must not open on the agent-session path'); },
    resolveSecret: async () => null, supervise: async () => { throw new Error('no supervisor on this path'); },
    ...(opts.codexLiveReadAvailable !== undefined ? { codexLiveReadAvailable: opts.codexLiveReadAvailable } : {}),
    navigation: 'agent-session', seatLease: new PlaywrightSeatLease({ filePath: path.join(stateDir, 'seat-lease.json') }),
    helperSession: { spawn, kill, isAlive: (t) => tmux.get(t) === true, listHelpers: () => [], hasCapacity: () => true, serverPort: 4042,
      codexLoginStatus: async () => opts.codexCli ?? 'signed-in', timing: { pollMs: 10, startGraceMs: 0, exitSettleMs: 0 } },
  });
  return { runtime, spawn, kill, pasteBack, pollAccount, accounts, broken, loginChecks };
}

describe('agent-session sign-in repair runtime', () => {
  it('drives an approved repair through a pinned helper session to SERVER-verified success', async () => {
    const w = world();
    await w.runtime.service.tick();
    const episode = w.runtime.store.list()[0]!;
    expect(episode.state).toBe('suggested');
    await w.runtime.service.approve(episode.id);
    await vi.waitFor(() => expect(w.runtime.store.get(episode.id)?.state).toBe('succeeded'));
    expect(w.spawn).toHaveBeenCalledTimes(1);
    expect(w.spawn.mock.calls[0]![0]).toMatchObject({ name: `relogin-${episode.id}`,
      seat: { accountId: 'acct-helper-0', framework: 'claude-code' } });
    expect(w.spawn.mock.calls[0]![0].prompt).toContain('google_password_person');
    expect(w.pasteBack.finish).toHaveBeenCalledWith(expect.anything(), CODE, expect.any(AbortSignal));
    expect(w.kill).toHaveBeenCalledWith(`proj-relogin-${episode.id}`);
    const events = w.runtime.store.listEvents(episode.id).map((e) => e.eventClass);
    expect(events).toContain('agent-session-drive-started');
    expect(events).toContain('authenticated-use-verified');
    expect(w.accounts.get('acct-broken')!.status).toBe('active');
    w.runtime.close();
  });

  it('an open repair on a cell later verified healthy by another path is closed as resolved-elsewhere, with an audit event', async () => {
    const w = world({ helperAccounts: [{ status: 'needs-reauth' }] as never }); // no helper ⇒ waits on the operator
    await w.runtime.service.tick();
    const episode = w.runtime.store.list()[0]!;
    await w.runtime.service.approve(episode.id);
    await vi.waitFor(() => expect(w.runtime.store.get(episode.id)?.state).toBe('waiting-operator-only'));
    // The operator signs the account in by hand. Pool says active, but no verified read yet ⇒ stays open.
    w.accounts.set('acct-broken', { ...w.accounts.get('acct-broken')!, status: 'active' });
    await w.runtime.service.tick();
    expect(w.runtime.store.get(episode.id)?.state).toBe('waiting-operator-only');
    // The poller's authenticated read (identity reconciled, no drift) verifies the cell.
    w.loginChecks.set('acct-broken', 'ok');
    await w.runtime.service.tick();
    expect(w.runtime.store.get(episode.id)).toMatchObject({ state: 'cancelled', failureClass: 'resolved-elsewhere' });
    expect(w.runtime.store.listEvents(episode.id).map((e) => e.eventClass)).toContain('resolved-elsewhere');
    w.runtime.close();
  });

  it('forces approval on this path even when the configured mode is unattended', async () => {
    const w = world({ mode: 'unattended' });
    await w.runtime.service.tick();
    expect(w.runtime.store.list()[0]).toMatchObject({ state: 'suggested', mode: 'approval' });
    expect(w.spawn).not.toHaveBeenCalled();
    w.runtime.close();
  });

  it('no other healthy account ⇒ waiting-operator-only / no-healthy-seat, never a helper on the repaired account', async () => {
    const w = world({ helperAccounts: [{ status: 'needs-reauth' }, { fiveHour: undefined, lastQuota: { sevenDay: { utilizationPct: 100, resetsAt: '' } } }] as never });
    await w.runtime.service.tick();
    const episode = w.runtime.store.list()[0]!;
    await w.runtime.service.approve(episode.id);
    await vi.waitFor(() => expect(w.runtime.store.get(episode.id)?.state).toBe('waiting-operator-only'));
    expect(w.runtime.store.get(episode.id)).toMatchObject({ failureClass: 'no-healthy-seat', attemptCount: 0 });
    expect(w.spawn).not.toHaveBeenCalled();
    w.runtime.close();
  });

  it('a Codex helper account counts only with a signed-in CLI check AND a live app-server read', async () => {
    const codex = [{ provider: 'openai', framework: 'codex-cli' }] as never;
    for (const [cli, src] of [['signed-out', 'codex-app-server'], ['signed-in', 'codex-rollout']] as const) {
      const w = world({ helperAccounts: codex, codexCli: cli, codexSource: src });
      await w.runtime.service.tick();
      const episode = w.runtime.store.list()[0]!;
      await w.runtime.service.approve(episode.id);
      await vi.waitFor(() => expect(w.runtime.store.get(episode.id)?.state).toBe('waiting-operator-only'));
      w.runtime.close();
    }
    const ok = world({ helperAccounts: codex, codexCli: 'signed-in', codexSource: 'codex-app-server' });
    await ok.runtime.service.tick();
    const episode = ok.runtime.store.list()[0]!;
    await ok.runtime.service.approve(episode.id);
    await vi.waitFor(() => expect(ok.runtime.store.get(episode.id)?.state).toBe('succeeded'));
    expect(ok.spawn.mock.calls[0]![0].seat).toMatchObject({ framework: 'codex-cli' });
    ok.runtime.close();
  });

  it('with the live Codex read turned off, a Codex repair is refused at admission by name (never burns attempts)', async () => {
    const w = world({ brokenFramework: 'codex-cli', codexLiveReadAvailable: false });
    await w.runtime.service.tick();
    expect(w.runtime.store.list()).toEqual([]);
    const on = world({ brokenFramework: 'codex-cli', codexLiveReadAvailable: true });
    await on.runtime.service.tick();
    expect(on.runtime.store.list()).toHaveLength(1);
    w.runtime.close(); on.runtime.close();
  });

  it('a helper that exits without the code ends failed / agent-sign-in-unfinished; nothing it said counts', async () => {
    const w = world({ helperPostsCode: false });
    await w.runtime.service.tick();
    const episode = w.runtime.store.list()[0]!;
    await w.runtime.service.approve(episode.id);
    await vi.waitFor(() => expect(w.runtime.store.get(episode.id)?.state).toBe('failed'));
    expect(w.runtime.store.get(episode.id)?.failureClass).toBe('agent-sign-in-unfinished');
    expect(w.pasteBack.finish).not.toHaveBeenCalled();
    expect(w.accounts.get('acct-broken')!.status).toBe('needs-reauth');
    w.runtime.close();
  });
});

describe('POST /subscription-relogin/:episodeId/code through the real middleware stack', () => {
  async function app(helperSubmit?: (id: string, token: string, body: unknown) => { status: number; body: Record<string, unknown> }) {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-code-route-')); dirs.push(stateDir);
    const config = { authToken: 'api-token', dashboardPin: '123456', stateDir, port: 0 };
    const a = express();
    a.use(corsMiddleware);
    a.use(express.json());
    a.use(authMiddleware('api-token'));
    a.use(createRoutes({ config, startTime: new Date(), subscriptionRelogin: helperSubmit === undefined ? null : {
      store: {} as never, approve: vi.fn(), cancel: vi.fn(), helperSubmit } } as never));
    const url = await new Promise<string>((resolve) => {
      const server = a.listen(0, () => {
        servers.push(() => new Promise<void>((done) => server.close(() => done())));
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      });
    });
    return url;
  }

  it('needs no bearer token — the per-episode token is the auth — and returns the helper verdict', async () => {
    const submit = vi.fn((_id: string, token: string) => token === 'tok' ? { status: 202, body: { accepted: true } } : { status: 403, body: { error: 'invalid-helper-token' } });
    const url = await app(submit);
    const ok = await fetch(`${url}/subscription-relogin/ep-1/code`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Relogin-Helper-Token': 'tok', Origin: 'http://localhost:3000' },
      body: JSON.stringify({ code: CODE }) });
    expect(ok.status).toBe(202);
    expect(ok.headers.get('access-control-allow-origin')).toBeNull(); // no permissive CORS, even for localhost origins
    expect(submit).toHaveBeenCalledWith('ep-1', 'tok', { code: CODE });
    const bad = await fetch(`${url}/subscription-relogin/ep-1/code`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Relogin-Helper-Token': 'nope' }, body: JSON.stringify({ code: CODE }) });
    expect(bad.status).toBe(403);
    // Every OTHER relogin route still requires the bearer token.
    expect((await fetch(`${url}/subscription-relogin`)).status).toBe(401);
  });

  it('refuses a non-loopback Host, a non-JSON body, an oversize body, and a preflight', async () => {
    const submit = vi.fn(() => ({ status: 202, body: {} }));
    const url = await app(submit);
    const port = new URL(url).port;
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/subscription-relogin/ep-1/code', method: 'POST',
        headers: { Host: 'evil.example', 'Content-Type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.end(JSON.stringify({ code: CODE }));
    });
    expect(status).toBe(403);
    expect((await fetch(`${url}/subscription-relogin/ep-1/code`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' })).status).toBe(415);
    expect((await fetch(`${url}/subscription-relogin/ep-1/code`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'x'.repeat(2000) }) })).status).toBe(413);
    const preflight = await fetch(`${url}/subscription-relogin/ep-1/code`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000' } });
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it('answers 503 when the agent-session path is not active', async () => {
    const url = await app(undefined);
    const res = await fetch(`${url}/subscription-relogin/ep-1/code`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Relogin-Helper-Token': 'tok' }, body: JSON.stringify({ code: CODE }) });
    expect(res.status).toBe(503);
  });
});

describe('GET /subscription-pool carries loginCheck next to each status (spec skill-driven-signin-repair)', () => {
  it('shows the poller verdict, and unavailable when there is no signal — never silent', async () => {
    const { SubscriptionPool } = await import('../../src/core/SubscriptionPool.js');
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-pool-logincheck-')); dirs.push(stateDir);
    const pool = new SubscriptionPool({ stateDir });
    pool.addFixture({ id: 'codex-live', nickname: 'a', email: 'a@example.test', provider: 'openai', framework: 'codex-cli', configHome: '/h/a' });
    pool.addFixture({ id: 'codex-dark', nickname: 'b', email: 'b@example.test', provider: 'openai', framework: 'codex-cli', configHome: '/h/b' });
    const a = express();
    a.use(express.json());
    a.use(createRoutes({ config: { authToken: 'test', stateDir, port: 0, dashboardPin: '123456' }, startTime: new Date(),
      subscriptionPool: pool, quotaPoller: { loginCheck: (id: string) => id === 'codex-live' ? 'ok' : 'unavailable' } } as never));
    const url = await new Promise<string>((resolve) => {
      const server = a.listen(0, () => {
        servers.push(() => new Promise<void>((done) => server.close(() => done())));
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      });
    });
    const body = await fetch(`${url}/subscription-pool`).then((r) => r.json() as Promise<{ accounts: Array<{ id: string; status: string; loginCheck: string }> }>);
    const byId = Object.fromEntries(body.accounts.map((acct) => [acct.id, acct]));
    expect(byId['codex-live']).toMatchObject({ status: 'active', loginCheck: 'ok' });
    expect(byId['codex-dark']).toMatchObject({ status: 'active', loginCheck: 'unavailable' });
    const pooled = await fetch(`${url}/subscription-pool?scope=pool`).then((r) => r.json() as Promise<{ accounts: Array<{ id: string; loginCheck: string }> }>);
    expect(pooled.accounts.find((acct) => acct.id === 'codex-dark')?.loginCheck).toBe('unavailable');
  });
});

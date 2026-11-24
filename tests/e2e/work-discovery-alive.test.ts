// Production boot, real private Work authentication and both enrolled sources.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SingleInstanceLock } from '../../src/core/SingleInstanceLock.js';
import { PUBLIC_PR_WARMUP_BUDGET_FILE } from '../../src/core/PublicPrWarmupBudget.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createMockSessionManager } from '../helpers/setup.js';

const PATH = '/work/discover';
const PIN = '135791';
const HOST = 'echo-work-discovery.example.dev';
const AUTH = 'e2e-work-discovery-master';
const dirs: string[] = [];
const servers: AgentServer[] = [];
const locks: SingleInstanceLock[] = [];
const liveConfigs = new WeakMap<AgentServer, LiveConfig>();

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const lock of locks.splice(0)) lock.release();
  for (const dir of dirs.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/work-discovery-alive.test.ts' });
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function boot(developmentAgent: boolean, unavailableMessaging: Array<'telegram' | 'slack'> = [], nominated = developmentAgent, activate = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-discovery-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const sub of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, sub), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  const identity = await new MachineIdentityManager(stateDir).generateIdentity({ name: 'work discovery machine' });
  const singleInstanceLock = new SingleInstanceLock({ stateDir });
  expect(await singleInstanceLock.acquire()).toMatchObject({ acquired: true });
  locks.push(singleInstanceLock);
  if (nominated) fs.writeFileSync(path.join(stateDir, 'state', PUBLIC_PR_WARMUP_BUDGET_FILE),
    JSON.stringify({ version: 1, attempts: [], pages: [], outstanding: [], retryNotBefore: 0, lastObservedAt: 0 }), { mode: 0o600 });
  const config = {
    projectName: 'work-discovery-e2e', projectDir: dir, stateDir, port: 0, developmentAgent,
    workDiscovery: nominated ? {
      publicPrWarmupHome: stateDir, publicPrWarmupMachineId: identity.machineId,
      ...(activate ? { publicPrWarmupPaused: false } : {}),
    } : {},
    authToken: AUTH, dashboardPin: PIN, security: { dashboardScopedToken: { enabled: true } },
    mobilePairing: { multiRoute: { enabled: false } },
    tunnel: { enabled: true, type: 'named', token: 'fixture', hostname: HOST },
    requestTimeoutMs: 5_000,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: unavailableMessaging.map(type => ({ type, enabled: true, config: {} })), updates: {},
    threadline: { ownerName: 'Owner fixture' },
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as never;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as never;
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ workDiscovery: config.workDiscovery }));
  const liveConfig = new LiveConfig(stateDir, { watchPaths: ['workDiscovery.publicPrWarmupPaused'] });
  const server = new AgentServer({ config, liveConfig, sessionManager, meshSelfId: identity.machineId, singleInstanceLock, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel });
  servers.push(server);
  liveConfigs.set(server, liveConfig);
  await server.start();
  return server;
}

function installGithubFixture(held?: Promise<void>, startupDelayMs = 0) {
  vi.stubEnv('GITHUB_TOKEN', 'e2e-fixture-github-token');
  const originalFetch = globalThis.fetch;
  const github = vi.fn(async (init?: RequestInit) => {
    if (startupDelayMs && !held) {
      held = new Promise(resolve => { setTimeout(resolve, startupDelayMs).unref(); });
    }
    if (held && init?.signal) {
      const signal = init.signal;
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, { once: true });
        void held.then(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        });
      });
    }
    const incoming = JSON.parse(String(init?.body)) as { query: string; variables: { states: string[]; cursor: string | null } };
    const step = Number(incoming.variables.cursor ?? 0);
    const open = incoming.variables.states[0] === 'OPEN';
    const next = open && step < 2 ? String(step + 1) : null;
    const numbers = !open ? [] : next ? Array.from({ length: 50 }, (_, index) => step * 50 + index + 1) : [3342];
    return new Response(JSON.stringify({
      data: { repository: { isPrivate: false, pullRequests: {
        nodes: numbers.map(number => ({
          number, title: `Existing work ${number}`, body: number === 3342 ? 'Permanent agent addresses on instar.sh' : '',
          headRefName: `topic/fixture-${number}`, baseRefName: 'main', state: 'OPEN', mergedAt: null,
          updatedAt: '2026-11-23T00:00:00.000Z',
        })),
        pageInfo: { hasNextPage: next !== null, endCursor: next },
      } } },
    }));
  });
  vi.stubGlobal('fetch', (url: Parameters<typeof fetch>[0], init?: RequestInit) =>
    url === 'https://api.github.com/graphql' ? github(init) : originalFetch(url, init));
  return github;
}

describe('work discovery production route', () => {
  it('admits only a private Work session and finds a conversation and a PR beyond the first hundred', async () => {
    const github = installGithubFixture();
    const server = await boot(true);
    const app = server.getApp();
    const native = server.appConversations!;
    const conversationKey = crypto.randomUUID();
    expect(native.applyCreate('work-discovery-fixture', 'creation-1', conversationKey, 'Private design').status).toBe(200);
    native.store.append({
      kind: 'message', eventId: 'discovery-event-1', messageId: 'discovery-message-1',
      conversationKey, at: new Date().toISOString(), machineId: native.deps.machineId(), role: 'operator',
      text: 'Prior design of permanent addresses on instar.sh',
    });
    native.store.append({
      kind: 'message', eventId: 'stale-generated-reply', messageId: 'stale-generated-reply-msg',
      conversationKey, at: new Date().toISOString(), machineId: native.deps.machineId(), role: 'agent',
      text: 'instar.sh stale approval from a nested generated reply',
    });
    await request(app).post(PATH).send({ query: 'instar.sh' }).expect(401).expect('Cache-Control', 'no-store');
    await request(app).post(PATH).send({ query: 'instar.sh', pin: PIN }).expect(401).expect('Cache-Control', 'no-store');
    await request(app).post(PATH).set('Authorization', `Bearer ${AUTH}`).set('X-Instar-AgentId', 'work-discovery-e2e')
      .send({ query: 'instar.sh' }).expect(403).expect('Cache-Control', 'no-store');
    expect(github).toHaveBeenCalledTimes(4);

    const unlock = await request(app).post('/dashboard/unlock').send({ pin: PIN }).expect(200);
    expect(unlock.body.token).toMatch(/^dst_/);
    const owner = { Authorization: `Bearer ${unlock.body.token}` };
    const found = await request(app).post(PATH).set(owner).send({ query: 'instar.sh' }).expect(200).expect('Cache-Control', 'no-store');
    expect(found.body).toMatchObject({
      status: 'partial',
      candidates: [
        { kind: 'conversation', ref: `app:${conversationKey}`, messageId: 'discovery-event-1', evidence: 'lead' },
        { kind: 'pull-request', number: 3342, url: 'https://github.com/JKHeadley/instar/pull/3342' },
      ],
      coverage: { conversations: { status: 'fresh', peers: 'unsearched' }, specs: { status: 'unsearched' } },
    });
    expect(found.text).not.toContain('stale approval');
    const earlierWork = await request(app).post(PATH).set(owner).send({
      query: 'instar.sh addresses for agents', sources: ['pullRequests'],
    }).expect(200);
    expect(earlierWork.body.candidates).toEqual([
      expect.objectContaining({ kind: 'pull-request', number: 3342, matchedBy: 'all-terms' }),
    ]);
    expect(github).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(github.mock.calls)).not.toContain('instar.sh');
    await request(app).post('/dashboard/session/revoke').set(owner).send({}).expect(200);
    await request(app).post(PATH).set(owner).send({ query: 'instar.sh' }).expect(401);
    expect(github).toHaveBeenCalledTimes(4);
  }, 20_000);

  it('reads app excerpts after the public wait and rechecks current erasure and source permission', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const github = installGithubFixture(held);
    try {
      const server = await boot(true, ['telegram', 'slack']);
      const app = server.getApp();
      const native = server.appConversations!;
      const created = (name: string, text: string) => {
        const conversationKey = crypto.randomUUID();
        const id = name.replaceAll(' ', '-');
        expect(native.applyCreate('fixture', `create-${id}`, conversationKey, name).status).toBe(200);
        native.store.append({
          kind: 'message', eventId: `event-${id}`, messageId: `message-${id}`, conversationKey,
          at: new Date().toISOString(), machineId: native.deps.machineId(), role: 'operator', text,
        });
        return conversationKey;
      };
      const erased = created('erased title', 'instar.sh erased excerpt');
      const restricted = created('restricted title', 'instar.sh restricted excerpt');
      const visible = created('visible-title', 'instar.sh visible excerpt');
      const unlock = await request(app).post('/dashboard/unlock').send({ pin: PIN }).expect(200);
      const owner = { Authorization: `Bearer ${unlock.body.token}` };
      const before = await request(app).post(PATH).set(owner).send({ query: 'instar.sh', sources: ['conversations'] }).expect(200);
      expect(before.body.candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ ref: `app:${erased}`, snippet: expect.stringContaining('erased excerpt') }),
        expect.objectContaining({ ref: `app:${restricted}`, snippet: expect.stringContaining('restricted excerpt') }),
      ]));
      expect(github).toHaveBeenCalledTimes(2);
      const pending = request(app).post(PATH).set(owner).send({ query: 'instar.sh' }).then(response => response);
      await vi.waitFor(() => expect(github).toHaveBeenCalled(), { interval: 5 });
      native.applyDelete('fixture', 'delete-erased', erased);
      const pairing = server.mobilePairing!;
      const mayUse = pairing.mayUse.bind(pairing);
      vi.spyOn(pairing, 'mayUse').mockImplementation((person, key, op) =>
        key !== restricted && key !== `app:${restricted}` && mayUse(person, key, op));
      release();
      const result = await pending;
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        coverage: { conversations: { status: 'partial', platforms: { app: 'present', telegram: 'unknown', slack: 'unknown' } } },
        candidates: [
          { kind: 'conversation', ref: `app:${visible}`, evidence: 'lead' },
          { kind: 'pull-request', number: 3342 },
        ],
      });
      expect(result.text).not.toMatch(/erased excerpt|restricted excerpt|erased title|restricted title/);
      expect(result.text).not.toContain(erased);
      expect(result.text).not.toContain(restricted);
      // Separately prove the same dashboard session still reads current, authorized inputs.
      await request(app).post(PATH).set(owner).send({ query: 'instar.sh', sources: ['conversations'] }).expect(200);
    } finally {
      release();
    }
  }, 20_000);

  it('keeps the shipped Work form pending during a healthy eighteen-second startup scan', async () => {
    installGithubFixture(undefined, 18_200);
    const server = await boot(true);
    const app = server.getApp();
    const native = server.appConversations!;
    const conversationKey = crypto.randomUUID();
    expect(native.applyCreate('work-ui-fixture', 'work-ui-created', conversationKey, 'Earlier design').status).toBe(200);
    native.store.append({
      kind: 'message', eventId: 'work-ui-event', messageId: 'work-ui-message', conversationKey,
      at: new Date().toISOString(), machineId: native.deps.machineId(), role: 'operator',
      text: 'Earlier design discussion about instar.sh addresses for agents.',
    });
    const asset = await request(app).get('/dashboard/console/work-discovery.js').expect(200);
    expect(asset.text).toContain("'/work/discover'");
    const unlock = await request(app).post('/dashboard/unlock').send({ pin: PIN }).expect(200);
    expect(unlock.body.token).toMatch(/^dst_/);
    const dom = new JSDOM('<!doctype html><main></main>', { url: 'http://localhost/dashboard/console/#/work/board' });
    try {
      for (const key of ['window', 'document', 'location', 'localStorage', 'Node', 'HTMLElement'] as const) {
        vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key]);
      }
      dom.window.localStorage.setItem('instar_token', unlock.body.token);
      const network = globalThis.fetch;
      const wire = vi.fn(async (path: string, init: RequestInit) => {
        const result = await request(app).post(path).set(init.headers as Record<string, string>).send(String(init.body));
        return { status: result.status, json: async () => result.body };
      });
      vi.stubGlobal('fetch', (target: Parameters<typeof fetch>[0], init?: RequestInit) =>
        target === '/work/discover' ? wire(target, init ?? {}) : network(target, init));
      const { renderWork } = await import('../../dashboard/console/work.js');
      const main = dom.window.document.querySelector('main')!;
      await renderWork(main, { get: async (url: string) => {
        const read = await request(app).get(url).set('Authorization', `Bearer ${unlock.body.token}`);
        return { ok: read.status === 200, status: read.status, data: read.body };
      } });
      const input = main.querySelector<HTMLInputElement>('#work-discovery-query')!;
      expect(input).not.toBeNull();
      input.value = 'instar.sh addresses for agents';
      input.form!.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
      expect(input.form!.getAttribute('aria-busy')).toBe('true');
      expect(main.textContent).toContain('Searching for earlier work');
      await request(app).get('/health').expect(200);
      await vi.waitFor(() => expect(main.querySelector('a[href="https://github.com/JKHeadley/instar/pull/3342"]')).not.toBeNull(),
        { timeout: 21_000 });
      const links = [...main.querySelectorAll('section[aria-label="Find earlier work"] a')].map(link => link.getAttribute('href'));
      expect(links).toContain(`#/work/chats?c=${encodeURIComponent('app:' + conversationKey)}&m=work-ui-event`);
      expect(main.textContent).toContain('Matched all search terms');
      expect(main.textContent).toContain('Search coverage');
      expect(wire).toHaveBeenCalledOnce();
      const [[url, post]] = wire.mock.calls;
      expect(url).toBe(PATH);
      expect(JSON.parse(String(post.body))).toEqual({ query: 'instar.sh addresses for agents' });
      expect(dom.window.location.href).not.toContain('instar.sh');
    } finally {
      dom.window.close();
    }
  }, 30_000);

  it('joins the server-started cold scan even when GitHub takes more than five seconds', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const github = installGithubFixture(held);
    try {
      const app = (await boot(true)).getApp();
      expect(github).toHaveBeenCalledTimes(2); // No lookup was sent.
      const unlock = await request(app).post('/dashboard/unlock').send({ pin: PIN }).expect(200);
      const owner = { Authorization: `Bearer ${unlock.body.token}` };
      let completed = false;
      const cold = request(app).post(PATH).set(owner)
        .send({ query: 'instar.sh', sources: ['pullRequests'] })
        .then(response => { completed = true; return response; });
      await new Promise(resolve => setTimeout(resolve, 5_200));
      expect(completed).toBe(false);
      expect(github).toHaveBeenCalledTimes(2);
      release();
      const result = await cold;
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        candidates: [{ kind: 'pull-request', number: 3342 }],
        coverage: { pullRequests: { status: 'fresh' } },
      });
      expect(github).toHaveBeenCalledTimes(4);
      const warm = await request(app).post(PATH).set(owner).send({ query: 'instar.sh' }).expect(200);
      expect(warm.body.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ number: 3342 })]));
      expect(github).toHaveBeenCalledTimes(4);
      expect(JSON.stringify(github.mock.calls)).not.toContain('instar.sh');
    } finally {
      release();
    }
  }, 25_000);

  it('aborts both GitHub requests as the server stops', async () => {
    let release!: () => void;
    const github = installGithubFixture(new Promise<void>(resolve => { release = resolve; }));
    try {
      const server = await boot(true);
      expect(github).toHaveBeenCalledTimes(2);
      const signals = github.mock.calls.map(([init]) => init?.signal);
      expect(signals.every(signal => signal && !signal.aborted)).toBe(true);
      await server.stop();
      servers.splice(servers.indexOf(server), 1);
      expect(signals.every(signal => signal?.aborted)).toBe(true);
      expect(github).toHaveBeenCalledTimes(2);
    } finally {
      release();
    }
  }, 20_000);

  it('leaves nomination alone dark and aborts immediately on an observed LiveConfig pause', async () => {
    let release!: () => void;
    const github = installGithubFixture(new Promise<void>(resolve => { release = resolve; }));
    try {
      const dark = await boot(true, [], true, false);
      expect(github).not.toHaveBeenCalled();
      const active = await boot(true);
      expect(github).toHaveBeenCalledTimes(2);
      const signals = github.mock.calls.map(([init]) => init?.signal);
      const { config } = active as unknown as { config: InstarConfig };
      const file = path.join(config.stateDir, 'config.json');
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...onDisk, workDiscovery: { ...onDisk.workDiscovery, publicPrWarmupPaused: true } }));
      const liveConfig = liveConfigs.get(active)!;
      liveConfig.forceRefresh();
      expect(signals.every(signal => signal?.aborted)).toBe(true);
      expect(github).toHaveBeenCalledTimes(2);
      expect((await request(dark.getApp()).get('/health')).status).toBe(200);
    } finally {
      release();
    }
  }, 20_000);

  it('leaves an unselected development installation on its existing on-demand path', async () => {
    const github = installGithubFixture();
    const app = (await boot(true, [], false)).getApp();
    expect(github).not.toHaveBeenCalled();
    const unlocked = await request(app).post('/dashboard/unlock').send({ pin: PIN }).expect(200);
    await request(app).post(PATH).set('Authorization', `Bearer ${unlocked.body.token}`)
      .send({ query: 'instar.sh' }).expect(200);
    expect(github).toHaveBeenCalledTimes(4);
  }, 20_000);

  it('returns an honest disabled status to the owner outside the development cohort', async () => {
    const github = installGithubFixture();
    const app = (await boot(false)).getApp();
    const unlock = await request(app).post('/dashboard/unlock').send({ pin: PIN }).expect(200);
    await request(app).post(PATH).set('Authorization', `Bearer ${unlock.body.token}`).send({ query: 'instar.sh' })
      .expect(503).expect('Cache-Control', 'no-store');
    expect(github).not.toHaveBeenCalled();
  }, 20_000);
});

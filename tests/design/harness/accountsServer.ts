import { createAccountsLoadingBarrier } from './accountsLoading.mjs';
import { createFixtureResponseEvidence, type FixtureResponseProvider } from './fixtureResponseEvidence.mjs';
import { createAccountsSurroundingReads, SURROUNDING_READ_PATHS, type SurroundingState } from './accountsSurroundingReads.js';
/** Loopback-only Accounts design fixture. No browser, capture or merge-gate proof. */
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { ACCOUNTS_CONSOLE_ASSETS, readAccountsConsoleAsset, type AccountsConsoleAsset } from './accountsConsoleAssets.js';
import { requireAccountsTargetRuntime, readTargetAccountsConsoleAsset, type AccountsProductionModules } from './targetProductionModules.js';
import type { AccountsReadContext, AccountsReadDeps } from '../../../src/server/accountsReadRoutes.js';
import type { SubscriptionPool, SubscriptionAccount } from '../../../src/core/SubscriptionPool.js';
import type { MachineCapacity, InstarConfig } from '../../../src/core/types.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

interface SeedAccount extends Omit<SubscriptionAccount, 'provider' | 'configHome' | 'enrolledAt'> {
  machineId: string; machineNickname: string; loginCheck: 'ok' | 'unavailable';
}
interface Seed {
  now: string;
  states: {
    busy: { subscriptionPool: { accounts: SeedAccount[] }; options: { episodes: []; blockers: []; inUse: { activeAccountId: string } } };
    empty: { subscriptionPool: { accounts: [] } };
    error: { reason: string };
  };
}
export type AccountsHarnessState = 'busy' | 'empty' | 'error';
export interface AccountsHarnessRequest { machineId: string; method: string; path: string; scope?: 'pool'; status: number | null }
export interface AccountsHarness {
  responseEvidenceProvider: FixtureResponseProvider;
  surroundingFailures: Array<{ detail: string; error: unknown }>;
  url: string; consoleUrl: string; bootNonce: string; requests: AccountsHarnessRequest[]; root: string; home: string; now: number; stateDirs: string[];
  options: Seed['states']['busy']['options']; peerRequests: Array<{ machineId: string; path: string }>;
  setState: (state: AccountsHarnessState) => Promise<void>;
  close: () => Promise<void>;
}

export interface AccountsHarnessOptions { surroundingState?: SurroundingState; loading?: boolean }
/** Explicit local-prototype entry. Not a BASE/target-bound fixture. */
export async function startAccountsHarness(initialState: AccountsHarnessState = 'busy', options: AccountsHarnessOptions = {}): Promise<AccountsHarness> {
  const { localAccountsProductionModules } = await import('./localAccountsProductionModules.js');
  return startAccountsHarnessWithModules(await localAccountsProductionModules(), readAccountsConsoleAsset, initialState, options);
}
/** Target mode has no local production-module or asset fallback. */
export async function startTargetAccountsHarness(runtime: AccountsProductionModules, initialState: AccountsHarnessState = 'busy', options: AccountsHarnessOptions = {}): Promise<AccountsHarness> {
  requireAccountsTargetRuntime(runtime);
  return startAccountsHarnessWithModules(runtime, asset => readTargetAccountsConsoleAsset(runtime, asset), initialState, options);
}
async function startAccountsHarnessWithModules(production: AccountsProductionModules, readAsset: (asset: Readonly<AccountsConsoleAsset>) => Buffer, initialState: AccountsHarnessState, options: AccountsHarnessOptions): Promise<AccountsHarness> {
  const { createAccountsReadHandlers } = production.accountsReadRoutes;
  const { SubscriptionPool } = production.subscriptionPool;
  const { InUseAccountResolver } = production.inUseAccountResolver;
  const { describeSubscriptionReloginConfig, readOnDiskSubscriptionReloginBlock } = production.subscriptionReloginOperatorConfig;
  if (options.loading && initialState !== 'busy') throw new Error('Loading uses the actual busy raw seed');
  const seed = JSON.parse(fs.readFileSync(new URL('../seeds/accounts.json', import.meta.url), 'utf8')) as Seed;
  const now = Date.parse(seed.now);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-design-accounts-'));
  const home = path.join(root, 'home');
  const names = new Map(seed.states.busy.subscriptionPool.accounts.map(row => [row.machineId, row.machineNickname]));
  const machineIds = [...names.keys()];
  const self = seed.states.busy.subscriptionPool.accounts[0].machineId;
  const capacities: MachineCapacity[] = machineIds.map(machineId => ({ machineId, nickname: names.get(machineId), online: true, clockSkewStatus: 'ok' }));
  const stateDirs = machineIds.map(id => path.join(home, 'agents', id, '.instar'));
  const pools = new Map<string, SubscriptionPool>();
  const addresses = new Map<string, string>();
  const servers: Server[] = [];
  const peerRequests: AccountsHarness['peerRequests'] = [];
  const bootNonce = randomBytes(32).toString('hex');
  const requests: AccountsHarnessRequest[] = [];
  const surroundingFailures: Array<{ detail: string; error: unknown }> = [];
  let currentState = initialState;
  const loading = options.loading ? createAccountsLoadingBarrier() : undefined;
  const responseEvidence = createFixtureResponseEvidence({ seedState: () => currentState, loading });
  let closed = false;
  const setState = async (state: AccountsHarnessState) => {
    if (closed) throw new Error('Accounts fixture is closed');
    currentState = state;
    for (const [index, id] of machineIds.entries()) {
      const stateDir = stateDirs[index]; fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ subscriptionPool: {} }));
      const rows = state === 'empty' ? [] : seed.states.busy.subscriptionPool.accounts.filter(row => row.machineId === id);
      const accounts = rows.map(row => {
        const { machineId: _machineId, machineNickname: _machineNickname, loginCheck: _loginCheck, ...account } = row;
        const configHome = path.join(home, 'credentials-not-installed', id, row.id);
        fs.mkdirSync(configHome, { recursive: true });
        return { ...account, provider: row.framework === 'codex-cli' ? 'openai' : 'anthropic', configHome, enrolledAt: seed.now };
      });
      // A corrupt raw store exercises the real production availability branch.
      fs.writeFileSync(path.join(stateDir, 'subscription-pool.json'), state === 'error' ? '{broken-fixture' : JSON.stringify({ version: 1, accounts, lastModified: seed.now }));
      // Legacy/test compatibility is explicit: no machine identity/key registry is constructed.
      pools.set(id, new SubscriptionPool({ stateDir }));
    }
  };
  const close = async () => {
    if (closed) return; closed = true; loading?.cancel();
    await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
    })));
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'design-accounts-harness:close' });
  };
  try {
    await setState(initialState);
    for (const [index, id] of machineIds.entries()) {
      const stateDir = stateDirs[index];
      const config = { projectName: 'design-accounts-fixture', projectDir: root, stateDir, port: 0 } as InstarConfig;
      const resolver = new InUseAccountResolver({ now: () => now, probe: async () => {
        if (currentState !== 'busy') return null;
        return seed.states.busy.subscriptionPool.accounts.find(row => row.machineId === id && row.id === seed.states.busy.options.inUse.activeAccountId)?.email ?? null;
      } });
      const ctx: AccountsReadContext = {
        config, meshSelfId: id,
        get subscriptionPool() { return pools.get(id)!; },
        quotaPoller: { loginCheck: accountId => seed.states.busy.subscriptionPool.accounts.find(row => row.machineId === id && row.id === accountId)?.loginCheck ?? 'unavailable' },
        machinePoolRegistry: { getCapacity: key => capacities.find(row => row.machineId === key) ?? null, getCapacities: () => structuredClone(capacities) },
        subscriptionRelogin: { store: { list: () => structuredClone(seed.states.busy.options.episodes) }, blockers: async () => structuredClone(seed.states.busy.options.blockers) },
        inUseAccountResolver: resolver,
        resolvePeerUrls: () => id === self ? machineIds.filter(peer => peer !== self).map(machineId => ({ machineId, url: addresses.get(machineId)!, kind: 'last-known-url' as const })) : [],
      };
      const readable = () => ['ready', 'unconfigured'].includes(pools.get(id)!.getAvailability().state);
      const deps: AccountsReadDeps = {
        subscriptionPoolAvailability: () => pools.get(id)!.getAvailability(), subscriptionPoolReadable: readable,
        subscriptionPoolFailureBody: () => { const availability = pools.get(id)!.getAvailability(); return { error: 'subscription-pool-authority-unavailable', availability: availability.state, reason: availability.reason, maintenance: availability.maintenance }; },
        subscriptionEmailGaps: () => [], // All seed identities use invented, present example.com addresses.
        subscriptionEmailReconciliation: () => ({ state: 'complete', unresolvedCount: 0, repairRunsFreshProbe: true }),
        localReloginConfig: () => ({ machineId: id, ...describeSubscriptionReloginConfig(readOnDiskSubscriptionReloginBlock(stateDir)), activationPending: false,
          verifiedPoolEmails: readable() ? pools.get(id)!.list().map(row => row.email).sort() : null }),
        deviceLimitStatus: () => null, recoveryPoolView: () => null, siblingHoldings: () => null, bearerMatches: () => false,
        peerFetch: async (_record, peer, pathname, init) => {
          if (addresses.get(peer.machineId) !== peer.url || new URL(peer.url).hostname !== '127.0.0.1') throw new Error('Design harness refuses a non-fixture peer');
          if (!['/subscription-pool', '/subscription-relogin'].includes(pathname.split('?')[0])
            || new URL(pathname, peer.url).searchParams.get('scope') === 'pool') throw new Error('Unexpected or recursive fixture peer request');
          peerRequests.push({ machineId: peer.machineId, path: pathname });
          if (pathname.split('?')[0] === '/subscription-pool') await loading?.wait();
          return fetch(new URL(pathname, peer.url), { ...init, redirect: 'error' });
        }, now: () => now,
      };
      const handlers = createAccountsReadHandlers(ctx, deps);
      const app = express();
      app.locals.stateDir = stateDir;
      if (id === self) { app.use(responseEvidence.middleware); if (loading) app.use(loading.middleware); }
      const routes = new Map([['/subscription-pool', handlers.subscriptionPool], ['/subscription-relogin', handlers.subscriptionRelogin],
        ['/subscription-pool/in-use', handlers.inUse], ['/pool', handlers.pool]]);
      const surrounding = id === self ? createAccountsSurroundingReads(production, bootNonce, now, self, surroundingFailures) : null;
      surrounding?.setState(options.surroundingState ?? 'available');
      const assets = new Map((id === self ? ACCOUNTS_CONSOLE_ASSETS : []).map(asset => [asset.route, asset]));
      app.use((req, res, next) => {
        // Deliberately no headers, query values or bodies: the nonce stays in the fixture handle.
        const entry: AccountsHarnessRequest = { machineId: id, method: req.method, path: req.path,
          ...(req.query.scope === 'pool' ? { scope: 'pool' as const } : {}), status: null };
        requests.push(entry);
        res.once('finish', () => { entry.status = res.statusCode; });
        // Fixture-only transport status for console validToken(): no live auth or session JSON.
        if (id === self && req.path === '/sessions') {
          if (req.method !== 'GET') { res.sendStatus(405); return; }
          if (req.originalUrl !== '/sessions') { res.sendStatus(404); return; }
          if (req.get('Authorization') !== `Bearer ${bootNonce}`) { res.sendStatus(401); return; }
          res.status(204).end(); return;
        }
        const asset = assets.get(req.path);
        if (asset) {
          if (req.method !== 'GET') { res.sendStatus(405); return; }
          try {
            res.set('Cache-Control', 'no-store').set('X-Content-Type-Options', 'nosniff').type(asset.contentType)
              .send(readAsset(asset));
          } catch { res.status(500).type('text/plain').send('Fixture asset unavailable'); }
          return;
        }
        const companionRead = surrounding && (SURROUNDING_READ_PATHS as readonly string[]).includes(req.path);
        if (companionRead && req.originalUrl !== req.path) { res.sendStatus(404); return; }
        if (!routes.has(req.path) && !companionRead) { res.sendStatus(404); return; }
        if (req.method !== 'GET') { res.sendStatus(405); return; }
        next();
      });
      for (const [route, handler] of routes) app.get(route, handler);
      if (surrounding) app.use(surrounding.router);
      const server = await new Promise<Server>((resolve, reject) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); listening.once('error', reject);
      });
      servers.push(server);
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected loopback fixture port');
      addresses.set(id, `http://127.0.0.1:${address.port}`);
      if (id === self) responseEvidence.bindOrigin(addresses.get(id)!);
    }
    return { responseEvidenceProvider: responseEvidence.provider, surroundingFailures, url: addresses.get(self)!, consoleUrl: `${addresses.get(self)!}/dashboard/console/#/capacity/accounts`,
      bootNonce, requests, root, home, now, stateDirs, options: structuredClone(seed.states.busy.options), peerRequests,
      setState: async state => { await setState(state); }, close };
  } catch (error) { await close(); throw error; }
}

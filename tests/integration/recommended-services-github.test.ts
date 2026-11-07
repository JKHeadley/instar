/**
 * GitHub private backup through the routes (docs/specs/recommended-services.md, First recipes: GitHub).
 * The repository is created and pushed by the server on the session's call; a public repository is
 * never pushed to and raises one attention item; a switch-off turns the config switch off.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { RecommendedServicesLedger } from '../../src/recommended/RecommendedServicesLedger.js';
import { RECOMMENDED_SERVICE_CATALOG, type CatalogRow } from '../../src/recommended/catalog.js';
import type { GitHubBackupSurface, GitHubRepoInfo } from '../../src/recommended/githubBackup.js';
import { readSetupStates } from '../../src/recommended/setupState.js';
import { registerRecommendedServiceRoutes } from '../../src/server/recommendedServiceRoutes.js';
import type { MachineKeyLookup, MachineSigner } from '../../src/core/AppRecordSignatures.js';

const { privateKey } = crypto.generateKeyPairSync('ed25519');
const signer: MachineSigner = {
  machineId: () => 'm_a', signerKeyHash: () => 'h',
  sign: (p: string) => ({ machineId: 'm_a', signerKeyHash: 'h', sig: crypto.sign(null, Buffer.from(p), privateKey).toString('base64') }) as ReturnType<MachineSigner['sign']>,
};
const PROVEN: CatalogRow = { ...RECOMMENDED_SERVICE_CATALOG.find((r) => r.id === 'github-state-backup')!, setupRecipe: 'github-v1' };
const BASE = '/recommended-services/github-state-backup';

describe('GitHub backup through the routes', () => {
  let dir: string;
  let ledger: RecommendedServicesLedger;
  let start: ReturnType<typeof vi.fn>;
  let told: ReturnType<typeof vi.fn>;
  let attention: Array<{ id: string; title: string }>;
  let store: Record<string, string>;
  let gh: { owner: string | null; repos: Record<string, GitHubRepoInfo>; remote: string | null; localHead: string; remoteHead: string | null | undefined; pushes: string[]; created: string[] };
  let disabled: number;
  let reconcile: () => Promise<void>;
  let running: string[];
  let now: number;

  const surface = (): GitHubBackupSurface => ({
    tokenOwner: async (t) => (t === 'tok' ? gh.owner : null),
    repo: async (_t, name) => gh.repos[name] ?? null,
    createPrivateRepo: async (_t, name) => { const info = { fullName: `octo/${name}`, private: true, htmlUrl: `https://github.com/octo/${name}`, cloneUrl: `https://github.com/octo/${name}.git` }; gh.repos[info.fullName] = info; gh.created.push(info.fullName); return info; },
    pushState: (_t, url) => { gh.pushes.push(url); gh.remote = url; gh.remoteHead = gh.localHead; return { head: gh.localHead }; },
    remoteHead: async () => gh.remoteHead,
    localHead: () => gh.localHead,
    currentRemote: () => gh.remote,
  });
  const app = () => {
    const a = express();
    a.use(express.text({ type: 'text/plain' }));
    a.use(express.json());
    const router = express.Router();
    registerRecommendedServiceRoutes(router, {
      ledger: () => ledger, stateDir: dir, owner: () => '42', catalog: [PROVEN], port: 4040, now: () => now, agentName: 'echo',
      checkPin: () => true, checkConfirmPin: () => true, recordApproval: () => undefined,
      openCommitment: () => 'CMT-1', finishCommitment: () => undefined, withdrawCommitment: () => undefined,
      startSetup: start, stopSetup: () => { running = []; return true; }, sessionForTopic: () => null,
      isSetupRunning: (id) => running.includes(id), notifyStuck: async () => true, clearStuck: () => undefined, tellOwner: told,
      readSecret: (n) => store[n] ?? null, writeSecret: (n, v) => { store[n] = v; }, deleteSecret: (n) => { delete store[n]; },
      readSecretNames: () => [],
      github: surface(),
      disableGitBackup: () => { disabled++; },
      raiseAttention: async (id, title) => { attention.push({ id, title }); return true; },
      onReady: (r) => { reconcile = r; },
    });
    a.use(router);
    return a;
  };
  const say = async (a: express.Express, what: 'yes' | 'no', shutdown = false) => {
    const { body } = await request(a).get(`${BASE}/confirm`);
    return request(a).post(`${BASE}/confirm`).set('X-Instar-Request', '1').send({ token: body.token, pin: '1', answer: what, shutdown });
  };
  const key = (a: express.Express, value: string) => request(a).post(`${BASE}/key`).set('X-Instar-Request', '1').type('text/plain').send(value);
  const sync = (a: express.Express) => request(a).post(`${BASE}/sync`).set('X-Instar-Request', '1').send({});
  const verify = (a: express.Express) => request(a).post(`${BASE}/verify`).set('X-Instar-Request', '1').send({});
  const started = () => vi.waitFor(() => expect(readSetupStates(dir)['github-state-backup']?.sessionName).toBe('sess-1'));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'rec-gh-'));
    ledger = new RecommendedServicesLedger({ stateDir: dir, signer, keyLookup: (() => ({ status: 'unknown' })) as unknown as MachineKeyLookup });
    running = [];
    start = vi.fn(async () => { running.push('sess-1'); return { sessionName: 'sess-1', topicId: 7 }; });
    told = vi.fn(); attention = []; disabled = 0;
    store = {};
    gh = { owner: 'octo', repos: {}, remote: null, localHead: 'aaaa', remoteHead: undefined, pushes: [], created: [] };
    now = Date.parse('2026-11-07T20:00:00Z');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/recommended-services-github.test.ts' }));

  it('the whole job: a yes starts setup, the session stores the token, the server creates the private repository and pushes, and the check passes', async () => {
    const a = app();
    await say(a, 'yes');
    await started();
    expect(readSetupStates(dir)['github-state-backup']?.absentBeforeSetup).toBe(true);
    expect((await sync(a)).status).toBe(503);
    expect((await key(a, 'tok')).status).toBe(200);
    const pushed = await sync(a);
    expect(pushed.status).toBe(200);
    expect(pushed.body).toMatchObject({ ok: true, copied: ['octo/instar-echo-state'] });
    expect(gh.created).toEqual(['octo/instar-echo-state']);
    expect(gh.pushes).toEqual(['https://github.com/octo/instar-echo-state.git']);
    expect(JSON.stringify(pushed.body)).not.toContain('tok');
    const checked = await verify(a);
    expect(checked.body.result).toBe('pass');
    expect(readSetupStates(dir)['github-state-backup']).toMatchObject({ keyStoredBySetup: true, lastSyncAt: expect.any(String) });
  });

  it('a repository that has gone public fails the check, is never pushed to, and raises exactly one attention item until it passes again', async () => {
    const a = app();
    await say(a, 'yes');
    await started();
    await key(a, 'tok');
    await sync(a);
    expect((await verify(a)).body.result).toBe('pass');
    gh.repos['octo/instar-echo-state'] = { ...gh.repos['octo/instar-echo-state'], private: false };
    const failed = await verify(a);
    expect(failed.body.result).toBe('fail');
    expect(failed.body.detail).toMatch(/PUBLIC/);
    await vi.waitFor(() => expect(attention).toHaveLength(1));
    expect(attention[0].id).toBe('recommended-service-public-repo:octo/instar-echo-state');
    expect(readSetupStates(dir)['github-state-backup']?.attentionRaised).toBe(attention[0].id);
    // Said once: a second failing check does not raise again; the regular refresh does not push.
    await verify(a);
    expect(attention).toHaveLength(1);
    gh.pushes = [];
    now += 25 * 60 * 60_000;
    await reconcile();
    expect(gh.pushes).toEqual([]);
    // Private again: the check passes and the mark clears, so a later relapse is raised again.
    gh.repos['octo/instar-echo-state'] = { ...gh.repos['octo/instar-echo-state'], private: true };
    expect((await verify(a)).body.result).toBe('pass');
    expect(readSetupStates(dir)['github-state-backup']?.attentionRaised).toBeUndefined();
  });

  it('the daily refresh pushes again, so later state reaches the repository', async () => {
    const a = app();
    await say(a, 'yes');
    await started();
    await key(a, 'tok');
    await sync(a);
    await verify(a);
    gh.pushes = [];
    gh.localHead = 'bbbb';
    now += 25 * 60 * 60_000;
    await reconcile();
    expect(gh.pushes).toEqual(['https://github.com/octo/instar-echo-state.git']);
    expect(gh.remoteHead).toBe('bbbb');
  });

  it('a switch-off removes the stored token, turns the config switch off, and leaves the repository', async () => {
    const a = app();
    await say(a, 'yes');
    await started();
    await key(a, 'tok');
    await sync(a);
    await verify(a);
    const { body } = await request(a).get(`${BASE}/confirm`);
    expect(body).toMatchObject({ workingHere: true, switchOffHere: true });
    expect(body.copies).toBeUndefined();
    await request(a).post(`${BASE}/confirm`).set('X-Instar-Request', '1').send({ token: body.token, pin: '1', answer: 'no', shutdown: true });
    await vi.waitFor(() => expect(readSetupStates(dir)['github-state-backup']?.stopped).toBeTruthy());
    expect(store.github_backup_token).toBeUndefined();
    expect(disabled).toBe(1);
    expect(Object.keys(gh.repos)).toEqual(['octo/instar-echo-state']);
    expect(told.mock.calls.map((c) => c[0]).some((t: string) => /private repository and what is in it stay yours/.test(t))).toBe(true);
  });
});

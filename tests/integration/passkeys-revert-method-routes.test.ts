/**
 * Integration tests — `POST /passkeys/revert-method` (Tier 2).
 * Spec: docs/specs/agent-held-google-passkey.md §3.4 rollback lever.
 * Real createRoutes() behind the real authMiddleware, backed by a REAL on-disk registry
 * seeded through a registry instance with a passkey-store predicate (the route itself
 * builds a registry WITHOUT one — reverting never needs the store).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PlaywrightProfileRegistry } from '../../src/core/PlaywrightProfileRegistry.js';

const AUTH_TOKEN = 'test-passkey-revert-bearer';
const PIN = '482913';

function appWith(projectDir: string, opts: { developmentAgent?: boolean; pin?: string | null } = {}): express.Express {
  const stateDir = path.join(projectDir, '.instar');
  const ctx = {
    config: { projectName: 'pk-revert-test', projectDir, stateDir, port: 0, authToken: AUTH_TOKEN,
      developmentAgent: opts.developmentAgent ?? true, ...(opts.pin === null ? {} : { dashboardPin: opts.pin ?? PIN }),
      sessions: {}, scheduler: {} },
    sessionManager: { listRunningSessions: () => [] }, state: { getJobState: () => null, getSession: () => null },
    sessionRefresh: null, startTime: new Date(),
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH_TOKEN));
  app.use('/', createRoutes(ctx));
  return app;
}

describe('POST /passkeys/revert-method (integration)', () => {
  let projectDir: string; let stateDir: string;
  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });
  const seed = () => {
    const reg = new PlaywrightProfileRegistry({ stateDir, projectDir, listVaultNames: () => ['google_password_justin'], passkeyEntryExists: () => true });
    reg.createProfile({ id: 'justin-google' });
    reg.assignAccount('justin-google', { service: 'google', identity: 'justin@example.com', owner: 'operator', loginMethod: 'password',
      vaultRefs: ['google_password_justin'], vaultBindings: { password: 'google_password_justin' } });
    reg.assignAccount('justin-google', { service: 'google', identity: 'justin@example.com', owner: 'operator', loginMethod: 'google-passkey', vaultBindings: { passkey: 'pk-1' } });
    reg.assignAccount('justin-google', { service: 'google', identity: 'fresh@example.com', owner: 'operator', loginMethod: 'google-passkey', vaultBindings: { passkey: 'pk-2' } });
    reg.assignAccount('justin-google', { service: 'google', identity: 'cookie@example.com', owner: 'operator', loginMethod: 'session-cookie' });
    return reg;
  };

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-revert-routes-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}\n');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/integration/passkeys-revert-method-routes.test.ts:afterEach' }));

  it('401 without a bearer token; 503 when the registry feature is dark', async () => {
    expect((await request(appWith(projectDir)).post('/passkeys/revert-method').send({ pin: PIN })).status).toBe(401);
    expect((await request(appWith(projectDir, { developmentAgent: false })).post('/passkeys/revert-method').set(auth()).send({ pin: PIN })).status).toBe(503);
  });

  it('403 without the dashboard PIN, with a wrong PIN, and when no PIN is configured — nothing changes', async () => {
    seed();
    for (const [app, body] of [
      [appWith(projectDir), {}], [appWith(projectDir), { pin: '000000' }], [appWith(projectDir, { pin: null }), { pin: PIN }],
    ] as const) {
      const res = await request(app).post('/passkeys/revert-method').set(auth()).send(body);
      expect(res.status).toBe(403);
    }
    expect(seedless().listPasskeyAccounts()).toHaveLength(2);
  });
  const seedless = () => new PlaywrightProfileRegistry({ stateDir, projectDir, listVaultNames: () => [] });

  it('400 on a malformed accounts list', async () => {
    const res = await request(appWith(projectDir)).post('/passkeys/revert-method').set(auth()).send({ pin: PIN, accounts: [{ profileId: 'x' }] });
    expect(res.status).toBe(400);
  });

  it('default set = every passkey account: reverts those with a prior, lists the rest as noPriorMethod, and audits each', async () => {
    seed();
    const res = await request(appWith(projectDir)).post('/passkeys/revert-method').set(auth()).send({ pin: PIN });
    expect(res.status).toBe(200);
    expect(res.body.reverted).toEqual([{ profileId: 'justin-google', service: 'google', identity: 'justin@example.com', reverted: true, from: 'google-passkey', to: 'password', bindingMissing: true }]);
    expect(res.body.noPriorMethod).toEqual([{ profileId: 'justin-google', service: 'google', identity: 'fresh@example.com', reverted: false, reason: 'no-prior-method' }]);
    expect(res.body.notPasskey).toEqual([]);
    const after = seedless().listProfiles().find((p) => p.id === 'justin-google')!.accounts;
    expect(after.find((a) => a.identity === 'justin@example.com')).toMatchObject({ loginMethod: 'password' });
    expect(after.find((a) => a.identity === 'fresh@example.com')).toMatchObject({ loginMethod: 'google-passkey', vaultBindings: { passkey: 'pk-2' } });
    expect(after.find((a) => a.identity === 'cookie@example.com')).toMatchObject({ loginMethod: 'session-cookie' });
    const audit = fs.readFileSync(path.join(projectDir, 'logs', 'playwright-profiles.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const revertRows = audit.filter((row) => row.action === 'revert-method');
    expect(revertRows).toHaveLength(2);
    expect(JSON.stringify(revertRows)).not.toContain('pk-1'); // entry keys are not written to the audit
    // Idempotent: a second call finds nothing left with a prior.
    const again = await request(appWith(projectDir)).post('/passkeys/revert-method').set(auth()).send({ pin: PIN });
    expect(again.body.reverted).toEqual([]);
    expect(again.body.noPriorMethod).toHaveLength(1);
  });

  it('an explicit accounts list scopes the revert; a non-passkey target is reported as notPasskey; an unknown target is 404', async () => {
    seed();
    const res = await request(appWith(projectDir)).post('/passkeys/revert-method').set(auth()).send({ pin: PIN,
      accounts: [{ profileId: 'justin-google', service: 'google', identity: 'cookie@example.com' }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reverted: [], noPriorMethod: [], notPasskey: [{ profileId: 'justin-google', service: 'google', identity: 'cookie@example.com', reverted: false, reason: 'not-passkey' }] });
    expect(seedless().listPasskeyAccounts()).toHaveLength(2); // untouched
    // A mixed list with an unknown target is all-or-nothing: 404 and NOTHING reverted.
    const missing = await request(appWith(projectDir)).post('/passkeys/revert-method').set(auth()).send({ pin: PIN,
      accounts: [{ profileId: 'justin-google', service: 'google', identity: 'justin@example.com' },
        { profileId: 'nope', service: 'google', identity: 'x@example.com' }] });
    expect(missing.status).toBe(404);
    expect(seedless().listProfiles().find((p) => p.id === 'justin-google')!.accounts.find((a) => a.identity === 'justin@example.com'))
      .toMatchObject({ loginMethod: 'google-passkey' });
  });
});

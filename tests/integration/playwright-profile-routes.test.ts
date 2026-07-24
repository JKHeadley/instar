/**
 * Integration tests — Playwright Profile Registry routes (Tier 2).
 *
 * Spec: docs/specs/playwright-profile-registry.md (routes section + D4 dev-gate +
 * D5 dryRun + D17 ref-validation + D18 ambiguity + D19 activate loop-guard + D20 audit).
 *
 * Exercises the REAL production path: the inline routes in createRoutes(), mounted
 * behind the real authMiddleware, backed by a REAL on-disk registry file + a REAL
 * SecretStore vault in a temp stateDir (file-key via the VITEST constructor guard).
 *
 * Covers:
 *   - 401 without a bearer token
 *   - 503 when dark (flag unset + developmentAgent false) and when explicitly disabled
 *   - 200 on every route via the developmentAgent gate
 *   - create 409 dup
 *   - assign 409 unknown-ref + 400 owner-required
 *   - resolve ambiguous → { ambiguous:true }
 *   - activate dry-run (no write, no refresh, returns wouldWriteFile) vs dryRun:false
 *     (writes the resolved config so the file the MCP loads carries the new --user-data-dir arg)
 *   - the audit log gains a line per write; vault VALUES never leak into a response
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
import { SecretStore } from '../../src/core/SecretStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PlaywrightSeatLease } from '../../src/core/PlaywrightSeatLease.js';

const AUTH_TOKEN = 'test-pw-registry-bearer';

function ctxFor(projectDir: string, opts: { developmentAgent?: boolean } = {}): RouteContext {
  const stateDir = path.join(projectDir, '.instar');
  return {
    config: {
      projectName: 'pw-registry-test',
      projectDir,
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      developmentAgent: opts.developmentAgent ?? false,
      sessions: {} as any,
      scheduler: {} as any,
    } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    // sessionRefresh stays null — activate's refresh is best-effort and skipped when unwired.
    sessionRefresh: null,
    scheduler: null, telegram: null, relationships: null, feedback: null,
    dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null,
    quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null,
    watchdog: null, triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null,
    discoveryEvaluator: null, startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(projectDir: string, opts: { developmentAgent?: boolean; seatFile?: string } = {}): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH_TOKEN));
  const ctx = ctxFor(projectDir, opts);
  if (opts.seatFile) ctx.playwrightSeatLease = () => new PlaywrightSeatLease({ filePath: opts.seatFile, ttlMs: 10_000 });
  app.use('/', createRoutes(ctx));
  return app;
}

describe('Playwright Profile Registry routes (integration, real createRoutes + authMiddleware)', () => {
  let projectDir: string;
  let stateDir: string;
  let configPath: string;
  let settingsPath: string;

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });
  const seedVault = (secrets: Record<string, unknown>) => new SecretStore({ stateDir }).write(secrets);

  /** Seed a .claude/settings.json with a playwright MCP entry whose args carry NO --user-data-dir. */
  const seedPlaywrightSettings = (args: string[] = ['@playwright/mcp@latest']) => {
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ mcpServers: { playwright: { command: 'npx', args } } }, null, 2) + '\n',
    );
  };

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-registry-routes-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    configPath = path.join(stateDir, 'config.json');
    settingsPath = path.join(projectDir, '.claude', 'settings.json');
    fs.writeFileSync(configPath, JSON.stringify({}, null, 2) + '\n');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/integration/playwright-profile-routes.test.ts:afterEach' });
  });

  it('401 without a bearer token', async () => {
    const res = await request(appWith(projectDir)).get('/playwright-profiles');
    expect(res.status).toBe(401);
  });

  it('503 when dark (flag unset, developmentAgent false) on every route', async () => {
    const app = appWith(projectDir, { developmentAgent: false });
    for (const r of [
      request(app).get('/playwright-profiles').set(auth()),
      request(app).get('/playwright-profiles/session-context').set(auth()),
      request(app).get('/playwright-profiles/resolve?service=github').set(auth()),
      request(app).post('/playwright-profiles').set(auth()).send({ id: 'x' }),
      request(app).post('/playwright-profiles/default/activate').set(auth()),
    ]) {
      const res = await r;
      expect(res.status).toBe(503);
    }
  });

  it('503 when explicitly disabled even on a developmentAgent', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ playwrightRegistry: { enabled: false } }, null, 2) + '\n');
    const res = await request(appWith(projectDir, { developmentAgent: true })).get('/playwright-profiles').set(auth());
    expect(res.status).toBe(503);
  });

  it('200 via the developmentAgent gate — list shows the seeded default profile', async () => {
    const res = await request(appWith(projectDir, { developmentAgent: true })).get('/playwright-profiles').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.profiles)).toBe(true);
    expect(res.body.profiles[0].id).toBe('default');
    expect(res.body.profiles[0].isDefault).toBe(true);
  });

  it('explicit enabled:true works on a NON-development agent (the live-fleet flip shape)', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ playwrightRegistry: { enabled: true } }, null, 2) + '\n');
    const res = await request(appWith(projectDir, { developmentAgent: false })).get('/playwright-profiles').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.profiles[0].id).toBe('default');
  });

  it('session-context returns the compact <playwright-profiles> boot block; ?full=1 sets full', async () => {
    const app = appWith(projectDir, { developmentAgent: true });
    const res = await request(app).get('/playwright-profiles/session-context').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.present).toBe(true);
    expect(res.body.block).toContain('<playwright-profiles');
    const full = await request(app).get('/playwright-profiles/session-context?full=1').set(auth());
    expect(full.body.full).toBe(true);
  });

  it('seat acquire renews one drive and blocks a competing drive', async () => {
    const app = appWith(projectDir, {
      developmentAgent: true,
      seatFile: path.join(stateDir, 'shared-host-seat.json'),
    });
    const first = await request(app).post('/playwright-profiles/seat/acquire').set(auth())
      .send({ holderId: 'agent-a:topic-1', holderLabel: 'topic-1' });
    expect(first.status).toBe(200);
    expect(first.body.acquired).toBe(true);

    const renewed = await request(app).post('/playwright-profiles/seat/acquire').set(auth())
      .send({ holderId: 'agent-a:topic-1', holderLabel: 'topic-1' });
    expect(renewed.status).toBe(200);
    expect(renewed.body.lease.acquiredAt).toBe(first.body.lease.acquiredAt);

    const conflict = await request(app).post('/playwright-profiles/seat/acquire').set(auth())
      .send({ holderId: 'agent-b:topic-2', holderLabel: 'topic-2' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.holderLabel).toBe('topic-1');
    expect(conflict.body.retryAfterMs).toBeGreaterThan(0);

    const wrongRelease = await request(app).post('/playwright-profiles/seat/release').set(auth())
      .send({ holderId: 'agent-b:topic-2' });
    expect(wrongRelease.status).toBe(409);

    const release = await request(app).post('/playwright-profiles/seat/release').set(auth())
      .send({ holderId: 'agent-a:topic-1' });
    expect(release.status).toBe(200);
    expect(release.body).toEqual({ released: true });

    const successor = await request(app).post('/playwright-profiles/seat/acquire').set(auth())
      .send({ holderId: 'agent-b:topic-2', holderLabel: 'topic-2' });
    expect(successor.status).toBe(200);
  });

  it('seat safety remains available when the optional profile registry is dark', async () => {
    const app = appWith(projectDir, {
      developmentAgent: false,
      seatFile: path.join(stateDir, 'dark-registry-shared-host-seat.json'),
    });
    const acquired = await request(app).post('/playwright-profiles/seat/acquire').set(auth())
      .send({ holderId: 'spawn-unique-id', holderLabel: 'drive' });
    expect(acquired.status).toBe(200);
    expect(acquired.body.acquired).toBe(true);
  });

  it('create → 409 on a duplicate id', async () => {
    const app = appWith(projectDir, { developmentAgent: true });
    const first = await request(app).post('/playwright-profiles').set(auth()).send({ id: 'justin-google' });
    expect(first.status).toBe(200);
    expect(first.body.profile.id).toBe('justin-google');
    const dup = await request(app).post('/playwright-profiles').set(auth()).send({ id: 'justin-google' });
    expect(dup.status).toBe(409);
  });

  it('create → 400 on a flag-shaped (rejected) userDataDir', async () => {
    const res = await request(appWith(projectDir, { developmentAgent: true }))
      .post('/playwright-profiles').set(auth()).send({ id: 'bad', userDataDir: '--evil' });
    expect(res.status).toBe(400);
  });

  it('assign → 400 when owner is missing, 409 on an unknown vault ref', async () => {
    seedVault({ github_token: 'ghp_INTEGRATIONSECRET' });
    const app = appWith(projectDir, { developmentAgent: true });

    const noOwner = await request(app).post('/playwright-profiles/default/accounts').set(auth())
      .send({ service: 'github', identity: 'EchoOfDawn', vaultRefs: ['github_token'] });
    expect(noOwner.status).toBe(400);

    const unknownRef = await request(app).post('/playwright-profiles/default/accounts').set(auth())
      .send({ service: 'github', identity: 'EchoOfDawn', owner: 'agent', vaultRefs: ['no_such_secret'] });
    expect(unknownRef.status).toBe(409);

    const ok = await request(app).post('/playwright-profiles/default/accounts').set(auth())
      .send({ service: 'github', identity: 'EchoOfDawn', owner: 'agent', vaultRefs: ['github_token'], loginMethod: 'oauth-token' });
    expect(ok.status).toBe(200);
    expect(ok.body.account.owner).toBe('agent');
    // Vault VALUES never appear in the response (D3).
    expect(JSON.stringify(ok.body)).not.toContain('ghp_INTEGRATIONSECRET');
  });

  it('resolve → exact match, ambiguous multi-profile, and no-match', async () => {
    seedVault({ tok_a: 'v', tok_b: 'v' });
    const app = appWith(projectDir, { developmentAgent: true });
    await request(app).post('/playwright-profiles').set(auth()).send({ id: 'a' });
    await request(app).post('/playwright-profiles').set(auth()).send({ id: 'b' });
    await request(app).post('/playwright-profiles/a/accounts').set(auth())
      .send({ service: 'google', identity: 'justin@x', owner: 'operator', vaultRefs: ['tok_a'] });
    await request(app).post('/playwright-profiles/b/accounts').set(auth())
      .send({ service: 'google', identity: 'echo@x', owner: 'agent', vaultRefs: ['tok_b'] });

    const exact = await request(app).get('/playwright-profiles/resolve?service=google&identity=justin@x').set(auth());
    expect(exact.status).toBe(200);
    expect(exact.body.profile.id).toBe('a');

    const ambiguous = await request(app).get('/playwright-profiles/resolve?service=google').set(auth());
    expect(ambiguous.status).toBe(200);
    expect(ambiguous.body.profile).toBeNull();
    expect(ambiguous.body.ambiguous).toBe(true);
    expect(ambiguous.body.candidates.length).toBe(2);

    const none = await request(app).get('/playwright-profiles/resolve?service=nowhere').set(auth());
    expect(none.body.profile).toBeNull();
    expect(none.body.ambiguous).toBeUndefined();
  });

  it('patch + delete account, delete profile (default refused 409)', async () => {
    seedVault({ tok: 'v' });
    const app = appWith(projectDir, { developmentAgent: true });
    await request(app).post('/playwright-profiles').set(auth()).send({ id: 'custom' });
    await request(app).post('/playwright-profiles/custom/accounts').set(auth())
      .send({ service: 'github', identity: 'me', owner: 'agent', vaultRefs: ['tok'] });

    const patched = await request(app).patch('/playwright-profiles/custom/accounts').set(auth())
      .send({ service: 'github', identity: 'me', lastAsserted: true, lastVerifiedAt: new Date().toISOString() });
    expect(patched.status).toBe(200);
    expect(patched.body.account.lastAsserted).toBe(true);

    const delAcct = await request(app).delete('/playwright-profiles/custom/accounts').set(auth())
      .send({ service: 'github', identity: 'me' });
    expect(delAcct.status).toBe(200);

    const delDefault = await request(app).delete('/playwright-profiles/default').set(auth());
    expect(delDefault.status).toBe(409);

    const delCustom = await request(app).delete('/playwright-profiles/custom').set(auth());
    expect(delCustom.status).toBe(200);
  });

  it('activate dry-run (default) performs NO write and NO refresh; reports wouldWriteFile', async () => {
    seedPlaywrightSettings(['@playwright/mcp@latest']);
    const before = fs.readFileSync(settingsPath, 'utf8');
    const app = appWith(projectDir, { developmentAgent: true });
    await request(app).post('/playwright-profiles').set(auth()).send({ id: 'custom' });

    const res = await request(app).post('/playwright-profiles/custom/activate').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.wouldWriteFile).toBe(path.resolve(settingsPath));
    expect(res.body.wouldRefresh).toBe(true);

    // The config file the MCP loads is UNCHANGED in dry-run.
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('activate dryRun:false WRITES the resolved config so the MCP loads the new --user-data-dir arg', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ playwrightRegistry: { enabled: true, dryRun: false } }, null, 2) + '\n');
    seedPlaywrightSettings(['@playwright/mcp@latest']);
    const app = appWith(projectDir, { developmentAgent: true });
    const created = await request(app).post('/playwright-profiles').set(auth()).send({ id: 'custom' });
    const expectedDir = created.body.profile.userDataDir;
    expect(expectedDir).toContain(path.join('.instar', 'state', 'playwright-profiles', 'custom'));

    const res = await request(app).post('/playwright-profiles/custom/activate').set(auth()).send({ sessionName: 'sess-1' });
    expect(res.status).toBe(200);
    expect(res.body.activated).toBe(true);
    expect(res.body.userDataDir).toBe(expectedDir);

    // The file the MCP actually loads now carries the new arg as two separate elements.
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const args: string[] = written.mcpServers.playwright.args;
    const idx = args.indexOf('--user-data-dir');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(expectedDir);

    // A repeat activate is now already-active → no further write, no refresh.
    const again = await request(app).post('/playwright-profiles/custom/activate').set(auth()).send({ sessionName: 'sess-1' });
    expect(again.body.alreadyActive).toBe(true);
  });

  it('writes an audit line per write to logs/playwright-profiles.jsonl (NAMES only)', async () => {
    seedVault({ github_token: 'ghp_AUDITSECRET' });
    const app = appWith(projectDir, { developmentAgent: true });
    await request(app).post('/playwright-profiles').set(auth()).send({ id: 'audited' });
    await request(app).post('/playwright-profiles/audited/accounts').set(auth())
      .send({ service: 'github', identity: 'me', owner: 'agent', vaultRefs: ['github_token'] });

    const auditPath = path.join(projectDir, 'logs', 'playwright-profiles.jsonl');
    const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const actions = lines.map((l) => JSON.parse(l).action);
    expect(actions).toContain('create');
    expect(actions).toContain('assign');
    // The audit log stores the vault NAME, never the value.
    const audit = fs.readFileSync(auditPath, 'utf8');
    expect(audit).toContain('github_token');
    expect(audit).not.toContain('ghp_AUDITSECRET');
  });
});

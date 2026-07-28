/**
 * Integration test — full HTTP pipeline for the P2.1 enrollment routes
 * (POST /subscription-pool/enroll, GET /subscription-pool/pending-logins,
 * POST /subscription-pool/enroll/:id/complete,
 * POST /subscription-pool/enroll/reissue-expired). Boots a real Express app
 * with createRoutes(), a real PendingLoginStore + EnrollmentWizard with an
 * INJECTED login driver → hermetic, zero spawning, zero network, zero secrets.
 *
 * The load-bearing security assertion: NO response body ever carries a token /
 * secret field — only public artifacts (verificationUrl, userCode, ttl).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { PendingLoginStore } from '../../src/core/PendingLoginStore.js';
import { EnrollmentWizard, type LoginArtifact } from '../../src/core/EnrollmentWizard.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface TestServer { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

const ARTIFACT: LoginArtifact = {
  verificationUrl: 'https://auth.openai.com/codex/device',
  userCode: '7DAU-W4XJA',
  ttlMs: 15 * 60_000,
};

describe('/subscription-pool enrollment routes (integration)', () => {
  let server: TestServer;
  let dir: string;
  let store: PendingLoginStore;
  let clock: number;
  let tmuxLog: string;
  let enrollmentCompleteInFlightHook: ((id: string) => void | Promise<void>) | undefined;
  let invalidatedSlots: string[];
  let polledAccounts: string[];

  beforeEach(async () => {
    enrollmentCompleteInFlightHook = undefined;
    invalidatedSlots = [];
    polledAccounts = [];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enroll-int-'));
    clock = Date.parse('2026-06-07T00:00:00Z');
    store = new PendingLoginStore({ stateDir: dir, now: () => clock });
    tmuxLog = path.join(dir, 'tmux-calls.log');
    const tmuxPath = path.join(dir, 'fake-tmux.sh');
    fs.writeFileSync(tmuxPath, `#!/usr/bin/env bash\necho "$@" >> "${tmuxLog}"\n`, { mode: 0o755 });
    const wizard = new EnrollmentWizard({ store, driveLogin: async () => ARTIFACT, now: () => clock });
    const app = express();
    app.use(express.json());
    const ctx: any = {
      config: { authToken: 't', stateDir: dir, port: 0, sessions: { tmuxPath } },
      startTime: new Date(),
      enrollmentWizard: wizard,
      enrollmentCompleteInFlightHook: (id: string) => enrollmentCompleteInFlightHook?.(id),
      subscriptionPool: { get: (id: string) => id === 'codex-1' ? { id, configHome: path.join(dir, 'codex-1') } : null },
      quotaPoller: {
        invalidateIdentityCache: (slots: string[]) => invalidatedSlots.push(...slots),
        pollAccount: async (account: { id: string }) => { polledAccounts.push(account.id); return null; },
      },
    };
    app.use(createRoutes(ctx));
    server = await listen(app);
  });
  afterEach(async () => {
    await server?.close();
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/subscription-enrollment-routes.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  const api = (p: string, init?: RequestInit) =>
    fetch(server.url + p, { headers: { 'Content-Type': 'application/json' }, ...init })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  it('POST /enroll starts a login + returns the public code/URL (no secret field)', async () => {
    const res = await api('/subscription-pool/enroll', {
      method: 'POST',
      body: JSON.stringify({ id: 'codex-1', label: 'codex', provider: 'openai', framework: 'codex-cli' }),
    });
    expect(res.status).toBe(201);
    expect(res.body.login.userCode).toBe('7DAU-W4XJA');
    expect(res.body.login.verificationUrl).toContain('auth.openai.com');
    expect(res.body.login.kind).toBe('device-code');
    // No token/secret ever in the response.
    const flat = JSON.stringify(res.body).toLowerCase();
    expect(flat).not.toMatch(/token|secret|refresh|access_key|api_key/);
  });

  it('GET /pending-logins lists the active login', async () => {
    await api('/subscription-pool/enroll', {
      method: 'POST',
      body: JSON.stringify({ id: 'codex-1', label: 'codex', provider: 'openai', framework: 'codex-cli' }),
    });
    const res = await api('/subscription-pool/pending-logins');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.logins.map((l: any) => l.id)).toEqual(['codex-1']);
    // D5 (topic 29836) record ⟂ pane-liveness: every local login carries paneAlive. This
    // harness has NO sessionManager → liveness is UNVERIFIABLE → the honest tri-state null
    // (never a fabricated true/false).
    expect(res.body.logins[0]).toHaveProperty('paneAlive', null);
  });

  it('GET /pending-logins annotates paneAlive from the live pane capture (true = alive, false = the pane is gone)', async () => {
    await api('/subscription-pool/enroll', {
      method: 'POST',
      body: JSON.stringify({ id: 'codex-1', label: 'codex', provider: 'openai', framework: 'codex-cli' }),
    });
    // Rebuild the server with a sessionManager whose capture answers per call: first ALIVE…
    await server.close();
    let frame: string | null = 'Sign in at the URL below';
    const app = express();
    app.use(express.json());
    const wizard = new EnrollmentWizard({ store, driveLogin: async () => ARTIFACT, now: () => clock });
    app.use(createRoutes({
      config: { authToken: 't', stateDir: dir, port: 0 },
      startTime: new Date(),
      enrollmentWizard: wizard,
      sessionManager: { captureOutput: () => frame },
    } as any));
    server = await listen(app);
    const alive = await api('/subscription-pool/pending-logins');
    expect(alive.body.logins[0].paneAlive).toBe(true);
    // …then the pane dies (tmux session gone → captureOutput null) — the record is honest.
    frame = null;
    const dead = await api('/subscription-pool/pending-logins');
    expect(dead.body.logins[0].paneAlive).toBe(false);
  });

  it('POST /enroll/:id/complete moves it off the pending surface', async () => {
    await api('/subscription-pool/enroll', {
      method: 'POST',
      body: JSON.stringify({ id: 'codex-1', label: 'codex', provider: 'openai', framework: 'codex-cli' }),
    });
    const done = await api('/subscription-pool/enroll/codex-1/complete', { method: 'POST' });
    expect(done.status).toBe(200);
    expect(done.body.login.status).toBe('completed');
    expect(invalidatedSlots).toEqual([path.join(dir, 'codex-1')]);
    expect(polledAccounts).toEqual(['codex-1']);
    const list = await api('/subscription-pool/pending-logins');
    expect(list.body.logins).toEqual([]);
  });

  it('POST /enroll/:id/cancel abandons a pending login, kills its pane, and makes the id non-reusable', async () => {
    await api('/subscription-pool/enroll', {
      method: 'POST',
      body: JSON.stringify({ id: 'codex-1', label: 'codex', provider: 'openai', framework: 'codex-cli' }),
    });
    const cancelled = await api('/subscription-pool/enroll/codex-1/cancel', { method: 'POST' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ cancelled: true, id: 'codex-1', status: 'abandoned' });
    expect(store.get('codex-1')?.status).toBe('abandoned');
    expect(fs.readFileSync(tmuxLog, 'utf8')).toContain('kill-session');
    const pending = await api('/subscription-pool/pending-logins');
    expect(pending.body.logins).toEqual([]);
    const reuse = await api('/subscription-pool/enroll/codex-1/complete', { method: 'POST' });
    expect(reuse.status).toBe(409);
    const second = await api('/subscription-pool/enroll/codex-1/cancel', { method: 'POST' });
    expect(second.body).toMatchObject({ cancelled: false, alreadyTerminal: true, terminalStatus: 'abandoned' });
  });

  it('POST /enroll/:id/cancel leaves a completed record byte-unchanged and never kills', async () => {
    await api('/subscription-pool/enroll', {
      method: 'POST',
      body: JSON.stringify({ id: 'codex-1', label: 'codex', provider: 'openai', framework: 'codex-cli' }),
    });
    store.complete('codex-1');
    const storePath = path.join(dir, 'pending-logins.json');
    const before = fs.readFileSync(storePath);
    const cancelled = await api('/subscription-pool/enroll/codex-1/cancel', { method: 'POST' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ cancelled: false, alreadyTerminal: true, terminalStatus: 'completed' });
    expect(fs.readFileSync(storePath).equals(before)).toBe(true);
    expect(fs.existsSync(tmuxLog)).toBe(false);
  });

  it('POST /enroll/:id/cancel returns 404 for malformed and unknown ids without tmux calls', async () => {
    const malformed = await api('/subscription-pool/enroll/CODEX_1/cancel', { method: 'POST' });
    expect(malformed.status).toBe(404);
    const unknown = await api('/subscription-pool/enroll/codex-404/cancel', { method: 'POST' });
    expect(unknown.status).toBe(404);
    expect(fs.existsSync(tmuxLog)).toBe(false);
  });

  it('POST /enroll/:id/cancel stands aside while completion is in flight', async () => {
    await api('/subscription-pool/enroll', {
      method: 'POST',
      body: JSON.stringify({ id: 'codex-1', label: 'codex', provider: 'openai', framework: 'codex-cli' }),
    });
    let releaseCompletion!: () => void;
    const holdCompletion = new Promise<void>((resolve) => { releaseCompletion = resolve; });
    let entered!: () => void;
    const completionEntered = new Promise<void>((resolve) => { entered = resolve; });
    enrollmentCompleteInFlightHook = () => { entered(); return holdCompletion; };
    const completing = api('/subscription-pool/enroll/codex-1/complete', { method: 'POST' });
    await completionEntered;
    const cancelled = await api('/subscription-pool/enroll/codex-1/cancel', { method: 'POST' });
    expect(cancelled.status).toBe(409);
    releaseCompletion();
    expect((await completing).status).toBe(200);
    expect(store.get('codex-1')?.status).toBe('completed');
  });

  it('POST /enroll/reissue-expired refreshes an expired login', async () => {
    await api('/subscription-pool/enroll', {
      method: 'POST',
      body: JSON.stringify({ id: 'codex-1', label: 'codex', provider: 'openai', framework: 'codex-cli' }),
    });
    clock += 16 * 60_000; // past the 15-min TTL
    const res = await api('/subscription-pool/enroll/reissue-expired', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.reissued).toHaveLength(1);
    expect(res.body.reissued[0].reissueCount).toBe(1);
  });

  it('400 when required fields are missing', async () => {
    const res = await api('/subscription-pool/enroll', { method: 'POST', body: JSON.stringify({ id: 'x' }) });
    expect(res.status).toBe(400);
  });
});

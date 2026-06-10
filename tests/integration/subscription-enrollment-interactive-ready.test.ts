/**
 * Integration test — enrollment seeds the interactive onboarding flags
 * (2026-06-09 incident). Full HTTP pipeline: the real enrollment routes over a
 * real EnrollmentWizard + real PendingLoginStore with the DEFAULT (real)
 * ensureInteractiveReady, against a real temp config home. Proves that
 * completing a claude-code enrollment over the API leaves the new account's
 * home interactive-ready — tokens untouched, flags present — so the first
 * pinned/swapped interactive session can never wedge on first-launch
 * onboarding.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { PendingLoginStore } from '../../src/core/PendingLoginStore.js';
import { EnrollmentWizard } from '../../src/core/EnrollmentWizard.js';
import { INTERACTIVE_ONBOARDING_FLAGS } from '../../src/core/ensureInteractiveReady.js';
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

describe('enrollment → interactive-ready config home (integration)', () => {
  let server: TestServer;
  let dir: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enroll-ready-'));
    const store = new PendingLoginStore({ stateDir: dir });
    // Real wizard, DEFAULT ensureReady (the real util) — the production wiring.
    const wizard = new EnrollmentWizard({
      store,
      // userCode satisfies the device-code (codex) flow; the claude
      // url-code-paste flow ignores it.
      driveLogin: async () => ({ verificationUrl: 'https://claude.com/oauth/authorize', userCode: 'AAAA-BBBB', ttlMs: 15 * 60_000 }),
    });
    const app = express();
    app.use(express.json());
    app.use(createRoutes({ config: { authToken: 't', stateDir: dir, port: 0 }, startTime: new Date(), enrollmentWizard: wizard } as never));
    server = await listen(app);
  });

  afterEach(async () => {
    await server?.close();
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/subscription-enrollment-interactive-ready.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  it('POST enroll + complete seeds the onboarding flags into the new home (tokens untouched)', async () => {
    // The home as `claude auth login` leaves it: tokens, no onboarding flags.
    const configHome = path.join(dir, '.claude-new-account');
    fs.mkdirSync(configHome);
    const oauthAccount = { accountUuid: 'u-1', emailAddress: 'new@example.com' };
    fs.writeFileSync(path.join(configHome, '.claude.json'), JSON.stringify({ oauthAccount }));

    const started = await fetch(server.url + '/subscription-pool/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'sm-1', label: 'SageMind - Justin', provider: 'anthropic', framework: 'claude-code', configHome }),
    });
    expect(started.status).toBe(201);

    // Flags must NOT land at start — only on completion (the login isn't
    // approved yet; seeding early would be premature but harmless, this
    // pins the contract).
    let cfg = JSON.parse(fs.readFileSync(path.join(configHome, '.claude.json'), 'utf-8'));
    expect(cfg.hasCompletedOnboarding).toBeUndefined();

    const completed = await fetch(server.url + '/subscription-pool/enroll/sm-1/complete', { method: 'POST' });
    expect(completed.status).toBe(200);

    cfg = JSON.parse(fs.readFileSync(path.join(configHome, '.claude.json'), 'utf-8'));
    for (const f of INTERACTIVE_ONBOARDING_FLAGS) expect(cfg[f]).toBe(true);
    expect(cfg.oauthAccount).toEqual(oauthAccount);
  });

  it('completing a codex enrollment touches no config home (claude-code only)', async () => {
    const configHome = path.join(dir, '.codex-home');
    fs.mkdirSync(configHome);
    await fetch(server.url + '/subscription-pool/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'cx-1', label: 'codex', provider: 'openai', framework: 'codex-cli', configHome }),
    });
    const completed = await fetch(server.url + '/subscription-pool/enroll/cx-1/complete', { method: 'POST' });
    expect(completed.status).toBe(200);
    expect(fs.existsSync(path.join(configHome, '.claude.json'))).toBe(false);
  });
});

/**
 * Route-level tests for the localhost-link guard at the /telegram/reply
 * chokepoint — the operator-mandated rule (2026-06-05): a clickable
 * machine-local link must never reach a user.
 *
 * Built on the minimal createRoutes(ctx) harness (same pattern as
 * parity-pass-timeout.test.ts): no tone gate configured, proving the
 * guard enforces INDEPENDENTLY of the LLM authority.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('localhost-link guard — /telegram/reply chokepoint', () => {
  let server: { url: string; close: () => Promise<void> };
  let sendToTopic: ReturnType<typeof vi.fn>;
  let stateDir: string;

  beforeEach(async () => {
    // HERMETIC stateDir: a literal '/tmp' here shares outbound-dedup.db
    // across suite runs — a prior run's dedup record for these exact texts
    // then suppresses this run's sends (200 with zero sendToTopic calls).
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localhost-guard-'));
    sendToTopic = vi.fn().mockResolvedValue({ messageId: 42, topicId: 12476 });
    const ctx: any = {
      telegram: { sendToTopic },
      sessionManager: { clearInjectionTracker: vi.fn() },
      config: { authToken: 't', stateDir, port: 0 },
      stateDir,
      // Deliberately NO messagingToneGate — the guard must hold without it.
    };
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx));
    server = await new Promise((resolve) => {
      const srv = app.listen(0, () =>
        resolve({
          url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
          close: () => new Promise<void>((r) => srv.close(() => r())),
        }),
      );
    });
  });

  afterEach(async () => {
    await server.close();
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/localhost-link-guard-route.test.ts' });
  });

  async function reply(text: string, metadata?: Record<string, unknown>) {
    return fetch(`${server.url}/telegram/reply/12476`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata ? { text, metadata } : { text }),
    });
  }

  it('blocks a localhost dashboard link with 422 and never sends', async () => {
    const res = await reply('Open your dashboard: http://localhost:4042/dashboard — PIN: 123456');
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.blockedBy).toBe('localhost-link-guard');
    expect(body.match).toBe('http://localhost:4042/dashboard');
    expect(body.error).toContain('tunnel');
    expect(sendToTopic).not.toHaveBeenCalled();
  });

  it('blocks a 127.0.0.1 link too', async () => {
    const res = await reply('see http://127.0.0.1:4040/view/abc');
    expect(res.status).toBe(422);
    expect(sendToTopic).not.toHaveBeenCalled();
  });

  it('passes a tunnel link through and sends', async () => {
    const res = await reply('Dashboard from your phone: https://echo.dawn-tunnel.dev/dashboard');
    expect(res.status).toBe(200);
    expect(sendToTopic).toHaveBeenCalledTimes(1);
  });

  it('passes prose mentions of localhost (no clickable link)', async () => {
    const res = await reply('my server listens on port 4042 of localhost, but use the tunnel link');
    expect(res.status).toBe(200);
    expect(sendToTopic).toHaveBeenCalledTimes(1);
  });

  it('escape hatch: metadata.allowLocalhostLink=true sends the raw local URL', async () => {
    const res = await reply('raw local URL as you asked: http://localhost:4042/health', {
      allowLocalhostLink: true,
    });
    expect(res.status).toBe(200);
    expect(sendToTopic).toHaveBeenCalledTimes(1);
  });
});

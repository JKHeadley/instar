/**
 * Sealed-handoff R3 — the AT-REST INVARIANT (the security guarantee the whole
 * feature rests on, and where the original leak lived).
 *
 * Drives the real submit pipeline end-to-end (mint → fetch the form for its CSRF
 * → submit a sentinel secret) with the Telegram adapter and SessionManager
 * mocked to CAPTURE everything they are handed, then asserts the secret VALUE
 * never escapes the in-memory store:
 *   - it is NOT in any Telegram message (the confirmation carries only label +
 *     field count),
 *   - it is NOT in the agent system-message injected into the session (only
 *     label / count / field-names + retrieval instructions),
 *   - it is NOT written to ANY file under the state directory.
 *
 * A regression here would re-open the exact leak class sealed-handoff exists to
 * close, so this test is the feature's load-bearing guarantee.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';

const SENTINEL = 'SEALED-HANDOFF-ATREST-SENTINEL-9f3a2b7c1e';
const TOPIC_ID = 424242;
const SERVER_TOKEN = 'server-side-token';

interface Captured {
  telegramMessages: string[];
  injectedMessages: string[];
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

describe('Sealed-handoff R3 — at-rest invariant (no plaintext to disk / Telegram / session)', () => {
  let server: { url: string; close: () => Promise<void> };
  let stateDir: string;
  let captured: Captured;

  beforeEach(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-atrest-'));
    captured = { telegramMessages: [], injectedMessages: [] };

    // Pre-seed the topic→session registry so the submit handler takes the
    // (simpler) inject-into-live-session path rather than spawning.
    fs.writeFileSync(
      path.join(stateDir, 'topic-session-registry.json'),
      JSON.stringify({ topicToSession: { [String(TOPIC_ID)]: 'live-session' } }),
    );

    const telegram: any = {
      sendToTopic: vi.fn((_topic: number, msg: string) => {
        captured.telegramMessages.push(msg);
        return Promise.resolve();
      }),
      getTopicName: () => 'At-Rest Test Topic',
      getTopicHistory: () => [],
      resolveTopicName: async () => 'At-Rest Test Topic',
    };
    const sessionManager: any = {
      isSessionAlive: () => true,
      injectPasteNotification: vi.fn((_session: string, msg: string) => {
        captured.injectedMessages.push(msg);
      }),
    };

    const app = express();
    app.use(express.json());
    app.use(authMiddleware(() => SERVER_TOKEN, 'test-agent'));
    const ctx: any = {
      config: { projectName: 'test-agent', authToken: SERVER_TOKEN, stateDir, port: 4042 },
      stateDir,
      tunnel: null,
      telegram,
      sessionManager,
    };
    app.use(createRoutes(ctx));

    await new Promise<void>(resolve => {
      const srv = app.listen(0, () => {
        const port = (srv.address() as AddressInfo).port;
        server = {
          url: `http://127.0.0.1:${port}`,
          close: () => new Promise<void>(r => srv.close(() => r())),
        };
        resolve();
      });
    });
  });

  afterEach(async () => {
    await server.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('the submitted secret value never reaches Telegram, the session, or disk', async () => {
    // 1. Self-mint a request (keystone loopback route), bound to a Telegram topic.
    const mint = await fetch(server.url + '/threadline/secrets/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Production API Key', topicId: TOPIC_ID }),
    });
    expect(mint.status).toBe(201);
    const { token } = await mint.json();
    expect(typeof token).toBe('string');

    // 2. Fetch the submission form and extract its CSRF token (as a browser would).
    const formRes = await fetch(server.url + `/secrets/drop/${token}`);
    expect(formRes.status).toBe(200);
    const formHtml = await formRes.text();
    const csrf = /name="_csrf"\s+value="([0-9a-fA-F]+)"/.exec(formHtml)?.[1];
    expect(csrf, 'CSRF token must be present in the form').toBeTruthy();

    // 3. Submit the sentinel secret value through the real pipeline.
    const submitRes = await fetch(server.url + `/secrets/drop/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _csrf: csrf, secret: SENTINEL }),
    });
    expect(submitRes.status).toBe(200);

    // Let any fire-and-forget notification promises settle.
    await new Promise(r => setTimeout(r, 50));

    // 4a. Telegram was notified, but with NO secret value.
    expect(captured.telegramMessages.length).toBeGreaterThan(0);
    for (const msg of captured.telegramMessages) {
      expect(msg).not.toContain(SENTINEL);
      expect(msg).toContain('Production API Key'); // label only
    }

    // 4b. The agent session was told a secret arrived, but NOT the value.
    expect(captured.injectedMessages.length).toBeGreaterThan(0);
    for (const msg of captured.injectedMessages) {
      expect(msg).not.toContain(SENTINEL);
      expect(msg).toContain('secret-drop-received'); // marker only
    }

    // 4c. The secret value is in NO file under the state directory.
    const leaked = walkFiles(stateDir).filter(f => {
      try {
        return fs.readFileSync(f, 'utf-8').includes(SENTINEL);
      } catch {
        return false; // binary/unreadable — not a plaintext leak surface
      }
    });
    expect(leaked, `secret value must not be persisted; found in: ${leaked.join(', ')}`).toEqual([]);
  });
});

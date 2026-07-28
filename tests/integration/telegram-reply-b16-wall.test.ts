/**
 * Integration test — B16_UNVERIFIED_WALL through the real POST /telegram/reply
 * route (Tier 2 of the "A Wall Is a Hypothesis" standard).
 *
 * Spec: docs/specs/wall-is-a-hypothesis-standard.md
 *
 * Proves the rule is wired end-to-end through the production HTTP pipeline, not
 * just inside the gate class:
 *   1. When the outbound authority blocks with B16, the real reply route returns
 *      422 with error="tone-gate-blocked" and rule="B16_UNVERIFIED_WALL", and the
 *      message is NOT sent to the topic (the unverified-wall message is suppressed
 *      exactly as the /goal-delegation miss should have been).
 *   2. The happy path still delivers — a passing candidate reaches sendToTopic and
 *      returns 200 (B16 does not over-block ordinary replies).
 *
 * Only the IntelligenceProvider is mocked (to drive the gate's verdict
 * deterministically); the route, the gate, and the 422 plumbing are all real.
 */

import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { MessagingToneGate } from '../../src/core/MessagingToneGate.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

// UNIQUE per-run stateDir — never a shared literal '/tmp'. The routes wire a
// DURABLE OutboundContentDedup store at `<stateDir>/outbound-dedup.db`; a shared
// '/tmp' makes the happy-path delivery test's fixed text a cross-run duplicate
// within the 15-min dedup window (same landmine as the b15 sibling test).
const tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b16-wall-'));

interface TestServer { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

function makeProvider(response: { pass: boolean; rule: string; issue: string; suggestion: string }): IntelligenceProvider {
  return { evaluate: vi.fn(async () => JSON.stringify(response)) } as unknown as IntelligenceProvider;
}

function buildApp(opts: {
  toneGate: MessagingToneGate;
  sent: Array<{ topicId: number; text: string }>;
}): express.Express {
  const app = express();
  app.use(express.json());
  const ctx: any = {
    config: { authToken: 'test', stateDir: tmpStateDir, port: 0, projectName: 'echo' },
    messagingToneGate: opts.toneGate,
    telegram: {
      sendToTopic: async (topicId: number, text: string) => {
        opts.sent.push({ topicId, text });
      },
    },
    sessionManager: { clearInjectionTracker: () => {} },
  };
  const router = createRoutes(ctx);
  app.use(router);
  return app;
}

const WALL_MESSAGE =
  "Native /goal delegation isn't feasible — there's no programmatic API for /goal, so we can't drive it.";

describe('B16_UNVERIFIED_WALL — POST /telegram/reply integration', () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });
  afterAll(() => {
    SafeFsExecutor.safeRmSync(tmpStateDir, {
      recursive: true,
      force: true,
      operation: 'tests/integration/telegram-reply-b16-wall.test.ts',
    });
  });

  async function reply(topicId: number, text: string) {
    const res = await fetch(`${server.url}/telegram/reply/${topicId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  it('returns 422 with rule=B16_UNVERIFIED_WALL and does NOT send when the gate blocks an unverified wall', async () => {
    const provider = makeProvider({
      pass: false,
      rule: 'B16_UNVERIFIED_WALL',
      issue: 'declares a path infeasible citing "no programmatic API", no capability inventory shown',
      suggestion: 'inventory existing mechanisms (e.g. session injection) before declaring it impossible',
    });
    const sent: Array<{ topicId: number; text: string }> = [];
    server = await listen(buildApp({ toneGate: new MessagingToneGate(provider), sent }));

    const r = await reply(12143, WALL_MESSAGE);

    expect(r.status).toBe(422);
    expect(r.body.error).toBe('tone-gate-blocked');
    expect(r.body.rule).toBe('B16_UNVERIFIED_WALL');
    expect(r.body.suggestion).toContain('inventory');
    // The unverified-wall message must be suppressed, not delivered.
    expect(sent.length).toBe(0);
  });

  it('delivers a passing reply (200) — B16 does not over-block ordinary messages', async () => {
    const provider = makeProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const sent: Array<{ topicId: number; text: string }> = [];
    server = await listen(buildApp({ toneGate: new MessagingToneGate(provider), sent }));

    const r = await reply(12143, 'Shipped — the new rule is live on main.');

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(sent).toEqual([{ topicId: 12143, text: 'Shipped — the new rule is live on main.' }]);
  });
});

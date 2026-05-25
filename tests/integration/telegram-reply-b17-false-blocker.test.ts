/**
 * Integration test — B17_FALSE_BLOCKER through the real POST /telegram/reply
 * route (Tier 2 of the "Never a False Blocker" standard).
 *
 * Spec: docs/specs/never-a-false-blocker-standard.md
 *
 * Proves the rule is wired end-to-end through the production HTTP pipeline, not
 * just inside the gate class:
 *   1. When the outbound authority blocks with B17, the real reply route returns
 *      422 with error="tone-gate-blocked" and rule="B17_FALSE_BLOCKER", and the
 *      false-blocker message is NOT sent to the topic (it is held and handed back,
 *      exactly as the codex-trust deferral should have been).
 *   2. The happy path still delivers — a passing candidate (a genuine value-judgment
 *      escalation) reaches sendToTopic and returns 200 (B17 does not over-block).
 *
 * Only the IntelligenceProvider is mocked (to drive the gate's verdict
 * deterministically); the route, the gate, and the 422 plumbing are all real.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { MessagingToneGate } from '../../src/core/MessagingToneGate.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

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
    config: { authToken: 'test', stateDir: '/tmp', port: 0, projectName: 'echo' },
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

const FALSE_BLOCKER_MESSAGE =
  "This needs a human to click the trust prompt, and the durable fix needs reverse-engineering, so I'd want a second opinion before I proceed.";

describe('B17_FALSE_BLOCKER — POST /telegram/reply integration', () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });

  async function reply(topicId: number, text: string) {
    const res = await fetch(`${server.url}/telegram/reply/${topicId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  it('returns 422 with rule=B17_FALSE_BLOCKER and does NOT send when the gate blocks a false blocker', async () => {
    const provider = makeProvider({
      pass: false,
      rule: 'B17_FALSE_BLOCKER',
      issue: 'defers clicking the trust prompt to a human and wants a second opinion; no inventory of own means shown',
      suggestion: 'enumerate your means (computer use, send-keys) and try them before deferring to a human',
    });
    const sent: Array<{ topicId: number; text: string }> = [];
    server = await listen(buildApp({ toneGate: new MessagingToneGate(provider), sent }));

    const r = await reply(12896, FALSE_BLOCKER_MESSAGE);

    expect(r.status).toBe(422);
    expect(r.body.error).toBe('tone-gate-blocked');
    expect(r.body.rule).toBe('B17_FALSE_BLOCKER');
    expect(r.body.suggestion).toContain('computer use');
    // The false-blocker message must be held, not delivered.
    expect(sent.length).toBe(0);
  });

  it('delivers a passing reply (200) — a genuine value-judgment escalation is not over-blocked', async () => {
    const provider = makeProvider({ pass: true, rule: '', issue: '', suggestion: '' });
    const sent: Array<{ topicId: number; text: string }> = [];
    server = await listen(buildApp({ toneGate: new MessagingToneGate(provider), sent }));

    const text = 'Do you want me to ship B16 + B17 bundled, or as two separate PRs? Your call.';
    const r = await reply(12896, text);

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(sent).toEqual([{ topicId: 12896, text }]);
  });
});

/**
 * Route-level wiring test for the outbound gate budget on POST /telegram/post-update.
 *
 * Proves the fix is actually WIRED into the production update path (not dead
 * code): a tone gate that HANGS must not stall the route past its budget — the
 * route fails the gate open and delivers the update to the Updates topic, rather
 * than 408ing (which is what made the calling session dump patch notes into a
 * working topic). And a gate that BLOCKS fast must still block (422) — the
 * budget wrapper protects against slow gates without weakening real verdicts.
 *
 * The budget is set tiny via ctx.config.outboundGateReviewBudgetMs so the hang
 * case resolves in ~50ms instead of the 20s production default.
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import type { ToneReviewResult } from '../../src/core/MessagingToneGate.js';

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

const UPDATES_TOPIC_ID = 777;

function buildApp(opts: {
  review: (text: string) => Promise<ToneReviewResult>;
  sends: { topicId: number; text: string }[];
  budgetMs?: number;
}): express.Express {
  const app = express();
  app.use(express.json());

  const ctx: any = {
    config: {
      authToken: 'test',
      stateDir: '/tmp',
      port: 0,
      outboundGateReviewBudgetMs: opts.budgetMs ?? 50,
    },
    state: {
      get: (key: string) => (key === 'agent-updates-topic' ? UPDATES_TOPIC_ID : undefined),
    },
    messagingToneGate: {
      review: (text: string) => opts.review(text),
    },
    telegram: {
      sendToTopic: async (topicId: number, text: string) => {
        opts.sends.push({ topicId, text });
      },
    },
  };

  const router = createRoutes(ctx);
  app.use(router);
  return app;
}

describe('POST /telegram/post-update — outbound gate budget wiring', () => {
  let server: TestServer;

  afterEach(async () => {
    await server?.close();
  });

  async function postUpdate(text: string) {
    const res = await fetch(server.url + '/telegram/post-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  it('delivers the update (200) when the gate HANGS past budget — does not 408 or stall', async () => {
    const sends: { topicId: number; text: string }[] = [];
    // The hang the fix exists to survive: review never resolves.
    server = await listen(
      buildApp({
        review: () => new Promise<ToneReviewResult>(() => {}),
        sends,
        budgetMs: 50,
      }),
    );

    const started = Date.now();
    const r = await postUpdate('Shipped a small reliability fix to the update notifier.');
    const elapsed = Date.now() - started;

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.topicId).toBe(UPDATES_TOPIC_ID);
    // The message was actually delivered to the Updates topic — not dropped.
    expect(sends).toHaveLength(1);
    expect(sends[0].topicId).toBe(UPDATES_TOPIC_ID);
    // Resolved fast (budget ~50ms), nowhere near the 120s route timeout.
    expect(elapsed).toBeLessThan(5_000);
  });

  it('still BLOCKS (422) and does not deliver when the gate decides fast', async () => {
    const sends: { topicId: number; text: string }[] = [];
    server = await listen(
      buildApp({
        review: async () => ({
          pass: false,
          rule: 'B3_OVERSELL',
          issue: 'Oversells a dark feature as finished',
          suggestion: 'Label it experimental',
          latencyMs: 10,
        }),
        sends,
      }),
    );

    const r = await postUpdate('Gemini support is fully ready and production-grade now!');

    expect(r.status).toBe(422);
    expect(r.body.error).toBe('tone-gate-blocked');
    expect(r.body.rule).toBe('B3_OVERSELL');
    // A real block must prevent delivery.
    expect(sends).toHaveLength(0);
  });

  it('delivers (200) when the gate passes fast', async () => {
    const sends: { topicId: number; text: string }[] = [];
    server = await listen(
      buildApp({
        review: async () => ({ pass: true, rule: '', issue: '', suggestion: '', latencyMs: 8 }),
        sends,
      }),
    );

    const r = await postUpdate('Quick heads-up: your dashboard now loads faster on mobile.');

    expect(r.status).toBe(200);
    expect(sends).toHaveLength(1);
    expect(sends[0].topicId).toBe(UPDATES_TOPIC_ID);
  });
});

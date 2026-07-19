/**
 * Integration test — B21_USER_TASK_SUBSTITUTION advisory disposition through the
 * real POST /telegram/reply route.
 *
 * Spec: docs/specs/correction-derived-hardening.md (operator directive
 * 2026-07-18: outbound sentinels NUDGE on a drafted message; the AGENT holds the
 * ultimate decision; overrides are recorded — a decision-quality signal, never
 * authority).
 *
 * Proves the advisory contract end-to-end:
 *   1. A B21 citation returns 422 with error="tone-gate-advisory" (NOT
 *      "tone-gate-blocked"), notSent=true, and a howToProceed naming the
 *      acknowledge-and-resend path. The message is NOT delivered.
 *   2. Resending the SAME text with metadata.toneAdvisoryAck set to the FULL
 *      rule id delivers the message unchanged (200, sendToTopic called).
 *   3. The ack path can NEVER override a BLOCKING rule: a B17 block with a
 *      toneAdvisoryAck for B17 still returns tone-gate-blocked and does not send.
 *
 * Only the IntelligenceProvider is mocked; the route, gate, disposition map,
 * and the 422 plumbing are all real.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    config: { authToken: 'test', stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'b21-route-')), port: 0, projectName: 'echo' },
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

const CLICK_LIST_MESSAGE =
  'Quick fix on your side: open the app config portal, add the four scopes under OAuth & Permissions, click Reinstall, then /invite the bot in both channels.';

describe('B21_USER_TASK_SUBSTITUTION — advisory disposition through POST /telegram/reply', () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });

  async function reply(topicId: number, text: string, metadata?: Record<string, unknown>) {
    const res = await fetch(`${server.url}/telegram/reply/${topicId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata ? { text, metadata } : { text }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  it('returns 422 tone-gate-advisory (a nudge, not a block) and does NOT send on a B21 citation', async () => {
    const provider = makeProvider({
      pass: false,
      rule: 'B21_USER_TASK_SUBSTITUTION',
      issue: 'hands the user a portal click procedure the agent could perform itself',
      suggestion: 'do the portal steps yourself and ask only for the credential you lack',
    });
    const sent: Array<{ topicId: number; text: string }> = [];
    server = await listen(buildApp({ toneGate: new MessagingToneGate(provider), sent }));

    const res = await reply(101, CLICK_LIST_MESSAGE);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('tone-gate-advisory');
    expect(res.body.notSent).toBe(true);
    expect(res.body.rule).toBe('B21_USER_TASK_SUBSTITUTION');
    expect(String(res.body.howToProceed)).toContain('toneAdvisoryAck');
    expect(sent).toHaveLength(0);
  });

  it('delivers unchanged on an explicit toneAdvisoryAck matching the cited rule (override recorded path)', async () => {
    const provider = makeProvider({
      pass: false,
      rule: 'B21_USER_TASK_SUBSTITUTION',
      issue: 'hands the user a portal click procedure',
      suggestion: 'perform it yourself',
    });
    const sent: Array<{ topicId: number; text: string }> = [];
    server = await listen(buildApp({ toneGate: new MessagingToneGate(provider), sent }));

    const res = await reply(102, CLICK_LIST_MESSAGE, {
      toneAdvisoryAck: 'B21_USER_TASK_SUBSTITUTION',
    });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe(CLICK_LIST_MESSAGE);
  });

  it('NEVER lets toneAdvisoryAck override a BLOCKING rule (B17 stays a hard block)', async () => {
    const provider = makeProvider({
      pass: false,
      rule: 'B17_FALSE_BLOCKER',
      issue: 'defers a doable task to a human with no inventory shown',
      suggestion: 'enumerate your means and try them',
    });
    const sent: Array<{ topicId: number; text: string }> = [];
    server = await listen(buildApp({ toneGate: new MessagingToneGate(provider), sent }));

    const res = await reply(103, 'This needs a human to click it, over to you.', {
      toneAdvisoryAck: 'B17_FALSE_BLOCKER',
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('tone-gate-blocked');
    expect(sent).toHaveLength(0);
  });
});

// safe-fs-allow: test file — tmp state dirs only.
/**
 * Integration test — B17 APPROVAL-NOT-ERRAND through the real POST /telegram/reply
 * route (Echo Bugs topic 10000002731).
 *
 * Proves the wiring end-to-end: the route builds the agent's reach on a reply with
 * NO phrase pre-filter, the gate adds the sub-clause and the reach data to the
 * prompt, and a B17 verdict holds the founding message. A right-shaped approval
 * ask is delivered. Only the IntelligenceProvider and the profile registry are
 * faked.
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

const FOUNDING =
  'Status: the Android build is ready. Remaining on your side: pay the $25 Google Play fee from the link in the Android conversation and reply "paid".';
const RIGHT_SHAPE =
  'Approve the $25 Google Play developer fee? On your yes I pay it with your saved card. Page: https://play.google.com/console/signup';

function capture(response: { pass: boolean; rule: string; issue: string; suggestion: string }) {
  const prompts: string[] = [];
  const provider = {
    evaluate: vi.fn(async (p: string) => { prompts.push(p); return JSON.stringify(response); }),
  } as unknown as IntelligenceProvider;
  return { provider, prompts };
}

async function start(toneGate: MessagingToneGate, sent: string[]) {
  const app = express();
  app.use(express.json());
  const ctx: any = {
    config: { authToken: 'test', stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'approval-not-errand-route-')), port: 0, projectName: 'echo' },
    messagingToneGate: toneGate,
    playwrightRegistry: () => ({
      listProfiles: () => [
        { id: 'justin-google', accounts: [{ service: 'google', identity: 'operator@example.com', owner: 'operator' }] },
      ],
    }),
    telegram: {
      sendToTopic: async (topicId: number, text: string) => { sent.push(text); return { messageId: sent.length, topicId }; },
    },
    sessionManager: { clearInjectionTracker: () => {} },
  };
  app.use(createRoutes(ctx));
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

async function reply(url: string, text: string) {
  const res = await fetch(`${url}/telegram/reply/141385`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

describe('B17 APPROVAL-NOT-ERRAND through POST /telegram/reply', () => {
  let server: { url: string; close: () => Promise<void> } | undefined;
  afterEach(async () => { await server?.close(); server = undefined; });

  it('the founding message reaches the gate with the sub-clause and reach data, and a B17 verdict holds it', async () => {
    const { provider, prompts } = capture({
      pass: false,
      rule: 'B17_FALSE_BLOCKER',
      issue: 'hands the operator the payment; only the approval is theirs',
      suggestion: 'ask one yes/no approval for the $25 fee with the direct link; pay it on their yes',
    });
    const sent: string[] = [];
    server = await start(new MessagingToneGate(provider), sent);
    const res = await reply(server.url, FOUNDING);
    const p = prompts.find((x) => x.includes('APPROVAL-NOT-ERRAND sub-clause')) ?? '';
    expect(p).not.toBe('');
    expect(p).toContain('google / operator@example.com in profile justin-google');
    expect(res.status).toBe(422);
    expect(sent).toHaveLength(0);
  });

  it('a right-shaped approval ask is delivered', async () => {
    const { provider, prompts } = capture({ pass: true, rule: '', issue: '', suggestion: '' });
    const sent: string[] = [];
    server = await start(new MessagingToneGate(provider), sent);
    const res = await reply(server.url, RIGHT_SHAPE);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(prompts.some((x) => x.includes('APPROVAL-NOT-ERRAND sub-clause'))).toBe(true);
  });
});

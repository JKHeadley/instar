// safe-fs-allow: test file — tmp state dirs only.
/**
 * Integration test — B17 UNOWNED-HANDOFF through the real POST /telegram/reply
 * route (Echo Bugs topic 10000002523).
 *
 * Proves the wiring end-to-end: the route runs detectUnownedHandoff on a reply,
 * the gate receives the signal and adds the sub-clause to the prompt, and a B17
 * verdict holds the message. A plain reply leaves the prompt without the
 * sub-clause and is delivered. Only the IntelligenceProvider is mocked.
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
  'Progress: the viewer works. Opening documents from inside the app will need a small button added to the app — app work outside this repository, recorded for the app\'s owner.';

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
    config: { authToken: 'test', stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'unowned-handoff-route-')), port: 0, projectName: 'echo' },
    messagingToneGate: toneGate,
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
  const res = await fetch(`${url}/telegram/reply/141469`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

describe('B17 UNOWNED-HANDOFF through POST /telegram/reply', () => {
  let server: { url: string; close: () => Promise<void> } | undefined;
  afterEach(async () => { await server?.close(); server = undefined; });

  it('the founding message reaches the gate with the sub-clause, and a B17 verdict holds it', async () => {
    const { provider, prompts } = capture({
      pass: false,
      rule: 'B17_FALSE_BLOCKER',
      issue: 'states app work is needed with no owner or route',
      suggestion: 'name who builds the app button and how it gets there, and put it on the completion list',
    });
    const sent: string[] = [];
    server = await start(new MessagingToneGate(provider), sent);
    const res = await reply(server.url, FOUNDING);
    expect(prompts.some((p) => p.includes('UNOWNED-HANDOFF sub-clause'))).toBe(true);
    expect(prompts.some((p) => p.includes('unowned-handoff detector (signal-only'))).toBe(true);
    expect(res.status).toBe(422);
    expect(sent).toHaveLength(0);
  });

  it('a plain reply gets no sub-clause and is delivered', async () => {
    const { provider, prompts } = capture({ pass: true, rule: '', issue: '', suggestion: '' });
    const sent: string[] = [];
    server = await start(new MessagingToneGate(provider), sent);
    const res = await reply(server.url, 'Merged the viewer fix; the button is live on the viewer page.');
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(prompts.some((p) => p.includes('UNOWNED-HANDOFF'))).toBe(false);
  });
});

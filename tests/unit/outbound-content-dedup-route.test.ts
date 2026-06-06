/**
 * Route-level tests for the content-dedup at the /telegram/reply chokepoint
 * (2026-06-06 duplicate-message fix). Mirrors the localhost-link-guard-route
 * harness: minimal createRoutes(ctx), NO tone gate — proving the dedup holds
 * INDEPENDENTLY of the LLM authority (it must, since the gate is skipped for
 * proxy/relay sends).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';

const LONG =
  '✅ The vault-GitHub-token security piece (your option C) just landed clean on the main branch.';

describe('content-dedup — /telegram/reply chokepoint', () => {
  let server: { url: string; close: () => Promise<void> };
  let sendToTopic: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    sendToTopic = vi.fn().mockResolvedValue({ messageId: 42, topicId: 12476 });
    const ctx: any = {
      telegram: { sendToTopic },
      sessionManager: { clearInjectionTracker: vi.fn() },
      config: { authToken: 't', stateDir: '/tmp', port: 0 },
      stateDir: '/tmp',
      // No tone gate — the dedup must hold without it.
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

  afterEach(async () => { await server.close(); });

  async function reply(text: string, metadata?: Record<string, unknown>) {
    const res = await fetch(`${server.url}/telegram/reply/12476`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata ? { text, metadata } : { text }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  it('first send of a long message goes through', async () => {
    const r = await reply(LONG);
    expect(r.status).toBe(200);
    expect(sendToTopic).toHaveBeenCalledTimes(1);
  });

  it('an identical re-send is suppressed (200, never re-sent)', async () => {
    await reply(LONG);
    const r2 = await reply(LONG);
    expect(r2.status).toBe(200);
    expect(r2.body.suppressedDuplicate).toBe(true);
    expect(sendToTopic).toHaveBeenCalledTimes(1); // only the first reached Telegram
  });

  it('a DIFFERENT long message still goes through', async () => {
    await reply(LONG);
    const r2 = await reply(LONG + ' Wiring the next piece now.');
    expect(r2.status).toBe(200);
    expect(sendToTopic).toHaveBeenCalledTimes(2);
  });

  it('brief acks are never suppressed even when identical', async () => {
    await reply('Got it, on it.');
    const r2 = await reply('Got it, on it.');
    expect(r2.status).toBe(200);
    expect(r2.body.suppressedDuplicate).toBeUndefined();
    expect(sendToTopic).toHaveBeenCalledTimes(2);
  });

  it('escape hatch: metadata.allowDuplicate=true re-sends the identical text', async () => {
    await reply(LONG);
    const r2 = await reply(LONG, { allowDuplicate: true });
    expect(r2.status).toBe(200);
    expect(sendToTopic).toHaveBeenCalledTimes(2);
  });

  it('does not cross topics — same text to another topic sends', async () => {
    await reply(LONG);
    const res = await fetch(`${server.url}/telegram/reply/99999`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: LONG }),
    });
    expect(res.status).toBe(200);
    expect(sendToTopic).toHaveBeenCalledTimes(2);
  });
});

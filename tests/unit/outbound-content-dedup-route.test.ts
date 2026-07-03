/**
 * Route-level tests for the content-dedup at the /telegram/reply chokepoint
 * (2026-06-06 duplicate-message fix). Mirrors the localhost-link-guard-route
 * harness: minimal createRoutes(ctx), NO tone gate — proving the dedup holds
 * INDEPENDENTLY of the LLM authority (it must, since the gate is skipped for
 * proxy/relay sends).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const LONG =
  '✅ The vault-GitHub-token security piece (your option C) just landed clean on the main branch.';

describe('content-dedup — /telegram/reply chokepoint', () => {
  let server: { url: string; close: () => Promise<void> };
  let sendToTopic: ReturnType<typeof vi.fn>;
  let stateDir: string;

  beforeEach(async () => {
    sendToTopic = vi.fn().mockResolvedValue({ messageId: 42, topicId: 12476 });
    // Isolated stateDir per test: the durable outbound-dedup store persists to
    // stateDir/outbound-dedup.db, so a shared dir would leak fingerprints across
    // cases (a record in one case would suppress sends in the next).
    stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-route-')));
    const ctx: any = {
      telegram: { sendToTopic },
      sessionManager: { clearInjectionTracker: vi.fn() },
      config: { authToken: 't', stateDir, port: 0 },
      stateDir,
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

  afterEach(async () => {
    await server.close();
    try { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/outbound-content-dedup-route.test.ts:cleanup' }); } catch { /* best-effort */ }
  });

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

  // ── In-flight reservation (2026-07-03 double-send race close) ──
  // The record-after-success dedup left a window: while send A is IN FLIGHT
  // (slow under a server stall), an identical request B passes the pre-check
  // (nothing recorded yet) and sends a duplicate. The reservation closes it.
  it('suppresses an identical send that arrives while the first is still IN FLIGHT', async () => {
    // Make the FIRST send hang until we release it; the second arrives meanwhile.
    let releaseA: (v: { messageId: number; topicId: number }) => void = () => {};
    const inFlight = new Promise<{ messageId: number; topicId: number }>((r) => (releaseA = r));
    sendToTopic.mockReturnValueOnce(inFlight); // A hangs
    // (subsequent calls fall back to the default mockResolvedValue)

    const pA = reply(LONG); // A: reserves, then blocks in the in-flight send
    // Give A's handler time to take the reservation before B arrives.
    await new Promise((r) => setTimeout(r, 20));
    const rB = await reply(LONG); // B: identical, arrives during A's in-flight send

    expect(rB.body.suppressedDuplicate).toBe(true); // B suppressed by the reservation
    releaseA({ messageId: 1, topicId: 12476 }); // let A finish
    const rA = await pA;
    expect(rA.status).toBe(200);
    expect(sendToTopic).toHaveBeenCalledTimes(1); // only A ever reached Telegram
  });

  it('releases the reservation when the send FAILS, so the legitimate retry goes through', async () => {
    sendToTopic.mockRejectedValueOnce(new Error('telegram 500')); // A fails
    const rA = await reply(LONG);
    expect(rA.status).toBe(500); // A surfaced the failure

    const rB = await reply(LONG); // retry of the exact text
    expect(rB.status).toBe(200);
    expect(rB.body.suppressedDuplicate).toBeUndefined(); // NOT suppressed
    expect(sendToTopic).toHaveBeenCalledTimes(2); // the retry reached Telegram
  });
});

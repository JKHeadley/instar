/**
 * ROUTE-level tests for the invisible-payload refusal at the /telegram/reply chokepoint.
 *
 * ── Why this file exists separately ────────────────────────────────────────────────────────────
 * `telegram-reply-invisible-payload.test.ts` tests the PREDICATE, and review pass 9 was right to
 * make it import the shared definition rather than re-declare it — neutering
 * `hasNoVisibleCharacters` now turns that file red. But pass 10 showed that was still not a
 * regression test for the ROUTE: deleting the entire `if (hasNoVisibleCharacters(text))` block from
 * `src/server/routes.ts` left all four predicate tests green. A file whose header called itself a
 * regression test for a route never touched the route.
 *
 * That is the same defect one level along: the fix closed the demonstrated instance (the test had
 * its own copy of the predicate) and then certified the class (that the route was regression-tested).
 * The predicate being shared proves the two expressions agree; it says nothing about whether the
 * route still calls it.
 *
 * ── Copied, not invented ───────────────────────────────────────────────────────────────────────
 * This harness is `tests/unit/localhost-link-guard-route.test.ts` with the payloads changed. That
 * file already tests a deterministic guard on THIS EXACT route, and pass 10 pointed at it directly.
 * Adopting a proven pattern rather than authoring a fresh one is the whole lesson of this window:
 * every fresh invention here has opened a new hole, and copying has not.
 *
 * Two details inherited from it that are load-bearing, and would have cost an hour to rediscover:
 *   • The stateDir must be a fresh mkdtemp. A literal '/tmp' shares outbound-dedup.db across runs,
 *     so a prior run's dedup record for these exact texts silently suppresses this run's sends —
 *     which surfaces as a 200 with zero sendToTopic calls and reads exactly like a passing test.
 *   • NO messagingToneGate is configured, deliberately. The refusal must hold independently of the
 *     LLM authority; wiring a gate here would let the gate's verdict stand in for the guard's.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('invisible-payload guard — /telegram/reply chokepoint', () => {
  let server: { url: string; close: () => Promise<void> };
  let sendToTopic: ReturnType<typeof vi.fn>;
  let stateDir: string;

  beforeEach(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invisible-payload-'));
    sendToTopic = vi.fn().mockResolvedValue({ messageId: 42, topicId: 12476 });
    const ctx: any = {
      telegram: { sendToTopic },
      sessionManager: { clearInjectionTracker: vi.fn() },
      config: { authToken: 't', stateDir, port: 0 },
      stateDir,
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
    SafeFsExecutor.safeRmSync(stateDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/telegram-reply-invisible-payload-route.test.ts',
    });
  });

  async function reply(text: string) {
    return fetch(`${server.url}/telegram/reply/12476`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  }

  it('refuses the exact incident payload (a lone U+200B) and never sends', async () => {
    const res = await reply('​');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('no visible characters');
    expect(sendToTopic).not.toHaveBeenCalled();
  });

  it('refuses the wider invisible class at the route, not only in the predicate', async () => {
    for (const ch of ['‎', '⁡', '️', '­', '᠎', '﻿']) {
      const res = await reply(ch);
      expect(res.status, `U+${ch.codePointAt(0)!.toString(16).toUpperCase()} should be refused`).toBe(400);
    }
    expect(sendToTopic).not.toHaveBeenCalled();
  });

  it('refuses a whitespace-only body and never sends', async () => {
    const res = await reply('   \n\t ');
    expect(res.status).toBe(400);
    expect(sendToTopic).not.toHaveBeenCalled();
  });

  // The direction that matters most: over-refusal eats real messages silently, which is a worse
  // failure than the one this guard was built for — the user at least SEES a delivery error.
  it('sends a message with real content', async () => {
    const res = await reply('a genuine reply');
    expect(res.status).toBe(200);
    expect(sendToTopic).toHaveBeenCalledTimes(1);
  });

  it('sends a single full stop — minimal but visible', async () => {
    const res = await reply('.');
    expect(res.status).toBe(200);
    expect(sendToTopic).toHaveBeenCalledTimes(1);
  });

  it('sends visible content padded with invisible characters', async () => {
    const res = await reply('​x​');
    expect(res.status).toBe(200);
    expect(sendToTopic).toHaveBeenCalledTimes(1);
  });
});

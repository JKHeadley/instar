/**
 * Slack adapter boundary (Robustness Net #1, Goal 2 — verify-and-test-only).
 *
 * A throw during Slack connection setup must surface via the adapter's onError
 * path, NEVER reject out of server bootstrap. This is "verify-and-test-only": the
 * synchronous boot boundary already exists in server.ts (the Slack init block —
 * including `await slackAdapter.start()` — is wrapped in try/catch that sets
 * `slackAdapter = undefined` and reports degradation, so /health keeps serving).
 * These tests pin (1) the async dial-failure boundary behaviorally and (2) the
 * synchronous boot boundary structurally.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { SocketModeClient, type SocketModeHandlers } from '../../src/messaging/slack/SocketModeClient.js';
import { SlackApiError } from '../../src/messaging/slack/SlackApiClient.js';

function makeHandlers(): SocketModeHandlers {
  return {
    onEvent: vi.fn(async () => {}),
    onInteraction: vi.fn(async () => {}),
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
    onError: vi.fn(),
  };
}

describe('SocketModeClient dial failure surfaces via onError (does not reject out of bootstrap)', () => {
  it('a permanent dial error calls onError(err, true) and connect() resolves without throwing', async () => {
    const handlers = makeHandlers();
    const permanentErr = new SlackApiError('invalid auth', 'apps.connections.open', 'invalid_auth', true);
    const apiClient = { call: vi.fn(() => Promise.reject(permanentErr)) };
    const client = new SocketModeClient(apiClient as any, handlers);

    // connect() must RESOLVE (not reject) — a caller awaiting it in server
    // bootstrap is not torn down by the dial failure.
    await expect(client.connect()).resolves.toBeUndefined();

    expect(handlers.onError).toHaveBeenCalledWith(permanentErr, true);
    expect(client.isConnected).toBe(false);
  });

  it('a permanent dial error stops retrying (started=false), so bootstrap is not blocked by backoff', async () => {
    const handlers = makeHandlers();
    const apiClient = {
      call: vi.fn(() => Promise.reject(new SlackApiError('invalid auth', 'apps.connections.open', 'invalid_auth', true))),
    };
    const client = new SocketModeClient(apiClient as any, handlers);

    await client.connect();

    // A permanent failure must not arm an endless backoff loop — exactly one
    // dial attempt, and the client is no longer "started".
    expect(apiClient.call).toHaveBeenCalledTimes(1);
    expect((client as unknown as { started: boolean }).started).toBe(false);
  });
});

describe('server.ts boot boundary contains a Slack init failure (keeps /health serving)', () => {
  const serverSource = readFileSync(path.resolve(__dirname, '../../src/commands/server.ts'), 'utf-8');

  it('wraps the Slack init (incl. slackAdapter.start) and degrades instead of crashing boot', () => {
    // The catch sets slackAdapter = undefined and reports a 'Slack' degradation —
    // bootstrap continues, so the HTTP server (and /health) stays up.
    expect(serverSource).toMatch(/await slackAdapter\.start\(\)/);
    expect(serverSource).toMatch(/catch \(err\)[\s\S]*?slackAdapter = undefined;[\s\S]*?degradationReporter\.report\(\{[\s\S]*?feature: 'Slack'/);
  });
});

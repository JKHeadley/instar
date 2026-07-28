/**
 * SocketModeClient reconnection tests — verifies that:
 * 1. The reconnect() method tears down and re-establishes the connection
 * 2. The close handler catches reconnect failures and retries
 * 3. Sleep/wake scenarios don't leave the connection permanently dead
 *
 * Root cause: After macOS sleep, the WebSocket dies silently. The close
 * handler's _backoffReconnect() was async-but-uncaught, so if the first
 * reconnect attempt failed (network not ready), the error was swallowed
 * and no further reconnects were attempted.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { SocketModeClient, type SocketModeHandlers } from '../../src/messaging/slack/SocketModeClient.js';

const socketClientPath = path.resolve(__dirname, '../../src/messaging/slack/SocketModeClient.ts');
const socketClientSource = readFileSync(socketClientPath, 'utf-8');

const slackAdapterPath = path.resolve(__dirname, '../../src/messaging/slack/SlackAdapter.ts');
const slackAdapterSource = readFileSync(slackAdapterPath, 'utf-8');

const serverPath = path.resolve(__dirname, '../../src/commands/server.ts');
const serverSource = readFileSync(serverPath, 'utf-8');

function makeHandlers(): SocketModeHandlers {
  return {
    onEvent: vi.fn(async () => {}),
    onInteraction: vi.fn(async () => {}),
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
    onError: vi.fn(),
  };
}

async function handleRaw(client: SocketModeClient, raw: string): Promise<void> {
  await (client as unknown as { _handleRawMessage(raw: string): Promise<void> })._handleRawMessage(raw);
}

describe('SocketModeClient reconnection', () => {
  it('has a reconnect() method', () => {
    expect(socketClientSource).toContain('async reconnect(): Promise<void>');
  });

  it('reconnect() resets reconnecting state to prevent deadlocks', () => {
    expect(socketClientSource).toMatch(/reconnect\(\)[\s\S]*?this\.reconnecting = false/);
  });

  it('reconnect() resets consecutiveErrors to zero', () => {
    expect(socketClientSource).toMatch(/reconnect\(\)[\s\S]*?this\.consecutiveErrors = 0/);
  });

  it('reconnect() sets started=true before opening connection', () => {
    expect(socketClientSource).toMatch(/reconnect\(\)[\s\S]*?this\.started = true[\s\S]*?this\._openConnection/);
  });

  it('reconnect() tears down via the epoch-bumping teardown (stale close events are identity-guarded)', () => {
    // The old "temporarily clear started" save/restore was synchronous, but
    // close events fire on a later tick — it never actually suppressed the
    // stale handler and leaked one live websocket per reconnect (#1076).
    // The teardown must bump the epoch and null this.ws BEFORE closing, and
    // the close handler must ignore sockets that are no longer current.
    expect(socketClientSource).toMatch(/reconnect\(\)[\s\S]*?this\._teardownSocket\(/);
    expect(socketClientSource).toMatch(/_teardownSocket\([\s\S]*?this\.epoch\+\+/);
    expect(socketClientSource).toMatch(/addEventListener\('close'[\s\S]*?if \(this\.ws !== sock\) return/);
  });
});

describe('Close handler error resilience', () => {
  it('catches _backoffReconnect() errors in the close handler', () => {
    // The close handler must .catch() the _backoffReconnect() promise
    // to prevent unhandled rejections from killing the reconnect loop.
    expect(socketClientSource).toContain('this._backoffReconnect().catch(');
  });

  it('schedules a fallback retry after catch', () => {
    // After catching a reconnect failure, a setTimeout should schedule
    // one more attempt to avoid permanent connection death.
    expect(socketClientSource).toMatch(/\.catch\([\s\S]*?setTimeout\(/);
  });
});

describe('SlackAdapter reconnect()', () => {
  it('exposes a reconnect() method', () => {
    expect(slackAdapterSource).toContain('async reconnect(): Promise<void>');
  });

  it('delegates to socketClient.reconnect()', () => {
    expect(slackAdapterSource).toMatch(/reconnect\(\)[\s\S]*?this\.socketClient\.reconnect\(\)/);
  });
});

describe('SleepWake Slack reconnection', () => {
  it('reconnects Slack in the wake handler', () => {
    // The SleepWake handler must call slackAdapter.reconnect() after wake
    expect(serverSource).toMatch(/sleepWakeDetector\.on\('wake'[\s\S]*?slackAdapter[\s\S]*?reconnect/);
  });

  it('delays Slack reconnect to let network stabilize', () => {
    // Should use setTimeout to wait for network after wake
    expect(serverSource).toMatch(/setTimeout\(async \(\) =>[\s\S]*?reconnect/);
  });

  it('handles Slack reconnect failure gracefully', () => {
    // Must catch errors from the reconnect attempt
    expect(serverSource).toMatch(/slackAdapter[\s\S]*?reconnect[\s\S]*?catch/);
  });
});

describe('Ack send guard against a mid-reconnect socket (#43 — no whole-agent crash)', () => {
  it('does not send or throw when an event arrives while the socket is not OPEN', async () => {
    const handlers = makeHandlers();
    const client = new SocketModeClient({} as any, handlers);
    const send = vi.fn(() => {
      throw new Error('Sent before connected.');
    });
    (client as any).ws = { readyState: WebSocket.CONNECTING, send };
    const payload = {
      envelope_id: 'E-mid-reconnect',
      type: 'events_api',
      payload: { event: { type: 'message' } },
    };

    await expect(handleRaw(client, JSON.stringify(payload))).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
    expect(handlers.onEvent).toHaveBeenCalledWith('message', payload.payload);
  });

  it('catches an ack send race when the socket flips state after the OPEN check', async () => {
    const handlers = makeHandlers();
    const client = new SocketModeClient({} as any, handlers);
    const send = vi.fn(() => {
      throw new Error('Sent before connected.');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (client as any).ws = { readyState: WebSocket.OPEN, send };
    const payload = {
      envelope_id: 'E-send-race',
      type: 'events_api',
      payload: { event: { type: 'message' } },
    };

    await expect(handleRaw(client, JSON.stringify(payload))).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledWith(JSON.stringify({ envelope_id: 'E-send-race' }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ack send failed'));
    expect(handlers.onEvent).toHaveBeenCalledWith('message', payload.payload);
    warn.mockRestore();
  });

  it('routes the event ack through the _safeSend funnel (net #1)', () => {
    // The "must ack within 3s" send now goes through _safeSend, which owns the
    // readyState guard + try/catch — during a reconnect race the socket can be
    // CONNECTING/CLOSING, and an unguarded send threw "Sent before connected" →
    // uncaught → FATAL. The ack path passes no reconnectOnFailure (a failed ack
    // does not by itself prove the socket is dead).
    expect(socketClientSource).toMatch(
      /envelope\.envelope_id\)\s*\{[\s\S]*?this\._safeSend\(JSON\.stringify\(\{ envelope_id: envelope\.envelope_id \}\), 'ack'\)/,
    );
  });

  it('_safeSend guards the send on readyState === OPEN and wraps it in try/catch', () => {
    // The funnel reads this.ws once into a local, returns false on a non-OPEN
    // precheck (no throw), and wraps the OPEN-socket send in try/catch so a
    // state flip between check and send cannot escape.
    expect(socketClientSource).toMatch(
      /_safeSend\([^)]*\): boolean \{[\s\S]*?readyState !== WebSocket\.OPEN\) return false;[\s\S]*?try \{[\s\S]*?sock\.send\([\s\S]*?\} catch/,
    );
  });

  it('server routes BOTH process-level error events through the shared policy (defense-in-depth)', () => {
    // The recoverable-error allowlist is a testable module; both the
    // uncaughtException AND unhandledRejection handlers delegate to the one
    // shared handleProcessLevelError so they cannot drift to divergent policies.
    expect(serverSource).toMatch(
      /import \{[^}]*\bhandleProcessLevelError\b[^}]*\} from '\.\.\/core\/uncaughtExceptionPolicy\.js'/,
    );
    expect(serverSource).toMatch(/process\.on\('uncaughtException'[\s\S]*?handleProcessLevelError\(/);
    expect(serverSource).toMatch(/process\.on\('unhandledRejection'[\s\S]*?handleProcessLevelError\(/);
  });
});

/**
 * Honest delivery §4 — with waitForReply:true the reply listener is registered
 * BEFORE the ≤3 s relay-verdict wait, so a reply that lands during that wait is
 * captured (second-pass review finding, 2026-10-06); and a refused send cancels
 * only its OWN reply waiter, never a later retry's waiter on the same thread.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createRoutes } from '../../../src/server/routes.js';
import { StateManager } from '../../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../../src/core/types.js';

const PEER = 'd5d07ce5f9b199abac3a90ea3c90d269';

describe('relay-send waitForReply runs concurrently with the verdict wait', () => {
  let projectDir: string;
  let server: Server;
  let port: number;
  const waiters = new Map<string, { resolve: (r: string) => void; timer: unknown }>();
  let verdictFor: (id: string) => Promise<unknown>;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-reply-wait-'));
    const stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'echo-rw' }));
    let n = 0;
    const relayClient = {
      connectionState: 'connected',
      resolveAgent: async () => PEER,
      sendAutoWithThread: (_r: string, _m: string, t?: string) => ({ messageId: `msg-rw-${++n}`, threadId: t ?? 'thread-rw' }),
      awaitRelayAck: (id: string) => verdictFor(id),
      banSuspected: false,
      noteUnconfirmedSettled() {},
    };
    const router = createRoutes({
      config: { projectDir, stateDir, projectName: 'echo-rw', port: 4042 } as InstarConfig,
      state: new StateManager(stateDir),
      threadlineRelayClient: relayClient,
      threadlineReplyWaiters: waiters,
      startTime: new Date(),
    } as any);
    const app = express();
    app.use(express.json());
    app.use(router);
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; r(); }); });
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/integration/threadline/relay-send-reply-wait-concurrency.test.ts' });
  });

  it('a reply that lands DURING the verdict wait is captured', async () => {
    verdictFor = async () => {
      // The peer replies while we are still waiting on the relay's verdict.
      waiters.get('thread-a')?.resolve('fast reply');
      await new Promise((r) => setTimeout(r, 50));
      return { messageId: 'x', status: 'delivered' };
    };
    const res = await fetch(`http://127.0.0.1:${port}/threadline/relay-send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetAgent: 'luna', message: 'hi', threadId: 'thread-a', waitForReply: true, timeoutSeconds: 5 }),
    });
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ reply: 'fast reply', delivered: true, relayStatus: 'delivered' });
  });

  it('a refusal cancels only its own waiter — a retry\'s waiter on the same thread survives', async () => {
    const retryEntry = { resolve: (_r: string) => {}, timer: null };
    verdictFor = async () => {
      // A retry registered its own waiter on the same thread meanwhile.
      waiters.set('thread-b', retryEntry);
      return { messageId: 'y', status: 'rejected', reasonCode: 'queue-full', retryLater: true };
    };
    const res = await fetch(`http://127.0.0.1:${port}/threadline/relay-send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetAgent: 'luna', message: 'hi', threadId: 'thread-b', waitForReply: true, timeoutSeconds: 5 }),
    });
    expect(res.status).toBe(502);
    expect(waiters.get('thread-b')).toBe(retryEntry);
  });
});

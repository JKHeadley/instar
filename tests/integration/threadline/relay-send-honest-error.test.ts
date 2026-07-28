/**
 * Integration test — Threadline send surfaces the honest relay-send error.
 *
 * Wires the REAL `/threadline/relay-send` route to the REAL MCP helper
 * `sendMessageViaHttp` over localhost HTTP. With the relay client
 * disconnected and no local target, relay-send returns 503 "Relay not
 * connected and local delivery unavailable". The helper must surface that
 * verbatim — and must NEVER fall through to `/messages/send` (the old bug,
 * which produced a misleading 400 "Missing required fields…").
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
import { sendMessageViaHttp } from '../../../src/threadline/mcp-http-client.js';
import type { InstarConfig } from '../../../src/core/types.js';

let projectDir: string;
let stateDir: string;
let server: Server;
let port: number;
const requestedPaths: string[] = [];

describe('Threadline send — honest relay-send error', () => {
  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-honest-error-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ projectName: 'echo-honest-error-test' }),
    );
    // No known-agents.json → no local target → relay-send must fall to the
    // relay path, where the disconnected client yields the honest 503.

    const config = {
      projectDir,
      stateDir,
      projectName: 'echo-honest-error-test',
      port: 4042,
    } as InstarConfig;

    const router = createRoutes({
      config,
      state: new StateManager(stateDir),
      // Relay client is null → relay path is unavailable → 503.
      threadlineRelayClient: null,
      startTime: new Date(),
    } as any);

    const app = express();
    app.use(express.json());
    // Record every request path so we can prove /messages/send is never hit.
    app.use((req, _res, next) => {
      requestedPaths.push(req.path);
      next();
    });
    app.use(router);

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/integration/threadline/relay-send-honest-error.test.ts:cleanup',
    });
  });

  it('relay-send returns the honest 503, not a 400 missing-fields error', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/threadline/relay-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetAgent: 'dawn', message: 'ping', waitForReply: false }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('Relay not connected');
    expect(body.error).not.toContain('Missing required fields');
  });

  it('sendMessageViaHttp surfaces the honest error and never calls /messages/send', async () => {
    requestedPaths.length = 0;

    const result = await sendMessageViaHttp(
      { targetAgent: 'dawn', message: 'ping', waitForReply: false, timeoutSeconds: 120 },
      port,
      'test-token',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Relay not connected and local delivery unavailable');
    expect(result.error).not.toContain('Missing required fields');

    // The whole point of the fix: no envelope fallback.
    expect(requestedPaths).toContain('/threadline/relay-send');
    expect(requestedPaths).not.toContain('/messages/send');
  });
});

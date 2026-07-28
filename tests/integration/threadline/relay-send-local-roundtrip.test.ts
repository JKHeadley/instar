/**
 * Integration test — full-stack local delivery through the fixed MCP helper.
 *
 * Regression guard (T6): the send-path fix removed the broken /messages/send
 * fallback, but co-located same-machine delivery must still work. This wires
 * the REAL `sendMessageViaHttp` helper → REAL `/threadline/relay-send` route →
 * a fake local target agent, and asserts a successful local round-trip
 * (deliveryPath: "local") is mapped back through the helper.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
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
let fakeTarget: Server;
let fakeTargetPort: number;
let tokenFilePath: string;
let capturedEnvelopes: Array<any>;
const TARGET = `roundtrip-target-${randomBytes(3).toString('hex')}`;

describe('Threadline send — full-stack local delivery round-trip', () => {
  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-roundtrip-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'echo-roundtrip-test' }));

    // Fake local target: alive on /threadline/health, accepts relay-agent.
    capturedEnvelopes = [];
    const targetApp = express();
    targetApp.use(express.json({ limit: '128kb' }));
    targetApp.get('/threadline/health', (_req, res) => res.json({ ok: true }));
    targetApp.post('/messages/relay-agent', (req, res) => {
      capturedEnvelopes.push(req.body);
      res.json({ ok: true, threadline: { handled: true, spawned: true, sessionName: 'thread-x', gateDecision: 'allow' } });
    });
    await new Promise<void>((resolve) => {
      fakeTarget = targetApp.listen(0, '127.0.0.1', () => {
        fakeTargetPort = (fakeTarget.address() as { port: number }).port;
        resolve();
      });
    });

    fs.writeFileSync(
      path.join(stateDir, 'threadline', 'known-agents.json'),
      JSON.stringify({
        agents: [{
          name: TARGET,
          port: fakeTargetPort,
          fingerprint: 'aabbccddeeff00112233445566778899',
          publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        }],
      }),
    );

    // Agent token so the route's getAgentToken returns non-null for local delivery.
    const tokenDir = path.join(os.homedir(), '.instar', 'agent-tokens');
    fs.mkdirSync(tokenDir, { recursive: true });
    tokenFilePath = path.join(tokenDir, `${TARGET}.token`);
    fs.writeFileSync(tokenFilePath, randomBytes(32).toString('hex'));

    const config = { projectDir, stateDir, projectName: 'echo-roundtrip-test', port: 4042 } as InstarConfig;
    const router = createRoutes({
      config,
      state: new StateManager(stateDir),
      threadlineRelayClient: { connectionState: 'connected', resolveAgent: async () => null, sendAuto: () => 'msg-stub' } as any,
      startTime: new Date(),
    } as any);

    const app = express();
    app.use(express.json());
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
    if (fakeTarget) await new Promise<void>((resolve) => fakeTarget.close(() => resolve()));
    SafeFsExecutor.safeRmSync(tokenFilePath, { force: true, operation: 'relay-send-local-roundtrip:cleanup-token' });
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'relay-send-local-roundtrip:cleanup' });
  });

  it('delivers locally and maps deliveryPath="local" success back through the helper', async () => {
    const result = await sendMessageViaHttp(
      { targetAgent: TARGET, message: 'roundtrip hello', waitForReply: false, timeoutSeconds: 120 },
      port,
      'sender-token',
    );

    expect(result.success).toBe(true);
    expect(result.deliveryPath).toBe('local');
    expect(result.messageId).toBeTruthy();
    expect(result.threadId).toBeTruthy();
    expect(capturedEnvelopes.length).toBe(1);
    expect(capturedEnvelopes[0]?.message?.body).toBe('roundtrip hello');
  });
});

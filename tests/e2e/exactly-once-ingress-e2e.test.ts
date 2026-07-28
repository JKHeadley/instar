/**
 * E2E: the exactly-once ingress gate is ALIVE in a real booted AgentServer
 * (spec §8 G3a, Tier-3 "feature is alive"). Boots an actual server with the
 * MessageProcessingLedger wired (as server.ts does when multiMachine
 * .exactlyOnceIngress is on) and proves a redelivered, already-replied event is
 * dropped over real HTTP — returns 200 + deduped, never routed to a session.
 *
 * Uses a pre-committed ledger entry so the assertion needs no live tmux session:
 * the gate short-circuits BEFORE routing on an already-replied dedupeKey, which
 * is exactly the redelivery/handoff-window-replay case the guarantee exists for.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { MessageProcessingLedger } from '../../src/messaging/MessageProcessingLedger.js';
import { dedupeKeyFor, decideIngress, commitInboundReply } from '../../src/messaging/ingressDedup.js';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'test-auth-exactly-once';
const TOPIC = 13481;

describe('Exactly-once ingress gate — alive in a real booted server', () => {
  const PORT = 19500 + Math.floor(Math.random() * 80);
  let stateDir: string;
  let server: AgentServer;
  let ledger: MessageProcessingLedger;

  beforeAll(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exactly-once-e2e-'));
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    ProcessIntegrity.reset();
    ProcessIntegrity.initialize('1.3.19', null);

    // Pre-seed: messageId 99 was received AND already replied to.
    ledger = MessageProcessingLedger.openMemory();
    const key = dedupeKeyFor('telegram', TOPIC, 99);
    decideIngress(ledger, key, { platform: 'telegram', topic: String(TOPIC), epoch: 1, maxProcessingMs: 300_000 });
    commitInboundReply(ledger, key, 1);

    const config = {
      projectName: 'exactly-once-e2e',
      projectDir: stateDir,
      stateDir,
      port: PORT,
      host: '127.0.0.1',
      authToken: AUTH,
      claudePath: 'claude',
      tmuxPath: 'tmux',
      scheduler: { enabled: false, timezone: 'UTC' },
      messaging: [],
      monitoring: {},
      requestTimeoutMs: 30000,
    } as InstarConfig;

    const state = new StateManager(stateDir);
    const sessionManager = new SessionManager({ stateDir, claudePath: 'claude', tmuxPath: 'tmux', projectDir: stateDir, port: PORT });

    server = new AgentServer({
      config,
      sessionManager,
      state,
      messageLedger: ledger,
      currentInboundByTopic: new Map<string, string>(),
    });
    await server.start();
  }, 20000);

  afterAll(async () => {
    await server?.stop();
    ProcessIntegrity.reset();
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'exactly-once-e2e:cleanup' });
  }, 10000);

  it('drops an already-replied redelivery over real HTTP (200 + deduped, not routed)', async () => {
    const resp = await fetch(`http://127.0.0.1:${PORT}/internal/telegram-forward`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH}` },
      body: JSON.stringify({ topicId: TOPIC, text: 'hello again', fromUserId: 1, fromUsername: 't', fromFirstName: 'T', messageId: 99 }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean; deduped?: boolean; reason?: string };
    expect(body.ok).toBe(true);
    expect(body.deduped).toBe(true);
    expect(body.reason).toBe('already-replied');
  });
});

/**
 * Wiring-integrity test for A2A durable delivery (A2A-DURABLE-DELIVERY-SPEC.md).
 *
 * This is the test that would have caught the production bug cross-perspective
 * review found: the unit/integration tests called the tracker methods directly
 * with matching fingerprints, so the green suite hid the fact that the inbound
 * accept point keyed the ack by the wrong identifier and the implicit-ack never
 * fired end-to-end. This drives a REAL POST /messages/relay-agent round-trip
 * through AgentServer and asserts that an inbound "reply on a thread" actually
 * flips a pre-recorded outbound message from awaiting-ack → acked (the wiring),
 * and bumps the peer's inbound-liveness clock.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { MessageStore } from '../../src/messaging/MessageStore.js';
import { MessageFormatter } from '../../src/messaging/MessageFormatter.js';
import { MessageDelivery } from '../../src/messaging/MessageDelivery.js';
import { MessageRouter } from '../../src/messaging/MessageRouter.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import { generateAgentToken, deleteAgentToken } from '../../src/messaging/AgentTokenManager.js';
import { A2ADeliveryTracker } from '../../src/threadline/A2ADeliveryTracker.js';
import type { InstarConfig } from '../../src/core/types.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

describe('A2A delivery wiring (relay-agent round-trip flips awaiting-ack → acked)', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  let tracker: A2ADeliveryTracker;
  let agentToken: string;
  const PROJECT = 'test-a2a-wiring-project';
  const PEER_FP = '8c7928aa9f04fbda947172a2f9b2d81a';
  const THREAD = 'th-wire-1';

  beforeAll(async () => {
    project = createTempProject();
    mockSM = createMockSessionManager();

    const messagingDir = path.join(project.stateDir, 'messages');
    fs.mkdirSync(messagingDir, { recursive: true });
    const messageStore = new MessageStore(messagingDir);
    await messageStore.initialize();
    const formatter = new MessageFormatter();
    const mockTmux = {
      getForegroundProcess: () => 'bash',
      isSessionAlive: () => true,
      hasActiveHumanInput: () => false,
      sendKeys: () => true,
      getOutputLineCount: () => 100,
    };
    const delivery = new MessageDelivery(formatter, mockTmux as any);
    const messageRouter = new MessageRouter(messageStore, delivery, {
      localAgent: PROJECT, localMachine: 'test-machine', serverUrl: 'http://localhost:0',
    });

    // A real tracker, INJECTED — we assert on this exact instance after the round-trip.
    tracker = A2ADeliveryTracker.openMemory();
    // Pre-record an outbound message awaiting ack on THREAD, keyed by the peer's
    // FINGERPRINT (as the real send path does).
    tracker.recordSent({ messageId: 'm-out-1', peerFp: PEER_FP, threadId: THREAD, transport: 'relay' });

    const config: InstarConfig = {
      projectName: PROJECT, projectDir: project.dir, stateDir: project.stateDir, port: 0,
      authToken: 'test-auth-a2a-wiring', requestTimeoutMs: 5000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {}, users: [],
    } as InstarConfig;
    agentToken = generateAgentToken(config.projectName);

    server = new AgentServer({
      config, sessionManager: mockSM as any, state: project.state,
      messageRouter, a2aDeliveryTracker: tracker,
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    deleteAgentToken(PROJECT);
    tracker?.close();
  });

  it('an inbound reply on the thread flips the pre-recorded outbound message to acked', async () => {
    expect(tracker.get('m-out-1')!.state).toBe('awaiting-ack'); // precondition

    const res = await request(app)
      .post('/messages/relay-agent')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({
        schemaVersion: 1,
        message: {
          id: `reply-${crypto.randomUUID()}`,
          from: { agent: 'dawn', session: 'dawn-session', machine: 'dawn-machine' },
          to: { agent: PROJECT, session: 'best', machine: 'local' },
          type: 'info', priority: 'medium',
          subject: 'Re: your message', body: 'Got it, thanks.',
          threadId: THREAD,
          createdAt: new Date().toISOString(), ttlMinutes: 30,
        },
        transport: { relayChain: ['dawn-machine'], originServer: 'http://dawn:3000', nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`, timestamp: new Date().toISOString() },
        delivery: { phase: 'sent', transitions: [], attempts: 0 },
      })
      .expect(200);
    expect(res.body.ok).toBe(true);

    // THE WIRING ASSERTION: the route actually invoked recordAckByThread.
    expect(tracker.get('m-out-1')!.state).toBe('acked');
  });

  it('the same round-trip bumped the peer inbound-liveness clock', async () => {
    // peerHealth keyed by the same fingerprint must now show inbound activity.
    // (Liveness resolves the thread owner; with no threadResumeMap entry it falls
    // back to the sender name 'dawn' — assert via the all-peers list which surfaces
    // whichever key was recorded, proving recordInboundFrom fired.)
    const all = tracker.allPeerHealth();
    const sawInbound = all.some((p) => p.lastInboundAt !== null);
    expect(sawInbound).toBe(true);
  });
});

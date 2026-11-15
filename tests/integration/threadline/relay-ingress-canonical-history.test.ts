/**
 * Integration (Tier 2) — a relay-socket inbound recorded through the shared
 * `recordRelayIngressHistory` step is readable over the REAL history routes
 * (`GET /threadline/threads/:id`, `GET /messages/thread/:threadId`), including a
 * >8 KiB body resolved from the real MessageStore backing — not an empty row.
 * Real ThreadLog + ConversationStore + MessageStore, composed by the SAME
 * production factory server.ts calls (createThreadMessageRecorder, with the
 * peer-contact hook), and each inbound goes through the same shared handler
 * step (classifyRelayIngress → recordGatePassedIngress).
 */

// canonical-migration-validator: threadline-inbound-canonical-store@4
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../../src/server/routes.js';
import { ThreadLog } from '../../../src/threadline/ThreadLog.js';
import { ConversationStore } from '../../../src/threadline/ConversationStore.js';
import type { ThreadMessageRecorder } from '../../../src/threadline/recordThreadMessage.js';
import { createThreadMessageRecorder } from '../../../src/threadline/createThreadMessageRecorder.js';
import { classifyRelayIngress, recordGatePassedIngress } from '../../../src/threadline/relayIngressHistory.js';
import { MessageStore } from '../../../src/messaging/MessageStore.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const AUTH = 'test-bearer-token';
const PEER = 'c'.repeat(32);
const BIG = 'y'.repeat(10_000) + ' tail-marker';
let dir: string;
let app: express.Express;
let recorder: ThreadMessageRecorder;
let contacts: string[];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ingress-routes-'));
  const threadLog = new ThreadLog(dir);
  const conversationStore = new ConversationStore(dir);
  const messageStore = new MessageStore(path.join(dir, 'messages'));
  await messageStore.initialize();
  contacts = [];
  recorder = createThreadMessageRecorder({ config: { stateDir: dir }, threadLog, conversationStore, messageStore, onContact: (p) => contacts.push(p) });
  const ctx: any = {
    config: { authToken: AUTH, stateDir: dir, port: 0, projectName: 'echo' },
    stateDir: dir, threadLog, threadMessageRecorder: recorder, conversationStore,
    messageRouter: null, listenerManager: null, telegram: null, coordinator: null, getInboundQueue: () => null,
  };
  app = express();
  app.use(express.json());
  app.use(createRoutes(ctx));
});
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/threadline/relay-ingress-canonical-history.test.ts' }); });

function relayInbound(threadId: string, messageId: string | undefined, text: string, timestamp?: string, timestampSynthesized?: true) {
  const message = { from: PEER, threadId, messageId, timestamp, ...(timestampSynthesized ? { timestampSynthesized } : {}), content: { content: text, type: 'chat' } };
  return recordGatePassedIngress(recorder, { reason: 'relay-authenticated', message }, classifyRelayIngress(message), 'auto-unused');
}

describe('relay-socket inbound → canonical history routes', () => {
  it('an inbound (small and >8 KiB) next to outbound legs reads back over GET /threadline/threads/:id with bodies resolved', async () => {
    const t = 'thread-relay-hist';
    recorder.record({ threadId: t, messageId: 'out-1', direction: 'outbound', body: 'hello peer', createdAt: '2026-11-10T00:00:01.000Z', peerFingerprint: PEER });
    expect(relayInbound(t, 'in-1', 'short reply', '2026-11-10T00:00:02.000Z').status).toBe('appended');
    expect(relayInbound(t, 'in-2', BIG, '2026-11-10T00:00:03.000Z').status).toBe('appended');
    const res = await request(app).get(`/threadline/threads/${t}`).set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body.messageCount).toBe(3);
    const inbound = res.body.entries.filter((e: any) => e.direction === 'inbound');
    expect(inbound.map((e: any) => [e.messageId, e.createdAt, e.peerFingerprint])).toEqual([
      ['in-1', '2026-11-10T00:00:02.000Z', PEER],
      ['in-2', '2026-11-10T00:00:03.000Z', PEER],
    ]);
    expect(inbound[0].body).toBe('short reply');
    expect(inbound[1].body).toBe(BIG); // recovered from the MessageStore backing, not a null row
  });

  it('the legacy aggregate-shaped read (GET /messages/thread/:threadId) also returns the full large body', async () => {
    const t = 'thread-relay-agg';
    relayInbound(t, 'in-big', BIG, '2026-11-10T00:00:05.000Z');
    const res = await request(app).get(`/messages/thread/${t}`).set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body.thread.source).toBe('canonical-log');
    expect(res.body.messages[0].message.body).toBe(BIG);
    expect(res.body.messages[0].message.from.agent).toBe(PEER);
  });

  it('a legacy inbound whose timestamp the bootstrap synthesized reads back as receive time, and a redelivery adds no row', async () => {
    const t = 'thread-relay-legacy';
    // As the unknown-sender bootstrap delivers a timestamp-less, id-less envelope: filled in + marked.
    expect(relayInbound(t, undefined, 'old sender', '2026-11-10T00:00:07.000Z', true).status).toBe('appended');
    expect(relayInbound(t, undefined, 'old sender', '2026-11-10T00:00:19.000Z', true).status).toBe('duplicate');
    const res = await request(app).get(`/threadline/threads/${t}`).set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0]).toMatchObject({ body: 'old sender', createdAt: '2026-11-10T00:00:07.000Z', createdAtSource: 'receive-time' });
    expect(res.body.entries[0].messageId).toMatch(/^legacy-[0-9a-f]{40}$/);
  });

  it('an ack the ack stage consumes is not served as history; the contact hook fired once per new leg', async () => {
    const t = 'thread-relay-ack';
    relayInbound(t, 'in-a', 'real message', '2026-11-10T00:00:08.000Z');
    const ack = { from: PEER, threadId: t, messageId: 'in-ack', timestamp: '2026-11-10T00:00:09.000Z', content: { content: 'Message received. Composing response...', type: 'ack' } };
    expect(recordGatePassedIngress(recorder, { message: ack }, classifyRelayIngress(ack), 'auto-unused')).toEqual({ status: 'excluded', reason: 'ack' });
    const res = await request(app).get(`/threadline/threads/${t}`).set('Authorization', `Bearer ${AUTH}`);
    expect(res.body.entries.map((e: any) => e.messageId)).toEqual(['in-a']);
    expect(contacts).toEqual([PEER]);
  });
});

/**
 * An ack is never acked — E2E "feature is alive" tier
 * (docs/specs/a2a-ack-never-acked.md).
 *
 * Production path, nothing mocked on the wire:
 *  - a real in-repo RelayServer;
 *  - two agents booted with the real `bootstrapThreadline` (real identities,
 *    real relay clients, the real unknown-sender decode that turns a plaintext
 *    envelope into a `gate-passed` decision);
 *  - each agent's `gate-passed` consumer is the production composition
 *    (`runRelayInboundWithLedger` → `runRelayAckStage` → warrants gate → router),
 *    answering through the real `ThreadlineClient.sendAck`.
 *
 * ONE message is sent from A to B. Then: B sends exactly one ack, A sends none,
 * exactly one session is spawned in total, and A's record of the ack is a
 * terminal `no-reply` row plus a recorded delivery.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import { bootstrapThreadline } from '../../../src/threadline/ThreadlineBootstrap.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { createRelayAckNode, type RelayAckNode } from '../../helpers/relayAckNode.js';

const waitFor = async (cond: () => boolean, ms = 10_000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 50));
  }
};
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Boot = Awaited<ReturnType<typeof bootstrapThreadline>>;

describe('an ack is never acked — production relay path', () => {
  let relay: RelayServer;
  let tmp: string;
  let bootA: Boot;
  let bootB: Boot;
  let nodeA: RelayAckNode;
  let nodeB: RelayAckNode;
  let fpA = '';
  let fpB = '';
  /** Every plaintext frame each agent received, with its wire type. */
  const seen: Record<'A' | 'B', Array<{ type: unknown; text: string }>> = { A: [], B: [] };

  async function boot(name: string): Promise<{ boot: Boot; stateDir: string }> {
    const stateDir = path.join(tmp, name, 'state');
    const projectDir = path.join(tmp, name, 'project');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    const kp = generateIdentityKeyPair();
    fs.writeFileSync(path.join(stateDir, 'identity.json'), JSON.stringify({
      publicKey: kp.publicKey.toString('base64'), privateKey: kp.privateKey.toString('base64'),
      privateKeyEncryption: 'none', createdAt: new Date().toISOString(),
    }));
    const relayUrl = `ws://127.0.0.1:${relay.address!.port}/v1/connect`;
    const b = await bootstrapThreadline({ agentName: name, stateDir, projectDir, port: 4040, relayEnabled: true, relayUrl });
    expect(b.relayClient?.connectionState).toBe('connected');
    return { boot: b, stateDir };
  }

  function attach(which: 'A' | 'B', b: Boot, stateDir: string): RelayAckNode {
    const client = b.relayClient!;
    const node = createRelayAckNode({
      stateDir,
      wire: {
        sendAck: (to, text, threadId) => client.sendAck(to, text, threadId),
        sendPlaintext: (to, text, threadId) => client.sendPlaintext(to, text, threadId),
      },
    });
    client.on('gate-passed', (decision) => {
      const c = decision?.message?.content as { content?: string; type?: unknown } | undefined;
      seen[which].push({ type: c?.type, text: String(c?.content ?? '') });
      void node.handle(decision);
    });
    return node;
  }

  beforeAll(async () => {
    relay = new RelayServer({
      port: 0,
      rateLimitConfig: { perAgentPerMinute: 1000, perAgentPerHour: 10000, perIPPerMinute: 10000, globalPerMinute: 50000, discoveryPerMinute: 100, authAttemptsPerMinute: 100 },
      abuseDetectorConfig: { sybilFirstHourLimit: 10000, sybilSecondHourLimit: 10000, spamUniqueRecipientsPerMinute: 10000 },
    });
    await relay.start();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ack-alive-'));
    const a = await boot(`ack-agent-a-${process.pid}`);
    const b = await boot(`ack-agent-b-${process.pid}`);
    bootA = a.boot;
    bootB = b.boot;
    fpA = bootA.relayClient!.fingerprint!;
    fpB = bootB.relayClient!.fingerprint!;
    nodeA = attach('A', bootA, a.stateDir);
    nodeB = attach('B', bootB, b.stateDir);
  }, 30_000);

  afterAll(async () => {
    nodeA?.close();
    nodeB?.close();
    await bootA?.shutdown();
    await bootB?.shutdown();
    await relay.stop();
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/e2e/threadline/ack-never-acked-alive.test.ts' });
  });

  it('ONE message over a real relay: one ack back, no ack of the ack, one session in total', async () => {
    const threadId = `thread-ack-${Date.now()}`;
    const text = 'Please review the relay reconnect patch and tell me what you find';
    // A starts the thread and tracks its own send, as the relay-send route does.
    const sentId = bootA.relayClient!.sendPlaintext(fpB, text, threadId);
    nodeA.tracker.recordSent({ messageId: sentId, peerFp: fpB, threadId });

    // B receives the message, answers it (one session) and acks it; A receives the ack.
    await waitFor(() => nodeB.routed.length === 1);
    await waitFor(() => seen.A.length === 1);
    await waitFor(() => nodeA.tracker.get(sentId)?.state === 'acked');
    // Give a loop every chance to show itself (the pre-fix handlers needed well
    // under a second to trade ten acks on a local relay).
    await settle(1500);

    // The wire: A saw exactly one frame — B's ack, typed `ack`. B saw exactly one — the message.
    expect(seen.B).toEqual([{ type: 'chat', text }]);
    expect(seen.A).toHaveLength(1);
    expect(seen.A[0].type).toBe('ack');

    // Each side sends at most one ack.
    expect(nodeB.acksSent).toEqual([{ to: fpA, threadId }]);
    expect(nodeA.acksSent).toHaveLength(0);

    // At most one session in total; the ack never reached a gate or a router.
    expect(nodeB.routed).toHaveLength(1);
    expect(nodeA.routed).toHaveLength(0);
    expect(nodeA.gated).toHaveLength(0);
    expect(nodeA.routed.length + nodeB.routed.length).toBe(1);

    // The ack only recorded delivery: tracker acked, ledger row terminal no-reply.
    expect(nodeA.tracker.pending(fpB)).toHaveLength(0);
    const db = (nodeA.ledger as unknown as { db: { prepare(q: string): { all(): Array<{ disposition: string; thread_id: string; ingress: string }> } } }).db;
    expect(db.prepare('SELECT disposition, thread_id, ingress FROM inbound_message_ids').all()).toEqual([
      { disposition: 'no-reply', thread_id: threadId, ingress: 'relay-unknown-sender' },
    ]);
  });
});

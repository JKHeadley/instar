/**
 * ACT-1304 fault 3 (reported by Luna/sagemind, 2026-10-04): a send with no
 * explicit threadId returned the MESSAGE id ("msg-…") where the thread id
 * belonged. The peer replied on the wire thread ("thread-…"), so the sender
 * waited on a thread nobody answered and the reply cold-spawned instead.
 *
 * `sendAutoWithThread` returns the threadId that actually went on the wire,
 * for both the encrypted and the plaintext path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ThreadlineClient } from '../../src/threadline/client/ThreadlineClient.js';

interface Sent { threadId: string; messageId: string }

describe('ThreadlineClient.sendAutoWithThread', () => {
  let client: ThreadlineClient;
  let sent: Sent[];

  beforeEach(() => {
    sent = [];
    client = new ThreadlineClient({ name: 'TestAgent', stateDir: '/tmp/wire-thread-test' }, () => 1_791_144_650_402);
    const internals = client as unknown as Record<string, unknown>;
    internals.relayClient = { sendMessage: (envelope: Sent) => { sent.push(envelope); } };
    internals.identity = { fingerprint: 'self-fp' };
    internals.encryptor = {
      encrypt: (_pk: string, _xk: string, threadId: string) => ({ threadId, messageId: `msg-enc-${sent.length + 1}` }),
    };
  });

  it('plaintext path: returns the minted wire thread id, not the message id', () => {
    const { messageId, threadId } = client.sendAutoWithThread('peer-without-keys', 'hello');
    expect(sent).toHaveLength(1);
    expect(threadId).toBe(sent[0].threadId);
    expect(threadId).toMatch(/^thread-/);
    expect(messageId).toBe(sent[0].messageId);
    expect(threadId).not.toBe(messageId);
  });

  it('encrypted path: returns the wire thread id, and reuses it through client affinity', () => {
    (client as unknown as { knownAgents: Map<string, unknown> }).knownAgents.set('peer-with-keys', {
      publicKey: 'pk', x25519PublicKey: 'xk',
    });
    const first = client.sendAutoWithThread('peer-with-keys', 'one');
    const second = client.sendAutoWithThread('peer-with-keys', 'two');
    expect(first.threadId).toBe(sent[0].threadId);
    expect(first.threadId).toMatch(/^thread-/);
    expect(first.threadId).not.toBe(first.messageId);
    expect(second.threadId).toBe(first.threadId);
  });

  it('an explicit threadId is used on the wire and returned unchanged', () => {
    const result = client.sendAutoWithThread('peer-without-keys', 'hi', 'thread-explicit-1');
    expect(sent[0].threadId).toBe('thread-explicit-1');
    expect(result.threadId).toBe('thread-explicit-1');
  });
});

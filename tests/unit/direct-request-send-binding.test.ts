import { TelegramSendEvidenceStore } from '../../src/threadline/TelegramSendEvidenceStore.js';
import { exactDirectTelegramPollingSend } from '../../src/threadline/directTelegramSendEvidence.js';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { DirectRequestSendClaims } from '../../src/threadline/DirectRequestSendClaims.js';
import { describe, expect, it } from 'vitest';
import { directRequestSendBinding, type ExactDirectRequestSend } from '../../src/threadline/directRequestSendBinding.js';

const H = (c: string) => c.repeat(64);
const input: ExactDirectRequestSend = {
  agentId: 'fixture-agent', ownerKey: 'fixture-owner', authorityEpoch: 'epoch-2', ownerMessageRef: 'telegram:42:11',
  ownerEvidenceDigest: H('a'), senderFingerprint: 'a'.repeat(32), recipientFingerprint: 'b'.repeat(32),
  threadId: 'fixture-thread', inReplyTo: null, deliveryId: 'fixture-send', message: 'The exact approved fixture is ready.',
  attachments: [], expiresAt: 1795586730000,
};

describe('dark direct-request send binding', () => {
  it('distinguishes changed content, destination, authorization and execution identity', () => {
    const binding = directRequestSendBinding(input);
    expect(binding).toMatch(/^[a-f0-9]{64}$/);
    expect(directRequestSendBinding({ ...input })).toBe(binding);
    for (const patch of [
      { message: input.message + ' ' }, { recipientFingerprint: 'f'.repeat(32) }, { threadId: 'other-thread' }, { inReplyTo: 'prior-message' },
      { deliveryId: 'different-send' }, { ownerEvidenceDigest: H('f') }, { ownerMessageRef: 'telegram:42:12' },
      { authorityEpoch: 'epoch-3' }, { expiresAt: input.expiresAt + 1 },
    ]) {
      expect(directRequestSendBinding({ ...input, ...patch })).not.toBe(binding);
    }
  });

  it('refuses unresolved routing, attachments and malformed wire text', () => {
    expect(directRequestSendBinding({ ...input, recipientFingerprint: 'agent-name' })).toBeNull();
    expect(directRequestSendBinding({ ...input, threadId: '' })).toBeNull();
    expect(directRequestSendBinding({ ...input, attachments: [{ digest: H('d'), bytes: 1 }] } as unknown as ExactDirectRequestSend)).toBeNull();
    expect(directRequestSendBinding({ ...input, message: '\ud800' })).toBeNull();
    expect(directRequestSendBinding({ ...input, message: '�' })).not.toBeNull();
  });
});

it('reserves one attempt across independent connections and process reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'direct-send-'));
  const filename = join(dir, 'claims.sqlite');
  const first = new Database(filename);
  const second = new Database(filename);
  try {
    const writer = new DirectRequestSendClaims(first);
    const other = new DirectRequestSendClaims(second);
    const beforeExpiry = input.expiresAt - 1;
    const polling = {
      raw: {
        message_id: 11, message_thread_id: 42, is_topic_message: true, date: 1795586700,
        from: { id: 75, is_bot: false }, chat: { id: -10001, type: 'supergroup' },
        text: `Send via Threadline to ${input.recipientFingerprint}:\n${input.message}`,
      },
      botAccountId: 248, ownerId: 75,
    };
    const proof = exactDirectTelegramPollingSend(polling.raw, polling.botAccountId, polling.ownerId)!;
    const send = { ...input, ...proof };
    const evidence = new TelegramSendEvidenceStore(second);
    expect(writer.reserve(send, polling, beforeExpiry)).toEqual({ status: 'refused' });
    expect(evidence.capture(proof.ownerMessageRef, proof.ownerEvidenceDigest)).toBe('recorded');
    expect(writer.reserve({ ...send, message: 'substituted' }, polling, beforeExpiry)).toEqual({ status: 'refused' });
    expect(writer.reserve({ ...send, deliveryId: 'expired' }, polling, input.expiresAt)).toEqual({ status: 'refused' });
    first.transaction(() => {
      expect(writer.reserve(send, polling, beforeExpiry)).toEqual({ status: 'refused' });
    })();
    expect(writer.reserve(send, polling, beforeExpiry)).toEqual({ status: 'reserved', deliveryId: input.deliveryId });
    expect(other.reserve({ ...send, deliveryId: 'new-id' }, polling, beforeExpiry)).toEqual({ status: 'refused' });
    expect(other.reserve({ ...send, authorityEpoch: 'epoch-3' }, polling, beforeExpiry)).toEqual({ status: 'refused' });
    expect(other.reserve({ ...send, ownerMessageRef: 'another-message' }, polling, beforeExpiry)).toEqual({ status: 'refused' });
    const otherPolling = { ...polling, raw: { ...polling.raw, message_id: 12 } };
    const otherProof = exactDirectTelegramPollingSend(otherPolling.raw, otherPolling.botAccountId, otherPolling.ownerId)!;
    expect(evidence.capture(otherProof.ownerMessageRef, otherProof.ownerEvidenceDigest)).toBe('recorded');
    expect(other.reserve({ ...send, ...otherProof }, otherPolling, beforeExpiry)).toEqual({ status: 'refused' });
    expect(other.reserve({ ...send, ...otherProof, deliveryId: 'other-send' }, otherPolling, beforeExpiry))
      .toEqual({ status: 'reserved', deliveryId: 'other-send' });
    first.close();
    second.close();
    const reopened = new Database(filename);
    try {
      expect(new DirectRequestSendClaims(reopened).reserve(send, polling, input.expiresAt + 1))
        .toEqual({ status: 'already-reserved', deliveryId: input.deliveryId });
      new TelegramSendEvidenceStore(reopened).capture(proof.ownerMessageRef, H('f'));
      expect(new DirectRequestSendClaims(reopened).reserve(send, polling, beforeExpiry)).toEqual({ status: 'refused' });
    } finally {
      reopened.close();
    }
  } finally {
    if (first.open) first.close();
    if (second.open) second.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'direct-request send test cleanup' });
  }
});

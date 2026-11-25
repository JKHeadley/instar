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

/**
 * The pairing handshake's ops (docs/specs/a2a-pairing-invite-link.md §11.2) are control messages:
 * with verified pairing ON they go to the invite engine, with it OFF they are dropped. Never routed
 * to a session as ordinary text, even from a fully trusted peer.
 */
import { describe, it, expect, vi } from 'vitest';
import { InboundMessageGate } from '../../src/threadline/InboundMessageGate.js';
import type { ReceivedMessage } from '../../src/threadline/client/ThreadlineClient.js';

const trusted = () => ({
  getTrustLevelByFingerprint: vi.fn().mockReturnValue('trusted'),
  getAllowedOperationsByFingerprint: vi.fn().mockReturnValue(['message', 'query', 'request']),
  recordMessageReceivedByFingerprint: vi.fn(),
});
const msg = (type: string): ReceivedMessage => ({
  from: 'ab'.repeat(16), threadId: 't', timestamp: Date.now(),
  content: { type, content: type, iid: 'cd'.repeat(16), nonce: 'ef'.repeat(16), sig: '00' },
} as unknown as ReceivedMessage);

describe('InboundMessageGate — pairing handshake ops', () => {
  for (const op of ['pair-invite-received', 'pair-invite-refused', 'pair-invite-hello']) {
    it(`${op}: pairing OFF → dropped as control, never passed on`, async () => {
      const onInviteControl = vi.fn();
      const gate = new InboundMessageGate(trusted() as never, {} as never, { onInviteControl, getVerifiedPairingConfig: () => ({ enabled: false, dryRun: false, credentialShareEnforced: false }) });
      const d = await gate.evaluate(msg(op));
      expect(d).toMatchObject({ action: 'block', controlPlane: true });
      expect(onInviteControl).not.toHaveBeenCalled();
    });

    it(`${op}: pairing ON → handed to the invite engine, never passed on`, async () => {
      const onInviteControl = vi.fn();
      const gate = new InboundMessageGate(trusted() as never, {} as never, { onInviteControl, getVerifiedPairingConfig: () => ({ enabled: true, dryRun: true, credentialShareEnforced: false }) });
      const d = await gate.evaluate(msg(op));
      expect(d).toMatchObject({ action: 'block', controlPlane: true });
      expect(onInviteControl).toHaveBeenCalledWith(op, 'ab'.repeat(16), expect.any(Object));
    });
  }

  it('control: an ordinary message from the same trusted peer still passes', async () => {
    const gate = new InboundMessageGate(trusted() as never, {} as never, { getVerifiedPairingConfig: () => ({ enabled: false, dryRun: false, credentialShareEnforced: false }) });
    expect((await gate.evaluate(msg('message'))).action).toBe('pass');
  });
});

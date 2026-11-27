/**
 * The owner's own checks on a forward (app-conversations-in-the-pool §2.4), and the wiring of the drain.
 * The behaviour through real team phones is in tests/integration/team-access-guards.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDeliverMessageHandler } from '../../src/core/DeliverMessageHandler.js';
import { DEVICE_ALLOWLIST } from '../../src/server/mobilePairingRoutes.js';

const SESSION = 'app:0f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f';

function handler(isApp: boolean) {
  const accepted = vi.fn();
  const rejected = vi.fn();
  const h = createDeliverMessageHandler({
    ownerEpochOf: () => null,
    recordReceipt: () => true,
    onAccepted: accepted,
    onRejected: rejected,
    validateSender: () => true,
    app: { isApp: () => isApp, urgentAccepted: () => false, canTake: () => true, ingest: () => true },
  });
  return { h, accepted, rejected };
}
const command = (extra: Record<string, unknown> = {}) => ({ type: 'deliverMessage', session: SESSION, messageId: 'm1', payload: {}, ownershipEpoch: 1, ...extra }) as never;

describe('an app forward with no sender envelope', () => {
  it('is rejected before any receipt, and leaves a trace', () => {
    const { h, accepted, rejected } = handler(true);
    expect((h(command(), 'peer') as { accepted: string }).accepted).toBe('sender-rejected');
    expect(accepted).not.toHaveBeenCalled();
    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ reason: 'sender-rejected', messageId: 'm1' }));
  });
  it('with its envelope it is taken', () => {
    const { h, accepted } = handler(true);
    expect((h(command({ senderEnvelope: { via: 'mobile-device', deviceId: 'd', eventId: 'e' } }), 'peer') as { accepted: string }).accepted).toBe('queued');
    expect(accepted).toHaveBeenCalledTimes(1);
  });
  it('another platform\'s command keeps today\'s rule', () => {
    const { h } = handler(false);
    expect((h(command({ session: '42' }), 'peer') as { accepted: string }).accepted).not.toBe('sender-rejected');
  });
});

describe('the wiring', () => {
  const server = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf8');
  it('the queue\'s app tail is the tested drain, with no stop of its own', () => {
    expect(server).toMatch(/_appDrainDeliver = createAppDrainDeliver\(/);
    expect(server).not.toMatch(/svc\.emergencyStop\(/);
  });
  it('the placement read names its conversation and stays closed to a team phone', () => {
    const rule = DEVICE_ALLOWLIST.find((r) => r.method === 'GET' && r.re.test('/mobile/conversations/0f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f/placement'));
    expect(rule?.conversationRef).toBe(true);
    expect(rule?.tier).toBe('owner');
  });
});

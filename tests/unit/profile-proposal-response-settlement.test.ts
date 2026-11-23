import { describe, expect, it, vi } from 'vitest';
import { ProfileProposalRequests } from '../../src/core/ProfileProposalRequests.js';
import { ProfileProposalOwnerTurns } from '../../src/core/ProfileProposalOwnerTurns.js';
import type { ProfileRegisteredReplyProof } from '../../src/core/profileProposalResponseSettlement.js';
const binding = { source: '380', principal: 'telegram:7', inboundId: '403' };
function setup(options: { now?: () => number; ttlMs?: () => number; ownerExpiry?: number } = {}) {
  const requests = new ProfileProposalRequests(options);
  const registry = new ProfileProposalOwnerTurns(options);
  const handle = registry.issue(binding, options.ownerExpiry);
  const attempt = requests.begin('380', '381', { framework: 'codex-cli' }, 'Use Codex for the garden.', 'epoch', {
    ownerTurn: { registry, handle, principal: binding.principal, inboundId: binding.inboundId },
  });
  if (!attempt.ok) throw new Error(attempt.reason);
  return { requests, registry, attempt };
}
describe('registered question response settlement', () => {
  it('keeps an unclaimed question receipt separate from any owner-turn fulfillment', () => {
    const requests = new ProfileProposalRequests(); const handler = vi.fn(() => 'recorded' as const);
    requests.setRegisteredReplyHandler(handler);
    const attempt = requests.begin('380', '381', { framework: 'codex-cli' }, 'Use Codex.', 'epoch');
    if (!attempt.ok) throw new Error(attempt.reason);
    expect(attempt.settleRegisteredReply()).toBeNull();
    attempt.onDelivery(406);
    expect(attempt.settleRegisteredReply()).toEqual({ replyAlreadyDelivered: false, replySettlement: { status: 'unbound' } });
    expect(handler).not.toHaveBeenCalled();
  });
  it('offers only the privately claimed original binding after actual active registration', () => {
    const { requests, attempt } = setup(); let proof: ProfileRegisteredReplyProof | undefined;
    const handler = vi.fn((value: ProfileRegisteredReplyProof) => {
      proof = value; expect(requests.ownsRegisteredReplyProof(value)).toBe(true); return 'recorded' as const;
    });
    requests.setRegisteredReplyHandler(handler);
    expect(attempt.settleRegisteredReply()).toBeNull(); attempt.onDelivery(406);
    expect(attempt.settleRegisteredReply()).toEqual({ replyAlreadyDelivered: true, replySettlement: { status: 'recorded' } });
    expect(proof).toMatchObject({ ...binding, deliveredMessageId: 406, requestId: attempt.request.id, attemptId: attempt.attemptId });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(requests.ownsRegisteredReplyProof(JSON.parse(JSON.stringify(proof)))).toBe(false);
    expect(new ProfileProposalRequests().ownsRegisteredReplyProof(proof)).toBe(false);
    expect(JSON.stringify(proof)).not.toContain('reservation');
    attempt.settleRegisteredReply(); expect(handler).toHaveBeenCalledTimes(1);
  });
  it('retains the captured binding after the spent handle expires', () => {
    let now = 0; const { requests, registry, attempt } = setup({ now: () => now, ttlMs: () => 1000, ownerExpiry: 5 });
    const handler = vi.fn(() => 'pending' as const); requests.setRegisteredReplyHandler(handler);
    now = 6; registry.issue({ ...binding, inboundId: '404' }); attempt.onDelivery(406);
    expect(attempt.settleRegisteredReply()).toEqual({ replyAlreadyDelivered: true, replySettlement: { status: 'pending' } });
    expect(handler.mock.calls).toHaveLength(1);
  });
  it('never turns uncertain or invalid native delivery into a settlement proof', () => {
    for (const receipt of [null, 0, -1, Infinity, 1.5]) {
      const { requests, attempt } = setup(); const handler = vi.fn(() => 'recorded' as const); requests.setRegisteredReplyHandler(handler);
      attempt.onDelivery(receipt); expect(attempt.settleRegisteredReply()).toBeNull(); expect(handler).not.toHaveBeenCalled();
    }
  });
  it('does not offer an expired or consumed question as a current response', async () => {
    let now = 0; const expired = setup({ now: () => now, ttlMs: () => 10 }); const h = vi.fn(() => 'recorded' as const);
    expired.requests.setRegisteredReplyHandler(h); expired.attempt.onDelivery(406); now = expired.attempt.request.expiresAt + 1;
    expect(expired.attempt.settleRegisteredReply()).toBeNull(); expect(h).not.toHaveBeenCalled();
    const used = setup(); used.requests.setRegisteredReplyHandler(h); used.attempt.onDelivery(406);
    await used.requests.reply('380', { text: 'yes', messageId: 411, replyTo: 406, forwarded: false }, async () => ({ ok: true, reply: 'Saved.' }));
    expect(used.attempt.settleRegisteredReply()).toBeNull(); expect(h).not.toHaveBeenCalled();
  });
  it('keeps actual registered delivery truthful if the bookkeeping handler is unavailable', () => {
    const { attempt } = setup(); attempt.onDelivery(406);
    expect(attempt.settleRegisteredReply()).toEqual({ replyAlreadyDelivered: true, replySettlement: { status: 'unavailable' } });
  });
  it('does not let bookkeeping failure become transport failure or duplicate a platform send', () => {
    const { requests, attempt } = setup(); const handler = vi.fn(() => { throw new Error('Bookkeeping unavailable'); });
    requests.setRegisteredReplyHandler(handler); attempt.onDelivery(406);
    expect(attempt.settleRegisteredReply()).toEqual({ replyAlreadyDelivered: true, replySettlement: { status: 'unavailable' } });
    expect(requests.get('380', attempt.request.id)?.receipts.map(r => r.messageId)).toEqual([406]);
    attempt.settleRegisteredReply(); expect(handler).toHaveBeenCalledTimes(1);
  });
});

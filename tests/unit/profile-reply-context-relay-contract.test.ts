/** Contract/data regressions. These tests do not simulate or certify model behavior. */
import fs from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { ProfileProposalRequests } from '../../src/core/ProfileProposalRequests.js';
import { profileProposalConversationContext } from '../../src/core/handleProfileProposalReply.js';
function prepared(text: string) {
  const requests = new ProfileProposalRequests();
  const send = requests.begin('10', '20', { framework: 'codex-cli' }, 'Move the demo conversation to Codex?', 'epoch-1');
  if (!send.ok) throw Error(send.reason); send.onDelivery(80);
  return { requests, source: '10', text, replyTo: 80, messageId: 81, forwarded: false,
    authenticatedOwner: () => true, eligible: () => true, placement: () => 'epoch-1',
    currentEcho: () => 'Move the demo conversation to Codex?', ownerTurn: { handle: 'server-issued-fixture', inboundId: '81' } };
}
describe('operation-specific question relay context', () => {
  it('keeps mixed independent work intact while actual nonexact consent applies nothing', async () => {
    const text = '1) yes. Also, what is 2 + 2?'; const input = prepared(text);
    const context = profileProposalConversationContext(input); const facts = JSON.parse(context.split('\n')[1]);
    expect(facts.replyFacts).toEqual({ nativeReplyVerified: true, replyToMessageId: 80, inboundMessageId: 81, textIsExactYes: false });
    expect(facts.reminder.body).toMatchObject({ remindRequestId: input.requests.list('10')[0].id,
      ownerTurnHandle: 'server-issued-fixture', ownerTurnInboundId: '81' });
    const apply = vi.fn(async () => ({ ok: true, reply: 'Saved.' }));
    const result = await input.requests.reply('10', { text, messageId: 81, replyTo: 80, forwarded: false }, apply);
    expect(result.matched).toBe(false); expect(apply).not.toHaveBeenCalled();
    expect(input.text).toBe(text); expect(input.requests.list('10')).toHaveLength(1);
    expect(input.requests.list('10')[0].consumed).toBe(false);
  });
  it.each(['1) yes', '> Move the demo conversation to Codex?\nyes'])('supplies one real registered operation for %j without widening consent', async text => {
    const input = prepared(text); const data = JSON.parse(profileProposalConversationContext(input).split('\n')[1]);
    expect(data.replyFacts.nativeReplyVerified).toBe(true); expect(data.replyFacts.textIsExactYes).toBe(false);
    expect(data.reminder.method).toBe('POST'); expect(data.reminder.body.remindRequestId).toBe(input.requests.list('10')[0].id);
    const apply = vi.fn(async () => ({ ok: true, reply: 'Saved.' }));
    expect((await input.requests.reply('10', { text, messageId: 81, replyTo: 80, forwarded: false }, apply)).matched).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });
  it('ships awareness of pending bookkeeping, false/no-handle relay and independent mixed-content work', () => {
    const awareness = fs.readFileSync('src/data/awareness/profile-reply-context-followup.md', 'utf8');
    expect(awareness).toContain('replySettlement.status');
    expect(awareness).toContain('replyAlreadyDelivered:false');
    expect(awareness).toContain('2 + 2');
    expect(awareness).toContain('registered reminder');
    expect(awareness).toContain('registered reminder AND answer 4');
    expect(awareness).toContain("fulfills ONLY this registered approval question's relay requirement");
    expect(awareness).toContain('unrelated work');
  });
});

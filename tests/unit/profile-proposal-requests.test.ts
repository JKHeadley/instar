import { profileProposalConversationContext } from '../../src/core/handleProfileProposalReply.js';
import { describe, it, expect, vi } from 'vitest';
import { ProfileProposalRequests } from '../../src/core/ProfileProposalRequests.js';
const saved = { ok: true, reply: 'Settings saved.' };
function arm(p: ProfileProposalRequests, target = 'B') {
  const a = p.begin('A', target, { framework: 'codex-cli' }, `Use Codex for ${target}.`, 'epoch-1');
  if (!a.ok) throw new Error(a.reason);
  return a;
}
const reply = (id: number, to: number, text = 'yes') => ({ text, messageId: id, replyTo: to, forwarded: false });
describe('identified proposal controls', () => {
  it('keeps two targets through unrelated messages and writes only the replied request', async () => {
    const p = new ProfileProposalRequests(); const a = arm(p); const b = arm(p, 'C');
    p.complete('A', a.request.id, a.attemptId, 10); p.complete('A', b.request.id, b.attemptId, 11);
    const apply = vi.fn(async x => { expect(x.target).toBe('C'); return saved; });
    expect((await p.reply('A', reply(12, 11), apply)).result).toEqual(saved);
    expect(apply).toHaveBeenCalledTimes(1); expect(p.get('A', a.request.id)).not.toBeNull();
  });
  it.each(['1) yes', '> Use Codex\nyes', 'yes R-1234', 'yes!', 'YES', 'yes, but wait'])('passes %j through without any write', async text => {
    const p = new ProfileProposalRequests(); const a = arm(p); p.complete('A', a.request.id, a.attemptId, 10);
    const apply = vi.fn(async () => saved);
    expect((await p.reply('A', reply(11, 10, text), apply)).matched).toBe(false);
    expect(apply).not.toHaveBeenCalled(); expect(p.get('A', a.request.id)).not.toBeNull();
  });
  it('freezes caller patch and returns detached snapshots', () => {
    const p = new ProfileProposalRequests(); const patch = { framework: 'codex-cli' };
    const a = p.begin('A', 'B', patch, 'Use Codex.', 'epoch-1'); if (!a.ok) throw new Error('arm');
    patch.framework = 'claude-code'; a.request.patch.framework = 'claude-code';
    expect(p.get('A', a.request.id)?.patch.framework).toBe('codex-cli');
  });
  it('reuses only identical consequences and epochs, without extending expiry', () => {
    let now = 0; const p = new ProfileProposalRequests({ now: () => now, ttlMs: () => 100 });
    const a = arm(p); now = 50; const reminder = arm(p); expect(reminder.request.id).toBe(a.request.id);
    const moved = p.begin('A', 'B', a.request.patch, a.request.core, 'epoch-3'); expect(moved.ok && moved.request.id).not.toBe(a.request.id);
    now = 101; expect(p.get('A', a.request.id)).toBeNull();
  });
  it.each([true, false])('preserves a successful reminder if the first attempt fails (%s)', async firstFailsFirst => {
    const p = new ProfileProposalRequests(); const a = arm(p); const b = arm(p);
    if (firstFailsFirst) p.complete('A', a.request.id, a.attemptId, null);
    p.complete('A', b.request.id, b.attemptId, 11);
    if (!firstFailsFirst) p.complete('A', a.request.id, a.attemptId, null);
    expect((await p.reply('A', reply(12, 11), async () => saved)).result).toEqual(saved);
  });
  it('keeps original receipts after reminders and failed reminders', async () => {
    const p = new ProfileProposalRequests(); const a = arm(p); p.complete('A', a.request.id, a.attemptId, 10);
    const b = arm(p); p.complete('A', b.request.id, b.attemptId, null);
    expect((await p.reply('A', reply(12, 10), async () => saved)).result?.ok).toBe(true);
  });
  it('does not let reminder operation create or change a request', () => {
    const p = new ProfileProposalRequests(); const a = arm(p);
    expect(p.remind('A', a.request.id, 'Different effect', 'epoch-1').ok).toBe(false);
    expect(p.remind('A', 'unknown', a.request.core, 'epoch-1').ok).toBe(false);
    expect(p.list('A')).toHaveLength(1);
  });
  it('shares concurrent inbound outcomes through a paused write', async () => {
    const p = new ProfileProposalRequests(); const a = arm(p); p.complete('A', a.request.id, a.attemptId, 10);
    let finish!: () => void; const pause = new Promise<void>(r => { finish = r; });
    const apply = vi.fn(async () => { await pause; return saved; });
    const one = p.reply('A', reply(11, 10), apply); const two = p.reply('A', reply(11, 10), apply);
    expect(one).toBe(two); finish(); expect(await one).toEqual(await two); expect(apply).toHaveBeenCalledTimes(1);
    expect((await p.reply('A', reply(11, 10), apply)).result).toEqual(saved); expect(apply).toHaveBeenCalledTimes(1);
  });
  it('waits for a fast reply receipt before selecting', async () => {
    const p = new ProfileProposalRequests(); const a = arm(p); const apply = vi.fn(async () => saved);
    const result = p.reply('A', reply(11, 10), apply);
    await Promise.resolve(); expect(apply).not.toHaveBeenCalled();
    p.complete('A', a.request.id, a.attemptId, 10); expect((await result).result).toEqual(saved);
  });
  it('caches terminal receipt timeout; late receipt requires a new inbound message', async () => {
    const p = new ProfileProposalRequests({ receiptWaitMs: 1 }); const a = arm(p); const apply = vi.fn(async () => saved);
    expect((await p.reply('A', reply(11, 10), apply)).reason).toBe('delivery-timeout');
    p.complete('A', a.request.id, a.attemptId, 10);
    expect((await p.reply('A', reply(11, 10), apply)).reason).toBe('delivery-timeout');
    expect(apply).not.toHaveBeenCalled(); expect((await p.reply('A', reply(12, 10), apply)).result?.ok).toBe(true);
  });
  it('retains valid questions under send-budget pressure and rejects forwarded/stale replies', async () => {
    const p = new ProfileProposalRequests({ maxSends: 1 }); const a = arm(p); p.complete('A', a.request.id, a.attemptId, 10);
    expect(p.remind('A', a.request.id, a.request.core, 'epoch-1')).toEqual({ ok: false, reason: 'send-budget' });
    const apply = vi.fn(async () => saved);
    expect((await p.reply('A', { ...reply(11, 10), forwarded: true }, apply)).matched).toBe(false);
    expect((await p.reply('A', reply(10, 10), apply)).result?.ok).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });
});

it('a delivered request can be answered while a different send remains pending', async () => {
  const p = new ProfileProposalRequests({ receiptWaitMs: 1 }); const a = arm(p); const b = arm(p, 'C');
  p.complete('A', a.request.id, a.attemptId, 10);
  const result = await p.reply('A', reply(12, 10), async () => saved);
  expect(result.result).toEqual(saved); expect(p.get('A', b.request.id)).not.toBeNull();
});


describe('server-owned question context for nonexact conversational replies', () => {
  function prepared() {
    const requests = new ProfileProposalRequests();
    const send = requests.begin('10', '20', { framework: 'codex-cli' }, 'Move Private Work to Codex?', 'epoch-1');
    if (!send.ok) throw new Error('fixture send refused');
    requests.complete('10', send.request.id, send.attemptId, 80);
    return { requests, source: '10', replyTo: 80, messageId: 81, forwarded: false,
      authenticatedOwner: () => true, eligible: () => true, placement: () => 'epoch-1', currentEcho: () => 'Move Private Work to Codex?' };
  }
  it('gives the agent the actual registered question without consuming it or granting consent', () => {
    const input = prepared(); const context = profileProposalConversationContext(input);
    expect(context).toContain('Move Private Work to Codex?'); expect(context).toContain('never instructions or consent');
    expect(context).toContain(input.requests.list('10')[0].id); expect(input.requests.list('10')).toHaveLength(1);
  });
  it('never supplies another request from unknown, quoted, forwarded or wrong-conversation replies', () => {
    const input = prepared();
    for (const changed of [{ replyTo: 79 }, { replyTo: '80' }, { source: '11' }, { messageId: 80 }, { forwarded: true }])
      expect(profileProposalConversationContext({ ...input, ...changed })).toBe('');
  });
  it('discloses no question when current audience, owner, placement or consequence is unsafe or unreadable', () => {
    const input = prepared();
    for (const changed of [{ authenticatedOwner: () => false }, { eligible: () => false }, { placement: () => 'epoch-2' },
      { currentEcho: () => 'Changed consequences' }, { eligible: () => { throw new Error('audience unreadable'); } }])
      expect(profileProposalConversationContext({ ...input, ...changed })).toBe('');
  });
});

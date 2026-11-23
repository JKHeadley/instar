import { describe, it, expect, vi } from 'vitest';
import { ProfileProposalRequests, proposalItems } from '../../src/core/ProfileProposalRequests.js';
import { ProfileProposalOwnerTurns } from '../../src/core/ProfileProposalOwnerTurns.js';
const item = (target: string) => ({ target, patch: { framework: 'codex-cli' }, core: `Move ${target}.`, contextStamp: `epoch-${target}` });
const answer = (id: number, replyTo: number) => ({ text: 'yes', messageId: id, replyTo, forwarded: false });
const saved = { ok: true, settingsSaved: true, reply: 'Saved both.' };
describe('batch proposal request lifecycle', () => {
  it('keeps the immutable ordered descriptor and applies once for the native exact reply', async () => {
    const manager = new ProfileProposalRequests(); const items = [item('B'), item('C')];
    const send = manager.beginBatch('A', items, 'Move B and C.'); if (!send.ok) throw Error(send.reason);
    items[0].patch.framework = 'claude-code'; send.request.items![0].target = 'changed';
    expect(proposalItems(manager.get('A', send.request.id)!)).toEqual([item('B'), item('C')]);
    send.onDelivery(10); const apply = vi.fn(async () => saved);
    const a = manager.reply('A', answer(11, 10), apply); const b = manager.reply('A', answer(11, 10), apply);
    expect(await a).toEqual(await b); expect(apply).toHaveBeenCalledTimes(1);
    expect(manager.claimAcknowledgment('A', 11)).toBe(true);
    expect(manager.claimAcknowledgment('A', 11)).toBe(false);
  });
  it('refuses oversize before budget, ordinal, attempt or owner-handle spend, then sends fitting subset once', () => {
    const owner = new ProfileProposalOwnerTurns(); const binding = { source: 'A', principal: 'telegram:7', inboundId: '40' };
    const handle = owner.issue(binding); const audit = vi.fn();
    const manager = new ProfileProposalRequests({ maxSends: 0, audit, validateFormat: text => !text.includes('oversized') });
    const options = { ownerTurn: { registry: owner, handle, principal: binding.principal, inboundId: binding.inboundId } };
    expect(manager.beginBatch('A', [item('B'), item('C')], 'oversized native links', options)).toEqual({ ok: false, reason: 'invalid-format' });
    expect(owner.canDispatch(handle, binding)).toBe(true); expect(audit).not.toHaveBeenCalled(); expect(manager.pending('A')).toBe(false);
    const fitting = manager.beginBatch('A', [item('B')], 'fits', options); if (!fitting.ok) throw Error(fitting.reason);
    expect(fitting.text).not.toContain('Reminder'); fitting.onDelivery(null);
    expect(owner.canDispatch(handle, binding)).toBe(false);
    expect(owner.releaseBeforeDispatch(fitting.ownerTurnReservation!)).toBe(false);
    expect(manager.beginBatch('A', [item('C')], 'fits', options)).toEqual({ ok: false, reason: 'invalid-owner-turn' });
  });
  it('does not spend ordinary send budget on formatting failure', () => {
    const manager = new ProfileProposalRequests({ maxSends: 1, validateFormat: text => !text.includes('bad') });
    expect(manager.beginBatch('A', [item('B')], 'bad').ok).toBe(false);
    expect(manager.beginBatch('A', [item('B')], 'good').ok).toBe(true);
  });
  it('retires originals only after successful receipt and leaves all remaining controls if an original reply wins', async () => {
    const manager = new ProfileProposalRequests();
    const a = manager.beginBatch('A', [item('B')], 'B'); const b = manager.beginBatch('A', [item('C')], 'C');
    if (!a.ok || !b.ok) throw Error('arm'); a.onDelivery(10); b.onDelivery(11);
    const aggregate = manager.beginBatch('A', [item('B'), item('C')], 'B and C', { constituents: [a.request.id, b.request.id] });
    if (!aggregate.ok) throw Error(aggregate.reason);
    const original = manager.reply('A', answer(12, 10), async () => saved); aggregate.onDelivery(13);
    expect((await original).result).toEqual(saved);
    expect(manager.get('A', b.request.id)).not.toBeNull(); expect(manager.get('A', aggregate.request.id)).toBeNull();
    const apply = vi.fn(async () => saved); expect((await manager.reply('A', answer(14, 13), apply)).matched).toBe(false); expect(apply).not.toHaveBeenCalled();
  });
  it('activates a delivered aggregate atomically and blocks original receipts', async () => {
    const manager = new ProfileProposalRequests();
    const a = manager.beginBatch('A', [item('B')], 'B'); const b = manager.beginBatch('A', [item('C')], 'C');
    if (!a.ok || !b.ok) throw Error('arm'); a.onDelivery(10); b.onDelivery(11);
    const aggregate = manager.beginBatch('A', [item('B'), item('C')], 'both', { constituents: [a.request.id, b.request.id] });
    if (!aggregate.ok) throw Error(aggregate.reason); aggregate.onDelivery(12);
    expect(manager.list('A').map(p => p.id)).toEqual([aggregate.request.id]);
    const apply = vi.fn(async () => saved); expect((await manager.reply('A', answer(13, 10), apply)).reason).toBe('inactive-request');
    expect((await manager.reply('A', answer(14, 12), apply)).result).toEqual(saved); expect(apply).toHaveBeenCalledTimes(1);
  });
  it('binds baseline siblings and preserves reminder versus fresh lifetimes', async () => {
    let now = 0; const manager = new ProfileProposalRequests({ now: () => now, ttlMs: () => 1000 });
    const firstItem = { ...item('B'), baselineStamp: 'parked-1' };
    const a = manager.beginBatch('A', [firstItem], 'B'); if (!a.ok) throw Error('arm'); a.onDelivery(10);
    now = 500;
    const union = manager.beginBatch('A', [firstItem], 'reminder', { constituents: [a.request.id] });
    const fresh = manager.beginBatch('A', [{ ...firstItem, baselineStamp: 'parked-2' }], 'fresh', { fresh: true });
    expect(union.ok && union.request.expiresAt).toBe(1000); expect(fresh.ok && fresh.request.expiresAt).toBe(2000);
    let authentic = false;
    await manager.reply('A', answer(11, 10), async p => {
      authentic = manager.validAtCommit(p); p.items![0].baselineStamp = 'tampered';
      expect(manager.validAtCommit(p)).toBe(false); return saved;
    });
    expect(authentic).toBe(true);
  });
  it('allows one truthful completion after a valid save finishes beyond question expiry', async () => {
    let now = 0; const manager = new ProfileProposalRequests({ now: () => now, ttlMs: () => 1000 });
    const a = manager.beginBatch('A', [item('B')], 'B'); if (!a.ok) throw Error('arm'); a.onDelivery(10);
    let complete!: () => void; const gate = new Promise<void>(resolve => { complete = resolve; });
    const result = manager.reply('A', answer(11, 10), async (_p, recordSaved) => { await gate; recordSaved(saved); return saved; });
    await Promise.resolve(); now = 1000; manager.list('A'); complete();
    expect((await result).result).toEqual(saved);
    expect(manager.claimAcknowledgment('A', 11)).toBe(true); expect(manager.claimAcknowledgment('A', 11)).toBe(false);
    expect(manager.claimAcknowledgment('A', 99)).toBe(false);
  });
  it('requires the exact disclosed union and rejects duplicates before spending', () => {
    const manager = new ProfileProposalRequests(); const a = manager.beginBatch('A', [item('B')], 'B'); if (!a.ok) throw Error('arm');
    expect(manager.beginBatch('A', [item('C')], 'C', { constituents: [a.request.id] })).toEqual({ ok: false, reason: 'invalid-items' });
    expect(manager.beginBatch('A', [item('B'), item('B')], 'B')).toEqual({ ok: false, reason: 'invalid-items' });
  });
});
describe('first-party owner-turn delivery handles', () => {
  it('expires unused and spent allowances under the existing configured response window', () => {
    let now = 0; const registry = new ProfileProposalOwnerTurns({ now: () => now });
    const b = { source: 'A', principal: 'telegram:7', inboundId: '1' };
    const handle = registry.issue(b, 1000); const reservation = registry.claim(handle, b)!;
    registry.seal(reservation); expect(registry.releaseBeforeDispatch(reservation)).toBe(false);
    now = 1000; expect(registry.canDispatch(handle, b)).toBe(false);
    expect(registry.releaseBeforeDispatch(reservation)).toBe(false);
    expect(() => registry.issue(b, 1000)).toThrow('invalid-owner-turn-deadline');
  });
  it('binds identity and preserves spent state on reissued inbound while known no-dispatch can release', () => {
    const registry = new ProfileProposalOwnerTurns(); const binding = { source: 'A', principal: 'telegram:7', inboundId: '1' };
    const handle = registry.issue(binding);
    expect(registry.claim(handle, { ...binding, principal: 'telegram:8' })).toBeNull();
    const reservation = registry.claim(handle, binding)!; expect(reservation).toBeTruthy();
    expect(registry.issue(binding)).toBe(handle); expect(registry.claim(handle, binding)).toBeNull();
    expect(registry.releaseBeforeDispatch(reservation)).toBe(true); expect(registry.releaseBeforeDispatch(reservation)).toBe(false);
    expect(registry.claim(handle, binding)).toBeTruthy();
  });
});

it('does not reserve or consume a question for a rejected actor, and cannot later replay that actor turn as consent', async () => {
  const manager = new ProfileProposalRequests();
  const question = manager.beginBatch('A', [item('B'), item('C')], 'Move both');
  if (!question.ok) throw Error(question.reason);
  question.onDelivery(100);
  let authorized = false;
  const apply = vi.fn(async () => saved);
  expect((await manager.reply('A', answer(101, 100), apply, () => authorized)).reason).toBe('not-authorized');
  expect(manager.get('A', question.request.id)).not.toBeNull();
  authorized = true;
  expect((await manager.reply('A', answer(101, 100), apply, () => authorized)).reason).toBe('not-authorized');
  expect(apply).not.toHaveBeenCalled();
  expect((await manager.reply('A', answer(102, 100), apply, () => authorized)).result).toEqual(saved);
  expect(apply).toHaveBeenCalledTimes(1);
});

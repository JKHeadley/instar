import { describe, expect, it } from 'vitest';
import { checkEligibility, type EligibilityInput, type IdentityMap } from '../../../src/core/attribution/recordEligibility.js';

const owner: IdentityMap = (_channel, id) => (id === '7812716706' || id === 'U1' ? 'Justin' : null);
const telegramRow = { messageId: 139097, topicId: 136110, text: 'x', fromUser: true, senderName: 'Justin', telegramUserId: 7812716706, forwarded: false, provenance: 'user' };
const check = (over: Partial<EligibilityInput>) =>
  checkEligibility({ channel: 'telegram', conversation: '136110', row: telegramRow, person: 'Justin', identity: owner, authorship: 'human', ...over });

describe('telegram', () => {
  it('is verified only with provenance, not forwarded, mapped identity and a human verdict', () => {
    expect(check({})).toMatchObject({ eligible: true, strength: 'verified' });
  });

  it('never counts fromUser alone: an agent post through the account has no user provenance', () => {
    expect(check({ row: { ...telegramRow, provenance: 'agent' } })).toEqual({ eligible: false, reason: 'unproven-provenance' });
    expect(check({ row: { ...telegramRow, provenance: undefined } })).toEqual({ eligible: false, reason: 'unproven-provenance' });
  });

  it('refuses a forward, and treats a missing forwarded field as not proven', () => {
    expect(check({ row: { ...telegramRow, forwarded: true } })).toEqual({ eligible: false, reason: 'forwarded' });
    expect(check({ row: { ...telegramRow, forwarded: undefined } })).toEqual({ eligible: false, reason: 'forwarded' });
  });

  it('counts a message sent from the app, as weaker evidence', () => {
    const { forwarded: _dropped, ...noField } = telegramRow;
    expect(check({ row: { ...noField, via: 'mobile-device' } })).toMatchObject({ eligible: true, strength: 'identity-only' });
    expect(check({ row: noField })).toEqual({ eligible: false, reason: 'forwarded' });
  });

  it('refuses rows the join marks as agent or rejected', () => {
    for (const authorship of ['agent-outbound', 'agent-verified', 'rejected'] as const) {
      expect(check({ authorship })).toEqual({ eligible: false, reason: 'agent-authored' });
    }
  });

  it('reports the classification gap as weaker evidence, never as human', () => {
    for (const authorship of ['unclassifiable', 'UNRESOLVED'] as const) {
      expect(check({ authorship })).toMatchObject({ eligible: true, strength: 'logged-unclassified' });
    }
    expect(check({ authorship: undefined })).toMatchObject({ eligible: true, strength: 'logged-unclassified' });
  });

  it('refuses a display name with no mapped identity', () => {
    expect(check({ row: { ...telegramRow, telegramUserId: 999 } })).toEqual({ eligible: false, reason: 'identity-unverified' });
    expect(check({ row: { ...telegramRow, telegramUserId: undefined } })).toEqual({ eligible: false, reason: 'identity-unverified' });
  });

  it('refuses words mapped to somebody else', () => {
    expect(check({ person: 'Dawn' })).toEqual({ eligible: false, reason: 'not-this-person' });
  });

  it('matches the person without regard to case', () => {
    expect(check({ person: 'justin' })).toMatchObject({ eligible: true });
  });
});

describe('channels without provenance', () => {
  const slack = { messageId: '1.5', channelId: 'C1', text: 'x', fromUser: true, senderName: 'Justin', platformUserId: 'U1', platform: 'slack' };

  it('slack passes as identity-only on a mapped id', () => {
    expect(check({ channel: 'slack', row: slack, authorship: undefined })).toMatchObject({ eligible: true, strength: 'identity-only' });
  });

  it('slack refuses a settable display name with an unmapped id', () => {
    expect(check({ channel: 'slack', row: { ...slack, platformUserId: 'U2' } })).toEqual({ eligible: false, reason: 'identity-unverified' });
  });

  it('outbound rows do not count on any of these channels', () => {
    for (const channel of ['slack', 'imessage', 'whatsapp'] as const) {
      expect(check({ channel, row: { ...slack, fromUser: false } })).toEqual({ eligible: false, reason: 'not-inbound' });
    }
  });

  it('app needs the operator role and a mapped sender', () => {
    const identity: IdentityMap = (_c, id) => (id === 'justin' ? 'Justin' : null);
    expect(check({ channel: 'app', identity, row: { role: 'operator', senderPerson: { machineId: 'm1', userId: 'justin' } } })).toMatchObject({ eligible: true });
    expect(check({ channel: 'app', identity, row: { role: 'agent', senderPerson: { machineId: 'm1', userId: 'justin' } } })).toEqual({ eligible: false, reason: 'not-inbound' });
    expect(check({ channel: 'app', identity, row: { role: 'operator' } })).toEqual({ eligible: false, reason: 'identity-unverified' });
  });

  it('threadline credits the peer agent, never a human it relays', () => {
    const identity: IdentityMap = (_c, id) => (id === 'fp-dawn' ? 'Dawn' : null);
    expect(check({ channel: 'threadline', identity, person: 'Dawn', row: { direction: 'inbound', peerFingerprint: 'fp-dawn' } })).toMatchObject({ eligible: true });
    expect(check({ channel: 'threadline', identity, person: 'Justin', row: { direction: 'inbound', peerFingerprint: 'fp-dawn' } })).toEqual({ eligible: false, reason: 'not-this-person' });
  });
});

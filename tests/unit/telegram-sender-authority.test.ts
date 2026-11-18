/**
 * identity-security-piece1e: who a Telegram sender is to this agent.
 */
import { describe, expect, it } from 'vitest';
import { standingMay, telegramSenderStanding } from '../../src/messaging/telegramSenderAuthority.js';

const deps = (o: { owner?: number; list?: Array<number | string>; registered?: number[]; listThrows?: boolean; regThrows?: boolean } = {}) => ({
  ownerId: () => o.owner,
  allowList: () => { if (o.listThrows) throw new Error('unreadable'); return o.list; },
  registeredIds: () => { if (o.regThrows) throw new Error('unreadable'); return o.registered ?? []; },
});

describe('telegramSenderStanding', () => {
  it('the configured owner is the owner, even with an empty list', () => {
    expect(telegramSenderStanding(42, deps({ owner: 42 }))).toBe('owner');
  });
  it('an empty or missing list never means everyone', () => {
    expect(telegramSenderStanding(7, deps({ owner: 42 }))).toBe('stranger');
    expect(telegramSenderStanding(7, deps({ owner: 42, list: [] }))).toBe('stranger');
    expect(telegramSenderStanding(7, deps({}))).toBe('unknown'); // no owner known: never a stranger
  });
  it('the explicit list, a registered person, or an explicit "*" is authorized', () => {
    expect(telegramSenderStanding(7, deps({ list: [7] }))).toBe('authorized');
    expect(telegramSenderStanding('7', deps({ list: [7] }))).toBe('authorized');
    expect(telegramSenderStanding(7, deps({ registered: [7] }))).toBe('authorized');
    expect(telegramSenderStanding(7, deps({ list: ['*'] }))).toBe('authorized');
  });
  it('unreadable evidence is unknown, never a verified stranger; a match elsewhere still counts', () => {
    expect(telegramSenderStanding(7, deps({ listThrows: true }))).toBe('unknown');
    expect(telegramSenderStanding(7, deps({ regThrows: true }))).toBe('unknown');
    expect(telegramSenderStanding(7, deps({ listThrows: true, registered: [7] }))).toBe('authorized');
    expect(telegramSenderStanding(42, deps({ owner: 42, listThrows: true }))).toBe('owner');
  });
  it('a missing or unproven sender id is unknown, never a stranger', () => {
    expect(telegramSenderStanding(undefined, deps({ owner: 42, list: ['*'] }))).toBe('unknown');
    expect(telegramSenderStanding(7, deps({ owner: 42 }), { proven: false })).toBe('unknown');
    expect(telegramSenderStanding(42, deps({ owner: 42 }), { proven: false })).toBe('unknown');
  });
  it('the action table', () => {
    for (const a of ['message', 'command', 'session-control', 'agent-control', 'media'] as const) {
      expect(standingMay('owner', a)).toBe(true);
      expect(standingMay('unknown', a)).toBe(true); // today's handling, never refused for being unknown
      expect(standingMay('stranger', a)).toBe(false);
    }
    expect(standingMay('authorized', 'message')).toBe(true);
    expect(standingMay('authorized', 'agent-control')).toBe(false);
    expect(standingMay('authorized', 'session-control')).toBe(true);
    expect(standingMay('authorized', 'session-control', { viaWildcardOnly: true })).toBe(false);
    expect(standingMay('authorized', 'command', { viaWildcardOnly: true })).toBe(false);
    expect(standingMay('authorized', 'media', { viaWildcardOnly: true })).toBe(true);
  });
});

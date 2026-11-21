/**
 * agent-work-cards-default §8 — the Work Board's production team seams (`workBoardTeamSeams`), the mapping AgentServer
 * attaches from the pairing service: who carries a card (member and admin tiers; a guest does not), an ABSENT log is a
 * team of one (never "unavailable"), only an unreadable log withholds a verdict, and the pass floor's read check goes
 * through the one shared conversation check with the `app:` prefix.
 */
import { describe, it, expect } from 'vitest';
import { workBoardTeamSeams, membershipOf, type WorkBoardTeamSource } from '../../src/server/workBoardTeamSeams.js';
import type { TeamStanding } from '../../src/core/MobilePeople.js';

function source(health: 'absent' | 'ok' | 'unreadable' | null, people: Record<string, TeamStanding>, reads: Set<string> = new Set()): WorkBoardTeamSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    teamLog: () => (health === null ? null : { healthState: () => health }),
    teamStanding: (k) => people[k] ?? null,
    ownerIdentity: () => ({ ownerName: 'Justin', telegramOwnerId: null }),
    mayUse: (p, ref) => { asked.push(`${p.userId}|${ref}`); return reads.has(ref); },
  };
}

describe('workBoardTeamSeams', () => {
  it('member and admin tiers carry cards; a guest, an unknown person and an unknown tier do not', () => {
    expect(membershipOf({ name: 'A', tier: 'member' })).toBe('member');
    expect(membershipOf({ name: 'A', tier: 'admin' })).toBe('member');
    expect(membershipOf({ name: 'A', tier: 'guest' })).toBe('not-a-member');
    expect(membershipOf(null)).toBe('not-a-member');
    const s = workBoardTeamSeams(source('ok', { adriana: { name: 'Adriana', tier: 'member' }, guest: { name: 'G', tier: 'guest' } }));
    expect(s.teamMember('adriana')).toBe('member'); expect(s.teamMember('guest')).toBe('not-a-member'); expect(s.teamMember('zed')).toBe('not-a-member');
  });
  it('no log or an absent log is a team of one; only an unreadable log is unavailable', () => {
    expect(workBoardTeamSeams(source(null, {})).teamMember('adriana')).toBe('not-a-member');
    expect(workBoardTeamSeams(source('absent', { adriana: { name: 'A', tier: 'member' } })).teamMember('adriana')).toBe('not-a-member');
    expect(workBoardTeamSeams(source('unreadable', { adriana: { name: 'A', tier: 'member' } })).teamMember('adriana')).toBe('unavailable');
  });
  it('personMayRead asks the shared check with the app: prefix for a team person; cannot tell without a readable log; a person the log does not know reads nothing', () => {
    const src = source('ok', { adriana: { name: 'Adriana', tier: 'member' } }, new Set(['app:conv-1']));
    const s = workBoardTeamSeams(src);
    expect(s.personMayRead('adriana', 'conv-1')).toBe(true);
    expect(s.personMayRead('adriana', 'conv-2')).toBe(false);
    expect(src.asked).toEqual(['adriana|app:conv-1', 'adriana|app:conv-2']);
    expect(s.personMayRead('zed', 'conv-1')).toBe(false);
    expect(workBoardTeamSeams(source('unreadable', {})).personMayRead('adriana', 'conv-1')).toBeNull();
    expect(workBoardTeamSeams(source('absent', {})).personMayRead('adriana', 'conv-1')).toBeNull();
    expect(workBoardTeamSeams(source(null, {})).personMayRead('adriana', 'conv-1')).toBeNull();
  });
});

/**
 * The console's Who can reach me page (docs/specs/team-roles-and-access.md §3.10): plain headline,
 * a partial pool read never reads as complete, and the page is reachable from the People group.
 */
import { describe, expect, it } from 'vitest';
import { buildReachPage, personRow, reachHeadline, tierWords } from '../../dashboard/console/reach-model.js';
import { GROUPS, NATIVE_PAGES, tabHref } from '../../dashboard/console/nav-model.js';

describe('Who can reach me', () => {
  it('words the headline for one person, several, and anyone', () => {
    expect(reachHeadline({ count: 1, privacyOn: false }).text).toBe('Only you can reach this agent.');
    expect(reachHeadline({ count: 1, privacyOn: false }).tone).toBeUndefined();
    expect(reachHeadline({ count: 3, privacyOn: true }).text).toBe('3 people can reach this agent.');
    expect(reachHeadline({ count: 'anyone', privacyOn: true }).text).toBe('Anyone can reach this agent.');
    const risky = reachHeadline({ count: 2, privacyOn: false });
    expect(risky.text).toBe('2 people can reach this agent.');
    expect(risky.sub).toContain('Memory privacy is off');
    expect(risky.tone).toBe('warn');
  });

  it('never reads a partial pool answer as complete', () => {
    expect(reachHeadline({ count: 2, privacyOn: true, pool: { complete: false } }).sub).toContain('may be incomplete');
    const page = buildReachPage({ ok: true, data: { count: 2, privacyOn: true, people: [], pool: { complete: false, failed: [{ machineId: 'm2' }] } } });
    expect(page.notes).toContain("Couldn't reach a machine with no name yet (for how long is not known); not known whether anything is fixing it.");
  });

  it('labels tiers and the MSP relationship', () => {
    expect(tierWords({ tier: 'admin', relationship: 'msp' })).toBe('Admin (MSP)');
    expect(tierWords({ tier: 'nonsense' })).toBe('Not on your people list');
  });

  it('gives the owner the next step when privacy is off, and only then', () => {
    const off = buildReachPage({ ok: true, data: { count: 2, privacyOn: false, people: [] } });
    expect(off.notes[0]).toContain('turn on memory privacy');
    expect(buildReachPage({ ok: true, data: { count: 1, privacyOn: false, people: [] } }).notes).toEqual([]);
  });

  it('says it cannot tell rather than showing nobody', () => {
    expect(buildReachPage({ ok: false, reason: 'switched off on this agent' })).toEqual({ ok: false, reason: 'switched off on this agent' });
  });

  it('shapes a row', () => {
    expect(personRow({ key: 'k', name: 'Sam', tier: 'member', reach: [{ detail: 'Slack' }, { detail: 'Phone: X' }], sees: 'S', warnings: ['w'] }))
      .toEqual({ key: 'k', title: 'Sam', tier: 'Member', reach: 'Slack, Phone: X', sees: 'S', warnings: ['w'] });
  });

  it('is a tile in the People group', () => {
    const people = GROUPS.find((g) => g.id === 'people');
    expect(people?.tabs.some((t) => t.id === 'reach')).toBe(true);
    expect(NATIVE_PAGES.reach).toBe('#/people/reach');
    expect(tabHref('reach')).toBe('#/people/reach');
  });
});
